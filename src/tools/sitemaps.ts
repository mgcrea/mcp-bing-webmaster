import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { shapeFeeds } from "#/client/shape";
import { confirmArg, limitArg, pageUrlArg, runForSite, siteArg } from "#/tools/util";

const feedUrlArg = (what: string) => pageUrlArg(`${what}, e.g. "https://example.com/sitemap.xml"`);

export const registerSitemapReadTools = (server: McpServer, client: BingWebmasterClient): void => {
  server.registerTool(
    "bing_webmaster_list_sitemaps",
    {
      title: "Bing Webmaster: List Sitemaps",
      description:
        "The sitemaps and feeds submitted for the site (top level only), each with its type, " +
        "processing status, URL count, size and when Bing last crawled it. For the children of a " +
        "sitemap index, use bing_webmaster_get_sitemap.",
      inputSchema: z.object({ site: siteArg, limit: limitArg(500, 100, "sitemaps") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, limit }, req) =>
      runForSite(req, client, site, async (siteUrl) =>
        shapeFeeds(await client.get("GetFeeds", { siteUrl }), limit),
      ),
  );

  server.registerTool(
    "bing_webmaster_get_sitemap",
    {
      title: "Bing Webmaster: Get Sitemap",
      description:
        "Details of one submitted sitemap. For a sitemap index, lists the child sitemaps it " +
        "points to, each with status, URL count and last crawl.",
      inputSchema: z.object({
        site: siteArg,
        sitemap_url: feedUrlArg("The sitemap, as bing_webmaster_list_sitemaps reports it"),
        limit: limitArg(1000, 100, "child sitemaps"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, sitemap_url, limit }, req) =>
      runForSite(req, client, site, async (siteUrl) => ({
        sitemap_url,
        ...shapeFeeds(await client.get("GetFeedDetails", { siteUrl, feedUrl: sitemap_url }), limit),
      })),
  );
};

export const registerSitemapWriteTools = (server: McpServer, client: BingWebmasterClient): void => {
  server.registerTool(
    "bing_webmaster_submit_sitemap",
    {
      title: "Bing Webmaster: Submit Sitemap",
      description:
        "Submit a sitemap or feed for the site: XML sitemap or sitemap index, RSS 2.0, Atom 0.3/1.0, " +
        "or a plain text file of URLs. Bing fetches it on its own schedule; resubmitting an " +
        "existing one asks Bing to re-read it. Does not spend URL submission quota.",
      inputSchema: z.object({
        site: siteArg,
        sitemap_url: feedUrlArg("The sitemap or feed to submit"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ site, sitemap_url }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        await client.post("SubmitFeed", { siteUrl, feedUrl: sitemap_url });
        return {
          submitted: sitemap_url,
          next_step: "bing_webmaster_list_sitemaps shows its status once Bing has read it.",
        };
      }),
  );

  server.registerTool(
    "bing_webmaster_remove_sitemap",
    {
      title: "Bing Webmaster: Remove Sitemap",
      description:
        "Remove a submitted sitemap or feed from the site in Bing Webmaster Tools, losing its " +
        "processing history there; resubmitting it later starts from scratch. It does not remove " +
        "the sitemap's pages from Bing's index.",
      inputSchema: z.object({
        site: siteArg,
        sitemap_url: feedUrlArg(
          "The sitemap to remove, exactly as bing_webmaster_list_sitemaps reports it",
        ),
        confirm: confirmArg,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ site, sitemap_url }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        await client.post("RemoveFeed", { siteUrl, feedUrl: sitemap_url });
        return { removed: sitemap_url };
      }),
  );
};
