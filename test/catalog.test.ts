import { describe, expect, it } from "vitest";

import { capabilities, diffCatalogs, type Change, type Provider } from "../src/catalog.js";
import { fixtureCatalog } from "./helpers.js";

function byKey(changes: Change[]): Map<string, Change> {
  return new Map(changes.map((ch) => [`${ch.kind}/${ch.provider}/${ch.modelId}`, ch]));
}

describe("diffCatalogs", () => {
  it("detects additions and meaningful updates, ignoring unwatched providers", () => {
    const changes = diffCatalogs(fixtureCatalog("api_v1.json"), fixtureCatalog("api_v2.json"));
    const keyed = byKey(changes);

    const added = keyed.get("model_added/anthropic/claude-sonnet-5-1");
    expect(added).toBeDefined();
    expect(added!.model.release_date).toBe("2026-08-05");
    expect(added!.providerName).toBe("Anthropic");

    const updated = keyed.get("model_updated/xai/grok-4.5");
    expect(updated).toBeDefined();
    expect(updated!.changeKeys).toEqual(["cost", "limit"]);
    expect(updated!.previous!.cost!.input).not.toBe(updated!.model.cost!.input);

    // The cerebras addition in v2 must not surface: not a watched provider.
    expect(changes).toHaveLength(2);
  });

  it("reports nothing for identical catalogs", () => {
    const v1 = fixtureCatalog("api_v1.json");
    expect(diffCatalogs(v1, v1)).toHaveLength(0);
  });

  it("does not flood when a provider is new to the capture", () => {
    const v1 = fixtureCatalog("api_v1.json");
    const v2 = fixtureCatalog("api_v2.json");
    delete v1.anthropic;

    for (const ch of diffCatalogs(v1, v2)) {
      expect(ch.provider).not.toBe("anthropic");
    }
  });

  it("suppresses openrouter echoes of first-party releases", () => {
    const v1 = fixtureCatalog("api_v1.json");
    const v2 = fixtureCatalog("api_v2.json");
    const empty: Provider = { id: "openrouter", name: "OpenRouter", models: {} };
    v1.openrouter = empty;
    v2.openrouter = {
      ...empty,
      models: {
        // Echo of a first-party model: suppressed.
        "anthropic/claude-sonnet-5-1": { id: "anthropic/claude-sonnet-5-1" },
        // Genuinely new on openrouter: reported.
        "mistralai/mistral-large-3": { id: "mistralai/mistral-large-3" },
      },
    };

    const openrouter = diffCatalogs(v1, v2).filter((ch) => ch.provider === "openrouter");
    expect(openrouter).toHaveLength(1);
    expect(openrouter[0]!.modelId).toBe("mistralai/mistral-large-3");
  });
});

describe("capabilities", () => {
  it("lists flags and non-text input modalities in order", () => {
    const caps = capabilities({
      id: "m",
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text", "image", "pdf"] },
    });
    expect(caps).toEqual(["reasoning", "tool_call", "input:image", "input:pdf"]);
  });
});
