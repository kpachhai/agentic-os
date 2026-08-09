import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import {
  effectiveSettings,
  installedPlugins,
  mcpServers,
} from "../server/config-surface.js";

let root = "";

/** Synthetic fixtures only. Real config on a machine holds live credentials. */
function write(relativePath: string, body: unknown): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(body), "utf8");
  return filePath;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-cfg-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("effectiveSettings", () => {
  it("says which layer won an overridden key", () => {
    const userPath = write("user/settings.json", { model: "opus", tui: "dark" });
    write("project/.claude/settings.json", { model: "sonnet" });
    write("project/.claude/settings.local.json", { model: "haiku" });

    const { entries, layersFound } = effectiveSettings(
      userPath,
      path.join(root, "project"),
    );
    const model = entries.find((e) => e.key === "model")!;
    expect(model.value).toBe("haiku");
    expect(model.wonBy).toBe("project-local");
    // An override should be visible AS an override, not just as a final value.
    expect(model.setBy).toEqual(["user", "project", "project-local"]);
    expect(layersFound).toEqual(["user", "project", "project-local"]);
  });

  it("summarises a container instead of printing what is inside it", () => {
    // An env block holds credentials by design, so its contents are never shown.
    const userPath = write("user/settings.json", {
      env: { SOME_TOKEN: "live-credential", REGION: "us-east-1" },
      hooks: { Stop: [], PreToolUse: [], SessionStart: [] },
    });

    const { entries } = effectiveSettings(userPath);
    const env = entries.find((e) => e.key === "env")!;
    expect(env.rendered).toBe(false);
    expect(env.value).toBeNull();
    expect(env.summary).toBe("2 environment variables");
    expect(JSON.stringify(entries)).not.toContain("live-credential");

    expect(entries.find((e) => e.key === "hooks")!.summary).toBe("3 hook events");
  });

  it("reports an unrecognised key as set without showing its value", () => {
    // Fail closed: a key this file does not know about could hold anything.
    const userPath = write("user/settings.json", {
      someFutureKey: "live-credential-in-an-unknown-field",
    });
    const { entries } = effectiveSettings(userPath);
    const unknown = entries.find((e) => e.key === "someFutureKey")!;
    expect(unknown.rendered).toBe(false);
    expect(unknown.value).toBeNull();
    expect(unknown.summary).toContain("not shown");
    expect(JSON.stringify(entries)).not.toContain("live-credential-in-an-unknown-field");
  });

  it("does not print an allowlisted key that turns up holding an object", () => {
    // The allowlist is a claim about the value's shape as well as its name.
    const userPath = write("user/settings.json", {
      model: { nested: "live-credential" },
    });
    const { entries } = effectiveSettings(userPath);
    const model = entries.find((e) => e.key === "model")!;
    expect(model.rendered).toBe(false);
    expect(JSON.stringify(entries)).not.toContain("live-credential");
  });

  it("surfaces the retention key, because it bounds what other pillars can see", () => {
    const userPath = write("user/settings.json", { cleanupPeriodDays: 30 });
    const { entries } = effectiveSettings(userPath);
    expect(entries.find((e) => e.key === "cleanupPeriodDays")!.value).toBe(30);
  });

  it("names the missing source when no settings layer exists", () => {
    const absent = path.join(root, "user", "settings.json");
    expect(() => effectiveSettings(absent)).toThrow(SourceMissingError);
  });

  it("states that enterprise-managed policy is not covered", () => {
    const userPath = write("user/settings.json", { model: "opus" });
    // Reporting a partial precedence chain as complete would be worse than
    // saying plainly which layers this covers.
    expect(effectiveSettings(userPath).note).toMatch(/not read/i);
  });
});

