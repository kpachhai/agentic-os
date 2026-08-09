import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { outcomeForSession, outcomesReport } from "../server/outcomes.js";

/** Synthetic only; the real store describes the operator's own sessions. */

let root = "";
let usageDir = "";
let transcriptsDir = "";

function writeMeta(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(usageDir, "session-meta");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      project_path: "/tmp/demo-project",
      start_time: "2026-08-01T10:00:00Z",
      duration_minutes: 42,
      user_message_count: 12,
      assistant_message_count: 20,
      lines_added: 130,
      lines_removed: 20,
      files_modified: 4,
      git_commits: 2,
      tool_errors: 1,
      ...overrides,
    }),
    "utf8",
  );
}

function writeFacets(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(usageDir, "facets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      underlying_goal: "harden the launcher bounds",
      goal_categories: { feature_implementation: 1 },
      outcome: "mostly_achieved",
      user_satisfaction_counts: { likely_satisfied: 2 },
      claude_helpfulness: "very_helpful",
      session_type: "single_task",
      friction_counts: { buggy_code: 1 },
      friction_detail: "one wrong turn early on",
      primary_success: "multi_file_changes",
      brief_summary: "tightened the launch bounds and covered them with tests",
      ...overrides,
    }),
    "utf8",
  );
}

function report() {
  return outcomesReport(usageDir, transcriptsDir);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-outcomes-"));
  usageDir = path.join(root, "usage-data");
  transcriptsDir = path.join(root, "projects");
  fs.mkdirSync(transcriptsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("outcomesReport", () => {
  it("names the path when the store was never generated", () => {
    expect(() => outcomesReport(path.join(root, "absent"), transcriptsDir)).toThrow(
      SourceMissingError,
    );
  });

  it("joins a judgement to the statistics for the same session", () => {
    writeMeta("s1");
    writeFacets("s1");

    const [session] = report().sessions;
    expect(session!.outcome).toBe("mostly_achieved");
    expect(session!.linesAdded).toBe(130);
    expect(session!.gitCommits).toBe(2);
    expect(session!.frictionCount).toBe(1);
  });

  it("distributes the judged categories", () => {
    writeMeta("s1");
    writeFacets("s1");
    writeMeta("s2");
    writeFacets("s2", { outcome: "not_achieved", claude_helpfulness: "very_helpful" });

    const result = report();
    expect(result.byOutcome).toEqual([
      { name: "mostly_achieved", count: 1 },
      { name: "not_achieved", count: 1 },
    ]);
    expect(result.byHelpfulness).toEqual([{ name: "very_helpful", count: 2 }]);
  });

  it("counts sessions that were measured but never judged", () => {
    // The store holds far more statistics files than judgements, and a reader
    // must not take the judged set for everything it knows about.
    writeMeta("s1");
    writeFacets("s1");
    writeMeta("s2");
    writeMeta("s3");

    const result = report();
    expect(result.sessions).toHaveLength(1);
    expect(result.unjudgedWithStats).toBe(2);
  });

  it("keeps a judgement whose statistics file is missing, without inventing figures", () => {
    writeFacets("s-orphan");

    const [session] = report().sessions;
    expect(session!.outcome).toBe("mostly_achieved");
    expect(session!.startedAt).toBe("");
    expect(session!.linesAdded).toBe(0);
    expect(session!.durationMinutes).toBe(0);
  });

  it("carries coverage so no figure reads as a whole-history claim", () => {
    writeMeta("s1");
    writeFacets("s1");
    fs.mkdirSync(path.join(transcriptsDir, "-tmp-demo"), { recursive: true });
    for (const name of ["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"]) {
      fs.writeFileSync(path.join(transcriptsDir, "-tmp-demo", name), "", "utf8");
    }

    const { coverage } = report();
    expect(coverage.facetsCount).toBe(1);
    expect(coverage.transcriptCount).toBe(4);
    expect(coverage.facetsGeneratedAt).not.toBeNull();
  });

  it("sorts newest first and sinks a session with no start time", () => {
    writeMeta("older", { start_time: "2026-07-01T10:00:00Z" });
    writeFacets("older");
    writeMeta("newer", { start_time: "2026-08-15T10:00:00Z" });
    writeFacets("newer");
    writeFacets("undated");

    expect(report().sessions.map((s) => s.sessionId)).toEqual([
      "newer",
      "older",
      "undated",
    ]);
  });
});

describe("outcomeForSession", () => {
  it("returns the judgement for one session", () => {
    writeMeta("s1");
    writeFacets("s1");
    expect(outcomeForSession(usageDir, transcriptsDir, "s1")?.outcome).toBe(
      "mostly_achieved",
    );
  });

  it("returns null for a session nobody judged, rather than a blank verdict", () => {
    writeMeta("s1");
    expect(outcomeForSession(usageDir, transcriptsDir, "s1")).toBeNull();
  });
});
