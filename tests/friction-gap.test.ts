import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { frictionGapReport } from "../server/friction-gap.js";
import { readUsageData } from "../server/usage-data.js";

/**
 * Synthetic only. The real store is the operator's own history, and the whole
 * point of the pillar is that it reads what a model wrote about their sessions.
 */

let root = "";
let usageDir = "";
let frictionLog = "";
let transcriptsDir = "";

function writeMeta(sessionId: string, startTime: string, durationMinutes: number): void {
  const dir = path.join(usageDir, "session-meta");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      project_path: "/tmp/demo",
      start_time: startTime,
      duration_minutes: durationMinutes,
      tool_counts: { Read: 3 },
    }),
    "utf8",
  );
}

function writeFacets(
  sessionId: string,
  frictionCounts: Record<string, number>,
  overrides: Record<string, unknown> = {},
): void {
  const dir = path.join(usageDir, "facets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      outcome: "not_achieved",
      claude_helpfulness: "slightly_helpful",
      session_type: "single_task",
      friction_counts: frictionCounts,
      friction_detail: "the command exited without writing anything",
      primary_success: "none",
      brief_summary: "a run that produced no output",
      ...overrides,
    }),
    "utf8",
  );
}

function writeLog(lines: string[]): void {
  fs.writeFileSync(frictionLog, lines.join("\n"), "utf8");
}

function report() {
  return frictionGapReport(usageDir, transcriptsDir, frictionLog, 14);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-gap-"));
  usageDir = path.join(root, "usage-data");
  frictionLog = path.join(root, "friction.md");
  transcriptsDir = path.join(root, "projects");
  fs.mkdirSync(transcriptsDir, { recursive: true });
  writeLog([]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readUsageData", () => {
  it("reports the path when the store was never generated", () => {
    expect(() => readUsageData(path.join(root, "absent"), transcriptsDir)).toThrow(
      SourceMissingError,
    );
  });

  it("counts what it covers rather than implying completeness", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeMeta("s2", "2026-08-01T12:00:00Z", 30);
    writeFacets("s1", { buggy_code: 1 });
    fs.mkdirSync(path.join(transcriptsDir, "-tmp-demo"), { recursive: true });
    for (const name of ["a.jsonl", "b.jsonl", "c.jsonl"]) {
      fs.writeFileSync(path.join(transcriptsDir, "-tmp-demo", name), "", "utf8");
    }

    const usage = readUsageData(usageDir, transcriptsDir);
    expect(usage.coverage.sessionMetaCount).toBe(2);
    expect(usage.coverage.facetsCount).toBe(1);
    expect(usage.coverage.transcriptCount).toBe(3);
    expect(usage.coverage.generatedAt).not.toBeNull();
  });

  it("counts an unreadable file instead of losing the pillar to it", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    fs.writeFileSync(path.join(usageDir, "session-meta", "broken.json"), "{ nope", "utf8");

    const usage = readUsageData(usageDir, transcriptsDir);
    expect(usage.meta.size).toBe(1);
    expect(usage.coverage.unreadableFiles).toBe(1);
  });
});

describe("frictionGapReport", () => {
  it("flags a session whose friction never reached the log", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeFacets("s1", { missing_configuration: 1 });

    const result = report();
    expect(result.unloggedCount).toBe(1);
    expect(result.loggedCount).toBe(0);
    expect(result.entries[0]!.status).toBe("unlogged");
    expect(result.entries[0]!.categories).toEqual([
      { name: "missing_configuration", count: 1 },
    ]);
  });

  it("treats a session the operator was capturing during as logged", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeFacets("s1", { buggy_code: 2 });
    writeLog(["2026-08-01T10:15:00Z | [Friction] | the axis overflowed"]);

    const result = report();
    expect(result.loggedCount).toBe(1);
    expect(result.unloggedCount).toBe(0);
    expect(result.entries[0]!.loggedInWindow).toBe(1);
  });

  it("counts an entry written within the grace hours after the session", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeFacets("s1", { buggy_code: 1 });
    // Six hours after the session ended: still the same working day, and the
    // operator writing it up afterwards is the normal case.
    writeLog(["2026-08-01T16:30:00Z | [Friction] | wrote it up later"]);

    expect(report().loggedCount).toBe(1);
  });

  it("does not let an entry from days later count as capture", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeFacets("s1", { buggy_code: 1 });
    writeLog(["2026-08-05T10:00:00Z | [Friction] | unrelated, days later"]);

    expect(report().unloggedCount).toBe(1);
  });

  it("reads a bare date as the whole day, not as midnight", () => {
    // The log's section format dates an entry to the day rather than the
    // instant, and 35 real entries use it. Read as midnight, a bare date sorts
    // before every session that started after 00:00, so a whole day's captures
    // would count for nothing and those sessions would all read as unlogged.
    writeMeta("s1", "2026-08-01T14:00:00Z", 30);
    writeFacets("s1", { buggy_code: 1 });
    writeLog(["## 2026-08-01", "", "[Friction] logged with a bare date"]);

    expect(report().loggedCount).toBe(1);
  });

  it("reports a session it cannot place in time apart from the counts", () => {
    // Judged friction but no statistics file, so no window exists. Not
    // checkable is not the same claim as not logged.
    writeFacets("s-nowindow", { buggy_code: 1 });

    const result = report();
    expect(result.unwindowedCount).toBe(1);
    expect(result.unloggedCount).toBe(0);
    expect(result.entries).toHaveLength(0);
  });

  it("ignores a session the analysis found no friction in", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeFacets("s1", {}, { outcome: "fully_achieved" });

    const result = report();
    expect(result.entries).toHaveLength(0);
    expect(result.unloggedCount).toBe(0);
  });

  it("carries coverage so the answer cannot read as a whole-history claim", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeMeta("s2", "2026-08-02T10:00:00Z", 30);
    writeFacets("s1", { buggy_code: 1 });

    const result = report();
    expect(result.coverage.facetsCount).toBe(1);
    expect(result.coverage.sessionMetaCount).toBe(2);
    expect(result.graceHours).toBeGreaterThan(0);
  });

  it("reports the path when either side of the comparison is missing", () => {
    writeMeta("s1", "2026-08-01T10:00:00Z", 30);
    writeFacets("s1", { buggy_code: 1 });
    fs.rmSync(frictionLog);

    expect(() => report()).toThrow(SourceMissingError);
  });
});
