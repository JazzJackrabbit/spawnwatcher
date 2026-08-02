/** The poll → diff → summarize → store → deliver cycle. */
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  CATALOG_URL,
  WATCHED,
  capabilities,
  diffCatalogs,
  fetchCatalog,
  parseCatalog,
  sourceUrl,
  type Change,
} from "./catalog.js";
import { deliveryConfigured, geminiConfigured, type Config } from "./config.js";
import { backoff, WebhookClient } from "./deliver.js";
import { rfc3339, type Entry, type Store } from "./store.js";
import { fallback, Gemini, suggestedAction, type Blurb } from "./summarize.js";

/** Writes the public blurb for a change; null means templated text only. */
export interface Summarizer {
  summarize(ch: Change): Promise<Blurb>;
  generator(): string;
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export class Watcher {
  catalogUrl = CATALOG_URL;
  llm: Summarizer | null = null;
  webhook: WebhookClient | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly cfg: Config,
    readonly store: Store,
    private readonly log: Logger,
  ) {
    if (geminiConfigured(cfg)) this.llm = new Gemini(cfg.geminiKey, cfg.geminiModel);
    if (deliveryConfigured(cfg)) this.webhook = new WebhookClient(cfg.spawnWebhookUrl, cfg.spawnToken);
  }

  /**
   * Polls until stop(). Delivery retries run on their own faster timer so a
   * failed push is not stuck waiting for the next poll.
   */
  start(): void {
    const poll = async () => {
      try {
        await this.cycle();
      } catch (err) {
        this.log.error("poll cycle failed", { error: String(err) });
      }
      this.timers.push(setTimeout(poll, jitter(this.cfg.pollIntervalMs)));
    };
    this.timers.push(setTimeout(poll, 1_000)); // first cycle right after boot

    const retry = async () => {
      if (this.webhook) await this.deliverDue();
      this.timers.push(setTimeout(retry, 60_000));
    };
    this.timers.push(setTimeout(retry, 60_000));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /**
   * Performs one poll: fetch the catalog, diff against the stored capture,
   * generate feed items, persist everything atomically.
   */
  async cycle(): Promise<void> {
    const prev = this.store.latestSnapshot();
    const fetched = await fetchCatalog(this.catalogUrl, prev?.etag ?? "");
    if (fetched.notModified) return;

    const curr = parseCatalog(fetched.body!);
    const now = new Date();
    const snap = { etag: fetched.etag, body: gzipSync(fetched.body!), fetchedAt: now };

    // First capture, or one too stale to produce timely news: seed only.
    if (!prev || now.getTime() - prev.fetchedAt.getTime() > this.cfg.maxDiffAgeMs) {
      this.log.info("seeding snapshot without events", { had_previous: Boolean(prev) });
      this.store.saveCycle(snap, [], false);
      return;
    }

    const prevCatalog = parseCatalog(gunzipSync(prev.body));
    const changes = diffCatalogs(prevCatalog, curr);
    const entries: Entry[] = [];
    for (const ch of changes) entries.push(await this.entryFor(ch, now));
    if (entries.length > 0) this.log.info("detected catalog changes", { count: entries.length });
    this.store.saveCycle(snap, entries, this.webhook !== null);
  }

  /**
   * Seeds the feed with models the catalog says were released on or after
   * `since`, dated at their release dates. It exists for fresh deployments:
   * the poller only reports changes it witnesses, so without a backfill the
   * feed starts empty however eventful the preceding weeks were. Nothing is
   * queued for webhook delivery — history is not news to act on. openrouter
   * is skipped: its catalog echoes the first-party providers.
   */
  async backfill(since: Date): Promise<number> {
    const fetched = await fetchCatalog(this.catalogUrl, "");
    const providers = parseCatalog(fetched.body!);

    const entries: Entry[] = [];
    for (const pid of Object.keys(WATCHED)) {
      const provider = providers[pid];
      if (!provider || pid === "openrouter") continue;
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        if (!model.release_date) continue;
        const released = new Date(`${model.release_date}T00:00:00Z`);
        if (Number.isNaN(released.getTime()) || released < since) continue;
        const ch: Change = {
          kind: "model_added",
          provider: pid,
          providerName: provider.name ?? pid,
          modelId: id,
          changeKeys: [],
          model,
        };
        entries.push(await this.entryFor(ch, new Date(released.getTime() + 12 * 3_600_000)));
      }
    }
    this.store.addEntries(entries, false);
    return entries.length;
  }

  /** Builds the event row and feed item for one change. */
  private async entryFor(ch: Change, now: Date): Promise<Entry> {
    let { title, summaryMd } = fallback(ch);
    let generator = "template";
    if (this.llm) {
      try {
        ({ title, summaryMd } = await this.llm.summarize(ch));
        generator = this.llm.generator();
      } catch (err) {
        this.log.warn("llm summary failed, using fallback", { model: ch.modelId, error: String(err) });
      }
    }

    const agent = JSON.stringify({
      provider: WATCHED[ch.provider],
      model_id: ch.modelId,
      release_date: ch.model.release_date ?? "",
      context: ch.model.limit?.context ?? 0,
      max_output: ch.model.limit?.output ?? 0,
      cost: { input: ch.model.cost?.input ?? 0, output: ch.model.cost?.output ?? 0 },
      capabilities: capabilities(ch.model),
      change_keys: ch.changeKeys,
      suggested_action: suggestedAction(ch, WATCHED[ch.provider] ?? ch.provider),
    });

    return {
      event: {
        kind: ch.kind,
        provider: ch.provider,
        modelId: ch.modelId,
        changeKeys: ch.changeKeys.join(","),
        payload: JSON.stringify(ch.model),
        detectedAt: now,
      },
      item: {
        id: itemId(ch, now),
        title,
        summaryMd,
        agentSummary: agent,
        generator,
        sourceUrl: sourceUrl(ch),
        kind: ch.kind,
        publishedAt: now,
      },
    };
  }

  async deliverDue(): Promise<void> {
    let due;
    try {
      due = this.store.dueDeliveries(new Date());
    } catch (err) {
      this.log.error("list due deliveries failed", { error: String(err) });
      return;
    }
    for (const d of due) {
      const msg = {
        id: d.item.id,
        kind: d.item.kind,
        title: d.item.title,
        summary_md: d.item.summaryMd,
        agent_summary: JSON.parse(d.item.agentSummary) as unknown,
        source_url: d.item.sourceUrl,
        published_at: rfc3339(d.item.publishedAt),
      };
      try {
        await this.webhook!.send(msg);
        this.log.info("delivered", { item: d.item.id });
        this.store.markDelivered(d.item.id, new Date());
      } catch (err) {
        const next = new Date(Date.now() + backoff(d.attempts));
        this.log.warn("delivery failed", { item: d.item.id, attempts: d.attempts + 1, error: String(err) });
        this.store.recordFailure(d.item.id, String(err), next);
      }
    }
  }
}

/**
 * Derives a stable id from what the item is about, so regeneration on the
 * same day cannot mint a second feed entry.
 */
export function itemId(ch: Change, now: Date): string {
  const day = rfc3339(now).slice(0, 10);
  const hash = createHash("sha256")
    .update(`${ch.kind}|${ch.provider}|${ch.modelId}|${ch.changeKeys.join(",")}|${day}`)
    .digest("hex");
  return `sw_${hash.slice(0, 16)}`;
}

function jitter(ms: number): number {
  return ms + (Math.random() - 0.5) * 0.2 * ms;
}
