import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { delegationReport } from "../server/delegation.js";
import { clearScanCache } from "../server/transcripts.js";

/**
 * Synthetic fixtures only. The real corpus is the operator's own session history,
 * and a dispatch prompt is their prose about their own work, so nothing here is
 * copied from it: these files are hand-written to the shapes the real records use.
 */

let root = "";

function transcriptsDir(): string {
  return path.join(root, "projects");
}

/** A fixed read time, so a trend assertion does not depend on the day it runs. */
const READ_AT = Date.parse("2026-07-15T12:00:00.000Z");

type DispatchInput = {
  subagent_type?: string;
  prompt?: unknown;
  description?: string;
  model?: string;
  run_in_background?: boolean;
  isolation?: string;
};

type DispatchSpec = {
  id?: string;
  toolName?: string;
  timestamp?: string | null;
  input: DispatchInput;
  /** Record type the call is written under; real dispatches ride assistant turns. */
  recordType?: string;
};

/** One assistant record per dispatch, which is how Claude Code writes them. */
function dispatchRecord(spec: DispatchSpec): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: spec.recordType ?? "assistant",
    uuid: `uuid-${spec.id ?? "x"}`,
    isSidechain: false,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "handing this off" },
        {
          type: "tool_use",
          id: spec.id ?? "toolu_1",
          name: spec.toolName ?? "Agent",
          input: spec.input,
        },
      ],
    },
  };
  if (spec.timestamp !== null) {
    record.timestamp = spec.timestamp ?? "2026-07-01T10:00:00.000Z";
  }
  return record;
}

type ResultSpec = {
  /** tool_use id of the dispatch this answers. */
  id: string;
  /** Launch status as the tool result records it, or absent when it carried none. */
  status?: string;
  isAsync?: boolean;
  agentId?: string;
  timestamp?: string;
};

/**
 * The record that answers a dispatch. This is where the launch mode actually
 * lives: the status says whether the run was detached or waited for, where the
 * request's own flag is opt-out and absent more often than not.
 */
function dispatchResultRecord(spec: ResultSpec): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (spec.status !== undefined) result.status = spec.status;
  if (spec.isAsync !== undefined) result.isAsync = spec.isAsync;
  if (spec.agentId !== undefined) result.agentId = spec.agentId;
  return {
    type: "user",
    uuid: `uuid-result-${spec.id}`,
    isSidechain: false,
    timestamp: spec.timestamp ?? "2026-07-01T10:00:05.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: spec.id, content: "done" }],
    },
    toolUseResult: result,
  };
}

