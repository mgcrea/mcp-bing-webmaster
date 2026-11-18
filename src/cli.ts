#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { isConfigured, loadConfig, setupInstructions } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.BING_WEBMASTER_DEBUG) console.error("[bing-webmaster-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[bing-webmaster-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[bing-webmaster-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server, client } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLogger.warn(
    `bing-webmaster-mcp connected (credentials=${isConfigured(config) ? "set" : "MISSING"}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"})`,
  );
  for (const line of setupInstructions(config)) stderrLogger.warn(line);
  for (const warning of config.warnings) stderrLogger.warn(`config: ${warning}`);

  // The key belongs to a user and reaches every site that user verified, so
  // say which sites — after connect, and not awaited: startup must never
  // depend on the network. Never log a request URL: it carries the key.
  if (isConfigured(config)) {
    client
      .sites()
      .then((sites) => {
        const shown = sites
          .slice(0, 10)
          .map((s) => `${s.url}${s.verified === false ? " (unverified)" : ""}`);
        const more = sites.length > shown.length ? `, +${sites.length - shown.length} more` : "";
        stderrLogger.warn(
          `API key reaches ${sites.length} site(s)${sites.length ? `: ${shown.join(", ")}${more}` : ""}`,
        );
      })
      .catch((err: unknown) =>
        stderrLogger.warn(
          `could not list the key's sites: ${client.redact.text(err instanceof Error ? err.message : String(err))}`,
        ),
      );
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[bing-webmaster-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
