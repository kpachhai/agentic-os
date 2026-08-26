import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.js";
import { createApp } from "../server/index.js";

const LOOPBACK = { host: "127.0.0.1:4317" };

describe("API route contracts", () => {
  const app = createApp(loadConfig());

  it("answers health with a version and the bind host", async () => {
    const res = await app.request("http://127.0.0.1/api/health", {
      headers: LOOPBACK,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; host: string };
    expect(body.version).toBeTruthy();
    expect(body.host).toBe("127.0.0.1");
  });

  it("404s an unknown /api path instead of serving the SPA", async () => {
    const res = await app.request("http://127.0.0.1/api/nope", {
      headers: LOOPBACK,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("reports a missing data source as 503, naming the pillar and path", async () => {
    const app503 = createApp({
      ...loadConfig(),
      wrapsDir: "/no/such/wraps/dir",
    });
    const res = await app503.request("http://127.0.0.1/api/wraps", {
      headers: LOOPBACK,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; path: string };
    expect(body.error).toBe("source missing");
    expect(body.path).toBe("/no/such/wraps/dir");
  });

  it("degrades the search pillar like every other one when no source is left", async () => {
    // The index outlives its sources, so without a guard it answers 200 with real
    // excerpts and a document count for files that are no longer on disk, while
    // every other pillar on the same machine says 503. A stale hit presented as
    // current is worse than an empty answer, which is why this pillar cannot be
    // the one exception to the identical-degradation rule.
    const absent = createApp({
      ...loadConfig(),
      transcriptsDir: "/no/such/projects",
      engramVaultPath: "/no/such/vault",
      wrapsDir: "/no/such/wraps",
      frictionLogPath: "/no/such/friction.md",
    });
    for (const route of ["/api/index/stats", "/api/search?q=anything"]) {
      const res = await absent.request(`http://127.0.0.1${route}`, {
        headers: LOOPBACK,
      });
      expect(res.status, route).toBe(503);
      const body = (await res.json()) as { error: string; pillar: string; path: string };
      expect(body.error).toBe("source missing");
      expect(body.pillar).toBe("search index");
      expect(body.path).toContain("/no/such/projects");
    }
  });

  it("keeps searching while any one of the index sources is still present", async () => {
    // The negative control for the guard above. Requiring every source would make
    // a machine that has transcripts but no memory vault lose search entirely,
    // which is a regression dressed as strictness. Sources and cache are both
    // synthetic here so the answer does not depend on what this machine happens
    // to have.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-search-"));
    fs.mkdirSync(path.join(root, "projects"), { recursive: true });
    const partial = createApp({
      ...loadConfig(),
      transcriptsDir: path.join(root, "projects"),
      engramVaultPath: "/no/such/vault",
      wrapsDir: "/no/such/wraps",
      frictionLogPath: "/no/such/friction.md",
      indexPath: path.join(root, "index.db"),
    });
    try {
      const res = await partial.request("http://127.0.0.1/api/index/stats", {
        headers: LOOPBACK,
      });
      expect(res.status).toBe(200);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a launch prompt that is missing or not a string", async () => {
    for (const body of [{}, { prompt: "" }, { prompt: 42 }]) {
      const res = await app.request("http://127.0.0.1/api/launch", {
        method: "POST",
        headers: { ...LOOPBACK, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("404s an unknown launch id on fetch, stream, and cancel", async () => {
    const paths = [
      ["GET", "/api/launch/nope"],
      ["GET", "/api/launch/nope/stream"],
      ["POST", "/api/launch/nope/cancel"],
    ] as const;
    for (const [method, path] of paths) {
      const res = await app.request(`http://127.0.0.1${path}`, {
        method,
        headers: LOOPBACK,
      });
      expect(res.status).toBe(404);
    }
  });

  it("409s a cancel against a launch that already finished", async () => {
    const started = await app.request("http://127.0.0.1/api/launch", {
      method: "POST",
      headers: { ...LOOPBACK, "content-type": "application/json" },
      body: JSON.stringify({ smoke: true }),
    });
    const { launchId } = (await started.json()) as { launchId: string };

    // Drain the stream: it returns once the run reaches a terminal status.
    const stream = await app.request(
      `http://127.0.0.1/api/launch/${launchId}/stream`,
      { headers: LOOPBACK },
    );
    await stream.text();

    const res = await app.request(
      `http://127.0.0.1/api/launch/${launchId}/cancel`,
      { method: "POST", headers: LOOPBACK },
    );
    expect(res.status).toBe(409);
  }, 65000);
});
