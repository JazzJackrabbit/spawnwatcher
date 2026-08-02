/**
 * Turns catalog changes into feed prose. Structured facts always come
 * straight from the catalog; only the human-readable blurb is LLM-written,
 * and a templated fallback keeps the feed running with no API key at all.
 */
import { capabilities, type Change } from "./catalog.js";

const APP_NAME = "spawn/heimdall";

export interface Blurb {
  title: string;
  summaryMd: string;
}

/** Renders a blurb purely from structured catalog fields. */
export function fallback(ch: Change): Blurb {
  const name = ch.model.name || ch.modelId;

  if (ch.kind === "model_added") {
    const parts: string[] = [];
    if (ch.model.release_date) parts.push(`released ${ch.model.release_date}`);
    const context = ch.model.limit?.context ?? 0;
    if (context > 0) parts.push(`${tokens(context)} context`);
    const cin = ch.model.cost?.input ?? 0;
    const cout = ch.model.cost?.output ?? 0;
    if (cin > 0 || cout > 0) parts.push(`$${trim(cin)}/$${trim(cout)} per Mtok`);
    const caps = capabilities(ch.model);
    if (caps.length > 0) parts.push(caps.join(", "));

    let summary = `${ch.providerName} added \`${ch.modelId}\` to its lineup`;
    if (parts.length > 0) summary += `: ${parts.join(" · ")}`;
    summary += ".";
    if (ch.model.description) summary += ` ${ch.model.description}.`;
    return { title: `${ch.providerName} releases ${name}`, summaryMd: summary };
  }

  const parts: string[] = [];
  for (const key of ch.changeKeys) {
    const prev = ch.previous;
    if (key === "cost") {
      parts.push(
        `pricing is now $${trim(ch.model.cost?.input ?? 0)}/$${trim(ch.model.cost?.output ?? 0)} per Mtok` +
          ` (was $${trim(prev?.cost?.input ?? 0)}/$${trim(prev?.cost?.output ?? 0)})`,
      );
    } else if (key === "limit") {
      parts.push(
        `limits are now ${tokens(ch.model.limit?.context ?? 0)} context / ${tokens(ch.model.limit?.output ?? 0)} output` +
          ` (was ${tokens(prev?.limit?.context ?? 0)} / ${tokens(prev?.limit?.output ?? 0)})`,
      );
    } else if (key === "modalities") {
      parts.push(
        `modalities are now ${(ch.model.modalities?.input ?? []).join("+")} → ${(ch.model.modalities?.output ?? []).join("+")}`,
      );
    }
  }
  return {
    title: `${ch.providerName} updates ${name}`,
    summaryMd: `${ch.providerName} changed \`${ch.modelId}\`: ${parts.join("; ")}.`,
  };
}

/**
 * The operator-facing hint attached to the structured summary. Deliberately
 * templated, never LLM-written: it drives action.
 */
export function suggestedAction(ch: Change, consumerProvider: string): string {
  if (ch.kind === "model_added") {
    return (
      `Check whether the ${APP_NAME} model list should include ${ch.modelId} ` +
      `(provider "${consumerProvider}"); add a builder and pricing metadata if so.`
    );
  }
  return (
    `Verify ${APP_NAME} metadata for ${ch.modelId} (provider "${consumerProvider}") ` +
    `after upstream changes to ${ch.changeKeys.join(", ")}.`
  );
}

/**
 * Writes the public blurb for a catalog change via Gemini. Any failure is
 * thrown to the caller, which falls back to templated text — the feed never
 * blocks on the LLM.
 */
export class Gemini {
  constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly baseUrl = "https://generativelanguage.googleapis.com",
  ) {}

  /** Identifies how a blurb was produced, recorded per item. */
  generator(): string {
    return `gemini:${this.model}`;
  }

  async summarize(ch: Change): Promise<Blurb> {
    const facts = JSON.stringify({
      change: ch.kind,
      provider: ch.providerName,
      model_id: ch.modelId,
      model_name: ch.model.name ?? "",
      description: ch.model.description ?? "",
      release_date: ch.model.release_date ?? "",
      context: ch.model.limit?.context ?? 0,
      max_output: ch.model.limit?.output ?? 0,
      cost_per_mtok: { input: ch.model.cost?.input ?? 0, output: ch.model.cost?.output ?? 0 },
      capabilities: capabilities(ch.model),
      changed_keys: ch.changeKeys,
    });

    const prompt = `You write short items for a public feed that tracks LLM model releases.
Given the facts below, produce JSON with two fields:
- "title": a plain headline, max 80 characters, no quotes or exclamation marks.
- "summary": 1-3 sentences of neutral news prose. State only the facts given; no speculation, no hype, no advice.

Facts:
${facts}`;

    const res = await fetch(`${this.baseUrl}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: { title: { type: "string" }, summary: { type: "string" } },
            required: ["title", "summary"],
          },
        },
      }),
    });
    const raw = await res.text();
    if (res.status !== 200) {
      throw new Error(`gemini: status ${res.status}: ${raw.slice(0, 200)}`);
    }

    const wrapper = JSON.parse(raw) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = wrapper.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("gemini: empty response");

    const out = JSON.parse(text) as { title?: string; summary?: string };
    const title = out.title?.trim() ?? "";
    const summaryMd = out.summary?.trim() ?? "";
    if (!title || !summaryMd) throw new Error("gemini: blank fields");
    return { title, summaryMd };
  }
}

function tokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
  return `${n}`;
}

function trim(f: number): string {
  return f.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
