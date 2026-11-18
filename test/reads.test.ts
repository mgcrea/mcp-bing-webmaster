import { describe, expect, it } from "vitest";

import { connect, d, on, READ_ENV, wcfDay } from "#test/helpers";

const queryRows = [
  {
    __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
    Query: "bing api",
    Date: wcfDay("2026-11-02"),
    Impressions: 100,
    Clicks: 10,
    AvgImpressionPosition: 3,
    AvgClickPosition: 2,
  },
  {
    __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
    Query: "bing api",
    Date: wcfDay("2026-11-09"),
    Impressions: 300,
    Clicks: 30,
    AvgImpressionPosition: 5,
    AvgClickPosition: 4,
  },
  {
    __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
    Query: "old query",
    Date: wcfDay("2026-01-05"),
    Impressions: 900,
    Clicks: 90,
    AvgImpressionPosition: 1,
    AvgClickPosition: 1,
  },
];

describe("search performance tools", () => {
  it("get_query_stats defaults to the last 28 days and stamps the resolved site", async () => {
    const h = await connect(READ_ENV, { routes: [on("GetQueryStats", d(queryRows))] });
    const text = await h.callText("bing_webmaster_get_query_stats", { site: "example.com" });
    expect(text).not.toContain("__type");
    expect(text).not.toContain("/Date(");
    const res = JSON.parse(text);
    expect(res.site).toBe("https://example.com/");
    expect(res.window).toEqual({ start_date: "2026-10-22", end_date: "2026-11-18" });
    expect(res.rows).toEqual([
      {
        query: "bing api",
        clicks: 40,
        impressions: 400,
        ctr: 0.1,
        position: 4.5,
        click_position: 3.5,
      },
    ]);
    expect(h.callsTo("GetQueryStats")[0]?.url.searchParams.get("siteUrl")).toBe(
      "https://example.com/",
    );
  });

  it("get_query_stats takes an explicit window", async () => {
    const h = await connect(READ_ENV, { routes: [on("GetQueryStats", d(queryRows))] });
    const res = await h.call("bing_webmaster_get_query_stats", {
      site: "example.com",
      start_date: "2026-01-01",
      end_date: "2026-01-31",
    });
    expect((res.rows as { query: string }[]).map((r) => r.query)).toEqual(["old query"]);
  });

  it("refuses a window that ends before it starts, and a malformed date at the schema", async () => {
    const h = await connect(READ_ENV, { routes: [on("GetQueryStats", d(queryRows))] });
    const backwards = await h.call("bing_webmaster_get_query_stats", {
      site: "example.com",
      start_date: "2026-11-10",
      end_date: "2026-11-01",
    });
    expect(String(backwards.error)).toContain("is after end_date");
    const bad = await h.call("bing_webmaster_get_query_stats", {
      site: "example.com",
      start_date: "2026-02-30",
    });
    expect(bad.isToolError).toBe(true);
    expect(h.callsTo("GetQueryStats")).toHaveLength(0);
  });

  it("get_page_stats keys rows by page (Bing puts the URL in `Query`)", async () => {
    const rows = [
      {
        Query: "https://example.com/a",
        Date: wcfDay("2026-11-09"),
        Impressions: 10,
        Clicks: 1,
        AvgImpressionPosition: 2,
      },
    ];
    const h = await connect(READ_ENV, { routes: [on("GetPageStats", d(rows))] });
    const res = await h.call("bing_webmaster_get_page_stats", { site: "example.com" });
    expect(res.rows).toEqual([
      { page: "https://example.com/a", clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
    ]);
  });

  it("get_query_pages and get_page_queries send the query / page parameter", async () => {
    const h = await connect(READ_ENV, {
      routes: [on("GetQueryPageStats", d([])), on("GetPageQueryStats", d([]))],
    });
    const qp = await h.call("bing_webmaster_get_query_pages", {
      site: "example.com",
      query: "bing api",
    });
    expect(qp.query).toBe("bing api");
    expect(h.callsTo("GetQueryPageStats")[0]?.url.searchParams.get("query")).toBe("bing api");
    const pq = await h.call("bing_webmaster_get_page_queries", {
      site: "example.com",
      page: "https://example.com/a",
    });
    expect(pq.page).toBe("https://example.com/a");
    expect(String(pq.note)).toContain("no rows at all");
    expect(h.callsTo("GetPageQueryStats")[0]?.url.searchParams.get("page")).toBe(
      "https://example.com/a",
    );
  });

  it("get_traffic_summary returns totals and a series", async () => {
    const rows = [
      { Date: wcfDay("2026-11-16"), Clicks: 3, Impressions: 30 },
      { Date: wcfDay("2026-11-17"), Clicks: 1, Impressions: 10 },
    ];
    const h = await connect(READ_ENV, { routes: [on("GetRankAndTrafficStats", d(rows))] });
    const res = await h.call("bing_webmaster_get_traffic_summary", {
      site: "example.com",
      interval: "week",
    });
    expect(res.totals).toEqual({ clicks: 4, impressions: 40, ctr: 0.1 });
    expect(res.granularity).toBe("daily");
    expect(res.series).toEqual([{ date: "2026-11-16", clicks: 4, impressions: 40, ctr: 0.1 }]);
  });
});

describe("index and crawl tools", () => {
  it("get_url_info shapes UrlInfo and converts its timestamps", async () => {
    const info = {
      __type: "UrlInfo:#Microsoft.Bing.Webmaster.Api",
      AnchorCount: 50,
      DiscoveryDate: "/Date(1315349995266-0700)/",
      DocumentSize: 0,
      HttpStatus: 200,
      IsPage: true,
      LastCrawledDate: "/Date(1316213995266-0700)/",
      TotalChildUrlCount: 100,
      Url: "https://example.com/a",
    };
    const h = await connect(READ_ENV, { routes: [on("GetUrlInfo", d(info))] });
    const res = await h.call("bing_webmaster_get_url_info", {
      site: "example.com",
      url: "https://example.com/a",
    });
    expect(res).toMatchObject({
      site: "https://example.com/",
      url: "https://example.com/a",
      http_status: 200,
      is_page: true,
      discovery_date: "2011-09-06T15:59:55.266-07:00",
      last_crawled_date: "2011-09-16T15:59:55.266-07:00",
      anchor_count: 50,
    });
  });

  it("get_fetched_url lists without a url and details with one", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetFetchedUrls",
          d([{ Url: "https://example.com/a", Date: wcfDay("2026-11-17"), Status: "Success" }]),
        ),
        on(
          "GetFetchedUrlDetails",
          d({
            Url: "https://example.com/a",
            Document: "<html>".padEnd(3000, "x"),
            Headers: "HTTP/1.1 200 OK",
            Status: "Success",
          }),
        ),
      ],
    });
    const list = await h.call("bing_webmaster_get_fetched_url", { site: "example.com" });
    expect(list.fetched).toEqual([
      { url: "https://example.com/a", date: "2026-11-17", status: "Success" },
    ]);
    const one = await h.call("bing_webmaster_get_fetched_url", {
      site: "example.com",
      url: "https://example.com/a",
    });
    expect(one).toMatchObject({
      document_length: 3000,
      document_truncated: true,
      headers: "HTTP/1.1 200 OK",
    });
    expect(String(one.document)).toHaveLength(2000);
  });

  it("get_crawl_issues decodes flags and groups by issue", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetCrawlIssues",
          d([
            {
              __type: "UrlWithCrawlIssues",
              HttpCode: 200,
              Issues: 32,
              Url: "https://example.com/x",
              InLinks: 10,
            },
          ]),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_get_crawl_issues", { site: "example.com" });
    expect(res.by_issue).toEqual({ ContainsMalware: 1 });
    expect(res.urls).toEqual([
      { url: "https://example.com/x", http_code: 200, issues: ["ContainsMalware"], in_links: 10 },
    ]);
  });

  it("get_crawl_stats totals the window", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetCrawlStats",
          d([{ Date: wcfDay("2026-11-10"), CrawledPages: 7, InIndex: 3, InLinks: 1 }]),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_get_crawl_stats", { site: "example.com" });
    expect(res.totals).toMatchObject({ crawled_pages: 7 });
    expect(res.index).toEqual({
      in_index: { first: 3, last: 3, change: 0 },
      in_links: { first: 1, last: 1, change: 0 },
    });
  });

  it("list_sitemaps and get_sitemap shape Feed rows", async () => {
    const feed = {
      __type: "Feed",
      Compressed: false,
      FileSize: 1024,
      LastCrawled: "/Date(1315781995040-0700)/",
      Status: "Success",
      Submitted: "/Date(1316213995040-0700)/",
      Type: "Sitemap",
      Url: "https://example.com/sitemap.xml",
      UrlCount: 1023,
    };
    const h = await connect(READ_ENV, {
      routes: [on("GetFeeds", d([feed])), on("GetFeedDetails", d([feed]))],
    });
    const list = await h.call("bing_webmaster_list_sitemaps", { site: "example.com" });
    expect(list.sitemaps).toEqual([
      {
        url: "https://example.com/sitemap.xml",
        type: "Sitemap",
        status: "Success",
        url_count: 1023,
        file_size: 1024,
        compressed: false,
        submitted: "2011-09-16T15:59:55.040-07:00",
        last_crawled: "2011-09-11T15:59:55.040-07:00",
      },
    ]);
    await h.call("bing_webmaster_get_sitemap", {
      site: "example.com",
      sitemap_url: "https://example.com/sitemap.xml",
    });
    expect(h.callsTo("GetFeedDetails")[0]?.url.searchParams.get("feedUrl")).toBe(
      "https://example.com/sitemap.xml",
    );
  });
});

