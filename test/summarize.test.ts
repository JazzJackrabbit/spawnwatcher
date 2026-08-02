import { describe, expect, it } from "vitest";

import type { Change } from "../src/catalog.js";
import { fallback, Gemini, suggestedAction } from "../src/summarize.js";
import { testServer } from "./helpers.js";

const addition: Change = {
  kind: "model_added",
  provider: "anthropic",
  providerName: "Anthropic",
  modelId: "claude-sonnet-5-1",
  changeKeys: [],
  model: {
    id: "claude-sonnet-5-1",
    name: "Claude Sonnet 5.1",
    release_date: "2026-08-05",
    reasoning: true,
    tool_call: true,
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 2, output: 10 },
  },
};

const update: Change = {
  kind: "model_updated",
  provider: "xai",
  providerName: "xAI",
  modelId: "grok-4.5",
  changeKeys: ["cost"],
  model: { id: "grok-4.5", name: "Grok 4.5", cost: { input: 5, output: 15 } },
  previous: { id: "grok-4.5", name: "Grok 4.5", cost: { input: 3, output: 15 } },
};

describe("fallback", () => {
  it("renders an addition from structured fields", () => {
    const { title, summaryMd } = fallback(addition);
    expect(title).toBe("Anthropic releases Claude Sonnet 5.1");
    for (const want of ["claude-sonnet-5-1", "2026-08-05", "1M context", "$2/$10 per Mtok", "reasoning, tool_call"]) {
      expect(summaryMd).toContain(want);
    }
  });

  it("renders an update with before/after values", () => {
    const { title, summaryMd } = fallback(update);
    expect(title).toBe("xAI updates Grok 4.5");
    expect(summaryMd).toContain("$5/$15");
    expect(summaryMd).toContain("was $3/$15");
  });
});

describe("suggestedAction", () => {
  it("names the consumer's provider id and the changed keys", () => {
    const action = suggestedAction(update, "grok");
    expect(action).toContain('"grok"');
    expect(action).toContain("grok-4.5");
    expect(action).toContain("cost");
  });
});

describe("Gemini", () => {
  it("sends the API key and parses the structured response", async () => {
    let gotPath = "";
    let gotKey = "";
    const srv = await testServer((req, res) => {
      gotPath = req.url ?? "";
      gotKey = String(req.headers["x-goog-api-key"] ?? "");
      const payload = JSON.stringify({ title: "Anthropic releases Claude Sonnet 5.1", summary: "A new model." });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: payload }] } }] }));
    });
    try {
      const gemini = new Gemini("test-key", "gemini-flash-latest", srv.url);
      const { title, summaryMd } = await gemini.summarize(addition);
      expect(title).not.toBe("");
      expect(summaryMd).not.toBe("");
      expect(gotPath).toBe("/v1beta/models/gemini-flash-latest:generateContent");
      expect(gotKey).toBe("test-key");
    } finally {
      await srv.close();
    }
  });

  it("surfaces non-200 responses as errors", async () => {
    const srv = await testServer((_req, res) => {
      res.writeHead(429).end('{"error": "quota"}');
    });
    try {
      const gemini = new Gemini("k", "m", srv.url);
      await expect(gemini.summarize(addition)).rejects.toThrow("status 429");
    } finally {
      await srv.close();
    }
  });
});
