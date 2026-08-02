/** Fetches the models.dev catalog and diffs consecutive captures. */

export interface Modalities {
  input?: string[];
  output?: string[];
}

export interface Model {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: Modalities;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface Provider {
  id: string;
  name?: string;
  doc?: string;
  models: Record<string, Model>;
}

export type Catalog = Record<string, Provider>;

export const CATALOG_URL = "https://models.dev/api.json";

/**
 * Maps the models.dev provider ids worth reporting on to the names the
 * downstream consumer knows them by.
 */
export const WATCHED: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  xai: "grok",
  perplexity: "perplexity",
  openrouter: "openrouter",
};

export type ChangeKind = "model_added" | "model_updated";

/** One detected difference between two catalog captures. */
export interface Change {
  kind: ChangeKind;
  /** models.dev id, e.g. "xai" */
  provider: string;
  /** display name, e.g. "xAI" */
  providerName: string;
  modelId: string;
  /** for updates: which fields moved */
  changeKeys: string[];
  /** current state */
  model: Model;
  /** previous state; undefined for additions */
  previous?: Model;
}

export function sourceUrl(change: Change): string {
  return `https://models.dev/?provider=${change.provider}&model=${encodeURIComponent(change.modelId)}`;
}

export function parseCatalog(body: string | Buffer): Catalog {
  return JSON.parse(body.toString()) as Catalog;
}

export interface FetchResult {
  body?: Buffer;
  etag: string;
  notModified: boolean;
}

/**
 * Downloads the catalog, sending the previous ETag so an unchanged catalog
 * costs a 304 instead of a multi-megabyte body.
 */
export async function fetchCatalog(url: string, etag: string): Promise<FetchResult> {
  const headers: Record<string, string> = {};
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (res.status === 304) return { etag, notModified: true };
  if (res.status !== 200) {
    throw new Error(`fetch ${url}: unexpected status ${res.status}`);
  }
  return {
    body: Buffer.from(await res.arrayBuffer()),
    etag: res.headers.get("etag") ?? "",
    notModified: false,
  };
}

/** The model's feature flags and input modalities in a stable, readable form. */
export function capabilities(model: Model): string[] {
  const caps: string[] = [];
  if (model.reasoning) caps.push("reasoning");
  if (model.tool_call) caps.push("tool_call");
  for (const input of model.modalities?.input ?? []) {
    if (input !== "text") caps.push(`input:${input}`);
  }
  return caps;
}

/**
 * Compares two captures and reports additions and meaningful updates for
 * watched providers. Cosmetic fields (names, descriptions) never produce
 * events. openrouter is an aggregator: it only yields additions, and only
 * for models no first-party provider already lists, so every release
 * surfaces exactly once.
 */
export function diffCatalogs(prev: Catalog, curr: Catalog): Change[] {
  const out: Change[] = [];

  // Model ids first-party providers list, used to mute openrouter echoes.
  // openrouter ids look like "vendor/model"; compare on the part after "/".
  const firstParty = new Set<string>();
  for (const [pid, provider] of Object.entries(curr)) {
    if (pid === "openrouter" || !WATCHED[pid]) continue;
    for (const id of Object.keys(provider.models ?? {})) firstParty.add(id);
  }

  for (const pid of Object.keys(WATCHED)) {
    const currP = curr[pid];
    if (!currP) continue;
    const prevP = prev[pid];

    for (const id of Object.keys(currP.models ?? {}).sort()) {
      const model = currP.models[id]!;
      const before = prevP?.models?.[id];

      if (!before) {
        // A provider absent from the previous capture (models.dev
        // occasionally reshuffles ids) would report its entire catalog as
        // new; skip those wholesale.
        if (!prevP) continue;
        if (pid === "openrouter" && echoesFirstParty(id, firstParty)) continue;
        out.push({
          kind: "model_added",
          provider: pid,
          providerName: currP.name ?? pid,
          modelId: id,
          changeKeys: [],
          model,
        });
        continue;
      }
      if (pid === "openrouter") continue;
      const keys = changedKeys(before, model);
      if (keys.length > 0) {
        out.push({
          kind: "model_updated",
          provider: pid,
          providerName: currP.name ?? pid,
          modelId: id,
          changeKeys: keys,
          model,
          previous: before,
        });
      }
    }
  }
  return out;
}

function echoesFirstParty(openrouterId: string, firstParty: Set<string>): boolean {
  const slash = openrouterId.indexOf("/");
  const name = slash >= 0 ? openrouterId.slice(slash + 1) : openrouterId;
  return firstParty.has(name);
}

function changedKeys(before: Model, after: Model): string[] {
  const keys: string[] = [];
  const costFields = ["input", "output", "cache_read", "cache_write"] as const;
  if (costFields.some((f) => (before.cost?.[f] ?? 0) !== (after.cost?.[f] ?? 0))) {
    keys.push("cost");
  }
  if (
    (before.limit?.context ?? 0) !== (after.limit?.context ?? 0) ||
    (before.limit?.output ?? 0) !== (after.limit?.output ?? 0)
  ) {
    keys.push("limit");
  }
  if (
    !sameList(before.modalities?.input, after.modalities?.input) ||
    !sameList(before.modalities?.output, after.modalities?.output)
  ) {
    keys.push("modalities");
  }
  return keys;
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
