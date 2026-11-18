import { describe, expect, it } from "vitest";

import { API_KEY, connect, d, hang, on, READ_ENV, SITES, wcfDay, type Route } from "#test/helpers";

const quota = (h: Awaited<ReturnType<typeof connect>>) =>
  h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });

/** Poll until `cond` holds (or ~250 ms pass): for state set inside a route. */
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
};

const hangOn =
  (api: string): Route =>
  (call) =>
    call.api === api ? hang(call) : undefined;

describe("timeouts, the call deadline and cancellation", () => {
  it("times out one attempt after BING_WEBMASTER_TIMEOUT_MS", async () => {
    const h = await connect(
      { ...READ_ENV, BING_WEBMASTER_TIMEOUT_MS: "1000", BING_WEBMASTER_MAX_RETRIES: "0" },
      { routes: [hangOn("GetUrlSubmissionQuota")] },
    );
    const res = await quota(h);
    expect(res.error).toBe(
      "GetUrlSubmissionQuota failed: no response from Bing (timed out after 1000 ms)",
    );
    expect(h.callsTo("GetUrlSubmissionQuota")[0]?.signal?.aborted).toBe(true);
  });

  it("bounds the whole call, retries included, by the deadline", async () => {
    const h = await connect(READ_ENV, {
      routes: [hangOn("GetUrlSubmissionQuota")],
      callDeadlineMs: 150,
    });
    const started = Date.now();
    const res = await quota(h);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(String(res.error)).toContain("deadline for the whole call passed");
    // No retry is started once the deadline has gone.
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(1);
  });

  it("aborts the in-flight Bing request when the MCP client cancels the tool call", async () => {
    const h = await connect(READ_ENV, { routes: [hangOn("GetUrlSubmissionQuota")] });
    const controller = new AbortController();
    const pending = h.client
      .callTool(
        { name: "bing_webmaster_get_url_submission_quota", arguments: { site: "example.com" } },
        { signal: controller.signal },
      )
      .catch((err: unknown) => err);
    await waitFor(() => h.callsTo("GetUrlSubmissionQuota").length > 0);
    const call = h.callsTo("GetUrlSubmissionQuota")[0];
    expect(call?.signal?.aborted).toBe(false);
    controller.abort();
    await pending;
    await waitFor(() => call?.signal?.aborted === true);
    expect(call?.signal?.aborted).toBe(true);
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(1);
  });

  it("does not let one caller's cancel break the shared GetUserSites fetch for another", async () => {
    let release: (() => void) | undefined;
    const slowSites: Route = (call) =>
      call.api === "GetUserSites"
        ? new Promise<Response>((resolve) => {
            release = () => resolve(d(SITES));
          })
        : undefined;
    const h = await connect(READ_ENV, {
      routes: [slowSites, on("GetUrlSubmissionQuota", d({ DailyQuota: 7 }))],
    });
    const controller = new AbortController();
    const first = h.client
      .callTool(
        { name: "bing_webmaster_get_url_submission_quota", arguments: { site: "example.com" } },
        { signal: controller.signal },
      )
      .catch((err: unknown) => err);
    const second = quota(h);
    await waitFor(() => release !== undefined);
    controller.abort();
    await first;
    release?.();
    expect(await second).toMatchObject({ daily_quota: 7 });
    expect(h.callsTo("GetUserSites")).toHaveLength(1);
    expect(h.callsTo("GetUserSites")[0]?.signal?.aborted).toBe(false);
  });
});

