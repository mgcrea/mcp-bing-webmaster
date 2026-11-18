import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { PreconditionError } from "#/client/errors";
import {
  readStatsRows,
  readTrafficRows,
  resolveWindow,
  summarizeStats,
  summarizeTraffic,
  type Rec,
} from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  containsArg,
  endDateArg,
  limitArg,
  pageUrlArg,
  runForSite,
  siteArg,
  sortByArg,
  startDateArg,
} from "#/tools/util";

const DEFAULT_DAYS = 28;

const COST_NOTE =
  "Bing has no date parameter on this method: one call returns the site's whole history, which " +
  "this tool filters to the window, aggregates per key, sorts and cuts. Calling it again with " +
  "another window costs the same single call.";

/** Window args shared by every search-performance tool. */
const windowArgs = {
  start_date: startDateArg(`Defaults to ${DEFAULT_DAYS} days before end_date.`),
  end_date: endDateArg,
};

const checkWindow = (window: { start: string; end: string }): void => {
  if (window.start > window.end) {
    throw new PreconditionError(`start_date ${window.start} is after end_date ${window.end}.`, {
      remedy: "Swap them, or omit start_date for the last 28 days.",
    });
  }
};

/** Rows keyed by page: `Query` holds the URL there, but prefer a real URL field if one appears. */
const pageKey = (row: Rec): unknown => row.Page ?? row.Url ?? row.Query;
const queryKey = (row: Rec): unknown => row.Query;

export const registerTrafficTools = (
  server: McpServer,
  client: BingWebmasterClient,
  ctx: ToolContext,
): void => {
  const windowOf = (args: { start_date?: string | undefined; end_date?: string | undefined }) => {
    const window = resolveWindow(args, ctx.today(), DEFAULT_DAYS);
    checkWindow(window);
    return window;
  };

  server.registerTool(
    "bing_webmaster_get_traffic_summary",
    {
      title: "Bing Webmaster: Get Traffic Summary",
      description:
        "The site's Bing search clicks and impressions over a date window: totals plus a series, " +
        "as Bing reports it (daily) or rolled up by week. Since 2023-03-24 Bing counts every " +
        "vertical here — web, Copilot/chat, news, images, videos. Start here for 'how is the site " +
        "doing on Bing'; then bing_webmaster_get_query_stats or bing_webmaster_get_page_stats for " +
        `the breakdown. ${COST_NOTE}`,
      inputSchema: z.object({
        site: siteArg,
        ...windowArgs,
        interval: z
          .enum(["native", "week"])
          .default("native")
          .describe(
            "native: one point per bucket Bing reports (it documents daily updates for this " +
              "method; granularity in the answer says what came back). week: summed into " +
              "Monday-start weeks, easier to read over months. Defaults to native.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, start_date, end_date, interval }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const window = windowOf({ start_date, end_date });
        const rows = readTrafficRows(await client.get("GetRankAndTrafficStats", { siteUrl }));
        return summarizeTraffic(rows, window, interval);
      }),
  );

  const statsArgs = (keyWhat: string) => ({
    ...windowArgs,
    sort_by: sortByArg,
    limit: limitArg(1000, 50, keyWhat),
  });

  server.registerTool(
    "bing_webmaster_get_query_stats",
    {
      title: "Bing Webmaster: Get Query Stats",
      description:
        "The search queries the site appeared for on Bing over a date window, each with clicks, " +
        "impressions, CTR and average position (impression-weighted across Bing's buckets; " +
        "click_position is weighted by clicks). Bing only reports its top queries, so totals " +
        "here are less than the site's — use bing_webmaster_get_traffic_summary for site totals. " +
        `Bing updates this weekly. ${COST_NOTE}`,
      inputSchema: z.object({
        site: siteArg,
        ...statsArgs("queries"),
        contains: containsArg("queries"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, start_date, end_date, sort_by, limit, contains }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const window = windowOf({ start_date, end_date });
        const rows = readStatsRows(await client.get("GetQueryStats", { siteUrl }), queryKey);
        return summarizeStats(rows, { window, sortBy: sort_by, limit, contains, keyName: "query" });
      }),
  );

  server.registerTool(
    "bing_webmaster_get_page_stats",
    {
      title: "Bing Webmaster: Get Page Stats",
      description:
        "The site's pages that appeared in Bing search over a date window, each with clicks, " +
        "impressions, CTR and average position. Bing only reports its top pages. For the queries " +
        "behind one page, use bing_webmaster_get_page_queries. Bing updates this weekly. " +
        COST_NOTE,
      inputSchema: z.object({
        site: siteArg,
        ...statsArgs("pages"),
        contains: containsArg("page URLs"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, start_date, end_date, sort_by, limit, contains }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const window = windowOf({ start_date, end_date });
        const rows = readStatsRows(await client.get("GetPageStats", { siteUrl }), pageKey);
        return summarizeStats(rows, { window, sortBy: sort_by, limit, contains, keyName: "page" });
      }),
  );

  server.registerTool(
    "bing_webmaster_get_query_pages",
    {
      title: "Bing Webmaster: Get Query Pages",
      description:
        "For one search query, which of the site's pages Bing showed and how each performed " +
        "(clicks, impressions, CTR, position) over a date window. Use it to find the page that " +
        "ranks for a query, or two pages competing for it. " +
        COST_NOTE,
      inputSchema: z.object({
        site: siteArg,
        query: z
          .string()
          .min(1)
          .describe(
            'The search query exactly as bing_webmaster_get_query_stats reports it, e.g. "bing ' +
              'webmaster api". Bing matches it exactly, not as a substring.',
          ),
        ...statsArgs("pages"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, query, start_date, end_date, sort_by, limit }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const window = windowOf({ start_date, end_date });
        const rows = readStatsRows(
          await client.get("GetQueryPageStats", { siteUrl, query }),
          pageKey,
        );
        return {
          query,
          ...summarizeStats(rows, { window, sortBy: sort_by, limit, keyName: "page" }),
        };
      }),
  );

  server.registerTool(
    "bing_webmaster_get_page_queries",
    {
      title: "Bing Webmaster: Get Page Queries",
      description:
        "For one page of the site, the search queries it appeared for on Bing and how each " +
        "performed (clicks, impressions, CTR, position) over a date window. " +
        COST_NOTE,
      inputSchema: z.object({
        site: siteArg,
        page: pageUrlArg(
          "The page, exactly as bing_webmaster_get_page_stats reports it (scheme and trailing slash matter)",
        ),
        ...statsArgs("queries"),
        contains: containsArg("queries"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, page, start_date, end_date, sort_by, limit, contains }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const window = windowOf({ start_date, end_date });
        const rows = readStatsRows(
          await client.get("GetPageQueryStats", { siteUrl, page }),
          queryKey,
        );
        return {
          page,
          ...summarizeStats(rows, { window, sortBy: sort_by, limit, contains, keyName: "query" }),
        };
      }),
  );
};
