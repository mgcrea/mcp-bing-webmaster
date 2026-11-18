import { z } from "zod";

import { requestScope, type BingWebmasterClient } from "#/client/bingwebmaster";
import { BingWebmasterApiError, PreconditionError, WritesDisabledError } from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed: `null, 2` adds 19-41% to every response, and
 * no model needs the indentation.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * `extra` is spread at the top level, so a `remedy` lands beside the error
 * rather than inside the upstream envelope, where it gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof BingWebmasterApiError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      method: err.method,
      status: err.status,
      ...(err.codeName ? { error_code: err.codeName } : {}),
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof PreconditionError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...err.details,
    });
  }
  if (err instanceof WritesDisabledError) return fail(err.message);
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error");
};

/**
 * What a tool handler gets as its second argument, narrowed to the part this
 * server uses: the MCP request's abort signal, fired when the client cancels.
 */
export type RequestCtx = { mcpReq?: { signal?: AbortSignal } } | undefined;

/**
 * Run a tool body: JSON-format the result, turn a throw into a tool error, and
 * mask the API key in whatever text comes out. The client already keeps the
 * key out of everything it builds; this is the last gate before the model.
 *
 * The body runs inside the request's scope, so every Bing call it makes is
 * aborted when the client cancels the tool call.
 */
export const run = async (
  ctx: RequestCtx,
  client: BingWebmasterClient,
  fn: () => Promise<unknown>,
): Promise<ToolResult> => {
  let result: ToolResult;
  try {
    result = ok(await requestScope.run({ signal: ctx?.mcpReq?.signal }, fn));
  } catch (err) {
    result = toFailure(err);
  }
  for (const part of result.content) part.text = client.redact.text(part.text);
  return result;
};

/**
 * Run a body against one site: resolve `site` to its registered form first
 * (refusing an unknown or ambiguous one before anything else is sent), then
 * stamp the resolved site beside the result. The key reaches every site its
 * user verified, so the stamp is what shows which one a number came from.
 */
export const runForSite = (
  ctx: RequestCtx,
  client: BingWebmasterClient,
  site: string,
  fn: (siteUrl: string) => Promise<Record<string, unknown>>,
): Promise<ToolResult> =>
  run(ctx, client, async () => {
    const resolved = await client.resolveSite(site);
    return { site: resolved.url, ...(await fn(resolved.url)) };
  });

/** Drop undefined values so we never send `{"page": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

// ---- arg atoms -------------------------------------------------------------

export const siteArg = z
  .string()
  .min(3)
  .describe(
    'The site, e.g. "example.com" or "https://www.example.com/". Matched against the sites this ' +
      "API key reaches (bing_webmaster_list_sites), tolerating a missing scheme, www. or trailing " +
      "slash; an ambiguous or unknown site is refused with the list of accessible ones.",
  );

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (s: string): boolean =>
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const dayArg = (what: string) =>
  z
    .string()
    .regex(DAY, 'A date is YYYY-MM-DD, e.g. "2026-10-01".')
    .refine(realDay, "Not a real calendar date.")
    .describe(what);

export const startDateArg = (defaultText: string) =>
  dayArg(
    `First day of the window, inclusive, YYYY-MM-DD. ${defaultText} Bing returns the whole ` +
      "history and this server filters it, so any range Bing still holds works.",
  ).optional();

export const endDateArg = dayArg(
  "Last day of the window, inclusive, YYYY-MM-DD. Defaults to today (UTC). Bing's search data " +
    "lags a few days and is bucketed (often weekly), so the newest days are usually empty.",
).optional();

export const sortByArg = z
  .enum(["clicks", "impressions", "ctr", "position"])
  .default("clicks")
  .describe(
    "Sort order, best first: clicks, impressions, ctr (highest first — noisy on keys with few " +
      "impressions), or position (lowest, i.e. best, average position first). Defaults to clicks.",
  );

export const limitArg = (max: number, def: number, what = "rows") =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(def)
    .describe(`Maximum ${what} to return (1-${max}). Defaults to ${def}.`);

export const containsArg = (what: string) =>
  z
    .string()
    .min(1)
    .optional()
    .describe(`Keep only ${what} containing this text (case-insensitive), e.g. "pricing".`);

export const pageUrlArg = (what: string) =>
  z
    .url({
      protocol: /^https?$/,
      error: "An absolute http(s) URL, e.g. https://example.com/pricing.",
    })
    .describe(`${what} — an absolute URL, e.g. "https://example.com/pricing".`);

export const pageArg = z
  .number()
  .int()
  .min(0)
  .max(32_767)
  .default(0)
  .describe("Result page, 0-based. Each answer says total_pages and next_page. Defaults to 0.");

export const countryArg = z
  .string()
  .regex(/^[a-z]{2}$/, 'A lower-case ISO 3166 country code, e.g. "us", "gb", "fr".')
  .optional()
  .describe(
    'Market country: a lower-case ISO 3166 code, e.g. "us", "gb", "fr". Omit for all markets. ' +
      "Pair it with the matching language.",
  );

export const languageArg = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2})?$/, 'A language tag such as "en-US", "fr-FR" or "nl-BE".')
  .optional()
  .describe(
    'Market language: a language-region tag, e.g. "en-US", "en-GB", "fr-FR", "nl-BE". Omit for ' +
      "all languages.",
  );

/** Destructive tools require this, so an agent can never remove something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes the site in Bing.");
