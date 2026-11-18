import { AsyncLocalStorage } from "node:async_hooks";

import { createRedactor, type Logger, type Redactor } from "#/client/auth";
import {
  BingWebmasterApiError,
  parseBingError,
  PreconditionError,
  remedyForCode,
  remedyForStatus,
} from "#/client/errors";
import { normalizeResponse, readSites, type Site } from "#/client/shape";
import { matchSite } from "#/client/sites";

export type Query = Record<string, string | number | boolean | undefined>;
export type HttpVerb = "GET" | "POST";

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

/** Retry-After in ms (delta-seconds form), or undefined when absent or unreadable. */
export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

/** GetUserSites is cached this long: the site list changes when someone adds a site, not per call. */
export const SITE_CACHE_MS = 5 * 60_000;

/**
 * The longest Retry-After this server will sleep through. A longer one fails
 * the call at once with "retry after N s": sleeping ten minutes inside a tool
 * call outlives the client's own timeout, and the model then calls again.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The whole call, retries and backoff included, must finish inside this. It
 * sits under the 60 s an MCP client typically waits, so the answer — even a
 * failure — arrives before the client gives up and the model retries.
 */
export const CALL_DEADLINE_MS = 45_000;

/** Bing's throttle codes (ThrottleUser, ThrottleHost) arrive as HTTP 400, yet clear on their own. */
const THROTTLE_CODES = new Set([4, 5]);
/** InternalError. */
const INTERNAL_CODE = 1;

/**
 * The tool call a client request belongs to. tools/util.ts `run()` enters it
 * with the MCP request's abort signal, so a cancelled tool call aborts its
 * fetches without every call site having to pass the signal along.
 */
export const requestScope = new AsyncLocalStorage<{ signal?: AbortSignal | undefined }>();

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Settle with `promise`, or reject as soon as `signal` aborts — whichever comes first. */
export const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
};

export type BingWebmasterClientOptions = {
  baseUrl: string;
  apiKey: string;
  maxRetries: number;
  /** Per attempt. The whole call is bounded by `callDeadlineMs` too. */
  timeoutMs: number;
  userAgent: string;
  fetch?: typeof fetch;
  logger?: Logger;
  /** How to wait before a retry. Tests record the delay and resolve at once. */
  sleep?: Sleep;
  /** Overall budget for one call, retries included. Defaults to CALL_DEADLINE_MS. */
  callDeadlineMs?: number;
  /** Clock for the site cache. */
  now?: () => number;
};

/**
 * The Bing Webmaster API client. One RPC endpoint per method:
 * `GET <base>/<Method>?<params>&apikey=KEY`, or `POST <base>/<Method>?apikey=KEY`
 * with a JSON body.
 *
 * THE KEY IS IN THE URL. So the URL is built in exactly one place (`url()`),
 * and is never logged, never put in an error, never returned. Errors are built
 * from the method name alone, and every upstream string that could echo the
 * key back is redacted — before it is cut, so a truncation cannot leave half a
 * key behind.
 */