describe("link tools", () => {
  it("get_link_counts pages from 0 and says where the next page is", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetLinkCounts",
          d({
            __type: "LinkCounts",
            Links: [{ __type: "LinkCount", Count: 14, Url: "https://example.com/p" }],
            TotalPages: 3,
          }),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_get_link_counts", { site: "example.com" });
    expect(res).toMatchObject({
      page: 0,
      total_pages: 3,
      next_page: 1,
      links: [{ url: "https://example.com/p", inbound_links: 14 }],
    });
    expect(h.callsTo("GetLinkCounts")[0]?.url.searchParams.get("page")).toBe("0");
  });

  it("get_url_links sends the page as `link` and stops paging at the end", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetUrlLinks",
          d({ Details: [{ AnchorText: "link", Url: "https://other.com/x" }], TotalPages: 3 }),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_get_url_links", {
      site: "example.com",
      url: "https://example.com/p",
      page: 2,
    });
    expect(res.next_page).toBeUndefined();
    expect(res.links).toEqual([{ from_url: "https://other.com/x", anchor_text: "link" }]);
    expect(h.callsTo("GetUrlLinks")[0]?.url.searchParams.get("link")).toBe("https://example.com/p");
  });
});

describe("keyword tools", () => {
  it("get_keyword_stats sends empty country/language for all markets and needs no site", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetKeywordStats",
          d([
            {
              __type: "KeywordStats",
              BroadImpressions: 1397,
              Date: "/Date(1720854000000)/",
              Impressions: 597,
              Query: "dog beds",
            },
            {
              __type: "KeywordStats",
              BroadImpressions: 1354,
              Date: "/Date(1721458800000)/",
              Impressions: 606,
              Query: "dog beds",
            },
          ]),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_get_keyword_stats", { query: "dog beds" });
    expect(res).toMatchObject({
      query: "dog beds",
      country: "all",
      granularity: "weekly",
      totals: { impressions: 1203, broad_impressions: 2751 },
      series: [
        { date: "2024-07-13", impressions: 597, broad_impressions: 1397 },
        { date: "2024-07-20", impressions: 606, broad_impressions: 1354 },
      ],
    });
    const params = h.callsTo("GetKeywordStats")[0]?.url.searchParams;
    expect(params?.get("q")).toBe("dog beds");
    expect(params?.get("country")).toBe("");
    expect(params?.get("language")).toBe("");
    expect(h.callsTo("GetUserSites")).toHaveLength(0);
  });

  it("get_related_keywords sends the market and window, and ranks by impressions", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on(
          "GetRelatedKeywords",
          d([
            { Query: "dog bed large", Impressions: 10, BroadImpressions: 20 },
            { Query: "orthopedic dog bed", Impressions: 50, BroadImpressions: 60 },
          ]),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_get_related_keywords", {
      query: "dog beds",
      country: "be",
      language: "nl-BE",
      limit: 1,
    });
    expect(res.window).toEqual({ start_date: "2026-08-21", end_date: "2026-11-18" });
    expect(res.keywords).toEqual([
      { query: "orthopedic dog bed", impressions: 50, broad_impressions: 60 },
    ]);
    expect(res.truncated).toBe(true);
    const params = h.callsTo("GetRelatedKeywords")[0]?.url.searchParams;
    expect(Object.fromEntries(params?.entries() ?? [])).toMatchObject({
      q: "dog beds",
      country: "be",
      language: "nl-BE",
      startDate: "2026-08-21",
      endDate: "2026-11-18",
    });
  });

  it("rejects a malformed market at the schema", async () => {
    const h = await connect(READ_ENV);
    const res = await h.call("bing_webmaster_get_keyword_stats", { query: "x", country: "USA" });
    expect(res.isToolError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});
