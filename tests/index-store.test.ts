import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../server/config.js";
import {
  createIndexHandle,
  indexStats,
  openIndex,
  searchIndex,
  syncIndex,
  toMatchExpression,
} from "../server/index-store.js";

let root = "";
let config: AppConfig;
let indexPath = "";

/** Synthetic sources only; the real corpus is the operator's own writing. */
function writeTranscript(projectDir: string, sessionId: string, lines: unknown[]): void {
  const dir = path.join(root, "projects", projectDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
    "utf8",
  );
}

function userTurn(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: `u${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "s",
    timestamp: "2026-07-01T10:00:00.000Z",
    cwd: "/tmp/project",
    message: { role: "user", content: text },
    ...overrides,
  };
}

function writeThought(fileName: string, description: string, body: string): void {
  const dir = path.join(root, "vault", "thoughts", "Pattern");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, fileName),
    `---\nid: ${fileName.replace(/\.md$/, "")}\nprefix: Pattern\ncreated_at: 2026-01-01T00:00:00Z\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
    "utf8",
  );
}

function writeFrictionLog(lines: string[]): void {
  fs.writeFileSync(path.join(root, "friction.md"), lines.join("\n"), "utf8");
}

function writeWrap(dateSlug: string, title: string, body: string): void {
  const dir = path.join(root, "wraps");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `session_wrap_${dateSlug}.md`),
    `---\ndescription: ${JSON.stringify(title)}\n---\n\n# Session Wrap: ${title}\n\n${body}\n`,
    "utf8",
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-index-"));
  indexPath = path.join(root, ".cache", "index.db");
  config = {
    port: 0,
    engramVaultPath: path.join(root, "vault"),
    frictionLogPath: path.join(root, "friction.md"),
    skillRoots: [],
    ctaDbPath: path.join(root, "absent.db"),
    wrapsDir: path.join(root, "wraps"),
    frictionResolveWindowDays: 14,
    claudeBinary: "claude",
    launchDefaults: {
      cwd: root,
      allowedTools: "Read",
      permissionMode: "acceptEdits",
      maxBudgetUsd: null,
      timeoutSeconds: 60,
    },
    smokeCommand: "true",
    transcriptsDir: path.join(root, "projects"),
    liveSessionsDir: path.join(root, "sessions"),
    tasksDir: path.join(root, "tasks"),
    claudeConfigPath: path.join(root, "claude.json"),
    claudeSettingsPath: path.join(root, "settings.json"),
    pluginsDir: path.join(root, "plugins"),
    historyPath: path.join(root, "history.jsonl"),
    workflowsDir: path.join(root, "workflows"),
    pacingLogPath: path.join(root, "pacing-log.jsonl"),
    fileHistoryDir: path.join(root, "file-history"),
    usageDataDir: path.join(root, "usage-data"),
    claudeHome: root,
    agentsDir: path.join(root, "agents"),
    claudeMdPath: path.join(root, "CLAUDE.md"),
    indexPath,
    digest: { localModelUrl: "http://127.0.0.1:8080", model: null, maxGrade: 12 },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("toMatchExpression", () => {
  it("quotes each word so query syntax cannot leak in", () => {
    // FTS5's MATCH argument is a query language. An unescaped quote or NEAR would
    // either error or silently mean something the reader did not type.
    expect(toMatchExpression('launch "bounds"')).toBe('"launch"* AND "bounds"*');
    expect(toMatchExpression("NEAR OR AND")).toBe('"near"* AND "or"* AND "and"*');
    // A quote cannot reach the expression at all: tokenizing on non-word
    // characters drops it before quoting happens, so `a"b` becomes two terms.
    // That is a stronger property than escaping it would be.
    expect(toMatchExpression('a"b')).toBe('"a"* AND "b"*');
    expect(toMatchExpression('" OR "')).toBe('"or"*');
  });

  it("ANDs the words so more words means fewer results", () => {
    expect(toMatchExpression("one two three")).toBe('"one"* AND "two"* AND "three"*');
  });

  it("returns null when there is nothing to match on", () => {
    expect(toMatchExpression("")).toBeNull();
    expect(toMatchExpression("   ")).toBeNull();
    expect(toMatchExpression("!!! ??? ...")).toBeNull();
  });
});

describe("syncIndex", () => {
  it("indexes every pillar that exists on this machine", () => {
    writeTranscript("-tmp-project", "sess-1", [
      userTurn("Please harden the launcher bounds today"),
      { type: "ai-title", sessionId: "sess-1", aiTitle: "Harden launcher bounds" },
    ]);
    writeThought("t-one.md", "Bind to loopback only", "The server listens on loopback.");
    writeFrictionLog([
      "2026-01-01T00:00:00Z | [Friction] | the chart overflowed its axis",
      "2026-01-02T00:00:00Z | [Resolution] | added a compact tick formatter",
    ]);
    writeWrap("2026_01_03_ship", "Shipped the formatter", "Details of the work.");

    const db = openIndex(indexPath);
    const report = syncIndex(db, config);

    expect(report.documents).toBeGreaterThanOrEqual(4);
    const stats = indexStats(db, indexPath);
    expect(stats.byKind.session).toBe(1);
    expect(stats.byKind.thought).toBe(1);
    expect(stats.byKind.wrap).toBe(1);
    expect(stats.byKind.friction).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("gives a search hit a label, not the head of a markdown document", () => {
    writeTranscript("-tmp-project", "sess-md", [
      userTurn("# HANDOFF - continue the rename\n\n> state follows\n\nreal ask here"),
    ]);
    const db = openIndex(indexPath);
    syncIndex(db, config);

    const [hit] = searchIndex(db, "rename", { kind: "session" });
    expect(hit!.title).toBe("HANDOFF - continue the rename");
    db.close();
  });

  it("keeps the command envelope out of a search hit's title", () => {
    writeTranscript("-tmp-project", "sess-cmd", [
      userTurn("<command-name>/effort</command-name>\n<command-args></command-args>"),
      userTurn("harden the launcher bounds"),
    ]);
    const db = openIndex(indexPath);
    syncIndex(db, config);

    const [hit] = searchIndex(db, "launcher", { kind: "session" });
    expect(hit!.title).toBe("harden the launcher bounds");
    db.close();
  });

  it("still indexes a session whose prompts are only envelopes", () => {
    // No label can be made, but the body is still worth matching, so the
    // document must survive with the session id standing in for a title.
    writeTranscript("-tmp-project", "sess-env", [
      userTurn("<command-name>/clear</command-name>"),
    ]);
    const db = openIndex(indexPath);
    syncIndex(db, config);

    const [hit] = searchIndex(db, "clear", { kind: "session" });
    expect(hit).toBeDefined();
    expect(hit!.title).toBe("sess-env");
    db.close();
  });

  it("leaves no escape byte in an indexed title or body", () => {
    writeTranscript("-tmp-project", "sess-esc", [
      userTurn("Set model to \u001b[1mFable 5\u001b[22m now"),
    ]);
    const db = openIndex(indexPath);
    syncIndex(db, config);

    const esc = String.fromCharCode(27);
    const [hit] = searchIndex(db, "Fable", { kind: "session" });
    expect(hit!.title).toBe("Set model to Fable 5 now");
    expect(JSON.stringify(hit).includes(esc)).toBe(false);
    db.close();
  });

  it("skips a file whose identity has not changed", () => {
    writeTranscript("-tmp-project", "sess-1", [userTurn("first prompt")]);
    const db = openIndex(indexPath);

    const first = syncIndex(db, config);
    expect(first.filesIndexed).toBeGreaterThanOrEqual(1);
    expect(first.filesUnchanged).toBe(0);

    const second = syncIndex(db, config);
    expect(second.filesIndexed).toBe(0);
    expect(second.filesUnchanged).toBe(first.filesIndexed);
    db.close();
  });

  it("reindexes a file whose content changed", () => {
    writeTranscript("-tmp-project", "sess-1", [userTurn("original wording here")]);
    const db = openIndex(indexPath);
    syncIndex(db, config);
    expect(searchIndex(db, "original")).toHaveLength(1);

    writeTranscript("-tmp-project", "sess-1", [userTurn("replacement wording here")]);
    syncIndex(db, config);
    expect(searchIndex(db, "original")).toHaveLength(0);
    expect(searchIndex(db, "replacement")).toHaveLength(1);
    db.close();
  });

  it("removes documents for a source file that no longer exists", () => {
    writeTranscript("-tmp-project", "sess-1", [userTurn("findable phrase alpha")]);
    writeTranscript("-tmp-project", "sess-2", [userTurn("findable phrase beta")]);
    const db = openIndex(indexPath);
    syncIndex(db, config);
    expect(searchIndex(db, "findable")).toHaveLength(2);

    fs.rmSync(path.join(root, "projects", "-tmp-project", "sess-2.jsonl"));
    const report = syncIndex(db, config);

    // An index that outlives its source is a way to read something that has been
    // deleted, so a vanished file must take its documents with it.
    expect(report.filesRemoved).toBe(1);
    expect(searchIndex(db, "findable")).toHaveLength(1);
    expect(searchIndex(db, "beta")).toHaveLength(0);
    db.close();
  });

  it("holds a pillar's documents when its source cannot be read, and names the path", () => {
    // The removal sweep reads "not seen this run" as "deleted", and a source that
    // cannot be opened contributes exactly as many files as an emptied one: none.
    // So one mistyped path in config.json would purge a whole pillar out of the
    // index and report a clean sync. Measured against a copy of a real index, a
    // wrong vault path removed 879 files and 848 memory documents at HTTP 200.
    writeTranscript("-tmp-project", "sess-1", [userTurn("a transcript that stays")]);
    writeThought("t-one.md", "first note", "indexed body one");
    writeThought("t-two.md", "second note", "indexed body two");
    const db = openIndex(indexPath);
    syncIndex(db, config);
    expect(indexStats(db, indexPath).byKind.thought).toBe(2);

    const typo = { ...config, engramVaultPath: path.join(root, "vault-typo") };
    const report = syncIndex(db, typo);

    expect(report.sourcesUnreadable).toContainEqual({
      kind: "thought",
      path: typo.engramVaultPath,
    });
    expect(report.filesRemoved).toBe(0);
    expect(indexStats(db, indexPath).byKind.thought).toBe(2);
    expect(searchIndex(db, "indexed")).toHaveLength(2);
    db.close();
  });

  it("still removes a vanished file while another source is unreadable", () => {
    // The other half of the guard: holding an unread source's documents must not
    // become "stop removing anything". A real deletion under a source that IS
    // readable still has to take its documents with it.
    writeTranscript("-tmp-project", "sess-1", [userTurn("findable phrase alpha")]);
    writeTranscript("-tmp-project", "sess-2", [userTurn("findable phrase beta")]);
    writeThought("t-one.md", "a note", "held body");
    const db = openIndex(indexPath);
    syncIndex(db, config);

    fs.rmSync(path.join(root, "projects", "-tmp-project", "sess-2.jsonl"));
    const typo = { ...config, engramVaultPath: path.join(root, "vault-typo") };
    const report = syncIndex(db, typo);

    expect(report.filesRemoved).toBe(1);
    expect(searchIndex(db, "beta")).toHaveLength(0);
    expect(indexStats(db, indexPath).byKind.thought).toBe(1);
    db.close();
  });

  it("reports no unreadable source when every configured one is present", () => {
    // The negative control. Without it, a guard hard-coded to report every source
    // as unreadable would pass the two tests above and never remove anything.
    writeTranscript("-tmp-project", "sess-1", [userTurn("a transcript")]);
    writeThought("t-one.md", "a note", "a body");
    writeWrap("2026-07-01_thing", "A Wrap", "wrap body");
    writeFrictionLog(["| 2026-07-01 | Friction | something rubbed |"]);
    const db = openIndex(indexPath);
    const report = syncIndex(db, config);
    expect(report.sourcesUnreadable).toEqual([]);
    db.close();
  });

  it("builds from whichever pillars exist, without a missing one failing the sync", () => {
    // Only transcripts here: no vault, no wraps, no friction log.
    writeTranscript("-tmp-project", "sess-1", [userTurn("only transcripts on this box")]);
    const db = openIndex(indexPath);
    const report = syncIndex(db, config);
    expect(report.documents).toBe(1);
    expect(indexStats(db, indexPath).byKind.thought).toBeUndefined();
    db.close();
  });

  it("does not write to any source file", () => {
    writeTranscript("-tmp-project", "sess-1", [userTurn("a prompt")]);
    writeThought("t-one.md", "desc", "body");
    const snapshot = (): string =>
      JSON.stringify(
        ["projects/-tmp-project/sess-1.jsonl", "vault/thoughts/Pattern/t-one.md"].map((rel) => {
          const stat = fs.statSync(path.join(root, rel));
          return [rel, stat.size, stat.mtimeMs];
        }),
      );

    const before = snapshot();
    const db = openIndex(indexPath);
    syncIndex(db, config);
    searchIndex(db, "prompt");
    db.close();
    expect(snapshot()).toBe(before);
  });
});

describe("searchIndex", () => {
  function seeded() {
    writeTranscript("-tmp-project", "sess-1", [
      userTurn("The launcher must clamp every override to the configured ceiling"),
      { type: "ai-title", sessionId: "sess-1", aiTitle: "Launcher clamping" },
    ]);
    writeThought("t-loop.md", "Bind to loopback only", "Nothing off-machine can reach it.");
    writeFrictionLog(["2026-01-01T00:00:00Z | [Friction] | the axis overflowed"]);
    writeWrap("2026_01_03_ship", "Shipped clamping", "Clamping landed with tests.");
    const db = openIndex(indexPath);
    syncIndex(db, config);
    return db;
  }

  it("finds a match in any pillar from one query", () => {
    const db = seeded();
    expect(searchIndex(db, "loopback").map((h) => h.kind)).toEqual(["thought"]);
    expect(searchIndex(db, "overflowed").map((h) => h.kind)).toEqual(["friction"]);
    const clamping = searchIndex(db, "clamping").map((h) => h.kind);
    expect(clamping).toContain("session");
    expect(clamping).toContain("wrap");
    db.close();
  });

  it("returns a hit that names how to fetch the real record", () => {
    const db = seeded();
    // Pick the session hit by kind rather than assuming it ranks first: several
    // pillars legitimately match "clamp" here, and pinning a bm25 ordering would
    // make this test fail on a relevance change that broke nothing.
    const hit = searchIndex(db, "clamp").find((h) => h.kind === "session");
    expect(hit).toBeDefined();
    expect(hit!.ref).toBe("sess-1");
    // The session detail route needs the project directory too, which is why a
    // hit carries a second locator rather than just an id.
    expect(hit!.locator).toBe("-tmp-project");
    db.close();
  });

  it("returns an excerpt showing why it matched", () => {
    const db = seeded();
    const [hit] = searchIndex(db, "ceiling");
    expect(hit!.excerpt).toContain("[ceiling]");
    db.close();
  });

  it("filters by kind", () => {
    const db = seeded();
    expect(searchIndex(db, "clamping", { kind: "wrap" }).map((h) => h.kind)).toEqual(["wrap"]);
    db.close();
  });

  it("matches on a prefix", () => {
    const db = seeded();
    expect(searchIndex(db, "loopb").length).toBeGreaterThan(0);
    db.close();
  });

  it("returns nothing for a query that matches nothing", () => {
    const db = seeded();
    expect(searchIndex(db, "zzzzz-nothing-here")).toEqual([]);
    expect(searchIndex(db, "")).toEqual([]);
    db.close();
  });
});

describe("disposability", () => {
  it("gives identical answers after being deleted and rebuilt", () => {
    // This is the invariant that reconciles a cache with owning no data. It is
    // asserted by exercising it rather than by claiming it in a comment.
    writeTranscript("-tmp-project", "sess-1", [userTurn("clamp every override")]);
    writeThought("t-loop.md", "Bind to loopback only", "Nothing reaches it.");
    writeFrictionLog(["2026-01-01T00:00:00Z | [Friction] | the axis overflowed"]);

    const first = openIndex(indexPath);
    syncIndex(first, config);
    const before = ["clamp", "loopback", "overflowed", "axis"].map((q) =>
      searchIndex(first, q).map((h) => `${h.kind}:${h.ref}:${h.locator}`),
    );
    first.close();

    fs.rmSync(indexPath, { force: true });
    expect(fs.existsSync(indexPath)).toBe(false);

    const second = openIndex(indexPath);
    syncIndex(second, config);
    const after = ["clamp", "loopback", "overflowed", "axis"].map((q) =>
      searchIndex(second, q).map((h) => `${h.kind}:${h.ref}:${h.locator}`),
    );
    second.close();

    expect(after).toEqual(before);
  });

  it("rebuilds rather than migrating when the schema version moves", () => {
    writeTranscript("-tmp-project", "sess-1", [userTurn("clamp every override")]);
    const db = openIndex(indexPath);
    syncIndex(db, config);
    expect(indexStats(db, indexPath).documents).toBe(1);
    // Simulate an older index left behind by a previous version.
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    db.close();

    const reopened = openIndex(indexPath);
    // Everything is gone, which is the correct outcome: nothing here was
    // authoritative, so discarding it costs one re-read.
    expect(indexStats(reopened, indexPath).documents).toBe(0);
    syncIndex(reopened, config);
    expect(indexStats(reopened, indexPath).documents).toBe(1);
    reopened.close();
  });

  it("survives its own file being deleted while a handle is open", () => {
    // The promise that this cache may be deleted at any time has to hold while the
    // server is running, which is the only time it matters. SQLite refuses further
    // writes on an unlinked database with SQLITE_READONLY_DBMOVED, so without a
    // reopen the first delete would break the running process until restart.
    writeTranscript("-tmp-project", "sess-1", [userTurn("clamp every override")]);
    const handle = createIndexHandle(indexPath);

    handle.run((db) => syncIndex(db, config));
    const before = handle.run((db) => searchIndex(db, "clamp")).length;
    expect(before).toBe(1);

    fs.rmSync(indexPath, { force: true });

    // Both a write and a read must recover, not just one of them.
    const report = handle.run((db) => syncIndex(db, config));
    expect(report.documents).toBe(1);
    expect(handle.run((db) => searchIndex(db, "clamp")).length).toBe(before);
    handle.close();
  });

  it("creates its parent directory rather than failing on a fresh clone", () => {
    expect(fs.existsSync(path.dirname(indexPath))).toBe(false);
    const db = openIndex(indexPath);
    expect(fs.existsSync(indexPath)).toBe(true);
    db.close();
  });
});
