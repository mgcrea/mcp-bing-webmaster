import { describe, expect, it } from "vitest";

import {
  aggregateByKey,
  capResponse,
  convertDate,
  decodeCrawlIssues,
  detectGranularity,
  normalizeResponse,
  parseWcfDate,
  readStatsRows,
  resolveWindow,
  shapeFetchedUrl,
  summarizeCrawlIssues,
  summarizeCrawlStats,
  summarizeStats,
  summarizeTraffic,
  readTrafficRows,
  toDay,
  unwrap,
  weekStart,
  type StatsRow,
} from "#/client/shape";
import { wcfDay } from "#test/helpers";

describe("WCF dates", () => {
  it("keeps the offset Bing wrote, so the local day survives (the documented sample)", () => {
    // 1316156400000 is 2011-09-16T07:00:00Z, i.e. midnight Pacific (-07:00).
    expect(convertDate("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(toDay("/Date(1316156400000-0700)/")).toBe("2011-09-16");
  });

  it("keeps time and offset for a timestamp that is not a day bucket", () => {
    expect(convertDate("/Date(1315349995266-0700)/")).toBe("2011-09-06T15:59:55.266-07:00");
    expect(toDay("/Date(1315349995266-0700)/")).toBe("2011-09-06");
  });

  it("reads an offset-less date as UTC", () => {
    expect(convertDate("/Date(1720854000000)/")).toBe("2024-07-13T07:00:00Z");
    expect(toDay("/Date(1720854000000)/")).toBe("2024-07-13");
    expect(convertDate("/Date(1720828800000)/")).toBe("2024-07-13");
  });

  it("handles positive offsets and minutes in the offset", () => {
    // 2026-01-01T00:00+05:30 is 2025-12-31T18:30Z.
    const ms = Date.parse("2025-12-31T18:30:00Z");
    expect(convertDate(`/Date(${ms}+0530)/`)).toBe("2026-01-01");
    expect(parseWcfDate(`/Date(${ms}+0530)/`)).toEqual({ ms, offsetMinutes: 330 });
  });

  it("treats the epoch as a real date", () => {
    expect(convertDate("/Date(0)/")).toBe("1970-01-01");
    expect(convertDate("/Date(0+0000)/")).toBe("1970-01-01");
  });

  it("treats DateTime.MinValue and any negative value as no date", () => {
    expect(convertDate("/Date(-62135596800000)/")).toBeNull();
    expect(convertDate("/Date(-62135596800000-0800)/")).toBeNull();
    expect(convertDate("/Date(-1)/")).toBeNull();
    expect(toDay("/Date(-62135596800000)/")).toBeUndefined();
  });

  it("tolerates a double-escaped form and leaves other strings alone", () => {
    expect(convertDate("\\/Date(1316156400000-0700)\\/")).toBe("2011-09-16");
    expect(convertDate("Date(1316156400000)")).toBe("Date(1316156400000)");
    expect(convertDate("/Date(abc)/")).toBe("/Date(abc)/");
    expect(convertDate("hello")).toBe("hello");
  });

  it("accepts an ISO date where a WCF one was expected", () => {
    expect(toDay("2026-10-05T00:00:00-07:00")).toBe("2026-10-05");
    expect(toDay("2026-10-05")).toBe("2026-10-05");
    expect(toDay(42)).toBeUndefined();
  });
});

describe("the envelope", () => {
  it("unwraps d, and passes an unwrapped payload through", () => {
    expect(unwrap({ d: [1, 2] })).toEqual([1, 2]);
    expect(unwrap({ d: null })).toBeNull();
    expect(unwrap([1, 2])).toEqual([1, 2]);
    expect(unwrap({ d: 1, other: 2 })).toEqual({ d: 1, other: 2 });
  });

  it("strips __type and converts dates at every depth", () => {
    const body = {
      d: {
        __type: "LinkCounts:#Microsoft.Bing.Webmaster.Api",
        Links: [{ __type: "LinkCount:#x", Count: 14, Seen: "/Date(1316156400000-0700)/" }],
        TotalPages: 3,
      },
    };
    expect(normalizeResponse(body)).toEqual({
      Links: [{ Count: 14, Seen: "2011-09-16" }],
      TotalPages: 3,
    });
  });
});

describe("windows and buckets", () => {
  it("defaults to the last N days ending today, inclusive", () => {
    expect(resolveWindow({}, "2026-11-18", 28)).toEqual({ start: "2026-10-22", end: "2026-11-18" });
    expect(resolveWindow({ end_date: "2026-03-01" }, "2026-11-18", 7)).toEqual({
      start: "2026-02-23",
      end: "2026-03-01",
    });
  });

  it("detects daily and weekly buckets from the median gap", () => {
    expect(detectGranularity(["2026-01-01", "2026-01-02", "2026-01-03"])).toBe("daily");
    expect(detectGranularity(["2026-01-05", "2026-01-12", "2026-01-19", "2026-02-02"])).toBe(
      "weekly",
    );
    expect(detectGranularity(["2026-01-01"])).toBeUndefined();
  });

  it("finds the Monday of a week", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-16"); // a Wednesday
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // a Sunday
  });
});

const row = (
  key: string,
  day: string,
  impressions: number,
  clicks: number,
  position?: number,
  clickPosition?: number,
): StatsRow => ({
  key,
  day,
  impressions,
  clicks,
  position,
  clickPosition,
});

describe("aggregation per key", () => {
  it("sums clicks and impressions and weights position by impressions", () => {
    const [agg] = aggregateByKey([
      row("q", "2026-11-02", 2000, 100, 3, 2),
      row("q", "2026-11-09", 2, 0, 80),
    ]);
    // A plain mean would say 41.5; weighted, the big week dominates.
    expect(agg).toEqual({
      key: "q",
      clicks: 100,
      impressions: 2002,
      ctr: 0.05,
      position: 3.1,
      clickPosition: 2,
    });
  });

  it("weights click position by clicks, and ignores Bing's 0 / -1 'no position'", () => {
    const [agg] = aggregateByKey([
      row("q", "2026-11-02", 100, 30, 4, 2),
      row("q", "2026-11-09", 100, 10, 0, 6),
      row("q", "2026-11-16", 100, 0, -1, -1),
    ]);
    expect(agg?.position).toBe(4);
    expect(agg?.clickPosition).toBe(3);
  });

  it("has no position at all when no bucket carried one", () => {
    const [agg] = aggregateByKey([row("q", "2026-11-02", 0, 0, 0, 0)]);
    expect(agg?.position).toBeUndefined();
    expect(agg?.ctr).toBeUndefined();
  });
});

describe("summarizeStats", () => {
  const rows = readStatsRows(
    [
      {
        __type: "QueryStats",
        Query: "alpha",
        Date: wcfDay("2026-10-26"),
        Impressions: 100,
        Clicks: 10,
        AvgImpressionPosition: 2,
        AvgClickPosition: 1.5,
      },
      {
        Query: "alpha",
        Date: wcfDay("2026-11-02"),
        Impressions: 300,
        Clicks: 20,
        AvgImpressionPosition: 4,
        AvgClickPosition: 2,
      },
      {
        Query: "Beta Pricing",
        Date: wcfDay("2026-11-02"),
        Impressions: 1000,
        Clicks: 5,
        AvgImpressionPosition: 9,
      },
      {
        Query: "gamma",
        Date: wcfDay("2026-11-09"),
        Impressions: 50,
        Clicks: 25,
        AvgImpressionPosition: 1,
      },
      // Outside the window: must not count.
      {
        Query: "alpha",
        Date: wcfDay("2026-06-01"),
        Impressions: 99999,
        Clicks: 9999,
        AvgImpressionPosition: 50,
      },
    ],
    (r) => r.Query,
  );
  const window = { start: "2026-10-22", end: "2026-11-18" };

  it("filters to the window, aggregates, and sorts by clicks by default", () => {
    const out = summarizeStats(rows, { window, sortBy: "clicks", limit: 50, keyName: "query" });
    expect(out.window).toEqual({ start_date: "2026-10-22", end_date: "2026-11-18" });
    expect(out.granularity).toBe("weekly");
    expect(out.data_range).toEqual({ first: "2026-06-01", last: "2026-11-09" });
    expect(out.totals).toEqual({ clicks: 60, impressions: 1450, ctr: 0.0414 });
    expect(out.rows).toEqual([
      {
        query: "alpha",
        clicks: 30,
        impressions: 400,
        ctr: 0.075,
        position: 3.5,
        click_position: 1.8,
      },
      { query: "gamma", clicks: 25, impressions: 50, ctr: 0.5, position: 1 },
      { query: "Beta Pricing", clicks: 5, impressions: 1000, ctr: 0.005, position: 9 },
    ]);
    expect(out.truncated).toBeUndefined();
  });

  const keys = (sortBy: "position" | "impressions" | "ctr") =>
    (
      summarizeStats(rows, { window, sortBy, limit: 50, keyName: "query" }).rows as {
        query: string;
      }[]
    ).map((r) => r.query);

  it("sorts by position ascending (best first) and by impressions or ctr descending", () => {
    expect(keys("position")).toEqual(["gamma", "alpha", "Beta Pricing"]);
    expect(keys("impressions")).toEqual(["Beta Pricing", "alpha", "gamma"]);
    expect(keys("ctr")).toEqual(["gamma", "alpha", "Beta Pricing"]);
  });

  it("limits, says so, and filters with contains case-insensitively", () => {
    const out = summarizeStats(rows, { window, sortBy: "clicks", limit: 1, keyName: "query" });
    expect(out.returned).toBe(1);
    expect(out.total_keys).toBe(3);
    expect(out.truncated).toBe(true);
    const filtered = summarizeStats(rows, {
      window,
      sortBy: "clicks",
      limit: 50,
      contains: "PRICING",
      keyName: "page",
    });
    expect(filtered.rows).toEqual([
      { page: "Beta Pricing", clicks: 5, impressions: 1000, ctr: 0.005, position: 9 },
    ]);
  });

  it("explains an empty window instead of reporting zero traffic", () => {
    const out = summarizeStats(rows, {
      window: { start: "2025-01-01", end: "2025-01-31" },
      sortBy: "clicks",
      limit: 50,
      keyName: "query",
    });
    expect(out.rows).toEqual([]);
    expect(String(out.note)).toContain("2026-06-01 to 2026-11-09");
  });

  it("falls back to all-time figures, with a warning, when rows carry no date", () => {
    const undated = readStatsRows([{ Query: "x", Impressions: 5, Clicks: 1 }], (r) => r.Query);
    const out = summarizeStats(undated, { window, sortBy: "clicks", limit: 50, keyName: "query" });
    expect(out.rows).toHaveLength(1);
    expect(String(out.warning)).toContain("no Date");
  });
});

describe("summarizeTraffic", () => {
  const rows = readTrafficRows([
    { Date: wcfDay("2026-11-16"), Clicks: 5, Impressions: 50 },
    { Date: wcfDay("2026-11-17"), Clicks: 7, Impressions: 70 },
    { Date: wcfDay("2026-11-10"), Clicks: 1, Impressions: 10 },
    { Date: wcfDay("2026-01-01"), Clicks: 100, Impressions: 1000 },
  ]);
  const window = { start: "2026-11-10", end: "2026-11-18" };

  it("returns a sorted daily series and totals for the window", () => {
    const out = summarizeTraffic(rows, window, "native");
    expect(out.totals).toEqual({ clicks: 13, impressions: 130, ctr: 0.1 });
    expect(out.series).toEqual([
      { date: "2026-11-10", clicks: 1, impressions: 10, ctr: 0.1 },
      { date: "2026-11-16", clicks: 5, impressions: 50, ctr: 0.1 },
      { date: "2026-11-17", clicks: 7, impressions: 70, ctr: 0.1 },
    ]);
  });

  it("rolls up into Monday-start weeks", () => {
    const out = summarizeTraffic(rows, window, "week");
    expect(out.series).toEqual([
      { date: "2026-11-09", clicks: 1, impressions: 10, ctr: 0.1 },
      { date: "2026-11-16", clicks: 12, impressions: 120, ctr: 0.1 },
    ]);
  });
});

describe("summarizeCrawlStats", () => {
  const payload = [
    {
      Date: wcfDay("2026-11-01"),
      CrawledPages: 10,
      Code2xx: 9,
      Code4xx: 1,
      InIndex: 1000,
      InLinks: 50,
    },
    {
      Date: wcfDay("2026-11-02"),
      CrawledPages: 20,
      Code2xx: 18,
      Code5xx: 2,
      InIndex: 1010,
      InLinks: 48,
    },
    { Date: wcfDay("2026-10-01"), CrawledPages: 999, InIndex: 1 },
  ];

  it("sums the counters, and reports the index levels as first/last/change", () => {
    const out = summarizeCrawlStats(payload, { start: "2026-10-30", end: "2026-11-18" }, false);
    expect(out.buckets).toMatchObject({ first: "2026-11-01", last: "2026-11-02", count: 2 });
    expect(out.totals).toMatchObject({
      crawled_pages: 30,
      code_2xx: 27,
      code_4xx: 1,
      code_5xx: 2,
      dns_failures: 0,
    });
    expect(out.index).toEqual({
      in_index: { first: 1000, last: 1010, change: 10 },
      in_links: { first: 50, last: 48, change: -2 },
    });
    expect(out.series).toBeUndefined();
  });

  it("adds the per-day series on request", () => {
    const out = summarizeCrawlStats(payload, { start: "2026-10-30", end: "2026-11-18" }, true);
    expect((out.series as unknown[])[0]).toMatchObject({ date: "2026-11-01", crawled_pages: 10 });
  });
});

describe("crawl issues", () => {
  it("decodes the [Flags] enum from a number or from names", () => {
    expect(decodeCrawlIssues(32)).toEqual(["ContainsMalware"]);
    expect(decodeCrawlIssues(4 | 8 | 256)).toEqual(["Code4xx", "Code5xx", "TimeOutErrors"]);
    expect(decodeCrawlIssues(0)).toEqual([]);
    expect(decodeCrawlIssues(1024)).toEqual(["Unknown(1024)"]);
    expect(decodeCrawlIssues("Code4xx, Code5xx")).toEqual(["Code4xx", "Code5xx"]);
    expect(decodeCrawlIssues("None")).toEqual([]);
  });

  it("counts by issue, filters, and caps the URL list most-linked first", () => {
    const payload = [
      { Url: "https://example.com/a", HttpCode: 404, Issues: 4, InLinks: 1 },
      { Url: "https://example.com/b", HttpCode: 500, Issues: 8, InLinks: 9 },
      { Url: "https://example.com/c", HttpCode: 404, Issues: 4 | 16, InLinks: 5 },
    ];
    const out = summarizeCrawlIssues(payload, { limit: 2 });
    expect(out.by_issue).toEqual({ Code4xx: 2, Code5xx: 1, BlockedByRobotsTxt: 1 });
    expect((out.urls as { url: string }[]).map((u) => u.url)).toEqual([
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(out.truncated).toBe(true);
    const only = summarizeCrawlIssues(payload, { issue: "Code4xx", limit: 50 });
    expect(only.matching_urls).toBe(2);
    expect(only.total_urls).toBe(3);
  });
});

describe("fetched URL", () => {
  it("cuts the fetched HTML to a preview and says how long it was", () => {
    const out = shapeFetchedUrl(
      { Url: "https://example.com/", Document: "x".repeat(5000), Status: "Success" },
      100,
    );
    expect(out.document).toHaveLength(100);
    expect(out.document_length).toBe(5000);
    expect(out.document_truncated).toBe(true);
    expect(shapeFetchedUrl({ Document: "abc" }, 0).document).toBeUndefined();
  });
});

describe("capResponse", () => {
  it("passes a small response through", () => {
    expect(capResponse({ a: 1 }, 1000)).toEqual({ response: { a: 1 } });
    expect(capResponse(null, 1000)).toEqual({ response: null });
  });

  it("cuts an array to whole items that fit", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    const out = capResponse(items, 1000);
    expect(out.truncated).toBe(true);
    expect(out.items_total).toBe(100);
    const kept = out.response as unknown[];
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(items.slice(0, kept.length + 1)).length).toBeGreaterThan(1000);
  });

  it("cuts anything else as text", () => {
    const out = capResponse({ big: "y".repeat(5000) }, 1000);
    expect(out.total_chars).toBeGreaterThan(5000);
    expect(String(out.response_text)).toHaveLength(1000);
  });
});
