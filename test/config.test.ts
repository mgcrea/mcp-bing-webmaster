import { describe, expect, it } from "vitest";

import { DEFAULT_BASE_URL, isConfigured, loadConfig, setupInstructions } from "#/config";

describe("loadConfig", () => {
  it("never throws on an empty environment (rule 2)", () => {
    const config = loadConfig({});
    expect(isConfigured(config)).toBe(false);
    expect(config).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      allowWrites: false,
      maxRetries: 3,
      timeoutMs: 30_000,
    });
    expect(setupInstructions(config).join(" ")).toContain("Generate");
  });

  it("treats an empty or blank key as unset", () => {
    expect(isConfigured(loadConfig({ BING_WEBMASTER_API_KEY: "   " }))).toBe(false);
    expect(setupInstructions(loadConfig({ BING_WEBMASTER_API_KEY: "k" }))).toEqual([]);
  });

  it("parses the flags and tuning", () => {
    const config = loadConfig({
      BING_WEBMASTER_API_KEY: " key ",
      BING_WEBMASTER_ALLOW_WRITES: "yes",
      BING_WEBMASTER_MAX_RETRIES: "0",
      BING_WEBMASTER_TIMEOUT_MS: "5000",
      BING_WEBMASTER_API_URL: "https://proxy.example.net/bing/",
    });
    expect(config).toEqual({
      apiKey: "key",
      allowWrites: true,
      maxRetries: 0,
      timeoutMs: 5000,
      baseUrl: "https://proxy.example.net/bing",
      warnings: [],
    });
  });

  it("falls back from a plain-http API URL with a warning, rather than exiting — except on loopback", () => {
    const config = loadConfig({ BING_WEBMASTER_API_URL: "http://proxy.example.net" });
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.warnings.join(" ")).toContain("must be https://");
    expect(loadConfig({ BING_WEBMASTER_API_URL: "not a url" }).warnings).toHaveLength(1);
    expect(loadConfig({ BING_WEBMASTER_API_URL: "http://127.0.0.1:8080/json" }).baseUrl).toBe(
      "http://127.0.0.1:8080/json",
    );
  });

  // Rule 2: a throw here exits the process, and the client shows a bare
  // "Connection closed". Out of range is clamped, unreadable is defaulted,
  // and both are reported.
  it("clamps out-of-range numbers and defaults unreadable ones, with warnings, never throwing", () => {
    const config = loadConfig({
      BING_WEBMASTER_TIMEOUT_MS: "50",
      BING_WEBMASTER_MAX_RETRIES: "99",
    });
    expect(config).toMatchObject({ timeoutMs: 1000, maxRetries: 10 });
    expect(config.warnings).toEqual([
      "BING_WEBMASTER_MAX_RETRIES=99 is outside 0-10; using 10.",
      "BING_WEBMASTER_TIMEOUT_MS=50 is outside 1000-300000; using 1000.",
    ]);
    const unreadable = loadConfig({
      BING_WEBMASTER_TIMEOUT_MS: "soon",
      BING_WEBMASTER_MAX_RETRIES: "-1",
    });
    expect(unreadable).toMatchObject({ timeoutMs: 30_000, maxRetries: 0 });
    expect(unreadable.warnings).toHaveLength(2);
  });
});