function writeSession(
  projectDir: string,
  sessionId: string,
  records: Array<Record<string, unknown>>,
): void {
  const dir = path.join(transcriptsDir(), projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
}

/** One turn of a delegated run, as a subagent transcript records it. */
function delegatedTurn(spec: {
  agentType?: string;
  agentId?: string;
  timestamp?: string;
  outputTokens?: number;
  toolCalls?: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: "working on it" },
  ];
  for (let index = 0; index < (spec.toolCalls ?? 0); index++) {
    content.push({
      type: "tool_use",
      id: `sub_tool_${index}`,
      name: "Read",
      input: { file_path: "/tmp/x" },
    });
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (spec.outputTokens !== undefined) {
    message.usage = { input_tokens: 10, output_tokens: spec.outputTokens };
  }
  const record: Record<string, unknown> = {
    type: "assistant",
    isSidechain: true,
    message,
  };
  if (spec.agentType !== undefined) record.attributionAgent = spec.agentType;
  if (spec.agentId !== undefined) record.agentId = spec.agentId;
  if (spec.timestamp !== undefined) record.timestamp = spec.timestamp;
  return record;
}

/** A subagent transcript beside a session: the delegated work that came back. */
function writeSubagentTranscript(
  projectDir: string,
  ownerSessionId: string,
  fileName: string,
  records: Array<Record<string, unknown>>,
  underWorkflows = false,
): void {
  const dir = underWorkflows
    ? path.join(transcriptsDir(), projectDir, ownerSessionId, "subagents", "workflows", "wf_abc")
    : path.join(transcriptsDir(), projectDir, ownerSessionId, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, fileName),
    `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf8",
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-delegation-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("delegationReport", () => {
  it("counts dispatches per subagent type, busiest first", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "code-reviewer", prompt: "a".repeat(100) } }),
      dispatchRecord({ id: "t2", input: { subagent_type: "general-purpose", prompt: "b".repeat(200) } }),
      dispatchRecord({ id: "t3", input: { subagent_type: "general-purpose", prompt: "c".repeat(300) } }),
    ]);

    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(3);
    expect(report.totals.subagentTypes).toBe(2);
    expect(report.bySubagentType.map((row) => row.subagentType)).toEqual([
      "general-purpose",
      "code-reviewer",
    ]);
    expect(report.bySubagentType[0]!.dispatches).toBe(2);
  });

  it("reports the projects a specialist was used in", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    writeSession("-tmp-beta", "bbbbbbbb-2222-4333-8444-555555555555", [
      dispatchRecord({ id: "t2", input: { subagent_type: "debugger", prompt: "y" } }),
      dispatchRecord({ id: "t3", input: { subagent_type: "debugger", prompt: "z" } }),
    ]);

    const [row] = delegationReport(transcriptsDir()).bySubagentType;
    expect(row!.dispatches).toBe(3);
    expect(row!.sessions).toBe(2);
    // Busiest project first, and the label is the decoded form of the same dir.
    expect(row!.projects.map((p) => p.projectDir)).toEqual(["-tmp-beta", "-tmp-alpha"]);
    expect(row!.projects[0]!.dispatches).toBe(2);
    expect(row!.projects[0]!.label).toBe("/tmp-beta");
  });

  it("reports a prompt length and never the prompt itself", () => {
    // A dispatch prompt is the operator's own prose about their own work. The
    // length answers how much briefing a handoff took; the text is not needed.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({
        id: "t1",
        input: {
          subagent_type: "researcher",
          prompt: "PROMPT-BODY-THAT-MUST-NOT-APPEAR",
          description: "DESCRIPTION-THAT-MUST-NOT-APPEAR",
        },
      }),
    ]);

    const report = delegationReport(transcriptsDir());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("PROMPT-BODY-THAT-MUST-NOT-APPEAR");
    expect(serialized).not.toContain("DESCRIPTION-THAT-MUST-NOT-APPEAR");
    expect(report.bySubagentType[0]!.medianPromptChars).toBe(
      "PROMPT-BODY-THAT-MUST-NOT-APPEAR".length,
    );
  });

  it("takes the median prompt length as a length one dispatch really had", () => {
    // Never an average of two neighbours, so the number is an observed size.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "general-purpose", prompt: "a".repeat(10) } }),
      dispatchRecord({ id: "t2", input: { subagent_type: "general-purpose", prompt: "b".repeat(400) } }),
      dispatchRecord({ id: "t3", input: { subagent_type: "general-purpose", prompt: "c".repeat(90) } }),
    ]);
    expect(delegationReport(transcriptsDir()).totals.medianPromptChars).toBe(90);
  });

  it("reports a missing prompt as absent rather than as zero characters", () => {
    // Zero would read as an empty briefing, which is a different claim.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "general-purpose" } }),
    ]);
    const [row] = delegationReport(transcriptsDir()).bySubagentType;
    expect(row!.medianPromptChars).toBeNull();
    expect(row!.promptCharsMissing).toBe(1);
  });

  it("counts a model override only when the dispatch named one", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "general-purpose", prompt: "x", model: "sonnet" } }),
      dispatchRecord({ id: "t2", input: { subagent_type: "general-purpose", prompt: "y" } }),
    ]);
    const [row] = delegationReport(transcriptsDir()).bySubagentType;
    expect(row!.dispatches).toBe(2);
    expect(row!.modelOverrides).toBe(1);
    expect(row!.modelsRequested).toEqual(["sonnet"]);
  });

  it("counts worktree isolation only when the dispatch asked for it", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "general-purpose", prompt: "x", isolation: "worktree" } }),
      dispatchRecord({ id: "t2", input: { subagent_type: "general-purpose", prompt: "y" } }),
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(2);
    expect(report.totals.worktreeIsolatedDispatches).toBe(1);
  });

  it("reads a detached launch from the paired result, not from the request's flag", () => {
    // The request's background parameter is opt-out: absent means the run was
    // detached, so counting only an explicit true reported a third of the detached
    // launches and read the rest as having run inline. The paired result says what
    // the launch actually was, in a status the same scan already streams.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "general-purpose", prompt: "a" } }),
      dispatchResultRecord({ id: "t1", status: "async_launched", isAsync: true, agentId: "a1" }),
      dispatchRecord({ id: "t2", input: { subagent_type: "general-purpose", prompt: "b" } }),
      dispatchResultRecord({ id: "t2", status: "teammate_spawned", agentId: "a2" }),
      dispatchRecord({ id: "t3", input: { subagent_type: "general-purpose", prompt: "c", run_in_background: true } }),
      dispatchResultRecord({ id: "t3", status: "completed", agentId: "a3" }),
      dispatchRecord({ id: "t4", input: { subagent_type: "general-purpose", prompt: "d", run_in_background: false } }),
      dispatchResultRecord({ id: "t4", status: "completed", agentId: "a4" }),
      dispatchRecord({ id: "t5", input: { subagent_type: "general-purpose", prompt: "e" } }),
    ]);

    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(5);
    // Two detached by status, two inline, and one with nothing to read it from.
    expect(report.totals.backgroundDispatches).toBe(2);
    expect(report.totals.inlineDispatches).toBe(2);
    expect(report.totals.launchModeUnknownDispatches).toBe(1);
    const [row] = report.bySubagentType;
    expect(row!.backgroundDispatches).toBe(2);
    expect(row!.inlineDispatches).toBe(2);
    expect(row!.launchModeUnknownDispatches).toBe(1);
    // The request's own flag is kept as its own figure and never stands in for the
    // outcome: one dispatch asked for background and did not get it.
    expect(report.evidence.dispatchesRequestingBackgroundExplicitly).toBe(1);
    expect(report.evidence.dispatchesRequestingInlineExplicitly).toBe(1);
    expect(report.evidence.dispatchesWithNoBackgroundFlag).toBe(3);
    expect(report.evidence.dispatchesWithoutPairedResult).toBe(1);
    expect(report.evidence.dispatchOutcomeStatuses).toEqual([
      { status: "completed", dispatches: 2 },
      { status: "async_launched", dispatches: 1 },
      { status: "teammate_spawned", dispatches: 1 },
    ]);
  });

  it("keeps the three launch modes adding up to the dispatch count", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "a" } }),
      dispatchResultRecord({ id: "t1", status: "async_launched", agentId: "a1" }),
      dispatchRecord({ id: "t2", input: { subagent_type: "researcher", prompt: "b" } }),
    ]);
    const { totals } = delegationReport(transcriptsDir());
    expect(
      totals.backgroundDispatches + totals.inlineDispatches + totals.launchModeUnknownDispatches,
    ).toBe(totals.dispatches);
  });

  it("falls back to the result's own asynchrony when the status is unfamiliar", () => {
    // The status vocabulary belongs to Claude Code and can grow. An unrecognised
    // value must not be sorted into either side on a guess, so the result's own
    // isAsync answers first and an unreadable result stays unknown.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "a" } }),
      dispatchResultRecord({ id: "t1", status: "handed_to_a_new_thing", isAsync: true, agentId: "a1" }),
      dispatchRecord({ id: "t2", input: { subagent_type: "debugger", prompt: "b" } }),
      dispatchResultRecord({ id: "t2", status: "handed_to_a_new_thing", isAsync: false, agentId: "a2" }),
      dispatchRecord({ id: "t3", input: { subagent_type: "debugger", prompt: "c" } }),
      dispatchResultRecord({ id: "t3", status: "handed_to_a_new_thing", agentId: "a3" }),
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.totals.backgroundDispatches).toBe(1);
    expect(report.totals.inlineDispatches).toBe(1);
    expect(report.totals.launchModeUnknownDispatches).toBe(1);
    // The unfamiliar status is reported rather than hidden behind the fallback.
    expect(report.evidence.dispatchOutcomeStatuses).toEqual([
      { status: "handed_to_a_new_thing", dispatches: 3 },
    ]);
  });

  it("ignores a result that belongs to some other tool", () => {
    // A backgrounded shell command reports the same async status. Pairing is by
    // tool-call id, so one of those must not move a dispatch's launch mode.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "a" } }),
      {
        type: "user",
        timestamp: "2026-07-01T10:00:05.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "bash_1", content: "ok" }],
        },
        toolUseResult: { status: "async_launched", shellId: "sh-1" },
      },
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.totals.backgroundDispatches).toBe(0);
    expect(report.totals.launchModeUnknownDispatches).toBe(1);
    expect(report.evidence.dispatchesWithoutPairedResult).toBe(1);
  });

  it("counts a replayed dispatch record once", () => {
    // A resumed or forked session can replay earlier records. A replay is not a
    // second dispatch, and double-counting would inflate the one figure this
    // pillar exists to report.
    const record = dispatchRecord({ id: "toolu_same", input: { subagent_type: "debugger", prompt: "x" } });
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [record]);
    writeSession("-tmp-alpha", "bbbbbbbb-2222-4333-8444-555555555555", [record, { ...record, type: "attachment" }]);

    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(1);
    expect(report.evidence.duplicateDispatchRecordsIgnored).toBe(2);
  });

  it("recognises a dispatch by its input shape when the tool has been renamed", () => {
    // The tool name has already changed once between installs, and answering "no
    // delegation" because of a rename is the one wrong answer that matters here.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", toolName: "SomeFutureName", input: { subagent_type: "researcher", prompt: "x" } }),
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(1);
    expect(report.evidence.toolNames).toEqual(["SomeFutureName"]);
  });

  it("still counts a known dispatch tool that records no subagent type", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", toolName: "Task", input: { prompt: "x" } }),
    ]);
    const [row] = delegationReport(transcriptsDir()).bySubagentType;
    expect(row!.subagentType).toBe("(unspecified)");
    expect(row!.dispatches).toBe(1);
  });

  it("ignores tool calls that are not dispatches", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: {
          content: [
            { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/tmp/x" } },
            { type: "tool_use", id: "r2", name: "TaskCreate", input: { subject: "do a thing" } },
            { type: "tool_use", id: "r3", name: "TaskUpdate", input: { taskId: "1" } },
          ],
        },
      },
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(0);
    expect(report.bySubagentType).toEqual([]);
  });

  it("records first and last dispatch per specialist", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "2026-05-02T08:00:00.000Z", input: { subagent_type: "researcher", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: "2026-07-20T09:30:00.000Z", input: { subagent_type: "researcher", prompt: "y" } }),
    ]);
    const [row] = delegationReport(transcriptsDir()).bySubagentType;
    expect(row!.firstDispatchAt).toBe("2026-05-02T08:00:00.000Z");
    expect(row!.lastDispatchAt).toBe("2026-07-20T09:30:00.000Z");
  });

  it("fills a quiet month with zero so a gap in the habit is visible", () => {
    // Listing only active months would draw a two-month pause as a continuous
    // line, which is the opposite of what a trend gets read for.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "2026-04-10T10:00:00.000Z", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: "2026-07-10T10:00:00.000Z", input: { subagent_type: "debugger", prompt: "y" } }),
      dispatchRecord({ id: "t3", timestamp: "2026-07-11T10:00:00.000Z", input: { subagent_type: "debugger", prompt: "z" } }),
    ]);
    const report = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(report.byMonth).toEqual([
      { month: "2026-04", dispatches: 1 },
      { month: "2026-05", dispatches: 0 },
      { month: "2026-06", dispatches: 0 },
      { month: "2026-07", dispatches: 2 },
    ]);
  });

  it("zero-fills the quiet months between the last dispatch and the read", () => {
    // Stopping at the last dispatch made the final bar always non-zero, so a habit
    // that stopped last winter drew as a current one. The trailing gap is the one
    // that most needs to be visible.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "2026-01-10T10:00:00.000Z", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: "2026-02-10T10:00:00.000Z", input: { subagent_type: "debugger", prompt: "y" } }),
    ]);
    const report = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(report.byMonth).toEqual([
      { month: "2026-01", dispatches: 1 },
      { month: "2026-02", dispatches: 1 },
      { month: "2026-03", dispatches: 0 },
      { month: "2026-04", dispatches: 0 },
      { month: "2026-05", dispatches: 0 },
      { month: "2026-06", dispatches: 0 },
      { month: "2026-07", dispatches: 0 },
    ]);
    expect(report.evidence.trendThroughMonth).toBe("2026-07");
  });

  it("crosses a year boundary without inventing a month", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "2025-12-31T23:00:00.000Z", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: "2026-01-01T01:00:00.000Z", input: { subagent_type: "debugger", prompt: "y" } }),
    ]);
    const report = delegationReport(transcriptsDir(), {
      nowMs: Date.parse("2026-01-20T00:00:00.000Z"),
    });
    expect(report.byMonth.map((m) => m.month)).toEqual(["2025-12", "2026-01"]);
  });

  it("bounds the trend so one absurd timestamp cannot inflate the payload", () => {
    // Date.parse accepts a year in the hundreds, and a bucket per month from there
    // to now is tens of thousands of them: response size became a function of one
    // record's content rather than of the corpus. The window is capped and what
    // falls outside it is counted.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "0001-02-03T00:00:00.000Z", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: "2026-07-01T00:00:00.000Z", input: { subagent_type: "debugger", prompt: "y" } }),
    ]);
    const report = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(report.byMonth.length).toBe(report.evidence.trendMonthCap);
    expect(report.byMonth.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(report.byMonth).length).toBeLessThan(10_000);
    expect(report.byMonth[report.byMonth.length - 1]).toEqual({
      month: "2026-07",
      dispatches: 1,
    });
    // The clamp is reported, so the missing dispatch is not simply gone.
    expect(report.evidence.trendMonthsOmitted).toBeGreaterThan(24_000);
    expect(report.evidence.dispatchesBeforeTrendWindow).toBe(1);
    expect(report.limitation).toMatch(/monthly trend holds at most 120 months/);
  });

  it("gives a future-dated dispatch no bucket and says so", () => {
    // A clock skew or a mistyped year must not extend the trend past the month it
    // was read in, and must not disappear either.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "2026-07-01T00:00:00.000Z", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: "2031-01-01T00:00:00.000Z", input: { subagent_type: "debugger", prompt: "y" } }),
    ]);
    const report = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(report.byMonth).toEqual([{ month: "2026-07", dispatches: 1 }]);
    expect(report.evidence.dispatchesAfterTrendWindow).toBe(1);
    expect(report.limitation).toMatch(/dated after the month this was read in/);
  });

  it("keeps the monthly trend reconcilable with the total", () => {
    // A dispatch with no timestamp cannot be placed in a month. It is still a
    // dispatch, so it is counted in the total and reported as unplaceable rather
    // than dropped or stamped with now.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "2026-07-01T10:00:00.000Z", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchRecord({ id: "t2", timestamp: null, input: { subagent_type: "debugger", prompt: "y" } }),
    ]);
    const report = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    const placed = report.byMonth.reduce((sum, month) => sum + month.dispatches, 0);
    expect(report.totals.dispatches).toBe(2);
    expect(report.evidence.dispatchesWithoutTimestamp).toBe(1);
    expect(placed).toBe(
      report.totals.dispatches -
        report.evidence.dispatchesWithoutTimestamp -
        report.evidence.dispatchesBeforeTrendWindow -
        report.evidence.dispatchesAfterTrendWindow,
    );
    expect(report.bySubagentType[0]!.firstDispatchAt).toBe("2026-07-01T10:00:00.000Z");
  });

  it("does not stamp an unparseable timestamp with a real date", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", timestamp: "not-a-date", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.totals.firstDispatchAt).toBeNull();
    expect(report.byMonth).toEqual([]);
    expect(report.evidence.dispatchesWithoutTimestamp).toBe(1);
  });

  it("counts the marker without concluding anything about records that carry none", () => {
    // The wording used to say no subagent turns existed anywhere as soon as one
    // record carried the marker, which is a categorical claim over records that
    // never carried it. The counts are reported; the conclusion is not drawn.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
      { type: "file-history-snapshot", timestamp: "2026-07-01T10:01:00.000Z" },
      { type: "queue-operation", timestamp: "2026-07-01T10:02:00.000Z" },
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.evidence.sessionRecordsRead).toBe(3);
    expect(report.evidence.recordsCarryingSidechainFlag).toBe(1);
    expect(report.evidence.sessionRecordsWithoutSidechainFlag).toBe(2);
    expect(report.evidence.sidechainRecordsInSessionTranscripts).toBe(0);
    expect(report.limitation).toMatch(/0 of the 3 session records read are marked/);
    expect(report.limitation).toMatch(/leaving 2 that say nothing about it/);
    expect(report.limitation).not.toMatch(/no subagent turns/i);
    expect(report.limitation).not.toMatch(/the file saying no rather than the field being missing/);
  });

  it("says the marker is absent rather than reading anything into it", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "debugger", prompt: "x" } },
          ],
        },
      },
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.evidence.recordsCarryingSidechainFlag).toBe(0);
    expect(report.limitation).toMatch(/neither confirm nor deny a subagent turn/);
  });

  it("reports what the delegated work produced, per specialist", () => {
    // The delegated turns are on disk in nested directories the session reader
    // skips. Claiming subagent output is unknowable while those files sit there
    // unread was the largest thing this report got wrong.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
      dispatchResultRecord({ id: "t1", status: "async_launched", agentId: "agent-7" }),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "agent-aaa.jsonl", [
      delegatedTurn({
        agentType: "debugger",
        agentId: "agent-7",
        timestamp: "2026-07-01T10:00:10.000Z",
        outputTokens: 120,
        toolCalls: 2,
      }),
      delegatedTurn({
        agentType: "debugger",
        agentId: "agent-7",
        timestamp: "2026-07-01T10:01:10.000Z",
        outputTokens: 80,
        toolCalls: 1,
      }),
    ]);

    const report = delegationReport(transcriptsDir());
    const [row] = report.bySubagentType;
    expect(row!.subagentType).toBe("debugger");
    expect(row!.dispatches).toBe(1);
    expect(row!.delegatedWork).toEqual({
      transcripts: 1,
      owningSessions: 1,
      records: 2,
      toolCalls: 3,
      outputTokens: 200,
      recordsWithUsage: 2,
      firstRecordAt: "2026-07-01T10:00:10.000Z",
      lastRecordAt: "2026-07-01T10:01:10.000Z",
      wallClockMs: 60_000,
      transcriptsWithoutSpan: 0,
    });
    expect(report.totals.delegatedTranscripts).toBe(1);
    expect(report.totals.delegatedRecords).toBe(2);
    expect(report.totals.delegatedToolCalls).toBe(3);
    expect(report.totals.delegatedOutputTokens).toBe(200);
    expect(report.totals.delegatedWallClockMs).toBe(60_000);
    expect(report.totals.sessionsWithDelegatedWork).toBe(1);
    expect(report.evidence.subagentTranscriptsRead).toBe(1);
    expect(report.evidence.subagentRecordsRead).toBe(2);
    expect(report.evidence.subagentRecordsMarkedSidechain).toBe(2);
    // The dispatch and its transcript are paired by the agent id the result named.
    expect(report.evidence.dispatchesWithMatchingSubagentTranscript).toBe(1);
    expect(report.evidence.dispatchesWithoutMatchingSubagentTranscript).toBe(0);
    expect(report.limitation).not.toMatch(/none of them is opened/);
  });

  it("reports delegated output tokens as absent rather than zero when no usage exists", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "agent-aaa.jsonl", [
      delegatedTurn({ agentType: "debugger", timestamp: "2026-07-01T10:00:10.000Z" }),
    ]);
    const [row] = delegationReport(transcriptsDir()).bySubagentType;
    expect(row!.delegatedWork?.records).toBe(1);
    expect(row!.delegatedWork?.outputTokens).toBeNull();
    expect(row!.delegatedWork?.recordsWithUsage).toBe(0);
    // One record cannot span anything, and zero would read as an instant run.
    expect(row!.delegatedWork?.wallClockMs).toBeNull();
    expect(row!.delegatedWork?.transcriptsWithoutSpan).toBe(1);
  });

  it("keeps a dispatch with no transcript apart from a transcript with no dispatch", () => {
    // A request and a result are different records and are allowed to disagree: a
    // teammate writes its own session elsewhere, and an orchestration script's
    // agents leave transcripts nobody dispatched by tool call.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "researcher", prompt: "x" } }),
      dispatchResultRecord({ id: "t1", status: "teammate_spawned", agentId: "agent-elsewhere" }),
    ]);
    writeSubagentTranscript(
      "-tmp-alpha",
      "dddddddd-4444-4555-8666-777777777777",
      "agent-bbb.jsonl",
      [
        delegatedTurn({
          agentType: "workflow-subagent",
          agentId: "agent-9",
          timestamp: "2026-07-02T09:00:00.000Z",
          outputTokens: 40,
        }),
      ],
      true,
    );

    const report = delegationReport(transcriptsDir());
    expect(report.evidence.dispatchesWithMatchingSubagentTranscript).toBe(0);
    expect(report.evidence.dispatchesWithoutMatchingSubagentTranscript).toBe(1);
    expect(report.evidence.subagentTranscriptsWhoseOwnerSessionNeverDispatched).toBe(1);
    expect(report.evidence.workflowAgentTranscriptFiles).toBe(1);

    const dispatched = report.bySubagentType.find((row) => row.subagentType === "researcher");
    expect(dispatched!.dispatches).toBe(1);
    expect(dispatched!.delegatedWork).toBeNull();
    const delegated = report.bySubagentType.find(
      (row) => row.subagentType === "workflow-subagent",
    );
    expect(delegated!.dispatches).toBe(0);
    expect(delegated!.delegatedWork?.records).toBe(1);
    expect(report.limitation).toMatch(/The two sides are not required to agree/);
  });

  it("labels a subagent transcript that names no specialist and counts it", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "journal.jsonl", [
      { type: "started", key: "v2:abc", agentId: "agent-3" },
      { type: "result", key: "v2:abc", agentId: "agent-3" },
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.evidence.subagentTranscriptsWithoutAgentType).toBe(1);
    const row = report.bySubagentType.find((r) => r.subagentType === "(unattributed)");
    expect(row!.delegatedWork?.records).toBe(2);
    expect(report.limitation).toMatch(/name no specialist anywhere in the file/);
  });

  it("skips a nested file that is not a subagent transcript and counts the skip", () => {
    // A session directory holds other logs beside its delegated runs. Reading one
    // as delegated work would attribute records to a specialist that never ran.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    const sessionDir = path.join(transcriptsDir(), "-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "some-other-log.jsonl"),
      `${JSON.stringify({ notATranscriptRecord: true })}\n`,
      "utf8",
    );
    const report = delegationReport(transcriptsDir());
    expect(report.evidence.nestedFilesNotSubagentTranscripts).toBe(1);
    expect(report.evidence.subagentTranscriptFiles).toBe(0);
    expect(report.evidence.subagentRecordsRead).toBe(0);
    expect(report.limitation).toMatch(/skipped as not being delegated runs/);
  });

  it("always names both sides and never claims delegated work is absent", () => {
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    const report = delegationReport(transcriptsDir());
    expect(report.limitation).toMatch(/^Two sides, counted separately\./);
    expect(report.limitation).toMatch(/whether the answer was used/);
    expect(report.limitation).not.toMatch(/No subagent turns are in the session transcripts/);
  });

  it("does not treat a nested subagent transcript as a session", () => {
    // Only *.jsonl directly in a project directory is a session; a dispatch found
    // in a nested file would be attributed to a session id that does not exist.
    writeSession("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "agent-aaa.jsonl", [
      dispatchRecord({ id: "t-nested", input: { subagent_type: "researcher", prompt: "y" } }),
    ]);

    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(1);
    expect(report.evidence.sessionTranscriptsScanned).toBe(1);
    expect(report.evidence.subagentTranscriptsRead).toBe(1);
    // A dispatch a subagent made itself is a third channel: counted under its own
    // name so it is neither added to the operator's dispatches nor lost.
    expect(report.evidence.dispatchesInsideDelegatedWork).toBe(1);
    expect(report.limitation).toMatch(/1 dispatch calls sit inside the delegated/);
  });

  it("skips a torn trailing line without losing the file", () => {
    // A live session appends while this reads, so a half-written last line is
    // normal traffic and is counted rather than thrown on.
    const dir = path.join(transcriptsDir(), "-tmp-alpha");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s1.jsonl"),
      `${JSON.stringify(dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }))}\n{"type":"assist`,
      "utf8",
    );
    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(1);
    expect(report.evidence.unparseableLines).toBe(1);
    // A torn line is not a lost file, and the three are reported separately.
    expect(report.evidence.transcriptsVanishedDuringScan).toBe(0);
    expect(report.evidence.transcriptsTruncatedMidScan).toBe(0);
  });

  it("counts a transcript that disappears after its first chunk was read", () => {
    // The line reader reopens the file per chunk and stops without raising once it
    // is gone, so a deletion mid-read used to drop every record past the first
    // chunk while every counter still read as complete. Deleting the file from
    // inside the first chunk read reproduces exactly that, deterministically.
    const dir = path.join(transcriptsDir(), "-tmp-alpha");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "s1.jsonl");
    const filler = JSON.stringify({
      type: "user",
      isSidechain: false,
      timestamp: "2026-07-01T10:00:00.000Z",
      message: { role: "user", content: "f".repeat(900) },
    });
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(dispatchRecord({ id: "first", input: { subagent_type: "debugger", prompt: "x" } })),
        ...Array.from({ length: 600 }, () => filler),
        JSON.stringify(dispatchRecord({ id: "last", input: { subagent_type: "researcher", prompt: "y" } })),
        "",
      ].join("\n"),
      "utf8",
    );
    expect(fs.statSync(filePath).size).toBeGreaterThan(256 * 1024);

    const realReadSync = fs.readSync;
    let removed = false;
    const spy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const bytes = realReadSync(fd, buffer, offset, length, position);
      if (!removed) {
        removed = true;
        fs.rmSync(filePath);
      }
      return bytes;
    }) as typeof fs.readSync);

    let report;
    try {
      report = delegationReport(transcriptsDir());
    } finally {
      spy.mockRestore();
    }

    // Only what the first chunk held was counted, and the loss is now named.
    expect(report.totals.dispatches).toBe(1);
    expect(report.bySubagentType[0]!.subagentType).toBe("debugger");
    expect(report.evidence.transcriptsTruncatedMidScan).toBe(1);
    expect(report.evidence.transcriptsVanishedDuringScan).toBe(0);
    expect(report.limitation).toMatch(/1 transcripts changed while they were being read/);
    expect(report.limitation).toMatch(/unknown number of records past that point/);
  });

  it("counts a transcript that shrinks while it is being read", () => {
    // A rewritten transcript is the same invisible loss: the reader carries on at
    // the old byte offset in a shorter file and stops early with nothing to catch.
    const dir = path.join(transcriptsDir(), "-tmp-alpha");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "s1.jsonl");
    const filler = JSON.stringify({
      type: "user",
      isSidechain: false,
      timestamp: "2026-07-01T10:00:00.000Z",
      message: { role: "user", content: "f".repeat(900) },
    });
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify(dispatchRecord({ id: "first", input: { subagent_type: "debugger", prompt: "x" } })),
        ...Array.from({ length: 600 }, () => filler),
        JSON.stringify(dispatchRecord({ id: "last", input: { subagent_type: "researcher", prompt: "y" } })),
        "",
      ].join("\n"),
      "utf8",
    );

    const realReadSync = fs.readSync;
    let shrunk = false;
    const spy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const bytes = realReadSync(fd, buffer, offset, length, position);
      if (!shrunk) {
        shrunk = true;
        fs.truncateSync(filePath, 1024);
      }
      return bytes;
    }) as typeof fs.readSync);

    let report;
    try {
      report = delegationReport(transcriptsDir());
    } finally {
      spy.mockRestore();
    }

    expect(report.evidence.transcriptsTruncatedMidScan).toBe(1);
    expect(report.evidence.transcriptsVanishedDuringScan).toBe(0);
  });

  it("does not report a growing transcript as truncated", () => {
    // A live session appends to its own transcript while this reads. A prefix of a
    // growing file is a complete read of what was listed, so flagging it would turn
    // ordinary traffic into a warning nobody could act on.
    const dir = path.join(transcriptsDir(), "-tmp-alpha");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "s1.jsonl");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(dispatchRecord({ id: "t1", input: { subagent_type: "debugger", prompt: "x" } }))}\n`,
      "utf8",
    );

    const realReadSync = fs.readSync;
    let appended = false;
    const spy = vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const bytes = realReadSync(fd, buffer, offset, length, position);
      if (!appended) {
        appended = true;
        fs.appendFileSync(
          filePath,
          `${JSON.stringify(dispatchRecord({ id: "t2", input: { subagent_type: "researcher", prompt: "y" } }))}\n`,
        );
      }
      return bytes;
    }) as typeof fs.readSync);

    let report;
    try {
      report = delegationReport(transcriptsDir());
    } finally {
      spy.mockRestore();
    }

    expect(report.evidence.transcriptsTruncatedMidScan).toBe(0);
    expect(report.limitation).not.toMatch(/changed while they were being read/);
  });

  it("rethrows a read failure that is not a vanished file", () => {
    // A transcript rotated away mid-scan is expected traffic and is counted. An
    // unreadable one is a real fault, and a pillar that quietly reported fewer
    // dispatches would be answering a different question than it was asked.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = path.join(transcriptsDir(), "-tmp-alpha");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "s1.jsonl");
    fs.writeFileSync(filePath, "{}\n", "utf8");
    fs.chmodSync(filePath, 0o000);
    try {
      expect(() => delegationReport(transcriptsDir())).toThrow(/EACCES|permission/i);
    } finally {
      fs.chmodSync(filePath, 0o600);
    }
  });

  it("reports an empty corpus as no dispatches rather than failing", () => {
    // A present directory with nothing in it is a real answer: this operator has
    // not delegated. That is different from a missing source.
    fs.mkdirSync(transcriptsDir(), { recursive: true });
    const report = delegationReport(transcriptsDir());
    expect(report.totals.dispatches).toBe(0);
    expect(report.byMonth).toEqual([]);
    expect(report.totals.medianPromptChars).toBeNull();
    expect(report.totals.delegatedRecords).toBe(0);
    expect(report.totals.delegatedOutputTokens).toBeNull();
    expect(report.limitation).toMatch(/^Two sides, counted separately\./);
  });

  it("names the missing source instead of returning an empty report", () => {
    // An empty report reads as "you have never delegated", which is a different
    // and much worse claim than "this path is wrong".
    expect(() => delegationReport(path.join(root, "absent"))).toThrow(SourceMissingError);
    expect(() => delegationReport(path.join(root, "absent"))).toThrow(/absent/);
  });

  it("names the missing source when the path is a file, not a directory", () => {
    const filePath = path.join(root, "not-a-dir");
    fs.writeFileSync(filePath, "x", "utf8");
    expect(() => delegationReport(filePath)).toThrow(SourceMissingError);
  });
});

/**
 * The per-file scans are memoized, so every number here has to be the same on the
 * second call as on the first. A cache that answered differently once warm would
 * make the warm answer - the one a long-running server actually serves - the wrong
 * one, and a unit test that only ever reads cold would never see it.
 */
describe("reading the same corpus twice", () => {
  it("answers identically warm and cold", () => {
    writeSession("-proj-a", "11111111-1111-4111-8111-111111111111", [
      dispatchRecord({ id: "toolu_a", input: { subagent_type: "Explore", prompt: "look" } }),
      dispatchResultRecord({ id: "toolu_a", status: "success", agentId: "agent-a" }),
      dispatchRecord({ id: "toolu_b", input: { subagent_type: "Plan", prompt: "plan it" } }),
    ]);
    writeSubagentTranscript(
      "-proj-a",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222.jsonl",
      [
        delegatedTurn({
          agentType: "Explore",
          agentId: "agent-a",
          timestamp: "2026-07-01T10:00:10.000Z",
          outputTokens: 40,
          toolCalls: 2,
        }),
      ],
    );

    const cold = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    const warm = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(warm).toEqual(cold);

    // And identical again from a genuinely cold cache, which is what proves the
    // first call did not leave counters behind in the memo.
    clearScanCache();
    expect(delegationReport(transcriptsDir(), { nowMs: READ_AT })).toEqual(cold);
  });

  it("still pairs a result whose dispatch is in another transcript", () => {
    // The admission test that needs corpus-wide state: this result names no agent,
    // so the only evidence it belongs to a dispatch is that the tool-call id was
    // dispatched - and the dispatch is in a different file. A per-file scan that
    // resolved pairing on its own would drop this outcome and report the dispatch
    // as unanswered.
    const dispatched = "33333333-3333-4333-8333-333333333333";
    const answered = "44444444-4444-4444-8444-444444444444";
    writeSession("-proj-a", dispatched, [
      dispatchRecord({ id: "toolu_split", input: { subagent_type: "Explore", prompt: "go" } }),
    ]);
    writeSession("-proj-a", answered, [
      dispatchResultRecord({ id: "toolu_split", status: "success" }),
    ]);
    // Transcripts are folded newest first, so the dispatch has to be the newer of
    // the two for its id to be known by the time the result is read.
    const dir = path.join(transcriptsDir(), "-proj-a");
    fs.utimesSync(path.join(dir, `${answered}.jsonl`), new Date(1_000), new Date(1_000));
    fs.utimesSync(path.join(dir, `${dispatched}.jsonl`), new Date(9_000), new Date(9_000));

    clearScanCache();
    const cold = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(cold.totals.dispatches).toBe(1);
    expect(cold.evidence.dispatchesWithoutPairedResult).toBe(0);
    expect(cold.evidence.dispatchOutcomeStatuses).toEqual([
      { status: "success", dispatches: 1 },
    ]);

    // The same on the warm path, where the file summaries come out of the memo and
    // the pairing has to be redone by the fold rather than replayed.
    expect(delegationReport(transcriptsDir(), { nowMs: READ_AT })).toEqual(cold);
  });

  it("does not let a later dispatch in the same file pair an earlier result", () => {
    // Ordering the fold has to preserve: the sequential read this replaces could
    // not have known about a dispatch it had not reached yet, so a result sitting
    // above its own dispatch stays unpaired.
    writeSession("-proj-a", "55555555-5555-4555-8555-555555555555", [
      dispatchResultRecord({ id: "toolu_late", status: "success" }),
      dispatchRecord({ id: "toolu_late", input: { subagent_type: "Explore", prompt: "go" } }),
    ]);

    clearScanCache();
    const cold = delegationReport(transcriptsDir(), { nowMs: READ_AT });
    expect(cold.totals.dispatches).toBe(1);
    expect(cold.evidence.dispatchesWithoutPairedResult).toBe(1);
    expect(delegationReport(transcriptsDir(), { nowMs: READ_AT })).toEqual(cold);
  });

  it("counts a transcript appended to since the last read", () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    writeSession("-proj-a", sessionId, [
      dispatchRecord({ id: "toolu_first", input: { subagent_type: "Explore", prompt: "one" } }),
    ]);
    expect(delegationReport(transcriptsDir(), { nowMs: READ_AT }).totals.dispatches).toBe(1);

    const filePath = path.join(transcriptsDir(), "-proj-a", `${sessionId}.jsonl`);
    fs.appendFileSync(
      filePath,
      `${JSON.stringify(
        dispatchRecord({ id: "toolu_second", input: { subagent_type: "Plan", prompt: "two" } }),
      )}\n`,
      "utf8",
    );
    // The memo is keyed on the file's identity, so the append produces a new key
    // rather than serving the shorter read back.
    expect(delegationReport(transcriptsDir(), { nowMs: READ_AT }).totals.dispatches).toBe(2);
  });
});
