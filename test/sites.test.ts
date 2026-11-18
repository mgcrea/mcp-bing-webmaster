import { describe, expect, it } from "vitest";

import type { Site } from "#/client/shape";
import { matchSite, ownUrl, parseSite } from "#/client/sites";
import { connect, d, on, READ_ENV, SITES } from "#test/helpers";

const site = (url: string): Site => ({
  url,
  verified: true,
  authenticationCode: undefined,
  dnsVerificationCode: undefined,
});

const urlOf = (m: ReturnType<typeof matchSite>): string | undefined =>
  m.kind === "match" ? m.site.url : undefined;

describe("matchSite", () => {
  const sites = [
    site("https://example.com/"),
    site("http://shop.example.net"),
    site("https://acme.io/blog/"),
  ];

  it("matches the exact registered string first", () => {
    expect(urlOf(matchSite("https://example.com/", sites))).toBe("https://example.com/");
  });

  it("tolerates a missing scheme, www., a trailing slash and upper case", () => {
    for (const input of [
      "example.com",
      "www.example.com",
      "https://example.com",
      "HTTPS://Example.COM/",
      "https://www.example.com/",
    ]) {
      expect(urlOf(matchSite(input, sites)), input).toBe("https://example.com/");
    }
    expect(urlOf(matchSite("shop.example.net/", sites))).toBe("http://shop.example.net");
    expect(urlOf(matchSite("https://shop.example.net", sites))).toBe("http://shop.example.net");
    expect(urlOf(matchSite("acme.io/blog", sites))).toBe("https://acme.io/blog/");
  });

  it("accepts Search Console's sc-domain: form", () => {
    expect(urlOf(matchSite("sc-domain:example.com", sites))).toBe("https://example.com/");
  });

  it("does not match another path, host, or a parent domain", () => {
    expect(matchSite("acme.io", sites).kind).toBe("none");
    expect(matchSite("example.org", sites).kind).toBe("none");
    expect(matchSite("blog.example.com", sites).kind).toBe("none");
    expect(matchSite("not a site", sites).kind).toBe("none");
  });

  it("refuses to guess between http and https, or www and the apex, without a hint", () => {
    const twins = [site("http://example.com/"), site("https://example.com/")];
    expect(matchSite("example.com", twins).kind).toBe("ambiguous");
    expect(urlOf(matchSite("https://example.com", twins))).toBe("https://example.com/");
    expect(urlOf(matchSite("http://example.com", twins))).toBe("http://example.com/");

    const hosts = [site("https://example.com/"), site("https://www.example.com/")];
    expect(urlOf(matchSite("www.example.com", hosts))).toBe("https://www.example.com/");
    expect(urlOf(matchSite("example.com", hosts))).toBe("https://example.com/");

    const four = [
      site("http://example.com"),
      site("https://example.com"),
      site("http://www.example.com"),
      site("https://www.example.com"),
    ];
    expect(matchSite("example.com", four).kind).toBe("ambiguous");
    expect(urlOf(matchSite("https://www.example.com/", four))).toBe("https://www.example.com");
  });
});

const href = (url: string, siteUrl: string): string | undefined => {
  const r = ownUrl(url, siteUrl);
  return r.ok ? r.href : undefined;
};

describe("matchSite when host and scheme disagree", () => {
  // http://www.example.com/ shares the host, https://example.com/ shares the
  // scheme. Preferring either is a guess, so neither is picked.
  const cross = [site("http://www.example.com/"), site("https://example.com/")];

  it("is ambiguous rather than resolving https://www.example.com to the apex", () => {
    const m = matchSite("https://www.example.com", cross);
    expect(m.kind).toBe("ambiguous");
    expect(m.kind === "ambiguous" ? m.candidates.map((c) => c.url) : []).toEqual([
      "http://www.example.com/",
      "https://example.com/",
    ]);
  });

  it("still resolves the exact forms, and a bare host by host", () => {
    expect(urlOf(matchSite("http://www.example.com", cross))).toBe("http://www.example.com/");
    expect(urlOf(matchSite("https://example.com", cross))).toBe("https://example.com/");
    expect(urlOf(matchSite("www.example.com", cross))).toBe("http://www.example.com/");
  });

  it("follows the host when no candidate shares the scheme", () => {
    const http = [site("http://www.example.com/"), site("http://example.com/")];
    expect(urlOf(matchSite("https://www.example.com", http))).toBe("http://www.example.com/");
  });
});

