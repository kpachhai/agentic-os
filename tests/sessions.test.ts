import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { getSession, listSessions, sessionTotals } from "../server/sessions.js";

let root = "";
const PROJECT_DIR = "-tmp-demo-project";
const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";

/**
 * Records are hand-written to the shapes Claude Code actually emits. Nothing
 * here is captured from the operator's real history; this repo is meant to be
 * publishable, so fixtures are synthetic by rule.
 */
function writeTranscript(
  projectDir: string,
  sessionId: string,
  lines: unknown[],
): string {
  const dirPath = path.join(root, projectDir);
  fs.mkdirSync(dirPath, { recursive: true });
  const filePath = path.join(dirPath, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return filePath;
}

function userRecord(overrides: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: "2026-07-01T10:00:00.000Z",
    cwd: "/tmp/demo project",
    gitBranch: "main",
    version: "2.1.220",
    message: { role: "user", content: "Please harden the launch bounds." },
    ...overrides,
  };
}

function assistantRecord(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId: SESSION_ID,
    timestamp: "2026-07-01T10:00:30.000Z",
    cwd: "/tmp/demo project",
    gitBranch: "main",
    version: "2.1.220",
    attributionSkill: "verify-before-done",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        { type: "text", text: "Reading the launcher first." },
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Edit", input: {} },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 300,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-sessions-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listSessions", () => {
  it("prefers the title Claude Code already wrote to disk", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      { type: "ai-title", sessionId: SESSION_ID, aiTitle: "Harden launch bounds" },
    ]);

    const [session] = listSessions(root);
    expect(session!.title).toBe("Harden launch bounds");
    expect(session!.titleSource).toBe("ai-title");
  });

  it("falls back to the first real prompt when no title record exists", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [userRecord(), assistantRecord()]);
    const [session] = listSessions(root);
    expect(session!.title).toBe("Please harden the launch bounds.");
    expect(session!.titleSource).toBe("first-prompt");
  });

  it("never names a session after injected context or subagent traffic", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord({
        uuid: "meta1",
        isMeta: true,
        message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" },
      }),
      userRecord({
        uuid: "side1",
        isSidechain: true,
        message: { role: "user", content: "subagent instructions" },
      }),
      userRecord({ uuid: "real1", message: { role: "user", content: "The real ask." } }),
    ]);

    const [session] = listSessions(root);
    expect(session!.title).toBe("The real ask.");
  });

  it("falls back to the session id when there is no prose at all", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      { type: "system", uuid: "s1", sessionId: SESSION_ID, timestamp: "2026-07-01T10:00:00.000Z" },
    ]);
    const [session] = listSessions(root);
    expect(session!.title).toBe(SESSION_ID);
    expect(session!.titleSource).toBe("session-id");
  });

  it("sums token usage across the four cache tiers", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      assistantRecord({ uuid: "a2" }),
    ]);

    const [session] = listSessions(root);
    expect(session!.tokens).toEqual({
      input: 200,
      output: 100,
      cacheRead: 18000,
      cacheCreation: 600,
    });
  });

  it("counts tool calls, models, skills and mcp servers", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      assistantRecord({ uuid: "a2", attributionMcpServer: "context7" }),
    ]);

    const [session] = listSessions(root);
    expect(session!.toolCalls).toEqual([
      { name: "Edit", count: 2 },
      { name: "Read", count: 2 },
    ]);
    expect(session!.models).toEqual([{ name: "claude-opus-5", count: 2 }]);
    expect(session!.skills).toEqual([{ name: "verify-before-done", count: 2 }]);
    expect(session!.mcpServers).toEqual([{ name: "context7", count: 1 }]);
  });

  it("counts hook invocations and tool denials", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      userRecord({ uuid: "u2", toolDenialKind: "permission-rule" }),
      userRecord({ uuid: "u3", toolDenialKind: "user-rejected" }),
      {
        type: "system",
        uuid: "s1",
        sessionId: SESSION_ID,
        timestamp: "2026-07-01T10:01:00.000Z",
        subtype: "stop_hook_summary",
        hookCount: 4,
        hookErrors: ["boom"],
      },
    ]);

    const [session] = listSessions(root);
    expect(session!.hookInvocations).toBe(4);
    expect(session!.hookErrorRecords).toBe(1);
    expect(session!.toolDenials).toEqual([
      { name: "permission-rule", count: 1 },
      { name: "user-rejected", count: 1 },
    ]);
  });

  it("takes the working directory from a record rather than the lossy directory name", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [userRecord(), assistantRecord()]);
    const [session] = listSessions(root);
    // The encoded name flattens punctuation, so a record that carries the real
    // path is authoritative and the reader says which source it used.
    expect(session!.cwd).toBe("/tmp/demo project");
    expect(session!.cwdSource).toBe("record");
  });

  it("marks the working directory as reconstructed when no record carries one", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      { type: "ai-title", sessionId: SESSION_ID, aiTitle: "No cwd anywhere" },
    ]);
    const [session] = listSessions(root);
    expect(session!.cwdSource).toBe("decoded");
  });

  it("reports skipped lines instead of hiding them", () => {
    const dirPath = path.join(root, PROJECT_DIR);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, `${SESSION_ID}.jsonl`),
      [
        JSON.stringify(userRecord()),
        "{ this is not json",
        JSON.stringify(assistantRecord()),
        '{"truncated": tru',
      ].join("\n"),
      "utf8",
    );

    const [session] = listSessions(root);
    expect(session!.skippedLines).toBe(2);
    expect(session!.messageCount).toBe(2);
  });

  it("bounds how many transcripts it reads and honors the offset", () => {
    for (let i = 0; i < 5; i++) {
      writeTranscript(PROJECT_DIR, `session-${i}`, [userRecord()]);
    }
    expect(listSessions(root, { limit: 2 })).toHaveLength(2);
    expect(listSessions(root, { limit: 100 })).toHaveLength(5);
    expect(listSessions(root, { limit: 2, offset: 4 })).toHaveLength(1);
  });

  it("filters on title, working directory and branch", () => {
    writeTranscript(PROJECT_DIR, "s-one", [
      userRecord({ message: { role: "user", content: "Alpha work" } }),
    ]);
    writeTranscript(PROJECT_DIR, "s-two", [
      userRecord({
        gitBranch: "feature/beta",
        message: { role: "user", content: "Beta work" },
      }),
    ]);

    expect(listSessions(root, { q: "alpha" })).toHaveLength(1);
    expect(listSessions(root, { q: "feature/beta" })).toHaveLength(1);
    expect(listSessions(root, { q: "/tmp/demo project" })).toHaveLength(2);
    expect(listSessions(root, { q: "nothing matches this" })).toHaveLength(0);
  });

  it("names the missing transcripts directory rather than returning an empty list", () => {
    const absent = path.join(root, "not-here");
    expect(() => listSessions(absent)).toThrow(SourceMissingError);
  });
});

