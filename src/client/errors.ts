export class BingWebmasterApiError extends Error {
  // `string`, not the literal, so a subclass can override it.
  override readonly name: string = "BingWebmasterApiError";
  /** The API method that failed, e.g. `GetQueryStats`. Never the URL: it carries the key. */
  readonly method: string;
  /** HTTP status, or 0 when the request never got an answer (network, timeout). */
  readonly status: number;
  /** Bing's numeric `ErrorCode` (the ApiErrorCode enum), when the body carried one. */
  readonly code: number | undefined;
  /** The enum name for `code`, e.g. `InvalidApiKey`. */
  readonly codeName: string | undefined;
  /**
   * What to do about it, kept separate from `message`: the message says what
   * happened, the remedy is the half a model should act on, and fail() lifts it
   * to a top-level field so it is not buried inside the upstream envelope.
   */
  readonly remedy: string | undefined;
  readonly errors: unknown;

  constructor(
    message: string,
    opts: {
      method: string;
      status: number;
      code?: number;
      codeName?: string;
      remedy?: string;
      errors?: unknown;
    },
  ) {
    super(message);
    this.method = opts.method;
    this.status = opts.status;
    this.code = opts.code;
    this.codeName = opts.codeName;
    this.remedy = opts.remedy;
    this.errors = opts.errors;
  }
}

/** Thrown when a write path is reached while BING_WEBMASTER_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set BING_WEBMASTER_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}

/**
 * A local precondition failed before anything was sent: an unknown or
 * ambiguous site, a URL outside the site, a bad date window. Carries a remedy
 * like an API error does.
 */
export class PreconditionError extends Error {
  override readonly name: string = "PreconditionError";
  readonly remedy: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, opts: { remedy?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.remedy = opts.remedy;
    this.details = opts.details;
  }
}

/**
 * The ApiErrorCode enum (Microsoft.Bing.Webmaster.Api.Interfaces). The JSON
 * error body is `{"ErrorCode": 3, "Message": "InvalidApiKey"}` with HTTP 400 —
 * Bing reports nearly every failure as a 400, so the code, not the status, is
 * what tells them apart.
 */
export const API_ERROR_CODES: Record<number, string> = {
  0: "None",
  1: "InternalError",
  2: "UnknownError",
  3: "InvalidApiKey",
  4: "ThrottleUser",
  5: "ThrottleHost",
  6: "UserBlocked",
  7: "InvalidUrl",
  8: "InvalidParameter",
  9: "TooManySites",
  10: "UserNotFound",
  11: "NotFound",
  12: "AlreadyExists",
  13: "NotAllowed",
  14: "NotAuthorized",
  15: "UnexpectedState",
  16: "Deprecated",
};

const KEY_REMEDY =
  "The API key was rejected. Check BING_WEBMASTER_API_KEY against Bing Webmaster Tools → " +
  "Settings → API Access. There is one key per user; if it was deleted or regenerated, every " +
  "app using the old one stops working — set the current key and restart the server.";

const REMEDIES: Record<string, string> = {
  InternalError:
    "A failure inside Bing. Retry in a minute; if it persists, the method may be down.",
  UnknownError: "Bing could not say what went wrong. Retry once; then check the arguments.",
  InvalidApiKey: KEY_REMEDY,
  ThrottleUser:
    "Too many requests for this API key. Wait a minute before retrying, and avoid calling the " +
    "same method in a tight loop — the Get*Stats methods return the whole history in one call.",
  ThrottleHost: "Too many requests for this site. Wait a minute before retrying.",
  UserBlocked:
    "This Bing Webmaster account is blocked. Sign in at https://www.bing.com/webmasters to see why.",
  InvalidUrl:
    "Bing rejected a URL. A page URL must be absolute (https://…) and belong to the site; the " +
    "site itself must be one bing_webmaster_list_sites returns.",
  InvalidParameter:
    "Bing rejected a parameter. Dates are YYYY-MM-DD, country is a lower-case ISO code such as " +
    '"us", language a tag such as "en-US".',
  TooManySites: "This account has reached Bing's limit on the number of sites.",
  UserNotFound:
    "The API key's user has no Bing Webmaster Tools account data. Sign in at " +
    "https://www.bing.com/webmasters and add a site.",
  NotFound:
    "Bing has no such resource: the URL, sitemap or site is not known for this account. " +
    "bing_webmaster_list_sites and bing_webmaster_list_sitemaps show what exists.",
  AlreadyExists: "It already exists; nothing to do.",
  NotAllowed:
    "Bing refused the operation. For URL submission this usually means the quota is spent — " +
    "bing_webmaster_get_url_submission_quota shows what is left today and this month.",
  NotAuthorized:
    "The key's user has no access to this site, or the site is not verified. " +
    "bing_webmaster_list_sites shows the sites the key reaches and whether each is verified.",
  UnexpectedState:
    "The site is not in a state that allows this (for example, it is not verified yet).",
  Deprecated:
    "Bing has retired this method. Use a dedicated tool, or another method through " +
    "bing_webmaster_request.",
};

