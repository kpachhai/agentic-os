import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { liveCwds, listLiveSessions } from "../server/live.js";

let dir = "";

/**
 * A PID that nothing holds. Chosen by probing rather than hardcoding, because a
 * hardcoded "surely dead" number can be handed to a real process at any time
 * and would make this suite fail for a reason unrelated to the code.
 */
function findDeadPid(): number {
  for (let candidate = 60000; candidate < 90000; candidate++) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no unused pid found in the probe range");
}

function writeSession(name: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-live-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("listLiveSessions", () => {
  it("reports a session whose process is running and heartbeat is fresh as live", () => {
    const now = Date.now();
    writeSession("own.json", {
      pid: process.pid,
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      cwd: "/tmp/project-a",
      name: "project-a-01",
      nameSource: "derived",
      kind: "interactive",
      entrypoint: "cli",
      version: "2.1.220",
      status: "busy",
      startedAt: now - 60_000,
      updatedAt: now - 1_000,
    });

    const [session] = listLiveSessions(dir);
    expect(session).toBeDefined();
    expect(session!.pid).toBe(process.pid);
    expect(session!.processAlive).toBe(true);
    expect(session!.live).toBe(true);
    expect(session!.cwd).toBe("/tmp/project-a");
    expect(session!.version).toBe("2.1.220");
    expect(session!.uptimeMs).toBeGreaterThanOrEqual(60_000);
  });

  it("reports a registration whose process is gone as not live", () => {
    const now = Date.now();
    writeSession("dead.json", {
      pid: findDeadPid(),
      sessionId: "bbbbbbbb-1111-2222-3333-444444444444",
      cwd: "/tmp/project-b",
      startedAt: now - 60_000,
      updatedAt: now - 1_000,
    });

    const [session] = listLiveSessions(dir);
    expect(session!.processAlive).toBe(false);
    expect(session!.live).toBe(false);
  });

  it("treats a live pid with a stale heartbeat as not live, because pids get reused", () => {
    const now = Date.now();
    writeSession("stale.json", {
      pid: process.pid,
      sessionId: "cccccccc-1111-2222-3333-444444444444",
      cwd: "/tmp/project-c",
      startedAt: now - 10 * 60 * 60 * 1000,
      updatedAt: now - 60 * 60 * 1000,
    });

    const [session] = listLiveSessions(dir);
    expect(session!.processAlive).toBe(true);
    expect(session!.live).toBe(false);
    expect(session!.heartbeatAgeMs).toBeGreaterThan(15 * 60 * 1000);
  });

  it("keeps stale registrations instead of dropping them silently", () => {
    const now = Date.now();
    writeSession("live.json", {
      pid: process.pid,
      sessionId: "dddddddd-1111-2222-3333-444444444444",
      cwd: "/tmp/live",
      startedAt: now - 1000,
      updatedAt: now,
    });
    writeSession("gone.json", {
      pid: findDeadPid(),
      sessionId: "eeeeeeee-1111-2222-3333-444444444444",
      cwd: "/tmp/gone",
      startedAt: now - 1000,
      updatedAt: now,
    });

    const sessions = listLiveSessions(dir);
    expect(sessions).toHaveLength(2);
    // Live entries sort ahead of dead ones so a reader sees what is running first.
    expect(sessions[0]!.live).toBe(true);
    expect(sessions[1]!.live).toBe(false);
  });

  it("skips a torn or malformed registration without failing the pillar", () => {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, "torn.json"), '{"pid": 123, "cwd": "/tmp/x"', "utf8");
    writeSession("nopid.json", { sessionId: "ffffffff", cwd: "/tmp/y" });
    writeSession("good.json", {
      pid: process.pid,
      sessionId: "99999999-1111-2222-3333-444444444444",
      cwd: "/tmp/good",
      startedAt: now - 1000,
      updatedAt: now,
    });

    const sessions = listLiveSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cwd).toBe("/tmp/good");
  });

  it("ignores non-json entries", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a session", "utf8");
    fs.mkdirSync(path.join(dir, "a-directory.json"));
    expect(listLiveSessions(dir)).toEqual([]);
  });

  it("names the missing directory rather than returning an empty list", () => {
    const absent = path.join(dir, "does-not-exist");
    expect(() => listLiveSessions(absent)).toThrow(SourceMissingError);
    try {
      listLiveSessions(absent);
    } catch (err) {
      expect((err as SourceMissingError).sourcePath).toBe(absent);
      expect((err as SourceMissingError).pillar).toBe("live sessions");
    }
  });
});

describe("liveCwds", () => {
  it("returns only the working directories of live sessions, deduplicated", () => {
    const now = Date.now();
    writeSession("a.json", {
      pid: process.pid,
      sessionId: "a1",
      cwd: "/tmp/shared",
      startedAt: now - 1000,
      updatedAt: now,
    });
    writeSession("b.json", {
      pid: process.pid,
      sessionId: "b1",
      cwd: "/tmp/shared",
      startedAt: now - 1000,
      updatedAt: now,
    });
    writeSession("c.json", {
      pid: findDeadPid(),
      sessionId: "c1",
      cwd: "/tmp/abandoned",
      startedAt: now - 1000,
      updatedAt: now,
    });

    // Two live sessions share one directory, which collapses to a single entry;
    // the dead session's directory is not claimed by anyone.
    expect(liveCwds(dir)).toEqual(["/tmp/shared"]);
  });
});