describe("getSession", () => {
  it("returns a timeline of the conversation records", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      { type: "ai-title", sessionId: SESSION_ID, aiTitle: "Titled" },
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID);
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Titled");
    expect(detail!.timeline).toHaveLength(2);
    expect(detail!.timeline[0]!.type).toBe("user");
    expect(detail!.timeline[1]!.toolUses).toEqual([
      { name: "Edit", count: 1 },
      { name: "Read", count: 1 },
    ]);
    expect(detail!.timeline[1]!.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 9000,
      cacheCreation: 300,
    });
  });

  it("marks the record a rewind forked from as a branch point", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord({ uuid: "u1", parentUuid: null }),
      assistantRecord({ uuid: "a1", parentUuid: "u1" }),
      // A second child of the same parent is what a rewind leaves in the file.
      assistantRecord({ uuid: "a2", parentUuid: "u1" }),
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID);
    const byUuid = new Map(detail!.timeline.map((entry) => [entry.uuid, entry]));
    expect(byUuid.get("u1")!.isBranchPoint).toBe(true);
    expect(byUuid.get("a1")!.isBranchPoint).toBe(false);
  });

  it("does not call a turn a branch point because an attachment hangs off it", () => {
    // An attachment annotates the turn it belongs to, so it shares that turn's
    // parent. Counting it as a sibling would mark nearly every turn as a fork.
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord({ uuid: "u1", parentUuid: null }),
      {
        type: "attachment",
        uuid: "att1",
        parentUuid: null,
        sessionId: SESSION_ID,
        timestamp: "2026-07-01T10:00:01.000Z",
        attachment: { kind: "paste" },
      },
      assistantRecord({ uuid: "a1", parentUuid: "u1" }),
      {
        type: "file-history-snapshot",
        messageId: "a1",
        snapshot: {},
        isSnapshotUpdate: false,
      },
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID);
    expect(detail!.timeline.every((entry) => !entry.isBranchPoint)).toBe(true);
  });

  it("truncates a long excerpt and says so", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord({ message: { role: "user", content: "x".repeat(2000) } }),
    ]);
    const detail = getSession(root, PROJECT_DIR, SESSION_ID);
    expect(detail!.timeline[0]!.textTruncated).toBe(true);
    expect(detail!.timeline[0]!.text.length).toBeLessThan(2000);
  });

  it("returns null for an unknown session", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [userRecord()]);
    expect(getSession(root, PROJECT_DIR, "no-such-session")).toBeNull();
  });

  it("refuses path traversal in either identifier", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [userRecord()]);
    fs.writeFileSync(path.join(root, "..", "outside.jsonl"), JSON.stringify(userRecord()), "utf8");

    expect(getSession(root, "..", "outside")).toBeNull();
    expect(getSession(root, PROJECT_DIR, "../../outside")).toBeNull();
    expect(getSession(root, `${PROJECT_DIR}/nested`, SESSION_ID)).toBeNull();

    fs.rmSync(path.join(root, "..", "outside.jsonl"), { force: true });
  });
});

