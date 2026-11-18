import { describe, expect, it } from "vitest";

import { connect, d, on, READ_ENV, WRITE_ENV } from "#test/helpers";

const ok = [
  on("SubmitUrl", d(null)),
  on("SubmitUrlBatch", d(null)),
  on("FetchUrl", d(null)),
  on("RemoveFeed", d(null)),
];

const urlList = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `https://example.com/p${i}`);

describe("bing_webmaster_submit_urls", () => {
  it("uses SubmitUrl for a single URL", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a"],
    });
    expect(res).toMatchObject({ site: "https://example.com/", submitted: 1, method: "SubmitUrl" });
    expect(h.callsTo("SubmitUrl")[0]?.body).toEqual({
      siteUrl: "https://example.com/",
      url: "https://example.com/a",
    });
    expect(h.callsTo("SubmitUrlBatch")).toHaveLength(0);
  });

  it("uses one SubmitUrlBatch for several, deduplicated after normalizing", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const urls = ["https://example.com/a", "https://example.com/b", "https://EXAMPLE.com/a"];
    const res = await h.call("bing_webmaster_submit_urls", { site: "example.com", urls });
    expect(res).toMatchObject({ submitted: 2, method: "SubmitUrlBatch", duplicates_dropped: 1 });
    expect(h.callsTo("SubmitUrlBatch")).toHaveLength(1);
    expect(h.callsTo("SubmitUrlBatch")[0]?.body).toEqual({
      siteUrl: "https://example.com/",
      urlList: ["https://example.com/a", "https://example.com/b"],
    });
  });

  it("accepts 500 URLs and rejects 501 at the schema", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    expect(
      (await h.call("bing_webmaster_submit_urls", { site: "example.com", urls: urlList(500) }))
        .submitted,
    ).toBe(500);
    const tooMany = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: urlList(501),
    });
    expect(tooMany.isToolError).toBe(true);
    expect(h.callsTo("SubmitUrlBatch")).toHaveLength(1);
  });

  it("sends nothing when any URL belongs to another site", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a", "https://evil.com/b", "https://example.com.evil.com/c"],
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("Nothing was submitted");
    expect((res.foreign_urls as { url: string }[]).map((f) => f.url)).toEqual([
      "https://evil.com/b",
      "https://example.com.evil.com/c",
    ]);
    expect(h.callsTo("SubmitUrl")).toHaveLength(0);
    expect(h.callsTo("SubmitUrlBatch")).toHaveLength(0);
  });

  it("refuses an unknown site before anything is submitted", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "evil.com",
      urls: ["https://evil.com/a"],
    });
    expect(res.isToolError).toBe(true);
    expect(h.callsTo("SubmitUrl")).toHaveLength(0);
  });

  it("surfaces a spent quota with the quota tool as the remedy", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [
        on(
          "SubmitUrl",
          () =>
            new Response(JSON.stringify({ ErrorCode: 13, Message: "NotAllowed" }), { status: 400 }),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a"],
    });
    expect(String(res.remedy)).toContain("bing_webmaster_get_url_submission_quota");
  });
});

describe("the other write tools", () => {
  it("fetch_url posts FetchUrl for the site's own page only", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const res = await h.call("bing_webmaster_fetch_url", {
      site: "example.com",
      url: "https://example.com/a",
    });
    expect(String(res.next_step)).toContain("bing_webmaster_get_fetched_url");
    expect(h.callsTo("FetchUrl")[0]).toMatchObject({
      method: "POST",
      body: { siteUrl: "https://example.com/", url: "https://example.com/a" },
    });
    const foreign = await h.call("bing_webmaster_fetch_url", {
      site: "example.com",
      url: "https://other.com/a",
    });
    expect(foreign.isToolError).toBe(true);
    expect(h.callsTo("FetchUrl")).toHaveLength(1);
  });

  it("remove_sitemap requires confirm: true at the schema", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const args = { site: "example.com", sitemap_url: "https://example.com/sitemap.xml" };
    expect((await h.call("bing_webmaster_remove_sitemap", args)).rejected).toBe(true);
    expect(
      (await h.call("bing_webmaster_remove_sitemap", { ...args, confirm: false })).rejected,
    ).toBe(true);
    expect(h.callsTo("RemoveFeed")).toHaveLength(0);
    const res = await h.call("bing_webmaster_remove_sitemap", { ...args, confirm: true });
    expect(res.removed).toBe("https://example.com/sitemap.xml");
    expect(h.callsTo("RemoveFeed")[0]?.body).toEqual({
      siteUrl: "https://example.com/",
      feedUrl: "https://example.com/sitemap.xml",
    });
  });

  it("write tools are absent from tools/list with writes off, not merely refused", async () => {
    const h = await connect(READ_ENV, { routes: ok });
    const names = await h.toolNames();
    for (const tool of [
      "bing_webmaster_submit_urls",
      "bing_webmaster_submit_sitemap",
      "bing_webmaster_remove_sitemap",
      "bing_webmaster_fetch_url",
    ]) {
      expect(names).not.toContain(tool);
    }
    // And a direct call is answered as an unknown tool, with nothing sent.
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a"],
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toMatch(/not found|unknown/i);
    expect(h.calls).toHaveLength(0);
  });

  it("sends the normalized URL, and refuses credentials, another host or another port", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    await h.call("bing_webmaster_fetch_url", {
      site: "example.com",
      url: "https://Example.com/a b",
    });
    expect(h.callsTo("FetchUrl")[0]?.body).toEqual({
      siteUrl: "https://example.com/",
      url: "https://example.com/a%20b",
    });
    for (const url of [
      "https://user:pw@example.com/a",
      "https://example.org/a",
      "https://example.com.evil.com/a",
      "https://example.com:8443/a",
    ]) {
      const res = await h.call("bing_webmaster_submit_urls", { site: "example.com", urls: [url] });
      expect(res.isToolError, url).toBe(true);
    }
    expect(h.callsTo("SubmitUrl")).toHaveLength(0);
  });

  it("submits a subdomain URL for a root site, which Bing files under it (seen live)", async () => {
    const h = await connect(WRITE_ENV, { routes: ok });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://shop.example.com/a"],
    });
    expect(res.isToolError).toBeFalsy();
    expect(h.callsTo("SubmitUrl")[0]?.body).toMatchObject({ url: "https://shop.example.com/a" });
  });
});

