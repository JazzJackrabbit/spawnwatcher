import { describe, expect, it } from "vitest";

import { backoff, WebhookClient, type Message } from "../src/deliver.js";
import { testServer } from "./helpers.js";

function msg(): Message {
  return {
    id: "sw_test",
    kind: "model_added",
    title: "t",
    summary_md: "s",
    agent_summary: { model_id: "m" },
    source_url: "",
    published_at: "2026-08-09T12:00:00Z",
  };
}

describe("WebhookClient", () => {
  it("authorizes and posts to the ingest path", async () => {
    let gotAuth = "";
    let gotPath = "";
    const srv = await testServer((req, res) => {
      gotAuth = String(req.headers.authorization ?? "");
      gotPath = req.url ?? "";
      res.writeHead(201).end();
    });
    try {
      await new WebhookClient(srv.url, "secret").send(msg());
      expect(gotAuth).toBe("Bearer secret");
      expect(gotPath).toBe("/api/v1/watcher/messages");
    } finally {
      await srv.close();
    }
  });

  it("treats redelivery (200) as success", async () => {
    const srv = await testServer((_req, res) => res.writeHead(200).end());
    try {
      await expect(new WebhookClient(srv.url, "s").send(msg())).resolves.toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("throws on rejection so the caller retries", async () => {
    let calls = 0;
    const srv = await testServer((_req, res) => {
      calls++;
      if (calls === 1) res.writeHead(500).end("boom");
      else res.writeHead(201).end();
    });
    try {
      const client = new WebhookClient(srv.url, "s");
      await expect(client.send(msg())).rejects.toThrow("status 500");
      // The caller's retry succeeds against a recovered receiver.
      await expect(client.send(msg())).resolves.toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});

describe("backoff", () => {
  it("grows exponentially from one minute and caps at six hours", () => {
    expect(backoff(0)).toBe(60_000);
    expect(backoff(3)).toBe(8 * 60_000);
    expect(backoff(50)).toBe(6 * 3_600_000);
  });
});
