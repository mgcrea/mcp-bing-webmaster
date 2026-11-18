import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { PreconditionError } from "#/client/errors";
import { resolveWindow, summarizeKeywordStats, summarizeRelatedKeywords } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  countryArg,
  dayArg,
  endDateArg,
  languageArg,
  limitArg,
  run,
  startDateArg,
} from "#/tools/util";

const RELATED_DEFAULT_DAYS = 90;

const keywordArg = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The keyword, e.g. "dog beds". Matched as typed; Bing does not stem it.');

const MARKET_NOTE =
  "This is Bing-wide search demand, not your site's traffic, so it takes no site. Impressions " +
  "count searches for exactly this keyword (strict match); broad_impressions add close variants.";

export const registerKeywordTools = (
  server: McpServer,
  client: BingWebmasterClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "bing_webmaster_get_keyword_stats",
    {
      title: "Bing Webmaster: Get Keyword Stats",
      description:
        "Keyword research: how often a keyword was searched on Bing, as a weekly series (about six " +
        "months of history) with totals over the window. " +
        MARKET_NOTE +
        " A keyword with too little volume in the market returns no rows rather than zeros. For " +
        "ideas around a keyword, use bing_webmaster_get_related_keywords.",
      inputSchema: z.object({
        query: keywordArg,
        country: countryArg,
        language: languageArg,
        start_date: startDateArg("Defaults to the oldest week Bing returns."),
        end_date: dayArg(
          "Last day to keep, inclusive, YYYY-MM-DD. Defaults to the newest week Bing returns.",
        ).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, country, language, start_date, end_date }, req) =>
      run(req, client, async () => ({
        query,
        country: country ?? "all",
        language: language ?? "all",
        ...summarizeKeywordStats(
          // Country and language are required parameters that may be empty:
          // empty means every market.
          await client.get("GetKeywordStats", {
            q: query,
            country: country ?? "",
            language: language ?? "",
          }),
          { start: start_date, end: end_date },
        ),
      })),
  );

  server.registerTool(
    "bing_webmaster_get_related_keywords",
    {
      title: "Bing Webmaster: Get Related Keywords",
      description:
        "Keyword research: keywords related to one keyword, with how often each was searched on " +
        "Bing over a date window, most searched first. " +
        MARKET_NOTE +
        " Use it to find the phrasing people actually search for before writing or retitling a page.",
      inputSchema: z.object({
        query: keywordArg,
        country: countryArg,
        language: languageArg,
        start_date: startDateArg(`Defaults to ${RELATED_DEFAULT_DAYS} days before end_date.`),
        end_date: endDateArg,
        limit: limitArg(500, 50, "keywords"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, country, language, start_date, end_date, limit }, req) =>
      run(req, client, async () => {
        const window = resolveWindow({ start_date, end_date }, ctx.today(), RELATED_DEFAULT_DAYS);
        if (window.start > window.end) {
          throw new PreconditionError(
            `start_date ${window.start} is after end_date ${window.end}.`,
          );
        }
        // Dates go as plain YYYY-MM-DD: WCF's query-string converter parses an
        // ISO date for a DateTime parameter. Not live-verified — see README.
        const payload = await client.get("GetRelatedKeywords", {
          q: query,
          country: country ?? "",
          language: language ?? "",
          startDate: window.start,
          endDate: window.end,
        });
        return {
          query,
          country: country ?? "all",
          language: language ?? "all",
          window: { start_date: window.start, end_date: window.end },
          ...summarizeRelatedKeywords(payload, limit),
        };
      }),
  );
};
