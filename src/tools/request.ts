import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { BingWebmasterClient, HttpVerb, Query } from "#/client/bingwebmaster";
import { PreconditionError, WritesDisabledError } from "#/client/errors";
import { capResponse } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { run } from "#/tools/util";

/** A bare PascalCase method name: no slash, no query string, no traversal. */
const METHOD_NAME = /^[A-Z][A-Za-z]+$/;

/** Every Get* method is a read (WebGet); everything else changes something. */
export const isReadMethod = (name: string): boolean => /^Get[A-Z]/.test(name);

const hasApiKeyField = (obj: Record<string, unknown> | undefined): boolean =>
  obj !== undefined && Object.keys(obj).some((k) => k.toLowerCase() === "apikey");

export const registerRequestTool = (
  server: McpServer,
  client: BingWebmasterClient,
  ctx: ToolContext,
): void => {
  const verbs = ctx.allowWrites ? (["GET", "POST"] as const) : (["GET"] as const);

  server.registerTool(
    "bing_webmaster_request",
    {
      title: "Bing Webmaster: Request",
      description:
        "Escape hatch: call any Bing Webmaster API method that has no dedicated tool, by name — " +
        "e.g. GetBlockedUrls, GetCrawlSettings, GetQueryParameters, GetSiteRoles, GetSiteMoves, " +
        "GetUrlTrafficInfo, GetChildrenUrlInfo, GetKeyword, GetQueryPageDetailStats. Methods: " +
        "https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi. " +
        "Get* methods are GET with params in `params`; everything else is POST with a JSON `body`. " +
        "A `siteUrl` in params or body is resolved to its registered form first. The answer is " +
        "normalized (the `d` envelope unwrapped, __type dropped, dates ISO) but not shaped, and cut " +
        "at max_chars — prefer the dedicated tools. " +
        (ctx.allowWrites
          ? "Writes are ENABLED: a non-Get method (AddBlockedUrl, SaveCrawlSettings, RemoveSite, " +
            "SubmitContent, …) runs only with confirm: true, and goes straight to Bing — check " +
            "the method and body first."
          : "Writes are DISABLED: only Get* methods are allowed. Set BING_WEBMASTER_ALLOW_WRITES=1 " +
            "to allow others."),
      inputSchema: z.object({
        method_name: z
          .string()
          .regex(METHOD_NAME, 'A PascalCase API method name, e.g. "GetCrawlSettings".')
          .describe(
            'The API method, PascalCase and case-sensitive, e.g. "GetCrawlSettings" or "GetBlockedUrls".',
          ),
        http: z
          .enum(verbs)
          .optional()
          .describe(
            "HTTP verb. Defaults to GET for Get* methods and POST for the rest, which is what Bing " +
              "expects; a wrong verb answers 405.",
          ),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Query parameters for a GET, named as in the API reference (camelCase), e.g. " +
              '{"siteUrl": "example.com", "url": "https://example.com/a"}. Never the API key.',
          ),
        body: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'JSON body for a POST, e.g. {"siteUrl": "https://example.com/", "blockedUrl": {...}}.',
          ),
        ...(ctx.allowWrites
          ? {
              confirm: z
                .boolean()
                .optional()
                .describe(
                  "Must be true to call a method that is not Get*: explicit acknowledgement that it " +
                    "changes the site in Bing.",
                ),
            }
          : {}),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(200_000)
          .default(20_000)
          .describe(
            "Cut the answer to this many characters of JSON (an array keeps whole items). " +
              "Defaults to 20000.",
          ),
      }),
      annotations: {
        readOnlyHint: !ctx.allowWrites,
        destructiveHint: ctx.allowWrites,
        openWorldHint: true,
      },
    },
    async (args, req) =>
      run(req, client, async () => {
        const { method_name, params, body, max_chars } = args;
        const confirm = (args as { confirm?: boolean }).confirm;
        // Belt and braces: the schema already pins the name and narrows the
        // verb, but a client could hand-roll a request that skips validation.
        if (!METHOD_NAME.test(method_name)) {
          throw new PreconditionError(`"${method_name}" is not an API method name.`);
        }
        const read = isReadMethod(method_name);
        if (!read && !ctx.allowWrites)
          throw new WritesDisabledError(`bing_webmaster_request ${method_name}`);
        if (!read && confirm !== true) {
          throw new PreconditionError(
            `${method_name} changes the site in Bing, so it needs confirm: true. Nothing was sent.`,
          );
        }
        const http: HttpVerb = args.http ?? (read ? "GET" : "POST");
        if (http !== "GET" && !ctx.allowWrites)
          throw new WritesDisabledError(`bing_webmaster_request ${http}`);
        if (hasApiKeyField(params) || hasApiKeyField(body)) {
          throw new PreconditionError(
            "Do not pass apikey: the server adds BING_WEBMASTER_API_KEY itself.",
          );
        }

        const source: Record<string, unknown> | undefined = http === "GET" ? params : body;
        let site: string | undefined;
        if (typeof source?.siteUrl === "string")
          site = (await client.resolveSite(source.siteUrl)).url;
        const withSite = <T extends Record<string, unknown>>(obj: T | undefined): T | undefined =>
          site && obj ? { ...obj, siteUrl: site } : obj;

        const response =
          http === "GET"
            ? await client.call(method_name, {
                http,
                ...(params ? { query: withSite(params) as Query } : {}),
              })
            : await client.call(method_name, { http, body: withSite(body) ?? {} });
        // Redact before capping: a cut through the middle of the key would
        // otherwise leave its first half for the final redaction to miss.
        return {
          method: method_name,
          ...(site ? { site } : {}),
          ...capResponse(client.redact.deep(response), max_chars),
        };
      }),
  );
};
