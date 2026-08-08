/**
 * Persists snapshots, detected events, generated feed items, and webhook
 * delivery state in a single SQLite file.
 *
 * The schema (and the RFC3339 second-precision timestamp format) is shared
 * with earlier deployments of this service — an existing database is picked
 * up as-is.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// Applied idempotently at every boot. The database is small enough that
// numbered migrations would be ceremony; additive changes go here with
// IF NOT EXISTS guards.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY,
    etag       TEXT NOT NULL DEFAULT '',
    body       BLOB NOT NULL,
    fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    provider    TEXT NOT NULL,
    model_id    TEXT NOT NULL DEFAULT '',
    change_keys TEXT NOT NULL DEFAULT '',
    payload     TEXT NOT NULL DEFAULT '',
    detected_on TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    UNIQUE (kind, provider, model_id, change_keys, detected_on)
);

CREATE TABLE IF NOT EXISTS items (
    id            TEXT PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events (id),
    title         TEXT NOT NULL,
    summary_md    TEXT NOT NULL,
    agent_summary TEXT NOT NULL DEFAULT '{}',
    generator     TEXT NOT NULL DEFAULT 'template',
    source_url    TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT '',
    published_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS items_published_idx ON items (published_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
    item_id      TEXT PRIMARY KEY REFERENCES items (id),
    status       TEXT NOT NULL DEFAULT 'pending',
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT NOT NULL DEFAULT '',
    next_try_at  TEXT NOT NULL,
    delivered_at TEXT
);
`;

export interface Snapshot {
  id: number;
  etag: string;
  /** gzipped api.json */
  body: Buffer;
  fetchedAt: Date;
}

export interface EventRow {
  kind: string;
  provider: string;
  modelId: string;
  changeKeys: string;
  payload: string;
  detectedAt: Date;
}

export interface Item {
  id: string;
  title: string;
  summaryMd: string;
  agentSummary: string;
  generator: string;
  sourceUrl: string;
  kind: string;
  publishedAt: Date;
  /** models.dev provider id, from the event the item was generated for. */
  provider?: string;
}

/** An event paired with the feed item generated from it. */
export interface Entry {
  event: EventRow;
  item: Item;
}

export interface Delivery {
  item: Item;
  attempts: number;
}

export interface Stats {
  items: number;
  events: number;
  pendingDeliveries: number;
  deliveredDeliveries: number;
  nextRetryAt: Date | null;
  lastSnapshotAt: Date | null;
  lastSnapshotEtag: string | null;
}

