import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * This server reads no file at all — environment only — so there is no
 * config path to point at nothing. The env passed here is the whole input.
 */

/** Long enough that the redactor masks it; distinctive enough to grep for. */
export const API_KEY = "test0key0abcdef0123456789secret";

export const READ_ENV = { BING_WEBMASTER_API_KEY: API_KEY };
export const WRITE_ENV = { ...READ_ENV, BING_WEBMASTER_ALLOW_WRITES: "1" };

/** "Today" for every default date window in the suite. */
export const TODAY = "2026-11-18";

export const SITES = [
  {
    __type: "Site:#Microsoft.Bing.Webmaster.Api",
    AuthenticationCode: "258CAD36B9EEE22F1CFDEB4C239D26BB",
    DnsVerificationCode: "258cad36b9eee22f1cfdeb4c239d26bb.example.com",
    IsVerified: true,
    Url: "https://example.com/",
  },
  {
    __type: "Site:#Microsoft.Bing.Webmaster.Api",
    AuthenticationCode: "AAAA",
    DnsVerificationCode: "aaaa.blog.example.org",
    IsVerified: false,
    Url: "http://blog.example.org",
  },
];

export const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });

/** A WCF-enveloped payload, as Bing sends every answer. */
export const d = (payload: unknown): Response => jsonResponse({ d: payload });

/** Bing's error body: HTTP 400 with an ApiErrorCode. */
export const bingError = (code: number, message: string, status = 400): Response =>
  jsonResponse({ ErrorCode: code, Message: message }, { status });

/** A WCF date for a calendar day at Pacific midnight, as Bing writes day buckets. */
export const wcfDay = (day: string, offset = "-0700"): string => {
  const sign = offset.startsWith("-") ? 1 : -1;
  const hours = Number(offset.slice(1, 3));
  return `/Date(${Date.parse(`${day}T00:00:00Z`) + sign * hours * 3_600_000}${offset})/`;
};

export type Call = {
  method: string;
  /** The API method name: the last path segment. */
  api: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  /** The signal the client passed: aborts on timeout, deadline or cancel. */
  signal: AbortSignal | undefined;
};

/** A route: return a Response to answer, or undefined to fall through. */
export type Route = (call: Call) => Response | Promise<Response | undefined> | undefined;

/** Answer one API method by name. */
export const on =
  (api: string, answer: Response | ((call: Call) => Response)): Route =>
  (call) => {
    if (call.api !== api) return undefined;
    // A Response body can be read once; clone so a route can answer twice.
    return typeof answer === "function" ? answer(call) : answer.clone();
  };

/** Never answers; rejects with the signal's reason once the client aborts the request. */
export const hang = (call: Call): Promise<Response> =>
  new Promise((_, reject) => {
    call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true });
  });

/** GetUserSites, which every site-scoped tool asks first. */
export const sitesRoute: Route = on("GetUserSites", () => d(SITES));

/**
 * A fetch that records every call and answers from the routes in order. An
 * unmatched request fails loudly, so a test never passes by accident on a
 * request it did not expect.
 */
export const routedFetch = (routes: Route[]) => {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    const call: Call = {
      method: init.method ?? "GET",
      api: url.pathname.split("/").pop() ?? "",
      url,
      headers,
      body,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res) return res;
    }
    throw new Error(`unexpected request: ${call.method} ${call.api}`);
  };
  return { fetch: impl as typeof fetch, calls };
};

export const connect = async (
  env: Record<string, string> = READ_ENV,
  opts: { routes?: Route[]; now?: () => Date; callDeadlineMs?: number } = {},
) => {
  const config: Config = loadConfig(env);
  const { fetch, calls } = routedFetch([...(opts.routes ?? []), sitesRoute]);
  /** Every retry delay the client asked for; the wait itself is skipped. */
  const sleeps: number[] = [];
  const { server } = createServer({
    config,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: opts.now ?? (() => new Date(`${TODAY}T12:00:00Z`)),
    ...(opts.callDeadlineMs ? { callDeadlineMs: opts.callDeadlineMs } : {}),
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    sleeps,
    /** Every request made, GetUserSites included. */
    calls,
    /** The requests made to one method. */
    callsTo: (api: string): Call[] => calls.filter((c) => c.api === api),
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    /** The raw text of a tool result, for asserting what is (not) in it. */
    callText: async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      try {
        const res = await client.callTool({ name, arguments: args });
        return (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
      } catch (err) {
        return String(err);
      }
    },
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      // SDK v2 answers a schema violation with an isError result whose text
      // is plain prose, not a throw. Same outcome: the tool body never ran.
      if (res.isError === true && text.startsWith("Input validation error")) {
        return { isToolError: true, rejected: true, error: text } as Record<string, unknown>;
      }
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
  };
};
