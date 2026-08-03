import { describe, expect, it } from "vitest";

import { deliveryConfigured, geminiConfigured, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults with an empty environment", () => {
    const cfg = loadConfig({});
    expect(cfg.port).toBe(8080);
    expect(cfg.pollIntervalMs).toBe(30 * 60_000);
    expect(cfg.maxDiffAgeMs).toBe(7 * 24 * 3_600_000);
    expect(deliveryConfigured(cfg)).toBe(false);
    expect(geminiConfigured(cfg)).toBe(false);
  });

  it("parses compound durations", () => {
    expect(loadConfig({ POLL_INTERVAL: "45s" }).pollIntervalMs).toBe(45_000);
    expect(loadConfig({ POLL_INTERVAL: "1h30m" }).pollIntervalMs).toBe(90 * 60_000);
    expect(loadConfig({ MAX_DIFF_AGE: "168h" }).maxDiffAgeMs).toBe(168 * 3_600_000);
  });

  it("rejects malformed durations and ports", () => {
    expect(() => loadConfig({ POLL_INTERVAL: "30" })).toThrow("POLL_INTERVAL");
    expect(() => loadConfig({ POLL_INTERVAL: "5m oops" })).toThrow("POLL_INTERVAL");
    expect(() => loadConfig({ PORT: "http" })).toThrow("PORT");
  });

  it("trims trailing slashes from URLs", () => {
    const cfg = loadConfig({
      PUBLIC_URL: "https://feed.example.com/",
      SPAWN_WEBHOOK_URL: "https://spawn.example.com/",
      SPAWNWATCHER_TOKEN: "t",
    });
    expect(cfg.publicUrl).toBe("https://feed.example.com");
    expect(cfg.spawnWebhookUrl).toBe("https://spawn.example.com");
    expect(deliveryConfigured(cfg)).toBe(true);
  });

  it("refuses a webhook URL without a token", () => {
    expect(() => loadConfig({ SPAWN_WEBHOOK_URL: "https://spawn.example.com" })).toThrow(
      "SPAWNWATCHER_TOKEN",
    );
  });
});