/** RFC3339 with second precision, matching what's already stored. */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL and a generous busy timeout let the brief two-container overlap of
    // a zero-downtime deploy share the file safely.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 10000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  latestSnapshot(): Snapshot | undefined {
    const row = this.db
      .prepare("SELECT id, etag, body, fetched_at FROM snapshots ORDER BY id DESC LIMIT 1")
      .get() as { id: number; etag: string; body: Buffer; fetched_at: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, etag: row.etag, body: row.body, fetchedAt: new Date(row.fetched_at) };
  }

  /**
   * Records one completed poll cycle atomically: the new snapshot, the events
   * it produced, their feed items, and pending deliveries. Entries whose
   * event or item already exists are skipped, so a replayed diff cannot
   * duplicate the feed. Older snapshots beyond the previous one are pruned.
   */
  saveCycle(snap: { etag: string; body: Buffer; fetchedAt: Date }, entries: Entry[], queue: boolean): void {
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO snapshots (etag, body, fetched_at) VALUES (?, ?, ?)")
        .run(snap.etag, snap.body, rfc3339(snap.fetchedAt));
      this.db
        .prepare(
          "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 2)",
        )
        .run();
      this.insertEntries(entries, queue);
    })();
  }

  /** Inserts events and items outside a poll cycle — the backfill path. */
  addEntries(entries: Entry[], queue: boolean): void {
    this.db.transaction(() => this.insertEntries(entries, queue))();
  }

  private insertEntries(entries: Entry[], queue: boolean): void {
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events (kind, provider, model_id, change_keys, payload, detected_on, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertItem = this.db.prepare(`
      INSERT OR IGNORE INTO items (id, event_id, title, summary_md, agent_summary, generator, source_url, kind, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const enqueue = this.db.prepare(
      "INSERT OR IGNORE INTO deliveries (item_id, next_try_at) VALUES (?, ?)",
    );

    for (const { event, item } of entries) {
      const res = insertEvent.run(
        event.kind,
        event.provider,
        event.modelId,
        event.changeKeys,
        event.payload,
        rfc3339(event.detectedAt).slice(0, 10),
        rfc3339(event.detectedAt),
      );
      if (res.changes === 0) continue; // already recorded in a previous cycle

      const inserted = insertItem.run(
        item.id,
        res.lastInsertRowid,
        item.title,
        item.summaryMd,
        item.agentSummary,
        item.generator,
        item.sourceUrl,
        item.kind,
        rfc3339(item.publishedAt),
      );
      if (inserted.changes > 0 && queue) {
        enqueue.run(item.id, rfc3339(new Date()));
      }
    }
  }

  listItems(limit: number, offset = 0, provider?: string): Item[] {
    const where = provider ? "WHERE e.provider = ?" : "";
    const params: (string | number)[] = provider ? [provider, limit, offset] : [limit, offset];
    const rows = this.db
      .prepare(
        `SELECT i.id, i.title, i.summary_md, i.agent_summary, i.generator, i.source_url, i.kind, i.published_at,
                e.provider
         FROM items i JOIN events e ON e.id = i.event_id
         ${where}
         ORDER BY i.published_at DESC, i.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as Record<string, string>[];
    return rows.map((r) => ({
      id: r.id!,
      title: r.title!,
      summaryMd: r.summary_md!,
      agentSummary: r.agent_summary!,
      generator: r.generator!,
      sourceUrl: r.source_url!,
      kind: r.kind!,
      publishedAt: new Date(r.published_at!),
      provider: r.provider!,
    }));
  }

  dueDeliveries(now: Date): Delivery[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.title, i.summary_md, i.agent_summary, i.source_url, i.kind, i.published_at, d.attempts
         FROM deliveries d JOIN items i ON i.id = d.item_id
         WHERE d.status = 'pending' AND d.next_try_at <= ?
         ORDER BY i.published_at`,
      )
      .all(rfc3339(now)) as (Record<string, string> & { attempts: number })[];
    return rows.map((r) => ({
      attempts: r.attempts,
      item: {
        id: r.id!,
        title: r.title!,
        summaryMd: r.summary_md!,
        agentSummary: r.agent_summary!,
        generator: "",
        sourceUrl: r.source_url!,
        kind: r.kind!,
        publishedAt: new Date(r.published_at!),
      },
    }));
  }

  /** A one-shot operational summary for the `stats` CLI command. */
  stats(): Stats {
    const one = <T>(sql: string): T => this.db.prepare(sql).get() as T;
    const items = one<{ n: number }>("SELECT COUNT(*) AS n FROM items").n;
    const events = one<{ n: number }>("SELECT COUNT(*) AS n FROM events").n;
    const deliveries = one<{ pending: number; delivered: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
         COUNT(*) FILTER (WHERE status = 'delivered') AS delivered
       FROM deliveries`,
    );
    const nextTry = one<{ at: string | null }>(
      "SELECT MIN(next_try_at) AS at FROM deliveries WHERE status = 'pending'",
    ).at;
    const snapshot = this.latestSnapshot();
    return {
      items,
      events,
      pendingDeliveries: deliveries.pending,
      deliveredDeliveries: deliveries.delivered,
      nextRetryAt: nextTry ? new Date(nextTry) : null,
      lastSnapshotAt: snapshot?.fetchedAt ?? null,
      lastSnapshotEtag: snapshot?.etag ?? null,
    };
  }

  markDelivered(itemId: string, at: Date): void {
    this.db
      .prepare("UPDATE deliveries SET status = 'delivered', delivered_at = ? WHERE item_id = ?")
      .run(rfc3339(at), itemId);
  }

  recordFailure(itemId: string, cause: string, nextTry: Date): void {
    this.db
      .prepare(
        "UPDATE deliveries SET attempts = attempts + 1, last_error = ?, next_try_at = ? WHERE item_id = ?",
      )
      .run(cause, rfc3339(nextTry), itemId);
  }
}
