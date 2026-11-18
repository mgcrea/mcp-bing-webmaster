import type { Site } from "#/client/shape";

// Bing matches `siteUrl` against the form the site was registered in
// (`https://example.com/` and `http://example.com` are different sites to
// it), and answers a near miss with a NotAuthorized or NotFound that reads like
// a key problem. So every tool resolves the caller's `site` against
// GetUserSites first, and sends the registered string byte for byte.

type ParsedSite = {
  /** `https`, or undefined when the input had no scheme. */
  scheme: string | undefined;
  host: string;
  /** Path without its trailing slash; "" for a root site. */
  path: string;
  /** "" for the scheme's default port. */
  port: string;
};

/**
 * Parse a site as a person would type it: `example.com`, `https://example.com/`,
 * `www.example.com`, or Search Console's `sc-domain:example.com`. Returns
 * undefined for something that is not a host at all.
 */
export const parseSite = (input: string): ParsedSite | undefined => {
  let value = input.trim().replace(/^(sc-domain|domain):/i, "");
  const schemeMatch = /^(https?):\/\//i.exec(value);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (!schemeMatch) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!url.hostname || !url.hostname.includes(".")) return undefined;
    return {
      scheme,
      host: url.hostname.toLowerCase(),
      path: url.pathname.replace(/\/+$/, ""),
      port: url.port,
    };
  } catch {
    return undefined;
  }
};

const bareHost = (host: string): string => host.replace(/^www\./, "");

/** `https://example.com/blog`: scheme and host lower-cased, no trailing slash. */
const canonical = (p: ParsedSite): string => `${p.scheme ?? "https"}://${p.host}${p.path}`;

/** `example.com/blog`: no scheme, no `www.`. Two sites equal here are the "same site". */
const loose = (p: ParsedSite): string => `${bareHost(p.host)}${p.path}`;

export type SiteMatch =
  | { kind: "match"; site: Site }
  | { kind: "ambiguous"; candidates: Site[] }
  | { kind: "none" };

/**
 * Resolve `input` against the registered sites, strictest rule first:
 * 1. the exact registered string;
 * 2. the same scheme, host and path, ignoring case and a trailing slash;
 * 3. the same host (ignoring `www.`) and path, whatever the scheme. Several
 *    survivors are narrowed by the exact host first, then by the scheme, and
 *    when those two point at different sites the answer is ambiguous:
 *    `https://www.example.com` against `http://www.example.com/` and
 *    `https://example.com/` matches one by host and the other by scheme, and
 *    picking either is a guess.
 * Ambiguity is never guessed through: the caller gets the candidates.
 */
export const matchSite = (input: string, sites: Site[]): SiteMatch => {
  const exact = sites.find((s) => s.url === input.trim());
  if (exact) return { kind: "match", site: exact };

  const wanted = parseSite(input);
  if (!wanted) return { kind: "none" };
  const parsed = sites
    .map((site) => ({ site, p: parseSite(site.url) }))
    .filter((e): e is { site: Site; p: ParsedSite } => e.p !== undefined);

  if (wanted.scheme) {
    const same = parsed.filter((e) => canonical(e.p) === canonical(wanted));
    if (same.length === 1) return { kind: "match", site: (same[0] as { site: Site }).site };
  }

  const candidates = parsed.filter((e) => loose(e.p) === loose(wanted));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) {
    return { kind: "match", site: (candidates[0] as { site: Site }).site };
  }
  const byHost = candidates.filter((e) => e.p.host === wanted.host);
  const byScheme = wanted.scheme ? candidates.filter((e) => e.p.scheme === wanted.scheme) : [];
  if (byHost.length === 1) {
    const host = byHost[0] as { site: Site };
    // The scheme points elsewhere: host and scheme disagree.
    if (byScheme.length > 0 && !byScheme.some((e) => e.site === host.site)) {
      return { kind: "ambiguous", candidates: [host.site, ...byScheme.map((e) => e.site)] };
    }
    return { kind: "match", site: host.site };
  }
  if (byHost.length === 0 && byScheme.length === 1) {
    return { kind: "match", site: (byScheme[0] as { site: Site }).site };
  }
  return { kind: "ambiguous", candidates: candidates.map((e) => e.site) };
};

export type OwnUrl = { ok: true; href: string } | { ok: false; reason: string };

/**
 * Whether `url` is one of `siteUrl`'s own pages, and if so its normalized form
 * (`new URL(u).href`) — which is what gets sent, never the raw string.
 *
 * An absolute http(s) URL on exactly the site's host, under its path. Either
 * scheme is accepted, since Bing treats a site's http and https pages as that
 * site's; anything else is refused:
 * - another host, a subdomain included: Bing registers `www.example.com`,
 *   `example.com` and `shop.example.com` as separate sites;
 * - a port other than the site's, which is another origin;
 * - credentials (`https://user:pw@example.com/`), which have no business in a
 *   URL handed to a crawler.
 */
export const ownUrl = (url: string, siteUrl: string): OwnUrl => {
  const site = parseSite(siteUrl);
  if (!site) return { ok: false, reason: "the site URL itself does not parse" };
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, reason: "not http(s)" };
  }
  if (target.username || target.password) return { ok: false, reason: "contains credentials" };
  if (target.port !== site.port)
    return { ok: false, reason: `port ${target.port || "default"} is not the site's` };
  if (target.hostname.toLowerCase() !== site.host) {
    return { ok: false, reason: `host ${target.hostname} is not ${site.host}` };
  }
  const underPath =
    site.path === "" ||
    target.pathname === site.path ||
    target.pathname.startsWith(`${site.path}/`);
  if (!underPath) return { ok: false, reason: `not under ${site.path}/` };
  return { ok: true, href: target.href };
};
