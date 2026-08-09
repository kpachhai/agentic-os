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
