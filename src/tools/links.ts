import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { shapeLinkCounts, shapeUrlLinks } from "#/client/shape";
import { pageArg, pageUrlArg, runForSite, siteArg } from "#/tools/util";

export const registerLinkTools = (server: McpServer, client: BingWebmasterClient): void => {
  server.registerTool(
    "bing_webmaster_get_link_counts",
    {
      title: "Bing Webmaster: Get Link Counts",
      description:
        "The site's pages that have inbound links from other sites, with how many each has, one " +
        "page of results at a time (page 0 first; the answer gives total_pages and next_page). " +
        "For who links to one page, and with what anchor text, use bing_webmaster_get_url_links.",
      inputSchema: z.object({ site: siteArg, page: pageArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, page }, req) =>
      runForSite(req, client, site, async (siteUrl) =>
        shapeLinkCounts(await client.get("GetLinkCounts", { siteUrl, page }), page),
      ),
  );

  server.registerTool(
    "bing_webmaster_get_url_links",
    {
      title: "Bing Webmaster: Get URL Links",
      description:
        "The external pages linking to one page of the site, with their anchor text, one page of " +
        "results at a time (page 0 first; the answer gives total_pages and next_page).",
      inputSchema: z.object({
        site: siteArg,
        url: pageUrlArg("The linked-to page, as bing_webmaster_get_link_counts reports it"),
        page: pageArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, url, page }, req) =>
      runForSite(req, client, site, async (siteUrl) => ({
        url,
        ...shapeUrlLinks(await client.get("GetUrlLinks", { siteUrl, link: url, page }), page),
      })),
  );
};
