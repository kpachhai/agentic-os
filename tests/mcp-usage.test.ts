import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import {
  canonicalServerKey,
  joinConfigured,
  mcpUsage,
  parseMcpToolName,
  serverNaming,
  type McpUsageReport,
} from "../server/mcp-usage.js";
import { clearScanCache } from "../server/transcripts.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-mcp-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Synthetic transcripts only, hand-written to the shape the real files use. The
 * operator's own sessions are never copied into a fixture.
 */
function writeTranscript(
  projectDir: string,
  sessionId: string,
  records: unknown[],
): void {
  const dir = path.join(root, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

/**
 * A subagent transcript, which lives in a directory named for the session that
 * dispatched the work rather than beside the session transcripts.
 */
function writeSubagentTranscript(
  projectDir: string,
  ownerSessionId: string,
  subagentId: string,
  records: unknown[],
): void {
  const dir = path.join(root, projectDir, ownerSessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${subagentId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
}

function assistantCall(timestamp: string, ...toolNames: string[]): unknown {
  return {
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      content: toolNames.map((name, index) => ({
        type: "tool_use",
        id: `toolu_${index}`,
        name,
        input: { query: "synthetic" },
      })),
    },
  };
}

function serverNamed(report: McpUsageReport, server: string) {
  const found = report.servers.find((entry) => entry.server === server);
  if (!found) throw new Error(`no usage recorded for ${server}`);
  return found;
}

describe("parseMcpToolName", () => {
  it("splits on the double underscore, not on every underscore", () => {
    // The delimiter is "__". A server name carries single underscores of its own,
    // so splitting on "_" reports one server as several with a fraction of its
    // calls each - which is the whole point of the naming convention.
    expect(parseMcpToolName("mcp__claude_ai_Google_Calendar__list_events")).toEqual({
      server: "claude_ai_Google_Calendar",
      tool: "list_events",
    });
    expect(
      parseMcpToolName("mcp__plugin_claude-token-analyzer_token-analyzer__sync_db"),
    ).toEqual({
      server: "plugin_claude-token-analyzer_token-analyzer",
      tool: "sync_db",
    });
  });

  it("keeps a hyphenated tool name and a hyphenated server name intact", () => {
    expect(parseMcpToolName("mcp__claude_ai_Notion__notion-update-page")).toEqual({
      server: "claude_ai_Notion",
      tool: "notion-update-page",
    });
    expect(parseMcpToolName("mcp__claude-in-chrome__tabs_context_mcp")).toEqual({
      server: "claude-in-chrome",
      tool: "tabs_context_mcp",
    });
  });

  it("splits at the first delimiter so the server segment stays exact", () => {
    // If a tool name ever carries its own double underscore, the server must not
    // absorb it: the server is the grouping key and a wrong one invents a server.
    expect(parseMcpToolName("mcp__some_server__odd__tool")).toEqual({
      server: "some_server",
      tool: "odd__tool",
    });
  });

  it("returns null for a name that is not an MCP tool name", () => {
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("TodoWrite")).toBeNull();
    expect(parseMcpToolName("mcp_single__tool")).toBeNull();
  });

  it("returns null rather than inventing a half-name", () => {
    // A server with no tool, a tool with no server, and an empty tail are all
    // malformed. Filing them under a guessed server would look like a real server
    // nobody recognises.
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp__server-only")).toBeNull();
    expect(parseMcpToolName("mcp__server__")).toBeNull();
    expect(parseMcpToolName("mcp____tool")).toBeNull();
  });
});

describe("canonicalServerKey", () => {
  it("makes the flattened, configured and readable spellings of one server meet", () => {
    expect(canonicalServerKey("claude.ai Notion")).toBe(
      canonicalServerKey("claude_ai_Notion"),
    );
    expect(canonicalServerKey("plugin:context7:context7")).toBe(
      canonicalServerKey("plugin_context7_context7"),
    );
    expect(canonicalServerKey("open-brain")).toBe(canonicalServerKey("open_brain"));
  });

  it("keeps different servers apart", () => {
    // A hosted connector and a locally configured server can describe the same
    // subject and are still two servers with two context costs.
    expect(canonicalServerKey("claude.ai Some Docs")).not.toBe(
      canonicalServerKey("some-docs"),
    );
  });
});

describe("serverNaming", () => {
  it("strips the client namespace so a bare configured name can still match", () => {
    // A connector and a plugin-supplied server are recorded with the client's
    // namespace in front of the server's own name, while a configuration file
    // names them bare. Without the stripped key there is no spelling the two
    // sides share, and every call to such a server matches nothing at all.
    expect(serverNaming("claude_ai_Notes_Service")).toEqual({
      key: "claude_ai_notes_service",
      origin: "connector",
      bareKey: "notes_service",
    });
    expect(serverNaming("plugin_notes-pack_notes-store")).toEqual({
      key: "plugin_notes_pack_notes_store",
      origin: "plugin",
      bareKey: "notes_store",
    });
  });

  it("reports a plain name as plain and offers no stripped key for it", () => {
    expect(serverNaming("memory-store")).toEqual({
      key: "memory_store",
      origin: "plain",
      bareKey: null,
    });
  });

  it("refuses to guess where a plugin namespace ends when it cannot tell", () => {
    // Both inner names keep their own hyphens and only the two joins are
    // underscores, so a segment with more than three parts could be split several
    // ways. A wrongly split name matches a different server, so it is not split.
    expect(serverNaming("plugin_notes_pack_store")).toEqual({
      key: "plugin_notes_pack_store",
      origin: "plugin",
      bareKey: null,
    });
  });
});

describe("mcpUsage", () => {
  it("counts calls per server and per tool, most-used server first", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-05-01T10:02:00.000Z", "mcp__notes_server__update-page"),
      assistantCall("2026-05-01T10:03:00.000Z", "mcp__memory-store__capture_thought"),
    ]);

    const report = mcpUsage(root);
    expect(report.servers.map((entry) => entry.server)).toEqual([
      "notes_server",
      "memory-store",
    ]);

    const notes = serverNamed(report, "notes_server");
    expect(notes.calls).toBe(3);
    expect(notes.distinctTools).toBe(2);
    expect(notes.tools).toEqual([
      { tool: "search", calls: 2, subagentCalls: 0 },
      { tool: "update-page", calls: 1, subagentCalls: 0 },
    ]);
    expect(report.totals.calls).toBe(4);
    expect(report.totals.servers).toBe(2);
    // Distinct tools are counted per server, which is what the label says.
    expect(report.totals.distinctTools).toBe(3);
  });

  it("counts every tool_use block in one record, because each one is a call", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall(
        "2026-05-01T10:00:00.000Z",
        "mcp__notes_server__search",
        "mcp__notes_server__fetch",
      ),
    ]);
    const report = mcpUsage(root);
    expect(serverNamed(report, "notes_server").calls).toBe(2);
  });

  it("does not count a tool name mentioned in prose as a call", () => {
    // Assistant text discusses tool names, and system notices list the ones
    // available. Matching on the text of a record rather than on its tool_use
    // blocks turns a server nobody calls into a busy one.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I could call mcp__notes_server__search here but will not.",
            },
          ],
        },
      },
    ]);
    const report = mcpUsage(root);
    expect(report.servers).toEqual([]);
    expect(report.totals.calls).toBe(0);
  });

  it("does not count the tool_result side of a call a second time", () => {
    // The user record that carries the result names the same call. Counting both
    // sides would double every number in this pillar.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
      {
        type: "user",
        timestamp: "2026-05-01T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_0",
              content: "result text",
            },
            { type: "tool_use", name: "mcp__notes_server__search" },
          ],
        },
      },
    ]);
    expect(serverNamed(mcpUsage(root), "notes_server").calls).toBe(1);
  });

  it("reports the first and last call as the records timestamp them", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-03-09T08:00:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-06-30T23:59:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-04-15T12:00:00.000Z", "mcp__notes_server__search"),
    ]);
    const notes = serverNamed(mcpUsage(root), "notes_server");
    expect(notes.firstUsedAt).toBe("2026-03-09T08:00:00.000Z");
    expect(notes.lastUsedAt).toBe("2026-06-30T23:59:00.000Z");
  });

  it("orders the window by instant, not by the digits of the timestamp", () => {
    // A timestamp carrying a UTC offset instead of a trailing Z sorts by its
    // wall-clock digits, so comparing the strings puts a call that happened first
    // at the end of the window and inverts it. The second call below is 05:00Z,
    // which is before the first.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T09:00:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-05-01T10:00:00+05:00", "mcp__notes_server__search"),
    ]);
    const notes = serverNamed(mcpUsage(root), "notes_server");
    expect(notes.firstUsedAt).toBe("2026-05-01T05:00:00.000Z");
    expect(notes.lastUsedAt).toBe("2026-05-01T09:00:00.000Z");
    // Both ends are rendered the same way, so the window can be read as a window.
    expect(notes.firstUsedAt <= notes.lastUsedAt).toBe(true);
  });

  it("leaves the window empty for a call whose record carried no usable timestamp", () => {
    // Substituting the current time would make an old call read as a fresh one,
    // which is the opposite of what a missing timestamp says.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "not-a-date",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "mcp__notes_server__search" }],
        },
      },
    ]);
    const notes = serverNamed(mcpUsage(root), "notes_server");
    expect(notes.calls).toBe(1);
    expect(notes.firstUsedAt).toBe("");
    expect(notes.lastUsedAt).toBe("");
  });

  it("counts distinct sessions and projects, not calls, under those labels", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-05-01T10:05:00.000Z", "mcp__notes_server__search"),
    ]);
    writeTranscript("-tmp-beta", "bbbbbbbb-2222-4333-8444-555555555555", [
      assistantCall("2026-05-02T10:00:00.000Z", "mcp__notes_server__search"),
    ]);
    writeTranscript("-tmp-beta", "cccccccc-3333-4444-8555-666666666666", [
      { type: "user", timestamp: "2026-05-03T10:00:00.000Z", message: {} },
    ]);

    const report = mcpUsage(root);
    const notes = serverNamed(report, "notes_server");
    expect(notes.calls).toBe(3);
    expect(notes.sessions).toBe(2);
    expect(notes.projects).toEqual(["-tmp-alpha", "-tmp-beta"]);
    expect(report.totals.transcriptFilesScanned).toBe(3);
    expect(report.totals.sessionsScanned).toBe(3);
    expect(report.totals.sessionsWithCalls).toBe(2);
  });

  it("counts files and sessions under separate labels when one session has two files", () => {
    // The per-server sessions field counts distinct session ids, so a totals field
    // that counted files while wearing the word "sessions" made the same session
    // read as 1 in a server row and 2 in the totals.
    writeTranscript("-tmp-alpha", "shared-session", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
    ]);
    writeTranscript("-tmp-beta", "shared-session", [
      assistantCall("2026-05-02T10:00:00.000Z", "mcp__notes_server__search"),
    ]);

    const report = mcpUsage(root);
    expect(report.totals.transcriptFilesScanned).toBe(2);
    expect(report.totals.sessionsScanned).toBe(1);
    expect(report.totals.sessionsWithCalls).toBe(1);
    expect(serverNamed(report, "notes_server").sessions).toBe(1);
  });

  it("lists a name it could not split instead of filing it under a guessed server", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__brokenname"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__notes_server__search"),
    ]);
    const report = mcpUsage(root);
    expect(report.servers.map((entry) => entry.server)).toEqual(["notes_server"]);
    expect(report.unparsedToolNames).toEqual(["mcp__brokenname"]);
    expect(report.totals.unparsedNameOccurrences).toBe(1);
    expect(report.totals.unparsedNamesDistinct).toBe(1);
    // The unparseable name is not in the call total either; it is not a call this
    // module can attribute.
    expect(report.totals.calls).toBe(1);
  });

  it("separates how many unparseable names there are from how often they appear", () => {
    // One field cannot answer both questions. A single unrecognised name seen four
    // times used to report as four names against a list of one, which is the shape
    // a naming-convention change actually produces.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__brokenname"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__brokenname"),
      assistantCall("2026-05-01T10:02:00.000Z", "mcp__brokenname"),
      assistantCall("2026-05-01T10:03:00.000Z", "mcp__brokenname"),
      assistantCall("2026-05-01T10:04:00.000Z", "mcp__notes_server__search"),
    ]);
    const report = mcpUsage(root);
    expect(report.totals.unparsedNameOccurrences).toBe(4);
    expect(report.totals.unparsedNamesDistinct).toBe(1);
    expect(report.totals.unparsedNamesDistinct).toBe(report.unparsedToolNames.length);
  });

  it("recovers the readable server name from an attribution when one is recorded", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00.000Z",
        attributionMcpServer: "claude.ai Notes Service",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "mcp__claude_ai_Notes_Service__search" },
          ],
        },
      },
    ]);
    const server = serverNamed(mcpUsage(root), "claude_ai_Notes_Service");
    expect(server.displayName).toBe("claude.ai Notes Service");
  });

  it("never treats an attribution as a call", () => {
    // The attribution appears on far more records than there are calls, and on one
    // record it can name a different server than the tool that record invoked. A
    // count taken from it would be a number under the wrong label.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00.000Z",
        attributionMcpServer: "notes-service",
        message: { role: "assistant", content: [{ type: "text", text: "thinking" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-01T10:01:00.000Z",
        attributionMcpServer: "notes-service",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "mcp__memory-store__capture_thought" }],
        },
      },
    ]);
    const report = mcpUsage(root);
    expect(report.totals.calls).toBe(1);
    expect(report.servers.map((entry) => entry.server)).toEqual(["memory-store"]);
    expect(serverNamed(report, "memory-store").calls).toBe(1);
  });

  it("counts a torn line as skipped rather than failing the read", () => {
    const dir = path.join(root, "-tmp-alpha");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session-1.jsonl"),
      `${JSON.stringify(assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"))}\n{"type":"assist`,
      "utf8",
    );
    const report = mcpUsage(root);
    expect(report.totals.calls).toBe(1);
    expect(report.totals.skippedLines).toBe(1);
  });

  it("says nothing about cost", () => {
    // A call count is calls. The tokens a server spends are mostly its tool
    // definitions, charged whether or not anything calls them, and no transcript
    // attributes those to a server.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
    ]);
    const report = mcpUsage(root);
    expect(JSON.stringify(report)).not.toMatch(/usd|cost[A-Z]|price/i);
    expect(report.note).toMatch(/not cost/i);
  });

  it("names the missing source rather than reporting no servers", () => {
    // An empty list would read as "no MCP server has ever been called", which is a
    // different claim from "the transcripts are not where the config says".
    expect(() => mcpUsage(path.join(root, "absent"))).toThrow(SourceMissingError);
  });
});