describe("mcpServers", () => {
  it("reduces a URL to its host so an inline credential cannot escape", () => {
    const configPath = write("claude.json", {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://user:live-credential@mcp.example.test/v1?access_token=also-live", // pii-allow: synthetic credential this test asserts is stripped to a host
        },
      },
    });
    const { servers } = mcpServers(configPath);
    expect(servers[0]!.host).toBe("mcp.example.test");
    const rendered = JSON.stringify(servers);
    expect(rendered).not.toContain("live-credential");
    expect(rendered).not.toContain("also-live");
  });

  it("reports environment and header names without their values", () => {
    // The operator wants to know a token is configured, not what it is. All three
    // of these shapes appear in real MCP configuration.
    const configPath = write("claude.json", {
      mcpServers: {
        stdio: {
          type: "stdio",
          command: "/usr/local/bin/some-server",
          args: ["--flag", "value", "-e", "API_KEY=live-credential"],
          env: { SERVER_ACCESS_KEY: "live-credential" },
        },
        networked: {
          type: "http",
          url: "https://mcp.example.test",
          headers: { Authorization: "Bearer live-credential" },
        },
      },
    });

    const { servers } = mcpServers(configPath);
    const stdio = servers.find((s) => s.name === "stdio")!;
    expect(stdio.command).toBe("some-server");
    expect(stdio.argumentCount).toBe(4);
    expect(stdio.environmentKeys).toEqual(["SERVER_ACCESS_KEY"]);
    expect(stdio.carriesSecrets).toBe(true);

    const networked = servers.find((s) => s.name === "networked")!;
    expect(networked.headerKeys).toEqual(["Authorization"]);

    const rendered = JSON.stringify(servers);
    expect(rendered).not.toContain("live-credential");
    // The full command line is never echoed, so an inline assignment cannot leak.
    expect(rendered).not.toContain("API_KEY=");
    expect(rendered).not.toContain("/usr/local/bin");
  });

  it("does not echo a URL it could not parse", () => {
    const configPath = write("claude.json", {
      mcpServers: { broken: { type: "http", url: "://live-credential@@@" } },
    });
    const { servers } = mcpServers(configPath);
    expect(servers[0]!.host).toBe("unparseable");
    expect(JSON.stringify(servers)).not.toContain("live-credential");
  });

  it("returns an empty list when no servers are configured", () => {
    const configPath = write("claude.json", { other: true });
    expect(mcpServers(configPath).servers).toEqual([]);
  });

  it("names the missing source when the config file is absent", () => {
    expect(() => mcpServers(path.join(root, "nope.json"))).toThrow(SourceMissingError);
  });
});

describe("installedPlugins", () => {
  it("reports provenance and joins usage on", () => {
    const pluginsDir = path.join(root, "plugins");
    write("plugins/installed_plugins.json", {
      version: 1,
      plugins: {
        "some-tool@official": [
          {
            scope: "user",
            version: "unknown",
            gitCommitSha: "abcdef1234567890",
            installedAt: "2026-01-01T00:00:00Z",
            lastUpdated: "2026-02-01T00:00:00Z",
            installPath: "/home/someone/.claude/plugins/cache/some-tool",  // pii-allow: generic placeholder path in a synthetic fixture
          },
        ],
        "quiet-tool@community": [
          { scope: "user", version: "1.2.0", gitCommitSha: "0011223344556677" },
        ],
      },
    });
    const configPath = write("claude.json", {
      pluginUsage: { "some-tool@official": { usageCount: 12, lastUsedAt: 1785000000000 } },
    });

    const { plugins } = installedPlugins(pluginsDir, configPath);
    expect(plugins).toHaveLength(2);

    const used = plugins.find((p) => p.name === "some-tool")!;
    expect(used.marketplace).toBe("official");
    expect(used.usageCount).toBe(12);
    // Keyed on commit because an official-marketplace plugin reports an unknown
    // version while still carrying an exact commit.
    expect(used.commit).toBe("abcdef1234");
    expect(used.version).toBe("unknown");

    const unused = plugins.find((p) => p.name === "quiet-tool")!;
    expect(unused.usageCount).toBeNull();
    // Most-used first, so a never-used plugin sorts last.
    expect(plugins[0]!.name).toBe("some-tool");
  });

  it("never renders an install path, which contains the home directory", () => {
    const pluginsDir = path.join(root, "plugins");
    write("plugins/installed_plugins.json", {
      plugins: {
        "t@m": [{ installPath: "/home/someone/.claude/plugins/cache/t", scope: "user" }],  // pii-allow: generic placeholder path in a synthetic fixture
      },
    });
    const configPath = write("claude.json", {});
    const rendered = JSON.stringify(installedPlugins(pluginsDir, configPath).plugins);
    expect(rendered).not.toContain("/home/someone");
    expect(rendered).not.toContain("installPath");
  });

  it("names the missing source when the manifest is absent", () => {
    const configPath = write("claude.json", {});
    expect(() => installedPlugins(path.join(root, "nope"), configPath)).toThrow(
      SourceMissingError,
    );
  });
});
