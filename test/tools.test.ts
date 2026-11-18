import { describe, expect, it } from "vitest";

import { API_KEY, bingError, connect, READ_ENV, SITES, WRITE_ENV } from "#test/helpers";

const AUTH_TOOLS = ["bing_webmaster_auth_status"];
const READ_TOOLS = [
  "bing_webmaster_get_crawl_issues",
  "bing_webmaster_get_crawl_stats",
  "bing_webmaster_get_fetched_url",
  "bing_webmaster_get_keyword_stats",
  "bing_webmaster_get_link_counts",
  "bing_webmaster_get_page_queries",
  "bing_webmaster_get_page_stats",
  "bing_webmaster_get_query_pages",
  "bing_webmaster_get_query_stats",
  "bing_webmaster_get_related_keywords",
  "bing_webmaster_get_sitemap",
  "bing_webmaster_get_traffic_summary",
  "bing_webmaster_get_url_info",
  "bing_webmaster_get_url_links",
  "bing_webmaster_get_url_submission_quota",
  "bing_webmaster_list_sitemaps",
  "bing_webmaster_list_sites",
  "bing_webmaster_request",
];
const WRITE_TOOLS = [
  "bing_webmaster_fetch_url",
  "bing_webmaster_remove_sitemap",
  "bing_webmaster_submit_sitemap",
  "bing_webmaster_submit_urls",
];

describe("with no credentials configured", () => {
  // The regression that produces "MCP error -32000: Connection closed": a server
  // that exits on startup takes the credential-free tools with it and leaves no
  // way to discover what to configure.
  it("still connects, and serves only bing_webmaster_auth_status", async () => {
    expect(await (await connect({})).toolNames()).toEqual(AUTH_TOOLS);
  });

  it("answers bing_webmaster_auth_status as a setup guide", async () => {
    const h = await connect({});
    const res = await h.call("bing_webmaster_auth_status");
    expect(res.configured).toBe(false);
    const setup = (res.setup as string[]).join(" ");
    expect(setup).toContain("BING_WEBMASTER_API_KEY");
    expect(setup).toContain("https://www.bing.com/webmasters");
    expect(setup).toContain("API Access");
    expect(setup).toContain("Google Search Console");
    expect(h.calls).toHaveLength(0);
  });

  it("ignores writes without a key: still only the auth tool", async () => {
    expect(await (await connect({ BING_WEBMASTER_ALLOW_WRITES: "1" })).toolNames()).toEqual(
      AUTH_TOOLS,
    );
  });
});

