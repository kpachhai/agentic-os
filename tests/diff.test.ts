import { describe, expect, it } from "vitest";
import { diffRuns } from "../server/diff.js";
import type { SessionDetail, TimelineEntry } from "../server/sessions.js";

/** Synthetic session details, built to the shape the reader produces. */

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    uuid: `u${Math.random().toString(36).slice(2, 8)}`,
    parentUuid: null,
    type: "assistant",
    timestamp: "2026-08-01T10:00:00.000Z",
    role: "assistant",
    model: "claude-opus-5",
    text: "doing the thing",
    textTruncated: false,
    toolUses: [],
    tokens: null,
    attributionSkill: null,
    attributionMcpServer: null,
    isSidechain: false,
    isMeta: false,
    denialKind: null,
    isBranchPoint: false,
    ...overrides,
  };
}

/** A run built from a list of tool-name arrays, one per assistant step. */
function run(sessionId: string, steps: string[][]): SessionDetail {
  const timeline = steps.map((tools) =>
    entry({ toolUses: tools.map((name) => ({ name, count: 1 })) }),
  );
  return {
    sessionId,
    projectDir: "-tmp-demo",
    cwd: "/tmp/demo",
    cwdSource: "record",
    title: sessionId,
    titleSource: "session-id",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: "2026-08-01T10:30:00.000Z",
    version: "2.1.220",
    gitBranch: "main",
    messageCount: timeline.length,
    userTurns: 0,
    assistantTurns: timeline.length,
    models: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    tokensByModel: [],
    sidechainTurns: 0,
    toolCalls: [],
    skills: [],
    mcpServers: [],
    hookInvocations: 0,
    hookErrorRecords: 0,
    toolDenials: [],
    skippedLines: 0,
    sizeBytes: 0,
    mtimeMs: 0,
    timeline,
    filePath: `/tmp/${sessionId}.jsonl`,
    touchedFiles: [],
    blastRadius: {
      files: 0,
      edits: 0,
      linesAdded: 0,
      linesRemoved: 0,
      filesUserModified: 0,
    },
  };
}

const LONG_A = [
  ["Read"], ["Grep"], ["Edit"], ["Bash"], ["Read"], ["Edit"],
  ["Bash"], ["Read"], ["Write"], ["Bash"], ["Read"], ["Edit"], ["Bash"],
];

