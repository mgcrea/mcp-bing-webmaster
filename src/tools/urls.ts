import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { PreconditionError } from "#/client/errors";
import { shapeFetchedList, shapeFetchedUrl, shapeUrlInfo } from "#/client/shape";
import { ownUrl } from "#/client/sites";
import { limitArg, pageUrlArg, runForSite, siteArg } from "#/tools/util";

/** SubmitUrlBatch's documented ceiling per call. */
export const MAX_BATCH = 500;

/**
 * Refuse, before anything is sent, URLs that are not the site's own, and
 * return the rest normalized (`new URL(u).href`) and deduplicated in that
 * form — so `https://Example.com/a` and `https://example.com/a` are one URL,
 * and what Bing receives is what was checked.
 */
const ownUrls = (urls: string[], siteUrl: string): string[] => {
  const checked = urls.map((u) => ({ url: u, own: ownUrl(u, siteUrl) }));
  const foreign = checked.filter((c) => !c.own.ok);
  if (foreign.length > 0) {
    throw new PreconditionError(
      `${foreign.length} of ${urls.length} URL(s) do not belong to ${siteUrl}. Nothing was submitted.`,
      {
        remedy:
          "Every URL must be an absolute http(s) URL on the site's host or, for a site registered " +
          "at a host root, one of its subdomains; on its port, under its path, with no credentials. " +
          "Submit other sites' URLs with their own `site`.",
        details: {
          foreign_urls: foreign.slice(0, 20).map((c) => ({
            url: c.url,
            reason: (c.own as { reason: string }).reason,
          })),
        },
      },
    );
  }
  return [...new Set(checked.map((c) => (c.own as { href: string }).href))];
};

export const registerUrlReadTools = (server: McpServer, client: BingWebmasterClient): void => {
  server.registerTool(
    "bing_webmaster_get_url_info",
    {
      title: "Bing Webmaster: Get URL Info",
      description:
        "Bing's URL inspection for one page: whether Bing knows it, the HTTP status it last got, " +
        "when it was discovered and last crawled, document size, anchor count, and how many URLs " +
        "Bing knows below it. Prefer this over a `site:` web search to check whether Bing has a " +
        "page — a search result is neither complete nor current. `url` may also be " +
        '"domain:example.com" for the whole domain.',
      inputSchema: z.object({
        site: siteArg,
        url: z
          .string()
          .min(1)
          .describe(
            'The page, e.g. "https://example.com/pricing", or "domain:example.com" for the domain.',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, url }, req) =>
      runForSite(req, client, site, async (siteUrl) =>
        shapeUrlInfo(await client.get("GetUrlInfo", { siteUrl, url })),
      ),
  );

  server.registerTool(
    "bing_webmaster_get_fetched_url",
    {
      title: "Bing Webmaster: Get Fetched URL",
      description:
        "The result of a live Bingbot fetch (requested with bing_webmaster_fetch_url, or from the " +
        "dashboard's URL Inspection): status, response headers and the HTML Bingbot received. " +
        "Without `url`, lists the URLs fetched so far. A fetch takes a minute or two to complete " +
        "after it is requested.",
      inputSchema: z.object({
        site: siteArg,
        url: pageUrlArg("The fetched page. Omit to list every fetched URL").optional(),
        max_document_chars: z
          .number()
          .int()
          .min(0)
          .max(200_000)
          .default(2000)
          .describe(
            "How much of the fetched HTML to return (0 for none). Defaults to 2000; document_length " +
              "says how long the whole page is.",
          ),
        limit: limitArg(500, 50, "fetched URLs, when listing"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ site, url, max_document_chars, limit }, req) =>
      runForSite(req, client, site, async (siteUrl) =>
        url
          ? shapeFetchedUrl(
              await client.get("GetFetchedUrlDetails", { siteUrl, url }),
              max_document_chars,
            )
          : shapeFetchedList(await client.get("GetFetchedUrls", { siteUrl }), limit),
      ),
  );
};

export const registerUrlWriteTools = (server: McpServer, client: BingWebmasterClient): void => {
  server.registerTool(
    "bing_webmaster_submit_urls",
    {
      title: "Bing Webmaster: Submit URLs",
      description:
        "Ask Bing to crawl and index 1-500 of the site's URLs now. SPENDS QUOTA: each URL costs " +
        "one of the site's daily submissions, the quota differs per site and is often small, so " +
        "call bing_webmaster_get_url_submission_quota first and submit only new or changed pages. " +
        "Every URL must belong to the site; if any does not, nothing is sent. Duplicates are " +
        "dropped. Submitting is a request, not a guarantee of indexing.",
      inputSchema: z.object({
        site: siteArg,
        urls: z
          .array(z.url({ protocol: /^https?$/, error: "Each URL must be absolute http(s)." }))
          .min(1)
          .max(MAX_BATCH)
          .describe(
            'The URLs, absolute, e.g. ["https://example.com/new-post"]. 1-500 per call — ' +
              "SubmitUrlBatch's ceiling — and no more than the site's remaining daily quota.",
          ),
      }),
      // Not idempotent: submitting the same URL again spends the quota again.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ site, urls }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const unique = ownUrls(urls, siteUrl);
        if (unique.length === 1) {
          await client.post("SubmitUrl", { siteUrl, url: unique[0] });
        } else {
          await client.post("SubmitUrlBatch", { siteUrl, urlList: unique });
        }
        return {
          submitted: unique.length,
          method: unique.length === 1 ? "SubmitUrl" : "SubmitUrlBatch",
          ...(unique.length < urls.length
            ? { duplicates_dropped: urls.length - unique.length }
            : {}),
          next_step:
            "bing_webmaster_get_url_submission_quota shows what is left; bing_webmaster_get_url_info " +
            "shows when Bing has crawled a page.",
        };
      }),
  );

  server.registerTool(
    "bing_webmaster_fetch_url",
    {
      title: "Bing Webmaster: Fetch URL",
      description:
        "Ask Bingbot to fetch one of the site's pages now, as Bing Webmaster Tools' live URL " +
        "inspection does, to see what Bing receives (status, headers, HTML). It does not submit " +
        "the page for indexing — that is bing_webmaster_submit_urls. The result arrives a minute " +
        "or two later: read it with bing_webmaster_get_fetched_url.",
      inputSchema: z.object({
        site: siteArg,
        url: pageUrlArg("The page to fetch; it must belong to the site"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ site, url }, req) =>
      runForSite(req, client, site, async (siteUrl) => {
        const [href] = ownUrls([url], siteUrl);
        await client.post("FetchUrl", { siteUrl, url: href });
        return {
          requested: href,
          next_step: "Call bing_webmaster_get_fetched_url with this url in a minute or two.",
        };
      }),
  );
};
