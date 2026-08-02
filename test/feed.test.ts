import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FeedHandler } from "../src/feed.js";
import { Store } from "../src/store.js";
import { quietLog, type TestServer } from "./helpers.js";

let store: Store;
let srv: TestServer;

beforeEach(async () => {
  store = new Store(join(mkdtempSync(join(tmpdir(), "swfeed-")), "f.db"));
  const now = new Date("2026-08-09T12:00:00Z");
  store.saveCycle({ etag: "v", body: Buffer.from("x"), fetchedAt: now }, [
    {
      event: { kind: "model_added", provider: "anthropic", modelId: "m-1", changeKeys: "", payload: "", detectedAt: now },
      item: {
        id: "sw_pub",
        title: "Anthropic releases M1",
        summaryMd: "A new model.",
        agentSummary: '{"secret":"never public"}',
        generator: "template",
        sourceUrl: "https://models.dev/?provider=anthropic&model=m-1",
        kind: "model_added",
        publishedAt: now,
      },
    },
  ], false);

  const handler = new FeedHandler(store, "https://feed.example.com", quietLog);
  const server = createServer((req, res) => {
    if (!handler.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  srv = { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
});

afterEach(async () => {
  await srv.close();
  store.close();
});

describe("public feed", () => {
  it("renders items on the index without leaking agent summaries", async () => {
    const res = await fetch(`${srv.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const body = await res.text();
    for (const want of ["Anthropic releases M1", "A new model.", "new model", "Aug 9, 2026"]) {
      expect(body).toContain(want);
    }
    expect(body).not.toContain("never public");
  });

  it("serves a JSON Feed 1.1 document", async () => {
    const res = await fetch(`${srv.url}/feed.json`);
    const body = await res.text();
    const feed = JSON.parse(body) as { version: string; items: { id: string }[] };
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.id).toBe("sw_pub");
    expect(body).not.toContain("never public");
  });

  it("serves RSS with the right content type", async () => {
    const res = await fetch(`${srv.url}/rss.xml`);
    expect(res.headers.get("content-type")).toContain("rss+xml");
    const body = await res.text();
    expect(body).toContain("<rss");
    expect(body).toContain("Anthropic releases M1");
  });

  it("answers healthz with ok", async () => {
    const res = await fetch(`${srv.url}/healthz`);
    expect(await res.text()).toBe("ok");
  });

  it("404s unknown paths", async () => {
    const res = await fetch(`${srv.url}/nope`);
    expect(res.status).toBe(404);
  });
});
