import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { PreconditionError } from "#/client/errors";
import {
  CRAWL_ISSUE_NAMES,
  resolveWindow,
  summarizeCrawlIssues,
  summarizeCrawlStats,
} from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { endDateArg, limitArg, runForSite, siteArg, startDateArg } from "#/tools/util";

const DEFAULT_DAYS = 28;

export const registerCrawlTools = (
  server: McpServer,
  client: BingWebmasterClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "bing_webmaster_get_crawl_stats",
    {
      title: "Bing Webmaster: Get Crawl Stats",
      description:
        "How Bingbot crawled the site over a date window: pages crawled, crawl errors, responses " +
        "by status class (2xx, 301, 302, 4xx, 5xx), robots.txt blocks, malware, DNS failures and " +
        "timeouts, summed over the window; plus pages in the index and inbound links as first/last " +
        "values (those are levels, not counters). Bing keeps about six months of daily rows and " +
        "returns them all in one call; this tool filters them.",
      inputSchema: z.object({
        site: siteArg,
        start_date: startDateArg(`Defaults to ${DEFAULT_DAYS} days before end_date.`),
        end_date: endDateArg,
        include_series: z
          .boolean()
          .default(false)
          .describe("Also return one row per day in the window. Defaults to false (totals only)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, start_date, end_date, include_series }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const window = resolveWindow({ start_date, end_date }, ctx.today(), DEFAULT_DAYS);
        if (window.start > window.end) {
          throw new PreconditionError(
            `start_date ${window.start} is after end_date ${window.end}.`,
          );
        }
        return summarizeCrawlStats(
          await client.get("GetCrawlStats", { siteUrl }),
          window,
          include_series,
        );
      }),
  );

  server.registerTool(
    "bing_webmaster_get_crawl_issues",
    {
      title: "Bing Webmaster: Get Crawl Issues",
      description:
        "The site's URLs with crawl problems, counted by issue type (Code4xx, Code5xx, Code301, " +
        "Code302, BlockedByRobotsTxt, ImportantUrlBlockedByRobotsTxt, ContainsMalware, DnsErrors, " +
        "TimeOutErrors), then the URLs themselves, most-linked first, capped by `limit`. A fixed " +
        "issue can take a few days to drop off Bing's list.",
      inputSchema: z.object({
        site: siteArg,
        issue: z
          .enum(CRAWL_ISSUE_NAMES)
          .optional()
          .describe(
            'Keep only URLs with this issue, e.g. "Code4xx". The counts still cover every URL.',
          ),
        limit: limitArg(500, 50, "URLs"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, issue, limit }, req) =>
      runForSite(req, client, site, async (siteUrl) =>
        summarizeCrawlIssues(await client.get("GetCrawlIssues", { siteUrl }), { issue, limit }),
      ),
  );
};