describe("diffRuns", () => {
  it("aligns identical runs with no divergence", () => {
    const result = diffRuns(run("a", LONG_A), run("b", LONG_A));
    expect(result.divergenceIndex).toBe(-1);
    expect(result.alignedSteps).toBe(LONG_A.length);
    expect(result.comparedSteps).toBe(LONG_A.length);
    expect(result.similarity).toBe(1);
  });

  it("points at the first step where the runs parted", () => {
    const b = [...LONG_A];
    b[3] = ["WebFetch"];
    const result = diffRuns(run("a", LONG_A), run("b", b));

    expect(result.divergenceIndex).toBeGreaterThanOrEqual(0);
    expect(result.ops.slice(0, result.divergenceIndex).every((op) => op.kind === "same")).toBe(
      true,
    );
  });

  it("reports the two counts behind the similarity figure", () => {
    // The measured hazard: a bare percentage hides how much evidence it rests
    // on, and unrelated short runs scored a perfect 1.0.
    const result = diffRuns(run("a", LONG_A), run("b", LONG_A.slice(0, 10)));
    expect(result.alignedSteps).toBe(10);
    expect(result.comparedSteps).toBe(13);
    expect(result.similarity).toBeCloseTo(10 / 13, 5);
  });

  it("flags a short run, where matching is nearly automatic", () => {
    const short = diffRuns(run("a", [["Read"], ["Edit"]]), run("b", [["Read"], ["Edit"]]));
    expect(short.similarity).toBe(1);
    expect(short.shortRun).toBe(true);

    const long = diffRuns(run("a", LONG_A), run("b", LONG_A));
    expect(long.shortRun).toBe(false);
  });

  it("treats tool order inside one step as not a path decision", () => {
    const a = run("a", [["Read", "Edit"]]);
    const b = run("b", [["Edit", "Read"]]);
    expect(diffRuns(a, b).alignedSteps).toBe(1);
  });

  it("leaves sidechain and meta steps out of the alignment", () => {
    const a = run("a", [["Read"]]);
    a.timeline.push(entry({ isSidechain: true, toolUses: [{ name: "Task", count: 1 }] }));
    a.timeline.push(entry({ isMeta: true }));
    const b = run("b", [["Read"]]);

    const result = diffRuns(a, b);
    expect(result.comparedSteps).toBe(1);
    expect(result.divergenceIndex).toBe(-1);
  });

  it("strips a command envelope from a step's label", () => {
    const a = run("a", [["Read"]]);
    a.timeline[0] = entry({
      text: "<command-name>/effort</command-name>\nharden the launcher",
      toolUses: [{ name: "Read", count: 1 }],
    });
    const b = run("b", [["Read"]]);

    const [op] = diffRuns(a, b).ops;
    expect(op!.kind).toBe("same");
    if (op!.kind === "same") expect(op!.a.excerpt).toBe("harden the launcher");
  });

  it("deltas only the tools whose counts differ", () => {
    const a = run("a", [["Read"]]);
    const b = run("b", [["Read"]]);
    a.toolCalls = [
      { name: "Read", count: 5 },
      { name: "Edit", count: 2 },
    ];
    b.toolCalls = [
      { name: "Read", count: 5 },
      { name: "Edit", count: 7 },
    ];

    expect(diffRuns(a, b).deltas.tools).toEqual([{ name: "Edit", a: 2, b: 7 }]);
  });

  it("splits touched files into both sides and each side alone", () => {
    const a = run("a", [["Edit"]]);
    const b = run("b", [["Edit"]]);
    const file = (path: string) => ({
      path,
      edits: 1,
      linesAdded: 1,
      linesRemoved: 0,
      firstTouchedAt: "2026-08-01T10:00:00.000Z",
      lastTouchedAt: "2026-08-01T10:00:00.000Z",
      userModified: false,
    });
    a.touchedFiles = [file("/tmp/shared.ts"), file("/tmp/only-a.ts")];
    b.touchedFiles = [file("/tmp/shared.ts"), file("/tmp/only-b.ts")];

    const { files } = diffRuns(a, b).deltas;
    expect(files.both).toEqual(["/tmp/shared.ts"]);
    expect(files.onlyA).toEqual(["/tmp/only-a.ts"]);
    expect(files.onlyB).toEqual(["/tmp/only-b.ts"]);
  });

  it("prices each run from its own model split", () => {
    const a = run("a", [["Read"]]);
    const b = run("b", [["Read"]]);
    a.tokensByModel = [
      {
        model: "claude-opus-4-5",
        tokens: { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 },
      },
    ];
    b.tokensByModel = [
      {
        model: "claude-opus-4-5",
        tokens: { input: 2000, output: 2000, cacheRead: 0, cacheCreation: 0 },
      },
    ];

    const { costUsd } = diffRuns(a, b).deltas;
    expect(costUsd.a).not.toBeNull();
    expect(costUsd.b).not.toBeNull();
    expect(costUsd.b!).toBeGreaterThan(costUsd.a!);
  });

  it("refuses a cost rather than reporting a partial one", () => {
    // An unpriced model would otherwise be silently omitted, and a total missing
    // one model reads as the whole figure.
    const a = run("a", [["Read"]]);
    const b = run("b", [["Read"]]);
    a.tokensByModel = [
      {
        model: "some-unreleased-model",
        tokens: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 },
      },
    ];

    expect(diffRuns(a, b).deltas.costUsd.a).toBeNull();
    // No model split at all is also "not available", never zero.
    expect(diffRuns(a, b).deltas.costUsd.b).toBeNull();
  });

  it("deltas delegated turns, which the alignment leaves out", () => {
    const a = run("a", [["Read"]]);
    const b = run("b", [["Read"]]);
    a.sidechainTurns = 0;
    b.sidechainTurns = 42;

    expect(diffRuns(a, b).deltas.sidechainTurns).toEqual({ a: 0, b: 42 });
  });

  it("calls two empty runs identical without dividing by zero", () => {
    const result = diffRuns(run("a", []), run("b", []));
    expect(result.similarity).toBe(1);
    expect(result.comparedSteps).toBe(0);
    expect(result.shortRun).toBe(true);
  });
});