describe("mcpUsage over subagent transcripts", () => {
  it("counts a call a subagent made, apart from the calls its session made", () => {
    // A subagent's transcript sits below the session directory, where the session
    // reader deliberately does not look. Leaving those calls out understates every
    // server a delegated turn ever used.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "subagent-a", [
      assistantCall("2026-05-01T10:05:00.000Z", "mcp__notes_server__search"),
      assistantCall("2026-05-01T10:06:00.000Z", "mcp__notes_server__fetch"),
    ]);

    const report = mcpUsage(root);
    const notes = serverNamed(report, "notes_server");
    expect(notes.calls).toBe(1);
    expect(notes.subagentCalls).toBe(2);
    expect(notes.callsTotal).toBe(3);
    expect(notes.tools).toEqual([
      { tool: "search", calls: 1, subagentCalls: 1 },
      { tool: "fetch", calls: 0, subagentCalls: 1 },
    ]);
    expect(report.totals.calls).toBe(1);
    expect(report.totals.subagentCalls).toBe(2);
    expect(report.totals.callsTotal).toBe(3);
    expect(report.totals.subagentFilesScanned).toBe(1);
    expect(report.totals.sessionsWithSubagentCalls).toBe(1);
  });

  it("attributes a subagent call to the session that dispatched it", () => {
    // A subagent is not one of the operator's sessions, so its own file name is
    // not the unit any session count should carry.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      { type: "user", timestamp: "2026-05-01T10:00:00.000Z", message: {} },
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "subagent-a", [
      assistantCall("2026-05-01T10:05:00.000Z", "mcp__notes_server__search"),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "subagent-b", [
      assistantCall("2026-05-01T10:06:00.000Z", "mcp__notes_server__search"),
    ]);

    const report = mcpUsage(root);
    const notes = serverNamed(report, "notes_server");
    expect(notes.sessions).toBe(0);
    expect(notes.subagentSessions).toBe(1);
    expect(notes.projects).toEqual(["-tmp-alpha"]);
    expect(report.totals.subagentFilesScanned).toBe(2);
    expect(report.totals.sessionsWithSubagentCalls).toBe(1);
    // The session's own transcript made no MCP call, and that stays true.
    expect(report.totals.sessionsWithCalls).toBe(0);
  });

  it("counts a torn subagent line under its own skip label", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_server__search"),
    ]);
    const dir = path.join(root, "-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "subagent-a.jsonl"), `{"type":"assist`, "utf8");

    const report = mcpUsage(root);
    expect(report.totals.skippedLines).toBe(0);
    expect(report.totals.subagentSkippedLines).toBe(1);
  });

  it("keeps a server only ever called by a subagent off the never-called list", () => {
    // Reporting a server that delegated work uses as pure overhead is wrong in the
    // direction that produces bad advice: the operator would remove it.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      { type: "user", timestamp: "2026-05-01T10:00:00.000Z", message: {} },
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "subagent-a", [
      assistantCall("2026-05-01T10:05:00.000Z", "mcp__notes-store__search"),
    ]);

    const report = joinConfigured(mcpUsage(root), ["notes-store"]);
    expect(report.configuredNeverCalled).toEqual([]);
    expect(report.usedAndConfigured).toHaveLength(1);
    expect(report.usedAndConfigured[0]!.calls).toBe(0);
    expect(report.usedAndConfigured[0]!.subagentCalls).toBe(1);
    expect(report.stats.callsConfigured).toBe(0);
    expect(report.stats.subagentCallsConfigured).toBe(1);
  });
});

describe("joinConfigured", () => {
  function usageFixture(): McpUsageReport {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__claude_ai_Notes__search"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__claude_ai_Notes__fetch"),
      assistantCall("2026-05-02T10:00:00.000Z", "mcp__memory-store__capture_thought"),
      assistantCall("2026-05-03T10:00:00.000Z", "mcp__retired-server__lookup"),
    ]);
    return mcpUsage(root);
  }

  it("splits servers into used, never called, and unaccounted for", () => {
    const report = joinConfigured(usageFixture(), [
      "claude.ai Notes",
      "memory-store",
      "docs-server",
      "issue-tracker",
    ]);

    expect(
      report.usedAndConfigured.map((entry) => [entry.configuredNames, entry.calls]),
    ).toEqual([
      [["claude.ai Notes"], 2],
      [["memory-store"], 1],
    ]);
    expect(report.configuredNeverCalled).toEqual(["docs-server", "issue-tracker"]);
    expect(report.calledUnaccounted.map((entry) => entry.server)).toEqual([
      "retired-server",
    ]);
    expect(report.calledProvidedElsewhere).toEqual([]);
    expect(report.stats).toEqual({
      configuredNames: 4,
      configuredServers: 4,
      configuredNamesCalled: 2,
      configuredNamesNeverCalled: 2,
      calledServers: 3,
      calledServersConfigured: 2,
      calledServersMatchedByStrippedNamespace: 0,
      calledServersProvidedElsewhere: 0,
      calledServersUnaccounted: 1,
      callsConfigured: 3,
      callsProvidedElsewhere: 0,
      callsUnaccounted: 1,
      subagentCallsConfigured: 0,
      subagentCallsProvidedElsewhere: 0,
      subagentCallsUnaccounted: 0,
    });
  });

  it("matches a server configured under its readable name to its flattened calls", () => {
    // Failing this match is the damaging error: the most used server on the machine
    // would appear on the never-called list and read as pure overhead.
    const report = joinConfigured(usageFixture(), ["claude.ai Notes"]);
    expect(report.configuredNeverCalled).toEqual([]);
    expect(report.usedAndConfigured).toHaveLength(1);
    expect(report.usedAndConfigured[0]!.usages.map((entry) => entry.server)).toEqual([
      "claude_ai_Notes",
    ]);
  });

  it("matches a bare configured name to the namespaced spelling the client records", () => {
    // The client records a connector and a plugin-supplied server with its own
    // namespace in front of the server's name, and a configuration file names them
    // bare. Matching on the recorded spelling alone can never find them, so a
    // server in daily use lands on the never-called list while every one of its
    // calls lands in the bucket for calls nothing explains.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__claude_ai_Notes_Service__search"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__claude_ai_Notes_Service__fetch"),
      assistantCall("2026-05-02T10:00:00.000Z", "mcp__plugin_notes-pack_lookup-tool__go"),
    ]);
    const report = joinConfigured(mcpUsage(root), ["notes-service", "lookup-tool"]);

    expect(report.configuredNeverCalled).toEqual([]);
    expect(report.calledUnaccounted).toEqual([]);
    expect(report.calledProvidedElsewhere).toEqual([]);
    expect(report.stats.callsConfigured).toBe(3);
    expect(report.stats.callsUnaccounted).toBe(0);
    expect(report.stats.configuredNamesCalled).toBe(2);
    // Both matched on the stripped name rather than the recorded one, which the
    // report says out loud because it is the weaker of the two claims.
    expect(report.stats.calledServersMatchedByStrippedNamespace).toBe(2);
    expect(
      report.usedAndConfigured.map((entry) => entry.matchedByStrippedNamespace),
    ).toEqual([true, true]);
  });

  it("flags a stripped-name match apart from one made on the recorded name", () => {
    // A connector and a locally configured server can share a bare name and still
    // be two servers. The match is worth taking, since refusing it files a server
    // in daily use under never called, but it must not read as an exact match.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__claude_ai_Some_Docs__search"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__memory-store__capture_thought"),
    ]);
    const report = joinConfigured(mcpUsage(root), ["some-docs", "memory-store"]);

    const flags = report.usedAndConfigured.map((entry) => [
      entry.configuredNames[0],
      entry.matchedByStrippedNamespace,
    ]);
    // Equal call counts, so the tie breaks alphabetically on the configured name.
    expect(flags).toEqual([
      ["memory-store", false],
      ["some-docs", true],
    ]);
    expect(report.stats.calledServersMatchedByStrippedNamespace).toBe(1);
  });

  it("does not call a connector or plugin server unaccounted for", () => {
    // These are configured; they are configured where a caller reading one file
    // does not see, and their own names say so. Counting their calls as calls
    // nothing explains described most of a real machine's MCP traffic that way.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__claude_ai_Notes__search"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__claude_ai_Notes__search"),
      assistantCall("2026-05-02T10:00:00.000Z", "mcp__plugin_pack_widget__run"),
      assistantCall("2026-05-03T10:00:00.000Z", "mcp__retired-server__lookup"),
    ]);
    const report = joinConfigured(mcpUsage(root), ["docs-server"]);

    expect(
      report.calledProvidedElsewhere.map((entry) => [entry.origin, entry.usage.server]),
    ).toEqual([
      ["connector", "claude_ai_Notes"],
      ["plugin", "plugin_pack_widget"],
    ]);
    expect(report.calledUnaccounted.map((entry) => entry.server)).toEqual([
      "retired-server",
    ]);
    expect(report.stats.callsProvidedElsewhere).toBe(3);
    expect(report.stats.callsUnaccounted).toBe(1);
    // Every recorded call is still accounted for somewhere after the join.
    expect(
      report.stats.callsConfigured +
        report.stats.callsProvidedElsewhere +
        report.stats.callsUnaccounted,
    ).toBe(4);
  });

  it("keeps the history of a server missing from the configured list", () => {
    // Whether it was removed or is configured somewhere the caller did not read,
    // the calls happened; dropping them would make this report disagree with the
    // usage it was built from.
    const report = joinConfigured(usageFixture(), []);
    expect([
      ...report.calledProvidedElsewhere.map((entry) => entry.usage.server),
      ...report.calledUnaccounted.map((entry) => entry.server),
    ]).toEqual(["claude_ai_Notes", "memory-store", "retired-server"]);
    expect(
      report.stats.callsProvidedElsewhere + report.stats.callsUnaccounted,
    ).toBe(4);
    expect(report.stats.configuredNames).toBe(0);
  });

  it("does not let a blank or repeated configured name pad the configured count", () => {
    const report = joinConfigured(usageFixture(), [
      "docs-server",
      "docs-server",
      "  ",
      "",
    ]);
    expect(report.stats.configuredNames).toBe(1);
    expect(report.configuredNeverCalled).toEqual(["docs-server"]);
  });

  it("keeps both supplied spellings of one server instead of dropping one", () => {
    // Two names that differ only in punctuation compare as one server. Matching
    // has to treat them as one; the counts must not, or the configured total stops
    // adding up to the two lists and a name is gone with nothing saying so.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes-store__search"),
    ]);
    const report = joinConfigured(mcpUsage(root), [
      "notes-store",
      "notes_store",
      "other-server",
    ]);

    expect(report.usedAndConfigured).toHaveLength(1);
    // Ordered the way every other list in this module is ordered, by
    // localeCompare, which puts the underscore spelling first.
    expect(report.usedAndConfigured[0]!.configuredNames).toEqual([
      "notes_store",
      "notes-store",
    ]);
    expect(report.configuredNeverCalled).toEqual(["other-server"]);
    expect(report.configuredNameCollisions).toEqual([["notes_store", "notes-store"]]);
    expect(report.stats.configuredNames).toBe(3);
    expect(report.stats.configuredServers).toBe(2);
    // Every supplied name is in exactly one of the two lists.
    expect(
      report.stats.configuredNamesCalled + report.stats.configuredNamesNeverCalled,
    ).toBe(report.stats.configuredNames);
  });

  it("reports the same server spelled two ways on disk as one configured server", () => {
    // The mirror of the fold above. One entry per configured server, so no count
    // of matched servers can come out larger than the number of names supplied.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      assistantCall("2026-05-01T10:00:00.000Z", "mcp__notes_store__search"),
      assistantCall("2026-05-01T10:01:00.000Z", "mcp__notes-store__search"),
    ]);
    const report = joinConfigured(mcpUsage(root), ["notes-store"]);

    expect(report.usedAndConfigured).toHaveLength(1);
    expect(report.usedAndConfigured[0]!.usages.map((entry) => entry.server)).toEqual([
      "notes_store",
      "notes-store",
    ]);
    expect(report.usedAndConfigured[0]!.callsTotal).toBe(2);
    expect(report.stats.configuredNamesCalled).toBe(1);
    expect(report.stats.calledServers).toBe(2);
    expect(report.stats.calledServersConfigured).toBe(2);
    expect(report.stats.configuredNamesCalled).toBeLessThanOrEqual(
      report.stats.configuredNames,
    );
  });

  it("lists a supplied name that cannot be compared with anything", () => {
    // A name with no alphanumeric character produces no comparison key, so it can
    // neither match nor fail to match. Ignoring it in silence made it look like a
    // name that had been checked.
    const report = joinConfigured(usageFixture(), ["memory-store", "---"]);
    expect(report.configuredNamesUnusable).toEqual(["---"]);
    expect(report.stats.configuredNames).toBe(1);
    expect(
      report.stats.configuredNamesCalled + report.stats.configuredNamesNeverCalled,
    ).toBe(1);
  });

  it("orders the used list by calls so the heaviest server reads first", () => {
    const report = joinConfigured(usageFixture(), ["memory-store", "claude.ai Notes"]);
    expect(report.usedAndConfigured.map((entry) => entry.callsTotal)).toEqual([2, 1]);
  });

  it("states what the unaccounted bucket means rather than claiming a removal", () => {
    // A caller that reads only one configuration file will see hosted connectors
    // and plugin-provided servers land outside its list. Copy that says "removed"
    // would then be wrong about most of it.
    const report = joinConfigured(usageFixture(), ["memory-store"]);
    expect(report.note).toMatch(/absent from the supplied list/i);
    expect(report.note).toMatch(/somewhere the caller did not read/i);
  });

  it("reads a configured server with no calls at all as never called", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      { type: "user", timestamp: "2026-05-01T10:00:00.000Z", message: {} },
    ]);
    const report = joinConfigured(mcpUsage(root), ["docs-server"]);
    expect(report.stats.calledServers).toBe(0);
    expect(report.configuredNeverCalled).toEqual(["docs-server"]);
  });

  /**
   * The per-file scans are memoized, so the warm answer - the one a long-running
   * server actually serves - has to match the cold one. A counter incremented where
   * the file is read rather than read off the scan would show up here and nowhere
   * else, because every other test in this file reads a fresh corpus once.
   */
  it("answers identically warm and cold", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      {
        type: "assistant",
        timestamp: "2026-05-01T10:00:00.000Z",
        attributionMcpServer: "Docs Server",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "mcp__docs_server__search", input: {} },
            { type: "tool_use", id: "t2", name: "mcp__docs_server__fetch", input: {} },
            { type: "tool_use", id: "t3", name: "mcp__malformed", input: {} },
          ],
        },
      },
      { type: "not json at all" },
    ]);
    writeSubagentTranscript(
      "-tmp-alpha",
      "aaaaaaaa-1111-4222-8333-444444444444",
      "bbbbbbbb-1111-4222-8333-444444444444",
      [
        {
          type: "assistant",
          timestamp: "2026-05-02T10:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t4", name: "mcp__docs_server__search", input: {} },
            ],
          },
        },
      ],
    );

    clearScanCache();
    const cold = mcpUsage(root);
    expect(cold.totals.callsTotal).toBe(3);
    expect(mcpUsage(root)).toEqual(cold);
  });

  it("counts a transcript appended to since the last read", () => {
    const sessionId = "aaaaaaaa-1111-4222-8333-444444444444";
    const call = (id: string) => ({
      type: "assistant",
      timestamp: "2026-05-01T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "mcp__docs_server__search", input: {} }],
      },
    });
    writeTranscript("-tmp-alpha", sessionId, [call("t1")]);
    expect(mcpUsage(root).totals.callsTotal).toBe(1);

    fs.appendFileSync(
      path.join(root, "-tmp-alpha", `${sessionId}.jsonl`),
      `${JSON.stringify(call("t2"))}\n`,
      "utf8",
    );
    // Keyed on the file's identity, so an append is a different key rather than a
    // stale hit that would report the shorter read forever.
    expect(mcpUsage(root).totals.callsTotal).toBe(2);
  });
});
