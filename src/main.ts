/**
 * spawnwatcher polls the models.dev catalog for new and updated LLM models,
 * publishes a public feed, and pushes structured release messages to a
 * spawn server.
 *
 * `spawnwatcher backfill [days]` seeds the feed from the catalog's release
 * dates (default 30 days back) and exits. Meant to run once against a fresh
 * database so the feed does not start empty.
 */
import { createServer } from "node:http";

import { deliveryConfigured, geminiConfigured, loadConfig } from "./config.js";
import { FeedHandler } from "./feed.js";
import { Store, rfc3339 } from "./store.js";
import { Watcher, type Logger } from "./watcher.js";

const log: Logger = {
  info: (msg, extra) => write("INFO", msg, extra),
  warn: (msg, extra) => write("WARN", msg, extra),
  error: (msg, extra) => write("ERROR", msg, extra),
};

function write(level: string, msg: string, extra?: Record<string, unknown>): void {
  const fields = Object.entries(extra ?? {})
    .map(([k, v]) => ` ${k}=${JSON.stringify(v)}`)
    .join("");
  process.stderr.write(`time=${new Date().toISOString()} level=${level} msg=${JSON.stringify(msg)}${fields}\n`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dbPath);
  const watcher = new Watcher(cfg, store, log);

  if (process.argv[2] === "backfill") {
    const days = Number.parseInt(process.argv[3] ?? "30", 10) || 30;
    const since = new Date(Date.now() - days * 24 * 3_600_000);
    const n = await watcher.backfill(since);
    log.info("backfill complete", { since: rfc3339(since).slice(0, 10), models: n });
    store.close();
    return;
  }

  watcher.start();

  const feed = new FeedHandler(store, cfg.publicUrl, log);
  const server = createServer((req, res) => {
    if (!feed.handle(req, res)) {
      res.writeHead(404).end("not found");
    }
  });
  server.listen(cfg.port, () => {
    log.info("listening", {
      port: cfg.port,
      delivery: deliveryConfigured(cfg),
      gemini: geminiConfigured(cfg),
    });
  });

  const shutdown = () => {
    watcher.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
