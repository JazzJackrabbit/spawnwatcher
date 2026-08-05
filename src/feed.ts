/**
 * The public side: an HTML page, a JSON Feed, and RSS. Only the public
 * fields of an item are exposed; the structured summaries delivered to
 * spawn never appear here.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Item, Store } from "./store.js";
import { rfc3339 } from "./store.js";
import type { Logger } from "./watcher.js";

const PAGE_SIZE = 50;
const CACHE = "public, max-age=300";

export class FeedHandler {
  constructor(
    private readonly store: Store,
    private readonly publicUrl: string,
    private readonly log: Logger,
  ) {}

  /** Routes a request; returns false when the path is not one of ours. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    switch (path) {
      case "/":
        this.render(req, res, "text/html; charset=utf-8", indexHtml);
        return true;
      case "/feed.json":
        this.render(req, res, "application/feed+json; charset=utf-8", (items) =>
          JSON.stringify(jsonFeed(this.publicUrl, items)),
        );
        return true;
      case "/rss.xml":
        this.render(req, res, "application/rss+xml; charset=utf-8", (items) =>
          rssXml(this.publicUrl, items),
        );
        return true;
      case "/healthz":
        try {
          this.store.ping();
          res.writeHead(200).end("ok");
        } catch {
          res.writeHead(503).end("db unavailable");
        }
        return true;
      default:
        return false;
    }
  }

  // Bodies are cheap to render but not free to send: an ETag over the
  // rendered output lets feed readers polling on short intervals pay a 304
  // instead of the full document.
  private render(
    req: IncomingMessage,
    res: ServerResponse,
    contentType: string,
    body: (items: Item[]) => string,
  ): void {
    let payload: string;
    try {
      payload = body(this.store.listItems(PAGE_SIZE));
    } catch (err) {
      this.log.error("feed request failed", { error: String(err) });
      res.writeHead(500).end("internal error");
      return;
    }
    const etag = `"${createHash("sha256").update(payload).digest("hex").slice(0, 16)}"`;
    const headers = { "Content-Type": contentType, "Cache-Control": CACHE, ETag: etag };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : payload);
  }
}

function jsonFeed(publicUrl: string, items: Item[]): unknown {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "spawnwatcher — LLM model releases",
    home_page_url: publicUrl,
    feed_url: `${publicUrl}/feed.json`,
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      content_text: it.summaryMd,
      ...(it.sourceUrl ? { url: it.sourceUrl } : {}),
      date_published: rfc3339(it.publishedAt),
    })),
  };
}

function rssXml(publicUrl: string, items: Item[]): string {
  const rows = items
    .map(
      (it) => `    <item>
      <title>${esc(it.title)}</title>
      ${it.sourceUrl ? `<link>${esc(it.sourceUrl)}</link>` : ""}
      <guid>${esc(it.id)}</guid>
      <pubDate>${it.publishedAt.toUTCString()}</pubDate>
      <description>${esc(it.summaryMd)}</description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>spawnwatcher — LLM model releases</title>
    <link>${esc(publicUrl)}</link>
    <description>New and updated models from the major LLM providers, detected from the models.dev catalog.</description>
${rows}
  </channel>
</rss>
`;
}

function indexHtml(items: Item[]): string {
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const list =
    items.length === 0
      ? `<div class="empty">Nothing yet — the watcher reports here as soon as a provider ships something.</div>`
      : `<ol>
${items
  .map((it) => {
    const kind = it.kind === "model_added" ? "new model" : "update";
    const title = it.sourceUrl
      ? `<a href="${esc(it.sourceUrl)}" rel="noopener">${esc(it.title)}</a>`
      : esc(it.title);
    return `    <li>
      <div class="meta"><span class="kind">${kind}</span><span>${dateFmt.format(it.publishedAt)}</span></div>
      <h2>${title}</h2>
      <p>${esc(it.summaryMd)}</p>
    </li>`;
  })
  .join("\n")}
  </ol>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spawnwatcher — LLM model releases</title>
<link rel="alternate" type="application/feed+json" href="/feed.json">
<link rel="alternate" type="application/rss+xml" href="/rss.xml">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fcfcfc; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e4e4e4; --chip: #efefef;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101012; --fg: #e8e8e8; --muted: #9a9a9a; --line: #2a2a2e; --chip: #1c1c20; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  header h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  header p { margin: 0; color: var(--muted); font-size: .95rem; }
  header nav { margin-top: .6rem; font-size: .85rem; }
  header nav a { color: var(--muted); text-decoration: none; margin-right: .9rem; }
  header nav a:hover { color: var(--fg); }
  ol { list-style: none; margin: 2.25rem 0 0; padding: 0; }
  li { border-top: 1px solid var(--line); padding: 1.15rem 0; }
  .meta { font-size: .8rem; color: var(--muted); display: flex; gap: .6rem; align-items: baseline; }
  .kind { background: var(--chip); border-radius: 99px; padding: .05rem .55rem; }
  h2 { font-size: 1.02rem; margin: .3rem 0 .35rem; }
  h2 a { color: inherit; text-decoration: none; }
  h2 a:hover { text-decoration: underline; }
  li p { margin: 0; color: var(--muted); font-size: .93rem; }
  .empty { border-top: 1px solid var(--line); margin-top: 2.25rem; padding: 3rem 0; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<main>
  <header>
    <h1>spawnwatcher</h1>
    <p>New and updated models from the major LLM providers, watched via the models.dev catalog.</p>
    <nav><a href="/feed.json">JSON Feed</a><a href="/rss.xml">RSS</a></nav>
  </header>
  ${list}
</main>
</body>
</html>
`;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