describe("bing_webmaster_request gating", () => {
  const routes = [
    on(
      "GetCrawlSettings",
      d({
        __type: "CrawlSettings",
        CrawlBoostEnabled: true,
        Updated: "/Date(1316156400000-0700)/",
      }),
    ),
    on("AddBlockedUrl", d(null)),
  ];

  it("calls a Get* method with writes off, resolving and stamping siteUrl, normalized", async () => {
    const h = await connect(READ_ENV, { routes });
    const res = await h.call("bing_webmaster_request", {
      method_name: "GetCrawlSettings",
      params: { siteUrl: "example.com" },
    });
    expect(res).toMatchObject({
      method: "GetCrawlSettings",
      site: "https://example.com/",
      response: { CrawlBoostEnabled: true, Updated: "2011-09-16" },
    });
    expect(h.callsTo("GetCrawlSettings")[0]?.url.searchParams.get("siteUrl")).toBe(
      "https://example.com/",
    );
  });

  it("refuses a non-Get method with writes off, sending nothing", async () => {
    const h = await connect(READ_ENV, { routes });
    const res = await h.call("bing_webmaster_request", {
      method_name: "AddBlockedUrl",
      body: { siteUrl: "example.com" },
    });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("writes are disabled");
    expect(h.calls).toHaveLength(0);
  });

  it("rejects POST with writes off at the schema", async () => {
    const h = await connect(READ_ENV, { routes });
    const res = await h.call("bing_webmaster_request", {
      method_name: "GetCrawlSettings",
      http: "POST",
    });
    expect(res.rejected).toBe(true);
  });

  it("with writes on, a non-Get method still needs confirm: true", async () => {
    const h = await connect(WRITE_ENV, { routes });
    const body = { siteUrl: "example.com", blockedUrl: { Url: "https://example.com/private" } };
    const refused = await h.call("bing_webmaster_request", { method_name: "AddBlockedUrl", body });
    expect(String(refused.error)).toContain("confirm: true");
    expect(h.callsTo("AddBlockedUrl")).toHaveLength(0);
    const res = await h.call("bing_webmaster_request", {
      method_name: "AddBlockedUrl",
      body,
      confirm: true,
    });
    expect(res).toMatchObject({
      method: "AddBlockedUrl",
      site: "https://example.com/",
      response: null,
    });
    expect(h.callsTo("AddBlockedUrl")[0]).toMatchObject({
      method: "POST",
      body: { siteUrl: "https://example.com/", blockedUrl: { Url: "https://example.com/private" } },
    });
  });

  it("rejects a method name that is not bare PascalCase", async () => {
    const h = await connect(READ_ENV, { routes });
    for (const name of [
      "getUserSites",
      "GetUserSites/../x",
      "GetUserSites?apikey=x",
      "Get_Sites",
      "G",
    ]) {
      expect((await h.call("bing_webmaster_request", { method_name: name })).rejected, name).toBe(
        true,
      );
    }
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an apikey parameter", async () => {
    const h = await connect(READ_ENV, { routes });
    const res = await h.call("bing_webmaster_request", {
      method_name: "GetUserSites",
      params: { ApiKey: "other" },
    });
    expect(String(res.error)).toContain("Do not pass apikey");
    expect(h.calls).toHaveLength(0);
  });

  it("caps a large answer to whole items", async () => {
    const big = Array.from({ length: 500 }, (_, i) => ({
      __type: "BlockedUrl",
      Url: `https://example.com/${"p".repeat(40)}${i}`,
    }));
    const h = await connect(READ_ENV, { routes: [on("GetBlockedUrls", d(big))] });
    const res = await h.call("bing_webmaster_request", {
      method_name: "GetBlockedUrls",
      params: { siteUrl: "example.com" },
      max_chars: 2000,
    });
    expect(res.truncated).toBe(true);
    expect(res.items_total).toBe(500);
    expect((res.response as unknown[]).length).toBeLessThan(500);
  });
});
