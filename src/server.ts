import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import type { Logger } from "#/client/auth";
import { BingWebmasterClient, type Sleep } from "#/client/bingwebmaster";
import { isConfigured, type Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-bing-webmaster-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** How to wait before a retry (tests record the delay and resolve at once). */
  sleep?: Sleep;
  /** Overall budget for one API call, retries included (tests shorten it). */
  callDeadlineMs?: number;
  /** Clock: "today" for default date windows, and the site cache (tests pin it). */
  now?: () => Date;
};

export type CreatedServer = {
  server: McpServer;
  client: BingWebmasterClient;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const now = opts.now ?? (() => new Date());

  // A static API key in the query string. There is no token to refresh, so a
  // rejected key is final and is never retried.
  const client = new BingWebmasterClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? "",
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    userAgent: USER_AGENT,
    now: () => now().getTime(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.callDeadlineMs ? { callDeadlineMs: opts.callDeadlineMs } : {}),
  });

  registerTools(server, client, {
    config,
    allowWrites: config.allowWrites,
    hasCredentials: isConfigured(config),
    today: () => now().toISOString().slice(0, 10),
  });

  return { server, client };
};
