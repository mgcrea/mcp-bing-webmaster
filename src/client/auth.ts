export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export const REDACTED = "[REDACTED]";

export type Redactor = {
  text(value: string): string;
  /** Redact every string inside a JSON-shaped value, keys included. */
  deep<T>(value: T): T;
};

/**
 * The Bing API key travels in the query string (`?apikey=KEY`), so any request
 * URL that reaches a log line, an error message or a tool result leaks it. The
 * client never puts a URL in either; this is the second line of defence, for
 * upstream text that might echo the key back (an error message, a proxy page).
 *
 * Both the raw and the URL-encoded forms are masked, since a URL that leaked
 * would carry the encoded one.
 */
export const createRedactor = (secret: string | undefined): Redactor => {
  // A secret this short would mask ordinary words; no real key is this short.
  const needles =
    secret && secret.length >= 6 ? [...new Set([secret, encodeURIComponent(secret)])] : [];
  const text = (value: string): string =>
    needles.reduce((acc, needle) => acc.split(needle).join(REDACTED), value);
  const deep = <T>(value: T): T => {
    if (needles.length === 0) return value;
    if (typeof value === "string") return text(value) as T;
    if (Array.isArray(value)) return value.map((v) => deep(v)) as T;
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [text(k), deep(v)]),
      ) as T;
    }
    return value;
  };
  return { text, deep };
};