export class BingWebmasterClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly sleep: Sleep;
  private readonly callDeadlineMs: number;
  private readonly now: () => number;
  readonly redact: Redactor;
  private sitesCache: { at: number; promise: Promise<Site[]> } | undefined;

  constructor(opts: BingWebmasterClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.maxRetries = opts.maxRetries;
    this.timeoutMs = opts.timeoutMs;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.sleep = opts.sleep ?? defaultSleep;
    this.callDeadlineMs = opts.callDeadlineMs ?? CALL_DEADLINE_MS;
    this.now = opts.now ?? Date.now;
    this.redact = createRedactor(opts.apiKey);
  }

  /** The only place a request URL exists. Keep it that way. */
  private url(method: string, query: Query | undefined): URL {
    const url = new URL(`${this.baseUrl}/${encodeURIComponent(method)}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      // Strings go raw, not JSON-quoted: WCF's JSON query-string converter
      // accepts both (the docs' samples use both), and raw is what a URL
      // reader expects. Numbers and booleans are their literal form.
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set("apikey", this.apiKey);
    return url;
  }

  /** JSON, or — for a proxy's HTML page — the text, redacted first and only then cut. */
  private parseBody(text: string): unknown {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return this.redact.text(text).slice(0, 300);
    }
  }

  get<T = unknown>(method: string, query?: Query): Promise<T> {
    return this.call<T>(method, { http: "GET", ...(query ? { query } : {}) });
  }

  post<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    return this.call<T>(method, { http: "POST", body });
  }

  /**
   * Call one API method and return its payload: `d` unwrapped, `__type`
   * stripped, every `/Date(...)/` converted to ISO. A void method (Submit*,
   * Remove*) answers `{"d": null}`, which comes back as null.
   *
   * Retries: a GET retries on a throttle, a 5xx, InternalError, a timeout or a
   * network error, honouring Retry-After up to MAX_RETRY_AFTER_MS, and only
   * while the call's deadline leaves room. A POST is NEVER retried here, not
   * even on a throttle: a ThrottleUser answer most likely means Bing refused
   * it, but a retry racing a model's own retry is how SubmitUrlBatch gets sent
   * twice. The error says when to retry instead, and the model decides.
   */
  async call<T = unknown>(
    method: string,
    opts: { http: HttpVerb; query?: Query; body?: unknown },
  ): Promise<T> {
    const callerSignal = requestScope.getStore()?.signal;
    const deadline = AbortSignal.timeout(this.callDeadlineMs);
    const outer = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    const startedAt = Date.now();
    const remaining = () => this.callDeadlineMs - (Date.now() - startedAt);
    const url = this.url(method, opts.http === "GET" ? opts.query : undefined);
    const isGet = opts.http === "GET";

    for (let attempt = 0; ; attempt += 1) {
      this.logger?.debug?.(`${opts.http} ${method} (attempt ${attempt + 1})`);
      const attemptTimeout = AbortSignal.timeout(
        Math.max(1, Math.min(this.timeoutMs, remaining())),
      );
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method: opts.http,
          headers: {
            Accept: "application/json",
            // The documented samples send this on GET too; WCF picks the
            // request format from it, so mirror them exactly.
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": this.userAgent,
          },
          ...(opts.http === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
          signal: AbortSignal.any([outer, attemptTimeout]),
        });
        // Inside the try: the body can fail mid-stream ("terminated") or time
        // out after the headers arrived, and that is a network error too.
        text = await res.text();
      } catch (err) {
        if (callerSignal?.aborted) {
          throw new BingWebmasterApiError(`${method} cancelled by the client`, {
            method,
            status: 0,
          });
        }
        // undici's errors can carry the URL (and so the key) in their message
        // or cause. Keep only a redacted message, never the error object.
        const reason = deadline.aborted
          ? `the ${Math.ceil(this.callDeadlineMs / 1000)} s deadline for the whole call passed`
          : attemptTimeout.aborted
            ? `timed out after ${Math.min(this.timeoutMs, this.callDeadlineMs)} ms`
            : this.redact.text(err instanceof Error ? err.message : String(err));
        const delay = backoffMs(attempt);
        if (isGet && !deadline.aborted && attempt < this.maxRetries && delay < remaining()) {
          this.logger?.warn?.(`${method}: no response (${reason}) — retrying in ${delay}ms`);
          await this.wait(method, delay, outer, callerSignal);
          continue;
        }
        throw new BingWebmasterApiError(`${method} failed: no response from Bing (${reason})`, {
          method,
          status: 0,
          remedy: remedyForStatus(0, opts.http) as string,
        });
      }

      const parsed = this.parseBody(text);
      if (res.ok) {
        if (typeof parsed === "string") {
          throw new BingWebmasterApiError(
            `${method} failed: Bing answered HTTP ${res.status} with something that is not JSON`,
            { method, status: res.status, errors: parsed },
          );
        }
        return normalizeResponse(parsed) as T;
      }

      const bing = parseBingError(parsed);
      const throttled =
        res.status === 429 || (bing.code !== undefined && THROTTLE_CODES.has(bing.code));
      const retryAfter = retryAfterMs(res);
      const transient = throttled || res.status >= 500 || bing.code === INTERNAL_CODE;
      if (isGet && transient && attempt < this.maxRetries) {
        const delay = retryAfter ?? backoffMs(attempt);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          if (delay < remaining()) {
            this.logger?.warn?.(
              `${method}: HTTP ${res.status}${bing.codeName ? ` ${bing.codeName}` : ""} — retrying in ${delay}ms`,
            );
            await this.wait(method, delay, outer, callerSignal);
            continue;
          }
        }
      }
      throw this.apiError(
        method,
        opts.http,
        res.status,
        parsed,
        throttled ? retryAfter : undefined,
      );
    }
  }

  /** Sleep before a retry, turning a cancel or the deadline into a clean error. */
  private async wait(
    method: string,
    ms: number,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await this.sleep(ms, signal);
    } catch {
      throw new BingWebmasterApiError(
        callerSignal?.aborted
          ? `${method} cancelled by the client`
          : `${method} failed: the call's deadline passed while waiting to retry`,
        { method, status: 0, remedy: remedyForStatus(0) as string },
      );
    }
  }

  private apiError(
    method: string,
    http: HttpVerb,
    status: number,
    body: unknown,
    retryAfter: number | undefined,
  ): BingWebmasterApiError {
    const { code, codeName, message } = parseBingError(body);
    const safeMessage = message === undefined ? undefined : this.redact.text(message);
    const wait = retryAfter === undefined ? undefined : Math.ceil(retryAfter / 1000);
    let remedy = remedyForCode(codeName) ?? remedyForStatus(status, http);
    if (wait !== undefined) {
      remedy =
        `Bing asked to retry after ${wait} s (Retry-After). A throttle answer means Bing refused ` +
        `the call rather than running it; wait that long, then call again once.`;
    }
    const detail = safeMessage && safeMessage !== codeName ? ` — ${safeMessage}` : "";
    const after = wait === undefined ? "" : `; retry after ${wait} s`;
    return new BingWebmasterApiError(
      `${method} failed: HTTP ${status}${codeName ? ` ${codeName}` : ""}${detail}${after}`,
      {
        method,
        status,
        ...(code !== undefined ? { code } : {}),
        ...(codeName ? { codeName } : {}),
        ...(remedy ? { remedy } : {}),
        // Only when there is more than the code and message already say.
        // parseBody has already redacted a text body; a JSON one is redacted here.
        ...(body !== undefined && codeName === undefined ? { errors: this.redact.deep(body) } : {}),
      },
    );
  }

  // ---- sites -----------------------------------------------------------------

  /**
   * Every site the key's user has added. Cached for five minutes; a failure is
   * not cached, or one transient error would stick for the cache's lifetime.
   *
   * The fetch runs outside any tool call's scope: it is shared (the startup
   * banner and the first tool call both wait on it), so one caller cancelling
   * must not abort it for the others. Each caller races its own signal instead.
   */
  sites(opts: { fresh?: boolean } = {}): Promise<Site[]> {
    const signal = requestScope.getStore()?.signal;
    const now = this.now();
    if (!opts.fresh && this.sitesCache && now - this.sitesCache.at < SITE_CACHE_MS) {
      return raceAbort(this.sitesCache.promise, signal);
    }
    const promise: Promise<Site[]> = requestScope
      .exit(() => this.get("GetUserSites"))
      .then(readSites)
      .catch((err: unknown) => {
        if (this.sitesCache?.promise === promise) this.sitesCache = undefined;
        throw err;
      });
    this.sitesCache = { at: now, promise };
    return raceAbort(promise, signal);
  }

  /**
   * Resolve `site` as a person typed it to the exact registered form. A miss
   * refetches once before failing, so a site added a minute ago is found. The
   * error names the sites the key does reach: with one key per user, "site
   * not found" is how a key from the wrong account shows itself.
   */
  async resolveSite(input: string): Promise<Site> {
    let sites = await this.sites();
    let match = matchSite(input, sites);
    if (match.kind === "none") {
      sites = await this.sites({ fresh: true });
      match = matchSite(input, sites);
    }
    if (match.kind === "match") return match.site;
    if (match.kind === "ambiguous") {
      throw new PreconditionError(
        `"${input}" matches ${match.candidates.length} registered sites: ` +
          `${match.candidates.map((s) => s.url).join(", ")}.`,
        {
          remedy:
            "Pass the exact site URL, scheme included, as bing_webmaster_list_sites shows it.",
          details: { candidates: match.candidates.map((s) => s.url) },
        },
      );
    }
    throw new PreconditionError(
      sites.length === 0
        ? `"${input}" is not a site of this API key: the key's user has no sites in Bing Webmaster Tools.`
        : `"${input}" is not one of the ${sites.length} site(s) this API key reaches.`,
      {
        remedy:
          sites.length === 0
            ? "Add and verify the site at https://www.bing.com/webmasters (it can import sites from " +
              "Google Search Console), or check BING_WEBMASTER_API_KEY belongs to the right account."
            : "Use one of accessible_sites (bing_webmaster_list_sites has them all). If the site " +
              "should be there, the key belongs to another account: there is one key per user, " +
              "reaching only that user's sites.",
        details: {
          accessible_sites: sites.slice(0, MAX_LISTED_SITES).map((s) => s.url),
          ...(sites.length > MAX_LISTED_SITES ? { accessible_sites_total: sites.length } : {}),
        },
      },
    );
  }
}

/** How many sites an error lists before it says "and N more". */
export const MAX_LISTED_SITES = 20;
