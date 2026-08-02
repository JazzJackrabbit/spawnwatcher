import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { parseCatalog, type Catalog } from "../src/catalog.js";
import type { Logger } from "../src/watcher.js";

export function fixture(name: string): Buffer {
  return readFileSync(join(import.meta.dirname, "fixtures", name));
}

export function fixtureCatalog(name: string): Catalog {
  return parseCatalog(fixture(name));
}

export const quietLog: Logger = { info() {}, warn() {}, error() {} };

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Boots an HTTP server on an ephemeral port, httptest-style. */
export async function testServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Serves swappable api.json bodies with ETags. */
export class CatalogServer {
  private body: Buffer = Buffer.alloc(0);
  private etag = "";

  set(body: Buffer, etag: string): void {
    this.body = body;
    this.etag = etag;
  }

  handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers["if-none-match"] === this.etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { ETag: this.etag }).end(this.body);
  };
}
