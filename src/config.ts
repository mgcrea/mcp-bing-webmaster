import { z } from "zod";

/**
 * The JSON endpoint of the Bing Webmaster API. SOAP and POX were retired on
 * 2026-08-31, so this is the only protocol left: one RPC endpoint per method,
 * `<base>/<Method>?apikey=KEY`.
 */
export const DEFAULT_BASE_URL = "https://ssl.bing.com/webmaster/api.svc/json";

/** Where the API key is generated. Shown in auth_status, the README and the startup banner. */
export const KEY_SETUP_URL = "https://www.bing.com/webmasters";

const isLoopback = (url: URL): boolean =>
  url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";

export const RETRIES = { min: 0, max: 10, default: 3 };
export const TIMEOUT_MS = { min: 1000, max: 300_000, default: 30_000 };

const ConfigSchema = z
  .object({
    baseUrl: z.url().default(DEFAULT_BASE_URL),
    apiKey: z.string().min(1).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().min(RETRIES.min).max(RETRIES.max).default(RETRIES.default),
    timeoutMs: z.number().int().min(TIMEOUT_MS.min).max(TIMEOUT_MS.max).default(TIMEOUT_MS.default),
    /**
     * Settings that were out of range or unreadable and were replaced. Shown
     * at startup and by bing_webmaster_auth_status: a bad value must never
     * stop the server (rule 2), and must never be ignored silently either.
     */
    warnings: z.array(z.string()).default([]),
  })
  .strict();
// Deliberately no superRefine on apiKey: an MCP server that exits on startup
// shows up in the client as a bare "Connection closed", with stderr swallowed —
// so the one message that would have explained the problem never reaches
// anyone. A missing key is reported through bing_webmaster_auth_status instead.

export type Config = z.infer<typeof ConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

/**
 * An integer setting, clamped into range. Unreadable or out-of-range values
 * fall back (to the default, or the nearest bound) and leave a warning.
 */
const intSetting = (
  name: string,
  raw: string | undefined,
  range: { min: number; max: number; default: number },
  warnings: string[],
): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    warnings.push(`${name}=${raw} is not an integer; using the default ${range.default}.`);
    return undefined;
  }
  if (n < range.min || n > range.max) {
    const clamped = Math.min(Math.max(n, range.min), range.max);
    warnings.push(`${name}=${raw} is outside ${range.min}-${range.max}; using ${clamped}.`);
    return clamped;
  }
  return n;
};

/**
 * The API URL override, or undefined (the default) with a warning when it is
 * unusable. Plain http is refused because the key travels in the URL; falling
 * back to Bing's own https endpoint sends the key nowhere it does not belong.
 */
const baseUrlSetting = (raw: string | undefined, warnings: string[]): string | undefined => {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warnings.push(`BING_WEBMASTER_API_URL=${raw} is not a URL; using ${DEFAULT_BASE_URL}.`);
    return undefined;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    warnings.push(
      `BING_WEBMASTER_API_URL must be https:// (the API key is sent in the URL; http:// is only ` +
        `accepted on loopback); using ${DEFAULT_BASE_URL}.`,
    );
    return undefined;
  }
  return raw.replace(/\/+$/, "");
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/**
 * Environment only. This server persists nothing of its own (no OAuth token,
 * no provisioned keys), so there is no config file to merge. If one ever
 * arrives, merge it per field under the environment — see references/auth.md.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const warnings: string[] = [];
  return ConfigSchema.parse({
    baseUrl: baseUrlSetting(trimmed(env.BING_WEBMASTER_API_URL), warnings),
    apiKey: trimmed(env.BING_WEBMASTER_API_KEY),
    allowWrites: parseBool(env.BING_WEBMASTER_ALLOW_WRITES),
    maxRetries: intSetting(
      "BING_WEBMASTER_MAX_RETRIES",
      env.BING_WEBMASTER_MAX_RETRIES,
      RETRIES,
      warnings,
    ),
    timeoutMs: intSetting(
      "BING_WEBMASTER_TIMEOUT_MS",
      env.BING_WEBMASTER_TIMEOUT_MS,
      TIMEOUT_MS,
      warnings,
    ),
    warnings,
  });
};

export const isConfigured = (config: Config): boolean => Boolean(config.apiKey);

/** The key-generation steps, as data: auth_status, the README and stderr all say this. */
export const KEY_STEPS: string[] = [
  `Sign in at ${KEY_SETUP_URL} (a Microsoft, Google or Facebook account works).`,
  "Add and verify your site. Bing can import sites, already verified, from Google Search " +
    "Console: Add site → Import from GSC.",
  "Open Settings (the gear, top right) → API Access, accept the terms, then API Key → Generate.",
  "There is one key per user, and it reaches every site that user has verified. Deleting it " +
    "breaks every app that uses it, so reuse the existing one rather than regenerating it.",
  "Set BING_WEBMASTER_API_KEY to the key, then restart the server.",
];

/** Returned by bing_webmaster_auth_status and printed to stderr at startup. */
export const setupInstructions = (config: Config): string[] =>
  isConfigured(config) ? [] : ["No Bing Webmaster API key is set. To get one:", ...KEY_STEPS];