describe("tool registration matrix", () => {
  it("registers the auth and read tools with a key and writes off", async () => {
    expect(await (await connect(READ_ENV)).toolNames()).toEqual(
      [...AUTH_TOOLS, ...READ_TOOLS].toSorted(),
    );
  });

  it("adds exactly the write tools with BING_WEBMASTER_ALLOW_WRITES=1", async () => {
    expect(await (await connect(WRITE_ENV)).toolNames()).toEqual(
      [...AUTH_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS].toSorted(),
    );
  });

  it("treats BING_WEBMASTER_ALLOW_WRITES=0 as off", async () => {
    const names = await (
      await connect({ ...READ_ENV, BING_WEBMASTER_ALLOW_WRITES: "0" })
    ).toolNames();
    expect(names).toEqual([...AUTH_TOOLS, ...READ_TOOLS].toSorted());
  });

  // A flag can widen a tool instead of adding one: the name matrix cannot see that.
  it("narrows bing_webmaster_request to GET and no confirm when writes are off", async () => {
    const tool = await (await connect(READ_ENV)).tool("bing_webmaster_request");
    const props = (tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(props.http?.enum).toEqual(["GET"]);
    expect(props.confirm).toBeUndefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("widens bing_webmaster_request to POST with confirm when writes are on", async () => {
    const tool = await (await connect(WRITE_ENV)).tool("bing_webmaster_request");
    const props = (tool?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(props.http?.enum).toEqual(["GET", "POST"]);
    expect(props.confirm).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

/**
 * The contract every tool owes the model, enforced mechanically.
 *
 * These are cheap and they fail the moment a new tool forgets one, which is the
 * only time anyone would notice: a missing `.describe()` is invisible in review
 * and invisible at runtime, and simply makes the model guess.
 */
describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    // `title` is what a host renders in its permission dialog, so a bare
    // "Cancel Order" re-creates the cross-server collision the name prefix
    // exists to prevent.
    const tools = (await (await connect(WRITE_ENV)).client.listTools()).tools;
    expect(tools.length).toBe(AUTH_TOOLS.length + READ_TOOLS.length + WRITE_TOOLS.length);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeDefined();
      expect(tool.title, tool.name).toMatch(/^Bing Webmaster: /);
    }
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    for (const tool of (await (await connect(WRITE_ENV)).client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool, and marks the destructive ones", async () => {
    const tools = (await (await connect(WRITE_ENV)).client.listTools()).tools;
    for (const tool of tools) expect(tool.annotations, tool.name).toBeDefined();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.bing_webmaster_remove_sitemap).toMatchObject({ destructiveHint: true });
    expect(byName.bing_webmaster_submit_urls).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    for (const name of READ_TOOLS.filter((n) => n !== "bing_webmaster_request")) {
      expect(byName[name], name).toMatchObject({ readOnlyHint: true });
    }
  });
});

describe("bing_webmaster_auth_status with a key", () => {
  it("lists the sites the key reaches, with their count (rule 11)", async () => {
    const res = await (await connect(READ_ENV)).call("bing_webmaster_auth_status");
    expect(res).toMatchObject({
      configured: true,
      key_accepted: true,
      sites_reachable: 2,
      sites: [
        { url: "https://example.com/", verified: true },
        { url: "http://blog.example.org", verified: false },
      ],
    });
    expect(String(res.writes)).toMatch(/^disabled/);
  });

  it("reports a rejected key as data, with the remedy and setup steps", async () => {
    const h = await connect(READ_ENV, { routes: [() => bingError(3, "InvalidApiKey")] });
    const res = await h.call("bing_webmaster_auth_status");
    expect(res.isToolError).toBe(false);
    expect(res.key_accepted).toBe(false);
    expect(String(res.error)).toContain("InvalidApiKey");
    expect(String(res.remedy)).toContain("API Access");
    expect(res.setup).toBeDefined();
  });

  it("says ENABLED when writes are on", async () => {
    const res = await (await connect(WRITE_ENV)).call("bing_webmaster_auth_status");
    expect(String(res.writes)).toMatch(/^ENABLED/);
  });
});

describe("bing_webmaster_list_sites", () => {
  it("strips __type and keeps verification codes only for unverified sites", async () => {
    const h = await connect(READ_ENV);
    const text = await h.callText("bing_webmaster_list_sites");
    expect(text).not.toContain("__type");
    const res = JSON.parse(text);
    expect(res.total).toBe(2);
    expect(res.sites[0]).toEqual({ url: "https://example.com/", verified: true });
    expect(res.sites[1]).toEqual({
      url: "http://blog.example.org",
      verified: false,
      verification: { meta_tag_or_xml_file_code: "AAAA", dns_cname: "aaaa.blog.example.org" },
    });
    expect(SITES).toHaveLength(2);
  });

  it("sends the key as the apikey query parameter on a GET", async () => {
    const h = await connect(READ_ENV);
    await h.call("bing_webmaster_list_sites");
    const call = h.callsTo("GetUserSites")[0];
    expect(call?.method).toBe("GET");
    expect(String(call?.url).split("?")[0]).toBe(
      "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites",
    );
    expect(call?.url.searchParams.get("apikey")).toBe(API_KEY);
  });
});
