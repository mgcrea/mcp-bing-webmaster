import { describe, expect, it } from "vitest";

import { createRedactor } from "#/client/auth";
import { parseBingError, remedyForCode } from "#/client/errors";
import {
  API_KEY,
  bingError,
  connect,
  d,
  jsonResponse,
  on,
  READ_ENV,
  WRITE_ENV,
} from "#test/helpers";

const quotaTool = (h: Awaited<ReturnType<typeof connect>>) =>
  h.call("bing_webmaster_get_url_submission_quota", { site: "example.com" });

describe("parseBingError", () => {
  it("reads the documented body", () => {
    expect(parseBingError({ ErrorCode: 3, Message: "InvalidApiKey" })).toEqual({
      code: 3,
      codeName: "InvalidApiKey",
      message: "InvalidApiKey",
    });
  });

  it("tolerates a d-wrapped body, a code sent by name or as a string, and a name in Message only", () => {
    expect(parseBingError({ d: { ErrorCode: 14, Message: "x" } }).codeName).toBe("NotAuthorized");
    expect(parseBingError({ ErrorCode: "ThrottleUser" }).code).toBe(4);
    expect(parseBingError({ ErrorCode: "7" }).codeName).toBe("InvalidUrl");
    expect(parseBingError({ Message: "NotAllowed" })).toMatchObject({
      code: 13,
      codeName: "NotAllowed",
    });
    expect(parseBingError("<html>bad gateway</html>")).toEqual({
      code: undefined,
      codeName: undefined,
      message: undefined,
    });
  });

  it("has a remedy for every code a caller can act on", () => {
    for (const name of [
      "InvalidApiKey",
      "ThrottleUser",
      "InvalidUrl",
      "NotAuthorized",
      "UserNotFound",
      "Deprecated",
      "NotAllowed",
      "NotFound",
    ]) {
      expect(remedyForCode(name), name).toBeTruthy();
    }
  });
});

const broken = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200 },
  );