describe("redaction happens before truncation", () => {
  it("leaves no key prefix when a non-JSON body is cut at 300 characters", async () => {
    // The key starts at offset 280: cut first, redact second would leak 20 characters.
    const page = `${"x".repeat(280)}${API_KEY}${"y".repeat(100)}`;
    const h = await connect(READ_ENV, {
      routes: [on("GetUrlSubmissionQuota", new Response(page, { status: 502 }))],
    });
    const text = await h.callText("bing_webmaster_get_url_submission_quota", {
      site: "example.com",
    });
    expect(text).not.toContain(API_KEY.slice(0, 12));
  });

  it("leaves no key prefix when the escape hatch cuts a response at max_chars", async () => {
    const h = await connect(READ_ENV, {
      routes: [on("GetCrawlSettings", d({ Pad: "z".repeat(985), Echo: API_KEY }))],
    });
    const text = await h.callText("bing_webmaster_request", {
      method_name: "GetCrawlSettings",
      max_chars: 1000,
    });
    expect(text).toContain("truncated");
    expect(text).not.toContain(API_KEY.slice(0, 8));
  });
});

describe("bounded lists", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    Url: `https://site${i}.example.net/`,
    IsVerified: true,
  }));
  const manySites = on("GetUserSites", d(many));

  it("list_sites takes a limit and says what it cut", async () => {
    const h = await connect(READ_ENV, { routes: [manySites] });
    const res = await h.call("bing_webmaster_list_sites", { limit: 5 });
    expect(res).toMatchObject({ total: 60, returned: 5, truncated: true });
    expect(res.sites).toHaveLength(5);
  });

  it("an unknown-site error lists at most 20 sites, plus the total", async () => {
    const h = await connect(READ_ENV, { routes: [manySites] });
    const res = await quota(h);
    expect(res.accessible_sites).toHaveLength(20);
    expect(res.accessible_sites_total).toBe(60);
  });

  it("auth_status names at most 50 sites, with the count", async () => {
    const h = await connect(READ_ENV, { routes: [manySites] });
    const res = await h.call("bing_webmaster_auth_status");
    expect(res.sites_reachable).toBe(60);
    expect(res.sites).toHaveLength(50);
    expect(String(res.sites_note)).toContain("50 of 60");
  });
});

describe("auth_status", () => {
  it("is marked open-world, since it calls Bing", async () => {
    const tool = await (await connect(READ_ENV)).tool("bing_webmaster_auth_status");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("reports config values that were clamped, and the server still starts", async () => {
    const h = await connect({
      ...READ_ENV,
      BING_WEBMASTER_TIMEOUT_MS: "5",
      BING_WEBMASTER_API_URL: "http://x.example",
    });
    const res = await h.call("bing_webmaster_auth_status");
    expect(res.configured).toBe(true);
    expect((res.config_warnings as string[]).join(" ")).toContain("BING_WEBMASTER_TIMEOUT_MS=5");
    expect(res.config_warnings).toHaveLength(2);
  });
});

describe("windowed answers say which buckets they kept", () => {
  it("reports the first and last bucket and the rule, for weekly data", async () => {
    const rows = ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"].map((day) => ({
      Query: "q",
      Date: wcfDay(day),
      Impressions: 10,
      Clicks: 1,
    }));
    const h = await connect(READ_ENV, { routes: [on("GetQueryStats", d(rows))] });
    const res = await h.call("bing_webmaster_get_query_stats", { site: "example.com" });
    // Window 2026-10-22..2026-11-18: the bucket dated 10-19 is out, though its week overlaps.
    expect(res.buckets).toMatchObject({ first: "2026-10-26", last: "2026-11-09", count: 3 });
    expect(String((res.buckets as { rule: string }).rule)).toContain("kept whole");
    expect(res.granularity).toBe("weekly");
  });

  it("omits the rule for daily data", async () => {
    const rows = ["2026-11-16", "2026-11-17"].map((day) => ({
      Date: wcfDay(day),
      Clicks: 1,
      Impressions: 2,
    }));
    const h = await connect(READ_ENV, { routes: [on("GetRankAndTrafficStats", d(rows))] });
    const res = await h.call("bing_webmaster_get_traffic_summary", { site: "example.com" });
    expect(res.buckets).toEqual({ first: "2026-11-16", last: "2026-11-17", count: 2 });
  });
});
