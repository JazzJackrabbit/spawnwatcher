import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Store, type Entry } from "../src/store.js";

let stores: Store[] = [];

function open(): Store {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "swtest-")), "test.db"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function entry(id: string, modelId: string, at: Date): Entry {
  return {
    event: { kind: "model_added", provider: "anthropic", modelId, changeKeys: "", payload: "", detectedAt: at },
    item: {
      id,
      title: `t ${modelId}`,
      summaryMd: "s",
      agentSummary: `{"model_id":"${modelId}"}`,
      generator: "template",
      sourceUrl: "",
      kind: "model_added",
      publishedAt: at,
    },
  };
}

const snap = (fetchedAt: Date, body = Buffer.from("gz"), etag = '"v1"') => ({ etag, body, fetchedAt });

describe("saveCycle", () => {
  it("is idempotent across replayed diffs", () => {
    const store = open();
    const now = new Date();

    store.saveCycle(snap(now), [entry("sw_1", "m-1", now)], true);
    store.saveCycle(snap(now), [entry("sw_1", "m-1", now)], true);

    expect(store.listItems(10)).toHaveLength(1);
    expect(store.dueDeliveries(new Date(Date.now() + 60_000))).toHaveLength(1);
  });

  it("prunes snapshots beyond the latest two", () => {
    const store = open();
    const base = new Date("2026-08-09T00:00:00Z");

    for (let i = 0; i < 4; i++) {
      store.saveCycle(snap(new Date(base.getTime() + i * 3_600_000), Buffer.from([i]), "v"), [], false);
    }
    const latest = store.latestSnapshot();
    expect(latest).toBeDefined();
    expect(latest!.body[0]).toBe(3);
    expect(latest!.fetchedAt.toISOString()).toBe(new Date(base.getTime() + 3 * 3_600_000).toISOString());
  });

  it("does not queue deliveries when disabled", () => {
    const store = open();
    const now = new Date();
    store.saveCycle(snap(now), [entry("sw_b", "m-b", now)], false);
    expect(store.dueDeliveries(new Date(Date.now() + 3_600_000))).toHaveLength(0);
  });
});

describe("delivery lifecycle", () => {
  it("retries after failure and settles on delivery", () => {
    const store = open();
    const now = new Date();
    store.saveCycle(snap(now), [entry("sw_a", "m-a", now)], true);

    // Failure pushes the retry into the future and off the due list.
    store.recordFailure("sw_a", "connection refused", new Date(now.getTime() + 3_600_000));
    expect(store.dueDeliveries(new Date(now.getTime() + 60_000))).toHaveLength(0);

    const due = store.dueDeliveries(new Date(now.getTime() + 2 * 3_600_000));
    expect(due).toHaveLength(1);
    expect(due[0]!.attempts).toBe(1);

    store.markDelivered("sw_a", now);
    expect(store.dueDeliveries(new Date(now.getTime() + 24 * 3_600_000))).toHaveLength(0);
  });
});