describe("error mapping", () => {
  it("maps ErrorCode to its name and remedy, keyed on the method, not the URL", async () => {
    const h = await connect(READ_ENV, {
      routes: [on("GetUrlSubmissionQuota", bingError(14, "NotAuthorized"))],
    });
    const res = await quotaTool(h);
    expect(res.isToolError).toBe(true);
    expect(res.error).toBe("GetUrlSubmissionQuota failed: HTTP 400 NotAuthorized");
    expect(res.error_code).toBe("NotAuthorized");
    expect(res.method).toBe("GetUrlSubmissionQuota");
    expect(String(res.remedy)).toContain("bing_webmaster_list_sites");
  });

  it("keeps Bing's message when it says more than the code", async () => {
    const h = await connect(READ_ENV, {
      routes: [on("GetUrlSubmissionQuota", bingError(8, "Parameter siteUrl is invalid"))],
    });
    const res = await quotaTool(h);
    expect(res.error).toBe(
      "GetUrlSubmissionQuota failed: HTTP 400 InvalidParameter — Parameter siteUrl is invalid",
    );
  });

  it("falls back to an HTTP-status remedy for a body with no code (WCF's 404 for an unknown method)", async () => {
    const h = await connect(READ_ENV, {
      routes: [on("GetNothing", new Response("<html>Endpoint not found.</html>", { status: 404 }))],
    });
    const res = await h.call("bing_webmaster_request", { method_name: "GetNothing" });
    expect(res.error).toBe("GetNothing failed: HTTP 404");
    expect(String(res.remedy)).toContain("case-sensitive");
    expect(res.details).toContain("Endpoint not found");
  });

  it("does not retry a rejected key: it is final", async () => {
    const h = await connect(READ_ENV, { routes: [() => bingError(3, "InvalidApiKey")] });
    await h.call("bing_webmaster_list_sites");
    expect(h.calls).toHaveLength(1);
  });

  it("retries a GET on a throttle and on a 5xx, then succeeds", async () => {
    let n = 0;
    const flaky = on("GetUrlSubmissionQuota", () =>
      n++ === 0
        ? bingError(4, "ThrottleUser")
        : n === 2
          ? jsonResponse("oops", { status: 503 })
          : d({ DailyQuota: 1, MonthlyQuota: 2 }),
    );
    const h = await connect(READ_ENV, { routes: [flaky] });
    const res = await quotaTool(h);
    expect(res).toMatchObject({ daily_quota: 1, monthly_quota: 2 });
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(3);
  });

  it("gives up after BING_WEBMASTER_MAX_RETRIES", async () => {
    const h = await connect(
      { ...READ_ENV, BING_WEBMASTER_MAX_RETRIES: "2" },
      { routes: [on("GetUrlSubmissionQuota", jsonResponse("down", { status: 500 }))] },
    );
    const res = await quotaTool(h);
    expect(res.status).toBe(500);
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(3);
  });

  it("never retries a POST on a 5xx — it may have been applied, and would spend quota twice", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [on("SubmitUrl", jsonResponse("x", { status: 502 }))],
    });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a"],
    });
    expect(res.isToolError).toBe(true);
    expect(h.callsTo("SubmitUrl")).toHaveLength(1);
  });

  // A retry here could race the model's own retry and submit twice, so a
  // POST is never retried in-process — the error says when to try again.
  it("never retries a POST on a throttle either, and says when to retry", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [
        on("SubmitUrl", () =>
          jsonResponse(
            { ErrorCode: 4, Message: "ThrottleUser" },
            { status: 400, headers: { "Retry-After": "20" } },
          ),
        ),
      ],
    });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a"],
    });
    expect(h.callsTo("SubmitUrl")).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(res.error).toBe("SubmitUrl failed: HTTP 400 ThrottleUser; retry after 20 s");
    expect(String(res.remedy)).toContain("retry after 20 s");
  });

  it("never retries a POST after a network error, and says it may have been applied", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [
        on("SubmitUrlBatch", () => {
          throw new TypeError("fetch failed");
        }),
      ],
    });
    const res = await h.call("bing_webmaster_submit_urls", {
      site: "example.com",
      urls: ["https://example.com/a", "https://example.com/b"],
    });
    expect(h.callsTo("SubmitUrlBatch")).toHaveLength(1);
    expect(String(res.remedy)).toContain("may have been applied");
    expect(String(res.remedy)).toContain("bing_webmaster_get_url_submission_quota");
  });

  it("gives a POST 5xx the may-have-been-applied remedy, a GET 5xx the retry one", async () => {
    const h = await connect(WRITE_ENV, {
      routes: [
        on("SubmitFeed", jsonResponse("x", { status: 503 })),
        on("GetFeeds", jsonResponse("x", { status: 503 })),
      ],
    });
    const post = await h.call("bing_webmaster_submit_sitemap", {
      site: "example.com",
      sitemap_url: "https://example.com/sitemap.xml",
    });
    expect(String(post.remedy)).toContain("may have been applied");
    const get = await h.call("bing_webmaster_list_sitemaps", { site: "example.com" });
    expect(String(get.remedy)).not.toContain("may have been applied");
  });

  it("honours a short Retry-After on a GET", async () => {
    let n = 0;
    const h = await connect(READ_ENV, {
      routes: [
        on("GetUrlSubmissionQuota", () =>
          n++ === 0
            ? jsonResponse("busy", { status: 429, headers: { "Retry-After": "2" } })
            : d({ DailyQuota: 1, MonthlyQuota: 2 }),
        ),
      ],
    });
    expect(await quotaTool(h)).toMatchObject({ daily_quota: 1 });
    expect(h.sleeps).toEqual([2000]);
  });

  it("fails at once on a Retry-After longer than 30 s instead of sleeping through it", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on("GetUrlSubmissionQuota", () =>
          jsonResponse(
            { ErrorCode: 4, Message: "ThrottleUser" },
            { status: 400, headers: { "Retry-After": "600" } },
          ),
        ),
      ],
    });
    const res = await quotaTool(h);
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(res.error).toBe(
      "GetUrlSubmissionQuota failed: HTTP 400 ThrottleUser; retry after 600 s",
    );
  });

  it("retries a GET whose body fails mid-stream, and reports it with method and remedy if it persists", async () => {
    let n = 0;
    const h = await connect(READ_ENV, {
      routes: [on("GetUrlSubmissionQuota", () => (n++ === 0 ? broken() : d({ DailyQuota: 3 })))],
    });
    expect(await quotaTool(h)).toMatchObject({ daily_quota: 3 });

    const always = await connect(
      { ...READ_ENV, BING_WEBMASTER_MAX_RETRIES: "0" },
      {
        routes: [on("GetUrlSubmissionQuota", broken)],
      },
    );
    const res = await quotaTool(always);
    expect(res.error).toBe("GetUrlSubmissionQuota failed: no response from Bing (terminated)");
    expect(res.method).toBe("GetUrlSubmissionQuota");
    expect(res.status).toBe(0);
    expect(res.remedy).toBeTruthy();
  });

  it("reports a 200 that is not JSON instead of returning garbage", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on("GetUrlSubmissionQuota", new Response("<html>maintenance</html>", { status: 200 })),
      ],
    });
    const res = await quotaTool(h);
    expect(String(res.error)).toContain("not JSON");
  });
});

