import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import type { Message } from "../src/deliver.js";
import { WebhookClient } from "../src/deliver.js";
import { Store } from "../src/store.js";
import { Watcher } from "../src/watcher.js";
import { CatalogServer, fixture, quietLog, type TestServer } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type HttpHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;

async function serve(handler: HttpHandler): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  const srv = { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  cleanups.push(srv.close);
  return srv;
}

function newWatcher(catalogUrl: string, spawnUrl: string): Watcher {
  const cfg: Config = {
    port: 0,
    dbPath: "",
    publicUrl: "",
    spawnWebhookUrl: "",
    spawnToken: "",
    geminiKey: "",
    geminiModel: "",
    pollIntervalMs: 3_600_000,
    maxDiffAgeMs: 7 * 24 * 3_600_000,
  };
  const store = new Store(join(mkdtempSync(join(tmpdir(), "swwatch-")), "w.db"));
  cleanups.push(() => store.close());
  const watcher = new Watcher(cfg, store, quietLog);
  watcher.catalogUrl = `${catalogUrl}/api.json`;
  if (spawnUrl) watcher.webhook = new WebhookClient(spawnUrl, "test-token");
  return watcher;
}

describe("full cycle", () => {
  it("seeds, diffs, delivers, and stays idempotent", async () => {
    const cat = new CatalogServer();
    cat.set(fixture("api_v1.json"), '"v1"');
    const catSrv = await serve(cat.handler);

    const received: Message[] = [];
    const spawnSrv = await serve((req, res) => {
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString()) as Message);
        res.writeHead(201).end();
      });
    });

    const watcher = newWatcher(catSrv.url, spawnSrv.url);

    // First cycle seeds without producing feed entries.
    await watcher.cycle();
    expect(watcher.store.listItems(10)).toHaveLength(0);

    // Unchanged catalog answers 304; nothing happens.
    await watcher.cycle();

    // The catalog moves to v2: one addition, one update.
    cat.set(fixture("api_v2.json"), '"v2"');
    await watcher.cycle();
    expect(watcher.store.listItems(10)).toHaveLength(2);

    await watcher.deliverDue();
    expect(received).toHaveLength(2);

    const agents = received.map((m) => m.agent_summary as Record<string, unknown>);
    const grok = agents.find((a) => a.model_id === "grok-4.5");
    expect(grok).toBeDefined();
    expect(grok!.provider).toBe("grok"); // xai maps to spawn's provider name
    expect(agents.every((a) => typeof a.suggested_action === "string" && a.suggested_action !== "")).toBe(true);
    expect(agents.some((a) => a.model_id === "claude-sonnet-5-1")).toBe(true);

    // Redelivery after a poll replay stays quiet: same ids, nothing new queued.
    await watcher.deliverDue();
    expect(received).toHaveLength(2);
  });

  it("retries failed deliveries with backoff", async () => {
    const cat = new CatalogServer();
    cat.set(fixture("api_v1.json"), '"v1"');
    const catSrv = await serve(cat.handler);

    let calls = 0;
    const spawnSrv = await serve((_req, res) => {
      calls++;
      if (calls === 1) res.writeHead(502).end("down");
      else res.writeHead(201).end();
    });

    const watcher = newWatcher(catSrv.url, spawnSrv.url);
    await watcher.cycle();
    cat.set(fixture("api_v2.json"), '"v2"');
    await watcher.cycle();

    await watcher.deliverDue(); // first item fails, second succeeds
    expect(calls).toBe(2);
    const due = watcher.store.dueDeliveries(new Date(Date.now() + 2 * 60_000));
    expect(due).toHaveLength(1);
    expect(due[0]!.attempts).toBe(1);
  });
});

describe("backfill", () => {
  it("seeds from release dates, idempotently, without deliveries", async () => {
    const cat = new CatalogServer();
    cat.set(fixture("api_v2.json"), '"v2"');
    const catSrv = await serve(cat.handler);

    const watcher = newWatcher(catSrv.url, "");

    // api_v2 has exactly one watched model released on/after 2026-08-01
    // (claude-sonnet-5-1, 2026-08-05); the cerebras addition is unwatched.
    const since = new Date("2026-08-01T00:00:00Z");
    expect(await watcher.backfill(since)).toBe(1);

    const items = watcher.store.listItems(10);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("model_added");
    expect(items[0]!.publishedAt.toISOString().slice(0, 10)).toBe("2026-08-05");

    await watcher.backfill(since);
    expect(watcher.store.listItems(10)).toHaveLength(1);
    expect(watcher.store.dueDeliveries(new Date(Date.now() + 3_600_000))).toHaveLength(0);
  });
});
