import type { McpServer } from "@modelcontextprotocol/server";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import type { Config } from "#/config";
import { registerAuthTools } from "#/tools/auth";
import { registerCrawlTools } from "#/tools/crawl";
import { registerKeywordTools } from "#/tools/keywords";
import { registerLinkTools } from "#/tools/links";
import { registerRequestTool } from "#/tools/request";
import { registerSitemapReadTools, registerSitemapWriteTools } from "#/tools/sitemaps";
import { registerSiteTools } from "#/tools/sites";
import { registerTrafficTools } from "#/tools/traffic";
import { registerUrlReadTools, registerUrlWriteTools } from "#/tools/urls";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see BING_WEBMASTER_ALLOW_WRITES. */
  allowWrites: boolean;
  hasCredentials: boolean;
  /** Today as YYYY-MM-DD (UTC): the end of every default date window. */
  today: () => string;
};

/**
 * Register the tools. All gating lives here, so "why can't I call X" is
 * answered by this one function.
 *
 * - bing_webmaster_auth_status always, first: an unconfigured server explains
 *   itself instead of closing the connection.
 * - The read tools, and the escape hatch, once an API key is set.
 * - The write tools only with BING_WEBMASTER_ALLOW_WRITES on. Not refused:
 *   absent, so they cannot be called at all. The escape hatch widens to
 *   non-Get methods under the same flag (see tools/request.ts).
 */
export const registerTools = (
  server: McpServer,
  client: BingWebmasterClient,
  ctx: ToolContext,
): void => {
  registerAuthTools(server, client, ctx);
  if (!ctx.hasCredentials) return;

  registerSiteTools(server, client);
  registerTrafficTools(server, client, ctx);
  registerUrlReadTools(server, client);
  registerCrawlTools(server, client, ctx);
  registerSitemapReadTools(server, client);
  registerLinkTools(server, client);
  registerKeywordTools(server, client, ctx);
  registerRequestTool(server, client, ctx);

  if (!ctx.allowWrites) return;
  registerUrlWriteTools(server, client);
  registerSitemapWriteTools(server, client);
};
