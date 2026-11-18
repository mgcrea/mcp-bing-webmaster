import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient } from "#/client/bingwebmaster";
import { BingWebmasterApiError } from "#/client/errors";
import { KEY_STEPS, setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { run } from "#/tools/util";

/** auth_status names this many sites; bing_webmaster_list_sites pages through the rest. */
const MAX_STATUS_SITES = 50;

const WRITE_TOOLS =
  "bing_webmaster_submit_urls, bing_webmaster_submit_sitemap, bing_webmaster_remove_sitemap, " +
  "bing_webmaster_fetch_url";

/**
 * Registered first and unconditionally, so an unconfigured server is still a
 * useful one rather than a connection that closes.
 */
export const registerAuthTools = (
  server: McpServer,
  client: BingWebmasterClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "bing_webmaster_auth_status",
    {
      title: "Bing Webmaster: Auth Status",
      description:
        "Whether an API key is configured and accepted, and which sites it reaches (count and " +
        "list, with verification state). The key belongs to a user, not a site, and reaches every " +
        "site that user verified — this is how to see which account it is. When unconfigured, " +
        "returns the exact steps to create a key. Call this first when a tool you expected is " +
        "missing. Costs one GetUserSites call (cached for 5 minutes).",
      inputSchema: z.object({}),
      // openWorldHint: it calls Bing (GetUserSites) once a key is set.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (_args, req) =>
      run(req, client, async () => {
        const warnings =
          ctx.config.warnings.length > 0 ? { config_warnings: ctx.config.warnings } : {};
        const writes = ctx.allowWrites
          ? `ENABLED — ${WRITE_TOOLS} are registered`
          : `disabled — set BING_WEBMASTER_ALLOW_WRITES=1 to register ${WRITE_TOOLS}`;
        if (!ctx.hasCredentials) {
          return {
            configured: false,
            available_without_credentials: ["bing_webmaster_auth_status"],
            setup: setupInstructions(ctx.config),
            writes,
            ...warnings,
          };
        }
        try {
          const sites = await client.sites();
          return {
            configured: true,
            key_accepted: true,
            sites_reachable: sites.length,
            sites: sites
              .slice(0, MAX_STATUS_SITES)
              .map((s) => ({ url: s.url, verified: s.verified })),
            ...(sites.length > MAX_STATUS_SITES
              ? {
                  sites_note: `First ${MAX_STATUS_SITES} of ${sites.length}; bing_webmaster_list_sites has them all.`,
                }
              : {}),
            writes,
            ...warnings,
            ...(sites.length === 0
              ? {
                  note:
                    "The key works but its user has no sites. Add and verify one at " +
                    "https://www.bing.com/webmasters (Bing can import them from Google Search Console).",
                }
              : {}),
            quota:
              "URL submission quota is per site and per day: bing_webmaster_get_url_submission_quota " +
              "shows what a site has left. Read calls have no published quota but are throttled " +
              "(ThrottleUser) when called in a tight loop.",
          };
        } catch (err) {
          return {
            configured: true,
            key_accepted: false,
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof BingWebmasterApiError && err.remedy ? { remedy: err.remedy } : {}),
            ...(err instanceof BingWebmasterApiError && err.codeName === "InvalidApiKey"
              ? { setup: KEY_STEPS }
              : {}),
            writes,
            ...warnings,
          };
        }
      }),
  );
};