describe("sessionTotals", () => {
  it("aggregates across sessions and says how many it read", () => {
    writeTranscript(PROJECT_DIR, "s-one", [userRecord(), assistantRecord()]);
    writeTranscript(PROJECT_DIR, "s-two", [userRecord(), assistantRecord()]);

    const totals = sessionTotals(root);
    // Reporting the sample size is what stops a bounded scan being read as a
    // lifetime total.
    expect(totals.sessionsScanned).toBe(2);
    expect(totals.tokens.output).toBe(100);
    expect(totals.toolCalls).toEqual([
      { name: "Edit", count: 2 },
      { name: "Read", count: 2 },
    ]);
    expect(totals.skills).toEqual([{ name: "verify-before-done", count: 2 }]);
  });
});

describe("blast radius", () => {
  /**
   * Edit results ride on the user record that reports the tool's outcome. These
   * hunk shapes are the ones Claude Code writes: a `lines` array whose entries
   * carry diff prefixes, alongside the region counts.
   */
  function editResult(
    filePath: string,
    lines: string[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      filePath,
      structuredPatch: [{ oldStart: 32, oldLines: 7, newStart: 32, newLines: 7, lines }],
      ...overrides,
    };
  }

  it("counts changed lines, not the size of the surrounding context", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      userRecord({
        uuid: "u-edit",
        toolUseResult: editResult("/tmp/demo project/server/launcher.ts", [
          " unchanged",
          " unchanged",
          "-const timeout = 0;",
          "+const timeout = 30_000;",
          " unchanged",
        ]),
      }),
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID)!;
    // The hunk's newLines/oldLines are both 7, since the changed region includes
    // its context. The real change is one line each way.
    expect(detail.blastRadius.linesAdded).toBe(1);
    expect(detail.blastRadius.linesRemoved).toBe(1);
    expect(detail.blastRadius.files).toBe(1);
    expect(detail.blastRadius.edits).toBe(1);
  });

  it("ignores a result that names a file without patching it", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      // A Read result names a file too. Counting it would make the panel claim the
      // session changed something it only looked at.
      userRecord({
        uuid: "u-read",
        toolUseResult: { filePath: "/tmp/demo project/README.md", content: "..." },
      }),
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID)!;
    expect(detail.blastRadius.files).toBe(0);
    expect(detail.touchedFiles).toEqual([]);
  });

  it("accumulates repeat edits per file and flags ones the operator then fixed", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      userRecord({
        uuid: "e1",
        timestamp: "2026-07-01T10:01:00.000Z",
        toolUseResult: editResult("/tmp/demo project/a.ts", ["+one", "+two"]),
      }),
      userRecord({
        uuid: "e2",
        timestamp: "2026-07-01T10:05:00.000Z",
        toolUseResult: editResult("/tmp/demo project/a.ts", ["-gone"], {
          userModified: true,
        }),
      }),
      userRecord({
        uuid: "e3",
        timestamp: "2026-07-01T10:02:00.000Z",
        toolUseResult: editResult("/tmp/demo project/b.ts", ["+only"]),
      }),
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID)!;
    expect(detail.blastRadius).toEqual({
      files: 2,
      edits: 3,
      linesAdded: 3,
      linesRemoved: 1,
      filesUserModified: 1,
    });
    // Most-edited first, so the file the session kept coming back to leads.
    expect(detail.touchedFiles[0]!.path).toBe("/tmp/demo project/a.ts");
    expect(detail.touchedFiles[0]!.edits).toBe(2);
    expect(detail.touchedFiles[0]!.userModified).toBe(true);
    // Out-of-order records must not corrupt the window; e2 is the latest touch.
    expect(detail.touchedFiles[0]!.firstTouchedAt).toBe("2026-07-01T10:01:00.000Z");
    expect(detail.touchedFiles[0]!.lastTouchedAt).toBe("2026-07-01T10:05:00.000Z");
    expect(detail.touchedFiles[1]!.userModified).toBe(false);
  });

  it("reports a reverted edit, because the blast radius is not the surviving diff", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      userRecord(),
      assistantRecord(),
      userRecord({
        uuid: "add",
        toolUseResult: editResult("/tmp/demo project/scratch.ts", ["+experiment"]),
      }),
      userRecord({
        uuid: "revert",
        toolUseResult: editResult("/tmp/demo project/scratch.ts", ["-experiment"]),
      }),
    ]);

    const detail = getSession(root, PROJECT_DIR, SESSION_ID)!;
    // git diff would show nothing here. This panel answers a different question.
    expect(detail.blastRadius.files).toBe(1);
    expect(detail.blastRadius.edits).toBe(2);
  });
});