export const remedyForCode = (codeName: string | undefined): string | undefined =>
  codeName === undefined ? undefined : REMEDIES[codeName];

/**
 * A POST that timed out or got a 5xx may still have been applied, and resending
 * SubmitUrlBatch spends the quota twice. So its remedy says to check first,
 * never to just retry.
 */
export const UNCERTAIN_WRITE_REMEDY =
  "The call may have been applied even though no answer came back. Before resubmitting, check: " +
  "bing_webmaster_get_url_submission_quota (for URL submissions — a drop means it went through) " +
  "or bing_webmaster_list_sitemaps (for sitemaps).";

/** Fallback by HTTP status, for answers that carry no ErrorCode (a proxy, WCF's own 404/405). */
export const remedyForStatus = (
  status: number,
  http: "GET" | "POST" = "GET",
): string | undefined => {
  if (http === "POST" && (status === 0 || status >= 500)) return UNCERTAIN_WRITE_REMEDY;
  if (status === 0) return "No answer from Bing (network error or timeout). Retry in a moment.";
  if (status === 401 || status === 403) return KEY_REMEDY;
  if (status === 404) {
    return (
      "No such API method. Method names are case-sensitive PascalCase, e.g. GetQueryStats — see " +
      "https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi"
    );
  }
  if (status === 405) {
    return "Wrong HTTP verb for this method: Get* methods are GET, everything else is POST.";
  }
  if (status === 429) return REMEDIES.ThrottleUser;
  if (status >= 500) return REMEDIES.InternalError;
  return undefined;
};

export type ParsedBingError = {
  code: number | undefined;
  codeName: string | undefined;
  message: string | undefined;
};

/**
 * Pull `{ErrorCode, Message}` out of an error body, tolerating anything else:
 * a `d`-wrapped body, a lower-case key, a code sent by name, or no JSON at all.
 * None of these variants is documented; the parser accepts them so that a
 * surprise costs a remedy, not the whole error.
 */
export const parseBingError = (body: unknown): ParsedBingError => {
  let record: Record<string, unknown> | undefined;
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    record = body as Record<string, unknown>;
    if (typeof record.d === "object" && record.d !== null)
      record = record.d as Record<string, unknown>;
  }
  if (!record) return { code: undefined, codeName: undefined, message: undefined };
  const rawCode = record.ErrorCode ?? record.errorCode;
  const rawMessage = record.Message ?? record.message;
  const message = typeof rawMessage === "string" ? rawMessage : undefined;
  let code: number | undefined;
  let codeName: string | undefined;
  if (typeof rawCode === "number") {
    code = rawCode;
    codeName = API_ERROR_CODES[rawCode];
  } else if (typeof rawCode === "string") {
    const asNumber = Number(rawCode);
    if (Number.isInteger(asNumber)) {
      code = asNumber;
      codeName = API_ERROR_CODES[asNumber];
    } else {
      const entry = Object.entries(API_ERROR_CODES).find(([, name]) => name === rawCode);
      if (entry) {
        code = Number(entry[0]);
        codeName = entry[1];
      }
    }
  }
  // The documented sample puts the enum name in Message: {"ErrorCode":3,"Message":"InvalidApiKey"}.
  if (codeName === undefined && message && REMEDIES[message]) {
    codeName = message;
    const entry = Object.entries(API_ERROR_CODES).find(([, name]) => name === message);
    if (entry) code = Number(entry[0]);
  }
  return { code, codeName, message };
};
