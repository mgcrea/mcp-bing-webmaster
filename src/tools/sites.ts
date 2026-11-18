import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { shapeQuota, shapeSite } from "#/client/shape";
import { limitArg, run, runForSite, siteArg } from "#/tools/util";

export const registerSiteTools = (server: McpServer, client: BingWebmasterClient): void => {
  server.registerTool(
    "bing_webmaster_list_sites",
    {
      title: "Bing Webmaster: List Sites",
      description:
        "Every site the API key's user has added to Bing Webmaster Tools, in its registered form " +
        "(scheme and trailing slash as Bing stores them), with whether it is verified. Unverified " +
        "sites carry their verification codes. Every other tool takes one of these as `site`; " +
        "data calls on an unverified site fail with NotAuthorized.",
      inputSchema: z.object({ limit: limitArg(1000, 100, "sites") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }, req) =>
      run(req, client, async () => {
        const sites = await client.sites({ fresh: true });
        const shown = sites.slice(0, limit);
        return {
          total: sites.length,
          returned: shown.length,
          ...(sites.length > shown.length
            ? {
                truncated: true,
                note: `Showing ${shown.length} of ${sites.length}; raise limit for more.`,
              }
            : {}),
          sites: shown.map(shapeSite),
        };
      }),
  );

  server.registerTool(
    "bing_webmaster_get_url_submission_quota",
    {
      title: "Bing Webmaster: Get URL Submission Quota",
      description:
        "How many URLs the site may still submit through bing_webmaster_submit_urls: today " +
        "(daily_quota) and this month (monthly_quota). The quota is per site and Bing sets it by " +
        "the site's age and standing, so it differs between sites. Check it before a large " +
        "submission: Bing caps a batch at what is left, so a bigger one fails.",
      inputSchema: z.object({ site: siteArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site }, req) =>
      runForSite(req, client, site, async (siteUrl) =>
        shapeQuota(await client.get("GetUrlSubmissionQuota", { siteUrl })),
      ),
  );
};