/** A user record carrying nothing but the given text, so a title can be read off it. */
function prompt(uuid: string, text: string, overrides: Record<string, unknown> = {}) {
  return userRecord({ uuid, message: { role: "user", content: text }, ...overrides });
}

function titleOf(): string {
  const [session] = listSessions(root);
  if (!session) throw new Error("fixture session did not load");
  return session.title;
}

describe("a title is a label, not the first thing in the file", () => {
  it("names the run after the operator, not the slash-command envelope", () => {
    // The harness writes the envelope and the command's own stdout as ordinary
    // non-meta user records, so the meta filter never sees them.
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt("u0", "<local-command-caveat>Caveat: ...</local-command-caveat>", {
        isMeta: true,
      }),
      prompt(
        "u1",
        "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args></command-args>",
      ),
      prompt("u2", "<local-command-stdout>Set effort to ultracode</local-command-stdout>"),
      prompt("u3", "Harden the launch bounds"),
    ]);

    expect(titleOf()).toBe("Harden the launch bounds");
  });

  it("falls back to the session id when every record is envelope", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt("u1", "<command-name>/clear</command-name>"),
      prompt("u2", "<local-command-stdout>cleared</local-command-stdout>"),
    ]);

    expect(titleOf()).toBe(SESSION_ID);
    expect(listSessions(root)[0]!.titleSource).toBe("session-id");
  });

  it("keeps prose that shares a record with an envelope", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt(
        "u1",
        "<command-name>/commit</command-name>\n<command-args></command-args>\nalso push it when the tests pass",
      ),
    ]);

    expect(titleOf()).toBe("also push it when the tests pass");
  });

  it("still prefers an explicit ai-title over any prompt", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt("u1", "<command-name>/effort</command-name>"),
      prompt("u2", "some later prose"),
      { type: "ai-title", sessionId: SESSION_ID, aiTitle: "Harden launch bounds" },
    ]);

    expect(titleOf()).toBe("Harden launch bounds");
  });

  it("names the run after the heading, not the whole markdown document", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt(
        "u1",
        "# HANDOFF - continue the rename\n\n> This file is the complete state.\n\nPicking up mid-stream.",
      ),
    ]);

    expect(titleOf()).toBe("HANDOFF - continue the rename");
  });

  it("strips nested block markers", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt("u1", "> - # dig into the flaky payment test"),
    ]);

    expect(titleOf()).toBe("dig into the flaky payment test");
  });

  it("falls back to the session id when the prompt is only markers", () => {
    // `---` separators and bare `###` carry no word, so no label can be made.
    writeTranscript(PROJECT_DIR, SESSION_ID, [prompt("u1", "###\n\n>\n\n- \n")]);

    expect(titleOf()).toBe(SESSION_ID);
  });

  it("leaves the message body alone - markdown there is content, not decoration", () => {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt(
        "u1",
        "# HANDOFF - continue the rename\n\n> This file is the complete state.",
      ),
    ]);

    const entry = getSession(root, PROJECT_DIR, SESSION_ID)!.timeline.find(
      (e) => e.uuid === "u1",
    );
    expect(entry!.text).toContain("# HANDOFF - continue the rename");
    expect(entry!.text).toContain("> This file is the complete state.");
  });
});

