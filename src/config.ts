export interface Config {
  port: number;
  dbPath: string;
  /** Origin the feed links point back to. */
  publicUrl: string;
  /**
   * Base URL of the spawn deployment that receives release messages. Empty
   * disables delivery; the public feed still works.
   */
  spawnWebhookUrl: string;
  spawnToken: string;
  /**
   * Enables LLM-written blurbs. Empty falls back to templated text built
   * from the catalog's structured fields.
   */
  geminiKey: string;
  geminiModel: string;
  /** models.dev polling cadence in milliseconds. */
  pollIntervalMs: number;
  /**
   * Cap on how old the previous snapshot may be before a diff is considered
   * stale news and skipped in favor of reseeding. Milliseconds.
   */
  maxDiffAgeMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    port: intVar(env, "PORT", 8080),
    dbPath: env.DB_PATH || "./data/spawnwatcher.db",
    publicUrl: (env.PUBLIC_URL || "https://feed.spawnstudio.cc").replace(/\/$/, ""),
    spawnWebhookUrl: (env.SPAWN_WEBHOOK_URL || "").replace(/\/$/, ""),
    spawnToken: env.SPAWNWATCHER_TOKEN || "",
    geminiKey: env.GEMINI_API_KEY || "",
    geminiModel: env.GEMINI_MODEL || "gemini-flash-latest",
    pollIntervalMs: durationVar(env, "POLL_INTERVAL", 30 * 60_000),
    maxDiffAgeMs: durationVar(env, "MAX_DIFF_AGE", 7 * 24 * 3_600_000),
  };
  if (cfg.spawnWebhookUrl && !cfg.spawnToken) {
    throw new Error("SPAWN_WEBHOOK_URL is set but SPAWNWATCHER_TOKEN is not");
  }
  return cfg;
}

export function deliveryConfigured(cfg: Config): boolean {
  return cfg.spawnWebhookUrl !== "" && cfg.spawnToken !== "";
}

export function geminiConfigured(cfg: Config): boolean {
  return cfg.geminiKey !== "";
}

function intVar(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key}: invalid number "${raw}"`);
  return n;
}

/** Parses Go-style durations ("30m", "1h30m", "45s", "168h") to milliseconds. */
function durationVar(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (!raw) return def;
  const matches = [...raw.matchAll(/(\d+(?:\.\d+)?)(h|m|s|ms)/g)];
  const consumed = matches.map((m) => m[0]).join("");
  if (matches.length === 0 || consumed !== raw) {
    throw new Error(`${key}: invalid duration "${raw}"`);
  }
  const unitMs = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 } as const;
  return matches.reduce(
    (total, m) => total + Number(m[1]) * unitMs[m[2] as keyof typeof unitMs],
    0,
  );
}