describe("parseSite / ownUrl", () => {
  it("parses what people type", () => {
    expect(parseSite("Example.com/")).toEqual({
      scheme: undefined,
      host: "example.com",
      path: "",
      port: "",
    });
    expect(parseSite("http://example.com:8080/blog/")).toEqual({
      scheme: "http",
      host: "example.com",
      path: "/blog",
      port: "8080",
    });
    expect(parseSite("localhost")).toBeUndefined();
  });

  it("accepts the site's own pages on either scheme, and returns the normalized href", () => {
    expect(href("https://example.com/a", "https://example.com/")).toBe("https://example.com/a");
    expect(href("http://example.com/a", "https://example.com/")).toBe("http://example.com/a");
    expect(href("https://EXAMPLE.com/a b", "https://example.com/")).toBe(
      "https://example.com/a%20b",
    );
    expect(href("https://example.com:443/a", "https://example.com/")).toBe("https://example.com/a");
    expect(href("https://acme.io/blog/post", "https://acme.io/blog/")).toBe(
      "https://acme.io/blog/post",
    );
    expect(href("https://acme.io/blog", "https://acme.io/blog/")).toBe("https://acme.io/blog");
  });

  it("accepts subdomains of a root site, as Bing files them under it (seen live)", () => {
    expect(href("https://contour.mgcrea.io/", "https://mgcrea.io/")).toBe(
      "https://contour.mgcrea.io/",
    );
    expect(href("http://www.example.com/a", "https://example.com/")).toBe(
      "http://www.example.com/a",
    );
    expect(href("https://a.b.example.com/x", "https://example.com/")).toBe(
      "https://a.b.example.com/x",
    );
    // A subdomain still has to be on the site's port and carry no credentials.
    expect(ownUrl("https://shop.example.com:8443/a", "https://example.com/")).toMatchObject({
      ok: false,
    });
    expect(ownUrl("https://u:p@shop.example.com/a", "https://example.com/")).toMatchObject({
      ok: false,
    });
  });

  it("refuses a parent, a sibling, a look-alike, and subdomains of a path site", () => {
    expect(ownUrl("https://example.com/a", "https://www.example.com/")).toMatchObject({
      ok: false,
    });
    expect(ownUrl("https://shop.example.com/a", "https://www.example.com/")).toMatchObject({
      ok: false,
    });
    expect(ownUrl("https://shop.acme.io/blog/a", "https://acme.io/blog/")).toMatchObject({
      ok: false,
    });
    expect(ownUrl("https://evil.com/a", "https://example.com/")).toMatchObject({ ok: false });
    expect(ownUrl("https://notexample.com/a", "https://example.com/")).toMatchObject({ ok: false });
    expect(ownUrl("https://example.com.evil.com/a", "https://example.com/")).toMatchObject({
      ok: false,
    });
  });

  it("refuses credentials, another port, another path and non-http schemes", () => {
    expect(ownUrl("https://user:pw@example.com/a", "https://example.com/")).toEqual({
      ok: false,
      reason: "contains credentials",
    });
    expect(ownUrl("https://user@example.com/a", "https://example.com/")).toMatchObject({
      ok: false,
    });
    expect(ownUrl("https://example.com:8443/a", "https://example.com/")).toMatchObject({
      ok: false,
    });
    expect(ownUrl("https://acme.io/blogger", "https://acme.io/blog/")).toMatchObject({ ok: false });
    expect(ownUrl("ftp://example.com/a", "https://example.com/")).toMatchObject({ ok: false });
    expect(ownUrl("not a url", "https://example.com/")).toMatchObject({ ok: false });
  });
});

describe("site resolution through a tool", () => {
  const quota = on(
    "GetUrlSubmissionQuota",
    d({ __type: "UrlSubmissionQuota", DailyQuota: 10, MonthlyQuota: 300 }),
  );

  it("sends the registered form and stamps it on the response", async () => {
    const h = await connect(READ_ENV, { routes: [quota] });
    const res = await h.call("bing_webmaster_get_url_submission_quota", {
      site: "www.example.com",
    });
    expect(res).toMatchObject({
      site: "https://example.com/",
      daily_quota: 10,
      monthly_quota: 300,
    });
    expect(h.callsTo("GetUrlSubmissionQuota")[0]?.url.searchParams.get("siteUrl")).toBe(
      "https://example.com/",
    );
  });

  it("caches GetUserSites across calls", async () => {
    const h = await connect(READ_ENV, { routes: [quota] });
    await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    expect(h.callsTo("GetUserSites")).toHaveLength(1);
  });

  it("refetches the cache once after five minutes", async () => {
    let now = Date.parse("2026-11-18T12:00:00Z");
    const h = await connect(READ_ENV, { routes: [quota], now: () => new Date(now) });
    await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    now += 6 * 60_000;
    await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    expect(h.callsTo("GetUserSites")).toHaveLength(2);
  });

  it("refuses an unknown site with the accessible ones, after one fresh look, sending nothing else", async () => {
    const h = await connect(READ_ENV, { routes: [quota] });
    const res = await h.call("bing_webmaster_get_url_submission_quota", { site: "other.com" });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("not one of the 2 site(s)");
    expect(res.accessible_sites).toEqual(SITES.map((s) => s.Url));
    expect(String(res.remedy)).toContain("another account");
    expect(h.callsTo("GetUserSites")).toHaveLength(2);
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(0);
  });

  it("finds a site added since the cache was filled", async () => {
    let answer = 0;
    const sites = on("GetUserSites", () =>
      d(answer++ === 0 ? SITES : [...SITES, { Url: "https://new.example.net/", IsVerified: true }]),
    );
    const h = await connect(READ_ENV, { routes: [sites, quota] });
    await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    const res = await h.call("bing_webmaster_get_url_submission_quota", {
      site: "new.example.net",
    });
    expect(res.site).toBe("https://new.example.net/");
  });

  it("refuses an ambiguous site, listing the candidates", async () => {
    const twins = on(
      "GetUserSites",
      d([{ Url: "http://example.com/" }, { Url: "https://example.com/" }]),
    );
    const h = await connect(READ_ENV, { routes: [twins, quota] });
    const res = await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    expect(res.isToolError).toBe(true);
    expect(res.candidates).toEqual(["http://example.com/", "https://example.com/"]);
  });

  it("says plainly when the key's user has no sites at all", async () => {
    const none = on("GetUserSites", d([]));
    const h = await connect(READ_ENV, { routes: [none] });
    const res = await h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });
    expect(String(res.error)).toContain("has no sites");
  });
});