describe("terminal escape sequences", () => {
  // Escapes are written as \u001b rather than as raw bytes: a literal ESC in
  // this source would be invisible to anyone reading or editing the fixture.
  function writeEscapes(): void {
    writeTranscript(PROJECT_DIR, SESSION_ID, [
      prompt("u1", "Set model to \u001b[1mFable 5\u001b[22m now"),
      assistantRecord({
        uuid: "a1",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [
            { type: "text", text: "\u001b[2Ktransforming...\u001b[2K built in 218ms" },
          ],
        },
      }),
      assistantRecord({
        uuid: "a2",
        parentUuid: "a1",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "plain prose, no escapes" }],
        },
      }),
    ]);
  }

  it("strips colour codes from the title", () => {
    writeEscapes();
    expect(titleOf()).toBe("Set model to Fable 5 now");
  });

  it("strips erase-line codes from timeline text", () => {
    writeEscapes();
    const entry = getSession(root, PROJECT_DIR, SESSION_ID)!.timeline.find(
      (e) => e.uuid === "a1",
    );
    expect(entry!.text).toBe("transforming... built in 218ms");
  });

  it("leaves text without escapes untouched", () => {
    writeEscapes();
    const entry = getSession(root, PROJECT_DIR, SESSION_ID)!.timeline.find(
      (e) => e.uuid === "a2",
    );
    expect(entry!.text).toBe("plain prose, no escapes");
  });

  it("leaves no escape byte in any timeline text", () => {
    // Built from a char code on purpose: an escape written literally here is an
    // invisible byte in the source, and asserting against the JSON string would
    // pass vacuously, since JSON.stringify renders ESC in its escaped
    // six-character form rather than as a raw byte.
    writeEscapes();
    const esc = String.fromCharCode(27);
    const leaked = getSession(root, PROJECT_DIR, SESSION_ID)!.timeline.filter((e) =>
      e.text.includes(esc),
    );
    expect(leaked).toEqual([]);
  });
});