describe("the API key never leaves the process", () => {
  it("is in the request URL, and nowhere in a failing call's error text", async () => {
    const h = await connect(READ_ENV, {
      routes: [on("GetUrlSubmissionQuota", bingError(3, `InvalidApiKey: ${API_KEY} is not valid`))],
    });
    const text = await h.callText("bing_webmaster_get_url_submission_quota", {
      site: "example.com",
    });
    expect(h.callsTo("GetUrlSubmissionQuota")[0]?.url.searchParams.get("apikey")).toBe(API_KEY);
    expect(text).toContain("InvalidApiKey");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(API_KEY);
  });

  it("is masked in an unparsed upstream body, raw or URL-encoded", async () => {
    const key = "abc+def/ghi=jkl0123456";
    const page = `<html>GET /json/GetUrlSubmissionQuota?apikey=${encodeURIComponent(key)} — or ${key}</html>`;
    const h = await connect(
      { BING_WEBMASTER_API_KEY: key },
      {
        routes: [on("GetUrlSubmissionQuota", new Response(page, { status: 502 }))],
      },
    );
    const text = await h.callText("bing_webmaster_get_url_submission_quota", {
      site: "example.com",
    });
    expect(text).not.toContain(key);
    expect(text).not.toContain(encodeURIComponent(key));
  });

  it("is not in a network error, even when the thrown error carries the full URL", async () => {
    const h = await connect(READ_ENV, {
      routes: [
        on("GetUrlSubmissionQuota", (call) => {
          throw new TypeError(`fetch failed for ${call.url.toString()}`);
        }),
      ],
    });
    const text = await h.callText("bing_webmaster_get_url_submission_quota", {
      site: "example.com",
    });
    expect(text).toContain("no response from Bing");
    expect(text).not.toContain(API_KEY);
    // A GET is retried on a network error before giving up.
    expect(h.callsTo("GetUrlSubmissionQuota")).toHaveLength(4);
  });

  it("is masked if a success payload ever echoed it", async () => {
    const h = await connect(READ_ENV, { routes: [on("GetCrawlSettings", d({ Echo: API_KEY }))] });
    const text = await h.callText("bing_webmaster_request", {
      method_name: "GetCrawlSettings",
      params: { siteUrl: "example.com" },
    });
    expect(text).not.toContain(API_KEY);
  });

  it("is not masked when shorter than a real key would be (it would mask ordinary text)", () => {
    expect(createRedactor("abc").text("abc abc")).toBe("abc abc");
    expect(createRedactor("secret123").deep({ k: ["x secret123"] })).toEqual({
      k: ["x [REDACTED]"],
    });
  });
});

describe("request shape", () => {
  it("sends a POST to the method's endpoint with the key in the query and a JSON body", async () => {
    const h = await connect(WRITE_ENV, { routes: [on("SubmitFeed", d(null))] });
    await h.call("bing_webmaster_submit_sitemap", {
      site: "example.com",
      sitemap_url: "https://example.com/sitemap.xml",
    });
    const call = h.callsTo("SubmitFeed")[0];
    expect(call?.method).toBe("POST");
    expect(String(call?.url).split("?")[0]).toBe(
      "https://ssl.bing.com/webmaster/api.svc/json/SubmitFeed",
    );
    expect([...(call?.url.searchParams.keys() ?? [])]).toEqual(["apikey"]);
    expect(call?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(call?.body).toEqual({
      siteUrl: "https://example.com/",
      feedUrl: "https://example.com/sitemap.xml",
    });
  });

  it("honours BING_WEBMASTER_API_URL", async () => {
    const h = await connect({
      ...READ_ENV,
      BING_WEBMASTER_API_URL: "https://proxy.example.net/bing/",
    });
    await h.call("bing_webmaster_list_sites");
    expect(String(h.calls[0]?.url).split("?")[0]).toBe(
      "https://proxy.example.net/bing/GetUserSites",
    );
  });
});
