import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.js";
import { narrowAllowlist } from "../server/launcher.js";
import { createApp } from "../server/index.js";

const config = loadConfig();

describe("allowlist narrowing (never widens)", () => {
  const base = "Read,Grep,Bash";
  it("keeps the full default when no override is given", () => {
    expect(narrowAllowlist(base, undefined)).toBe("Read,Grep,Bash");
    expect(narrowAllowlist(base, "")).toBe("Read,Grep,Bash");
  });
  it("intersects an override down to a subset", () => {
    expect(narrowAllowlist(base, "Read,Grep")).toBe("Read,Grep");
  });
  it("drops tools not in the default (cannot self-grant)", () => {
    expect(narrowAllowlist(base, "Read,WebFetch,Task")).toBe("Read");
    expect(narrowAllowlist(base, "WebFetch")).toBe("");
  });
});

describe("API request guard (CSRF + DNS-rebinding)", () => {
  const app = createApp(config);

  it("rejects a non-loopback Host header (rebinding)", async () => {
    const res = await app.request("http://127.0.0.1/api/health", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a cross-origin request (CSRF)", async () => {
    const res = await app.request("http://127.0.0.1/api/health", {
      headers: { host: "127.0.0.1:4317", origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a same-origin loopback request", async () => {
    const res = await app.request("http://127.0.0.1/api/health", {
      headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
    });
    expect(res.status).toBe(200);
  });

  it("blocks a cross-site POST to the launch endpoint", async () => {
    const res = await app.request("http://127.0.0.1/api/launch", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "https://evil.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "/whoami" }),
    });
    expect(res.status).toBe(403);
  });
});
