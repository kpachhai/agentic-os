import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SourceMissingError } from "../server/config.js";
import {
  MAX_LINE_CHARS,
  clearScanCache,
  decodeProjectDir,
  listSubagentTranscriptFiles,
  listTranscriptFiles,
  parseTranscript,
  resolveTranscriptPath,
  scanCached,
  streamTranscript,
} from "../server/transcripts.js";

// Everything here runs against a synthetic tree in a temp dir. The reader's
// real input is the operator's session history, which must never be read into
// a test or committed as a fixture.
let root: string;
let projectOne: string;
let projectTwo: string;
let wellFormedPath: string;
let malformedPath: string;
let unicodePath: string;

const PROJECT_ONE_DIR = "-Users-someone-repos-project";
const PROJECT_TWO_DIR = "-Users-someone-repos-other";

/** One record of each type observed in a real transcript. */
const WELL_FORMED_LINES = [
  {
    type: "user",
    uuid: "u-1",
    parentUuid: null,
    sessionId: "s-1",
    timestamp: "2026-07-01T10:00:00.000Z",
    cwd: "/Users/someone/repos/project",  // pii-allow: generic placeholder path in a synthetic fixture
    gitBranch: "main",
    version: "9.9.9",
    isSidechain: false,
    isMeta: false,
    message: { role: "user", content: "add a test" },
  },
  {
    type: "assistant",
    uuid: "a-1",
    parentUuid: "u-1",
    sessionId: "s-1",
    timestamp: "2026-07-01T10:00:04.000Z",
    requestId: "req_1",
    isSidechain: false,
    attributionSkill: "example-skill",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "test-model",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "reading the file first" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/x" } },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 56,
        cache_creation_input_tokens: 78,
        service_tier: "standard",
      },
    },
  },
  {
    type: "system",
    uuid: "sys-1",
    parentUuid: "a-1",
    sessionId: "s-1",
    timestamp: "2026-07-01T10:00:05.000Z",
    subtype: "hook_result",
    level: "info",
    durationMs: 21,
    hookCount: 1,
    hookErrors: [],
    preventedContinuation: false,
  },
  { type: "ai-title", sessionId: "s-1", aiTitle: "add a test" },
  {
    type: "attachment",
    uuid: "att-1",
    parentUuid: "u-1",
    sessionId: "s-1",
    timestamp: "2026-07-01T10:00:06.000Z",
    attachment: { kind: "file", path: "/x" },
  },
  { type: "file-history-snapshot", sessionId: "s-1", snapshot: { files: [] } },
  { type: "queue-operation", sessionId: "s-1", operation: "enqueue" },
];

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * Number of descriptors this process currently holds, or null where the kernel
 * does not expose them. Both directories list the calling process's own
 * descriptors; /proc/self/fd is the Linux name and /dev/fd the BSD one.
 */
function countOpenFds(): number | null {
  const dir = ["/proc/self/fd", "/dev/fd"].find((d) => fs.existsSync(d));
  return dir === undefined ? null : fs.readdirSync(dir).length;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-transcripts-"));
  projectOne = path.join(root, PROJECT_ONE_DIR);
  projectTwo = path.join(root, PROJECT_TWO_DIR);
  fs.mkdirSync(projectOne);
  fs.mkdirSync(projectTwo);

  wellFormedPath = path.join(projectOne, "11111111-1111-4111-8111-111111111111.jsonl");
  writeJsonl(wellFormedPath, WELL_FORMED_LINES);

  // Two unparseable lines, a blank line, and a truncated final line with no
  // newline - exactly what reading a file a live process is appending to looks
  // like. The blank line must not be counted as a failure.
  malformedPath = path.join(projectOne, "22222222-2222-4222-8222-222222222222.jsonl");
  fs.writeFileSync(
    malformedPath,
    [
      JSON.stringify({ type: "user", uuid: "u-1", message: { role: "user" } }),
      '{"type":"assistant","message":{',
      "this line is not json at all",
      "",
      JSON.stringify({ type: "system", uuid: "sys-1", subtype: "hook_result" }),
      '{"type":"user","uuid":"u-2","message":{"role":"user","content":"trunc',
    ].join("\n"),
  );

  // A single record larger than the reader's chunk size, padded with multi-byte
  // characters so a character lands on a chunk boundary.
  unicodePath = path.join(projectTwo, "33333333-3333-4333-8333-333333333333.jsonl");
  writeJsonl(unicodePath, [
    { type: "user", uuid: "u-1", message: { role: "user", content: "é".repeat(300000) } },
    { type: "ai-title", sessionId: "s-3", aiTitle: "wide payload" },
  ]);

  // Subagent traffic lives in a nested directory and is not a session.
  const nestedDir = path.join(projectOne, "subagent-plugin");
  fs.mkdirSync(nestedDir);
  writeJsonl(path.join(nestedDir, "44444444-4444-4444-8444-444444444444.jsonl"), [
    { type: "user", uuid: "u-1", isSidechain: true, message: { role: "user" } },
  ]);

  // A stray file at the top level belongs to no project and is not a session.
  writeJsonl(path.join(root, "loose.jsonl"), [{ type: "user", uuid: "u-1" }]);

  // A file whose whole name is the extension has no session id, so it is not a
  // session. It stays in the tree as a regression fixture: were it counted, the
  // listing tests would see a fourth file with an empty id.
  writeJsonl(path.join(projectTwo, ".jsonl"), [{ type: "user", uuid: "u-1" }]);

  // Explicit mtimes so newest-first ordering is deterministic.
  fs.utimesSync(wellFormedPath, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));
  fs.utimesSync(malformedPath, new Date("2026-07-03T00:00:00Z"), new Date("2026-07-03T00:00:00Z"));
  fs.utimesSync(unicodePath, new Date("2026-07-02T00:00:00Z"), new Date("2026-07-02T00:00:00Z"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("parseTranscript", () => {
  it("parses every record of a well-formed multi-type transcript", () => {
    const { records, skippedLines } = parseTranscript(wellFormedPath);
    expect(skippedLines).toBe(0);
    expect(records).toHaveLength(WELL_FORMED_LINES.length);
    expect(records.map((r) => r.type)).toEqual([
      "user",
      "assistant",
      "system",
      "ai-title",
      "attachment",
      "file-history-snapshot",
      "queue-operation",
    ]);
  });

  it("keeps nested record payloads intact for callers to narrow", () => {
    const assistant = parseTranscript(wellFormedPath).records.find(
      (r) => r.type === "assistant",
    )!;
    const message = assistant.message as {
      usage: { input_tokens: number; cache_read_input_tokens: number };
      content: Array<{ type: string; name?: string }>;
    };
    expect(message.usage.input_tokens).toBe(12);
    expect(message.usage.cache_read_input_tokens).toBe(56);
    expect(message.content.find((b) => b.type === "tool_use")?.name).toBe("Read");
  });

  it("skips malformed and truncated lines, counting exactly the failures", () => {
    const { records, skippedLines } = parseTranscript(malformedPath);
    expect(skippedLines).toBe(3);
    expect(records.map((r) => r.type)).toEqual(["user", "system"]);
  });

  it("counts a JSON line that is not a typed record as skipped", () => {
    const oddPath = path.join(projectTwo, "55555555-5555-4555-8555-555555555555.jsonl");
    fs.writeFileSync(
      oddPath,
      ["42", '"a bare string"', "[1,2,3]", '{"no":"type field"}', '{"type":7}'].join("\n") + "\n",
    );
    const { records, skippedLines } = parseTranscript(oddPath);
    expect(records).toEqual([]);
    expect(skippedLines).toBe(5);
    fs.rmSync(oddPath);
  });

  it("reads a record larger than one chunk without corrupting multi-byte text", () => {
    const { records, skippedLines } = parseTranscript(unicodePath);
    expect(skippedLines).toBe(0);
    expect(records).toHaveLength(2);
    const content = (records[0]!.message as { content: string }).content;
    expect(content).toHaveLength(300000);
    expect(content).toBe("é".repeat(300000));
    expect(records[1]!.type).toBe("ai-title");
  });

  it("drops a line past the length cap, counts it, and keeps reading after it", () => {
    // Every long line here is valid JSON, so length is the only thing that can
    // decide its fate: an unbounded reader would return all four records.
    const underCap = JSON.stringify({
      type: "user",
      uuid: "under-cap",
      pad: "a".repeat(1_000_000),
    });
    // Exactly at the cap, so the boundary is pinned from both sides: an
    // off-by-one would start dropping legitimate lines.
    const shell = JSON.stringify({ type: "user", uuid: "at-cap", pad: "" });
    const atCap = JSON.stringify({
      type: "user",
      uuid: "at-cap",
      pad: "b".repeat(MAX_LINE_CHARS - shell.length),
    });
    expect(atCap).toHaveLength(MAX_LINE_CHARS);
    // Past the cap by far less than one read chunk, so its terminating newline
    // arrives in the same chunk that carries it past the cap.
    const overCap = JSON.stringify({
      type: "user",
      uuid: "over-cap",
      pad: "c".repeat(MAX_LINE_CHARS),
    });
    expect(overCap.length).toBeGreaterThan(MAX_LINE_CHARS);
    expect(() => JSON.parse(overCap)).not.toThrow();

    const capPath = path.join(projectTwo, "66666666-6666-4666-8666-666666666666.jsonl");
    fs.writeFileSync(
      capPath,
      [underCap, atCap, overCap, JSON.stringify({ type: "ai-title", aiTitle: "after" })].join("\n") +
        "\n",
    );
    try {
      const { records, skippedLines } = parseTranscript(capPath);
      expect(skippedLines).toBe(1);
      expect(records.map((r) => r.type)).toEqual(["user", "user", "ai-title"]);
      expect(records.map((r) => r.uuid)).toEqual(["under-cap", "at-cap", undefined]);
    } finally {
      fs.rmSync(capPath);
    }
  });

  it("drops an over-long final line that has no trailing newline", () => {
    // Valid JSON again, and one character past the cap, so an unbounded reader
    // would hand it out as a record instead of counting it.
    const shell = JSON.stringify({ type: "user", uuid: "over-cap-at-eof", pad: "" });
    const overCapAtEof = JSON.stringify({
      type: "user",
      uuid: "over-cap-at-eof",
      pad: "d".repeat(MAX_LINE_CHARS + 1 - shell.length),
    });
    expect(overCapAtEof).toHaveLength(MAX_LINE_CHARS + 1);
    expect(() => JSON.parse(overCapAtEof)).not.toThrow();

    const capPath = path.join(projectTwo, "77777777-7777-4777-8777-777777777777.jsonl");
    fs.writeFileSync(capPath, `${JSON.stringify({ type: "user", uuid: "u-1" })}\n${overCapAtEof}`);
    try {
      const { records, skippedLines } = parseTranscript(capPath);
      expect(skippedLines).toBe(1);
      expect(records.map((r) => r.uuid)).toEqual(["u-1"]);
    } finally {
      fs.rmSync(capPath);
    }
  });
});

describe("streamTranscript", () => {
  it("yields records one at a time and stops when abandoned", () => {
    const seen: string[] = [];
    for (const line of streamTranscript(wellFormedPath)) {
      if (!line.ok) throw new Error("well-formed fixture yielded a failure");
      seen.push(line.record.type);
      if (seen.length === 2) break;
    }
    expect(seen).toEqual(["user", "assistant"]);
  });

  it("reads only what the consumer asks for instead of the whole file", () => {
    // Observing the bytes the reader pulls off disk is the only way to tell
    // laziness from an implementation that materializes the file first and then
    // hands out its head; a loop that breaks early proves nothing on its own.
    const line = JSON.stringify({
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: "y".repeat(900) },
    });
    const bigPath = path.join(projectTwo, "88888888-8888-4888-8888-888888888888.jsonl");
    fs.writeFileSync(bigPath, `${Array.from({ length: 4000 }, () => line).join("\n")}\n`);
    const fileSize = fs.statSync(bigPath).size;
    expect(fileSize).toBeGreaterThan(3_000_000);

    const spy = vi.spyOn(fs, "readSync");
    const bytesRead = (): number =>
      spy.mock.results.reduce(
        (sum, r) => sum + (r.type === "return" ? (r.value as number) : 0),
        0,
      );
    try {
      for (const first of streamTranscript(bigPath)) {
        expect(first.ok).toBe(true);
        break;
      }
      const lazyBytes = bytesRead();
      spy.mockClear();
      const { records } = parseTranscript(bigPath);
      const wholeFileBytes = bytesRead();

      expect(records).toHaveLength(4000);
      // One chunk is enough to reach the first record, and reading the whole
      // file must cost every byte of it.
      expect(lazyBytes).toBeLessThanOrEqual(512 * 1024);
      expect(wholeFileBytes).toBeGreaterThanOrEqual(fileSize);
      expect(lazyBytes * 4).toBeLessThan(wholeFileBytes);
    } finally {
      spy.mockRestore();
      fs.rmSync(bigPath);
    }
  });

  it.skipIf(countOpenFds() === null)(
    "leaks no descriptor when a generator is stepped by hand and dropped",
    () => {
      // A caller peeking the first record of many transcripts drives the
      // generator itself rather than with for..of, and a dropped generator never
      // runs its finally block, so a descriptor held across a yield would leak
      // once per peek until the process hits EMFILE.
      const before = countOpenFds()!;
      for (let i = 0; i < 50; i++) {
        const stepped = streamTranscript(wellFormedPath);
        expect(stepped.next().done).toBe(false);
        // Deliberately not returned to or exhausted.
      }
      const after = countOpenFds()!;
      expect(after - before).toBeLessThanOrEqual(2);
    },
  );
});

describe("listTranscriptFiles", () => {
  it("reports an absent directory as a missing source", () => {
    expect(() => listTranscriptFiles(path.join(root, "no-such-dir"))).toThrow(
      SourceMissingError,
    );
  });

  it("reports a configured path that is not a directory as a missing source", () => {
    // A config typo pointing this pillar at a file must degrade the way every
    // other pillar does (503 naming the path), not surface a raw ENOTDIR as 500.
    const filePath = path.join(root, "not-a-directory");
    fs.writeFileSync(filePath, "{}\n");
    try {
      expect(() => listTranscriptFiles(filePath)).toThrow(SourceMissingError);
      expect(() => listTranscriptFiles(filePath)).toThrow(/not-a-directory/);
      // Same for a path whose leading component is a file.
      expect(() => listTranscriptFiles(path.join(filePath, "projects"))).toThrow(
        SourceMissingError,
      );
    } finally {
      fs.rmSync(filePath);
    }
  });

  it("returns only top-level transcripts inside project directories", () => {
    const files = listTranscriptFiles(root);
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(path.dirname(f.filePath)).toBe(path.join(root, f.projectDir));
      expect(f.sessionId).not.toMatch(/\.jsonl$/);
      expect(f.sizeBytes).toBeGreaterThan(0);
    }
    expect(files.map((f) => f.filePath)).not.toContain(path.join(root, "loose.jsonl"));
  });

  it("excludes nested subagent transcripts", () => {
    const files = listTranscriptFiles(root);
    expect(files.some((f) => f.filePath.includes("subagent-plugin"))).toBe(false);
    expect(files.some((f) => f.sessionId.startsWith("44444444"))).toBe(false);
  });

  it("skips a file named only .jsonl rather than yielding an empty session id", () => {
    const files = listTranscriptFiles(root);
    expect(files.map((f) => f.sessionId)).not.toContain("");
    expect(files.map((f) => f.filePath)).not.toContain(path.join(projectTwo, ".jsonl"));
  });

  it("orders newest first by mtime", () => {
    const files = listTranscriptFiles(root);
    expect(files.map((f) => f.sessionId)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
    ]);
    const mtimes = files.map((f) => f.mtimeMs);
    expect([...mtimes].sort((a, b) => b - a)).toEqual(mtimes);
  });

  it("labels each transcript with its encoded project directory", () => {
    const files = listTranscriptFiles(root);
    const dirs = new Set(files.map((f) => f.projectDir));
    expect(dirs).toEqual(new Set([PROJECT_ONE_DIR, PROJECT_TWO_DIR]));
  });

  it("excludes a symlinked project directory and warns that it did", () => {
    // The exclusion keeps the scan inside the configured directory. It is worth
    // a test of its own because it rests on Dirent.isDirectory() answering for
    // the link and not its target; a target-following stat would silently start
    // walking wherever the link points.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-linktarget-"));
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-linkscan-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeJsonl(path.join(outside, "99999999-9999-4999-8999-999999999999.jsonl"), [
        { type: "user", uuid: "u-1" },
      ]);
      fs.symlinkSync(outside, path.join(scanRoot, "-Users-someone-repos-linked"), "dir");
      // A link whose target is gone, which is what a moved repo leaves behind.
      // Skipping links before stating them is what keeps this from throwing.
      fs.symlinkSync(
        path.join(outside, "moved-away"),
        path.join(scanRoot, "-Users-someone-repos-dangling"),
        "dir",
      );

      expect(listTranscriptFiles(scanRoot)).toEqual([]);
      const warned = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(warned).toContain("-Users-someone-repos-linked");
      expect(warned).toContain("symlink");
    } finally {
      warn.mockRestore();
      fs.rmSync(scanRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("excludes a symlinked transcript and warns that it did", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-linktarget-"));
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-linkscan-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const project = path.join(scanRoot, PROJECT_ONE_DIR);
      fs.mkdirSync(project);
      const target = path.join(outside, "real.jsonl");
      writeJsonl(target, [{ type: "user", uuid: "u-1" }]);
      fs.symlinkSync(target, path.join(project, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"));

      expect(listTranscriptFiles(scanRoot)).toEqual([]);
      const warned = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(warned).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
      expect(warned).toContain("symlink");
    } finally {
      warn.mockRestore();
      fs.rmSync(scanRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveTranscriptPath", () => {
  it("builds the path of a transcript inside the configured directory", () => {
    const resolved = resolveTranscriptPath(
      root,
      PROJECT_ONE_DIR,
      "11111111-1111-4111-8111-111111111111",
    );
    expect(resolved).toBe(wellFormedPath);
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it("rejects traversal in either component instead of reaching outside", () => {
    const escapes = ["..", "../..", "../../etc", "a/../..", ".", ""];
    for (const bad of escapes) {
      expect(resolveTranscriptPath(root, bad, "11111111")).toBeNull();
      expect(resolveTranscriptPath(root, PROJECT_ONE_DIR, bad)).toBeNull();
    }
    // The concrete attack: a session id that walks out of the tree entirely.
    expect(
      resolveTranscriptPath(root, PROJECT_ONE_DIR, "../../../../../etc/passwd"),
    ).toBeNull();
  });

  it("rejects separators, backslashes and NUL bytes in either component", () => {
    for (const bad of ["a/b", "a\\b", "/absolute", "a\0b"]) {
      expect(resolveTranscriptPath(root, bad, "session")).toBeNull();
      expect(resolveTranscriptPath(root, PROJECT_ONE_DIR, bad)).toBeNull();
    }
  });

  it("never returns a path outside the configured directory", () => {
    const candidates = ["ok-dir", "..", "a/b", "-Users-someone-repos-project"];
    for (const dir of candidates) {
      for (const id of candidates) {
        const resolved = resolveTranscriptPath(root, dir, id);
        if (resolved === null) continue;
        expect(path.resolve(resolved).startsWith(path.resolve(root) + path.sep)).toBe(true);
      }
    }
  });
});

describe("read-only behaviour", () => {
  it("reads a tree with no write permission and leaves every byte of it alone", () => {
    // Launching is the only action this tool takes; a reader of the operator's
    // session history must never write. A tree with the write bit off proves
    // there is no write to fail silently, and the digest proves nothing changed.
    const readOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-readonly-"));
    const project = path.join(readOnlyRoot, PROJECT_ONE_DIR);
    fs.mkdirSync(project);
    const transcript = path.join(project, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl");
    writeJsonl(transcript, WELL_FORMED_LINES.slice(0, 2));

    const digest = (): string => {
      const stat = fs.statSync(transcript);
      const hash = crypto.createHash("sha256").update(fs.readFileSync(transcript)).digest("hex");
      return `${stat.size}:${stat.mtimeMs}:${hash}`;
    };
    const before = digest();

    fs.chmodSync(transcript, 0o444);
    fs.chmodSync(project, 0o555);
    fs.chmodSync(readOnlyRoot, 0o555);
    try {
      const files = listTranscriptFiles(readOnlyRoot);
      expect(files).toHaveLength(1);
      expect(parseTranscript(files[0]!.filePath).records).toHaveLength(2);
      for (const line of streamTranscript(files[0]!.filePath)) {
        expect(line.ok).toBe(true);
        break;
      }
      expect(digest()).toBe(before);
    } finally {
      fs.chmodSync(readOnlyRoot, 0o755);
      fs.chmodSync(project, 0o755);
      fs.chmodSync(transcript, 0o644);
      fs.rmSync(readOnlyRoot, { recursive: true, force: true });
    }
  });
});

describe("decodeProjectDir", () => {
  it("restores the root separator of a realistic project directory", () => {
    // "github.com" and the repo's own hyphen both encode to "-", so mapping
    // every "-" back to "/" would report two path levels that never existed.
    const encoded = "-Users-someone-repos-github-com-someone-web-app";
    expect(decodeProjectDir(encoded)).toBe(
      "/Users-someone-repos-github-com-someone-web-app",
    );
    expect(decodeProjectDir(encoded)).not.toContain("github/com");
    expect(decodeProjectDir(encoded)).not.toContain("web/app");
  });

  it("does not invent separators for a path with no hyphens of its own", () => {
    // Even here the interior separators are unrecoverable: this encoded name is
    // indistinguishable from one for a directory literally called
    // "Users-someone-repos-project", so only the root is restored.
    expect(decodeProjectDir(PROJECT_ONE_DIR)).toBe("/Users-someone-repos-project");
  });

  it("leaves a name that does not start at the root alone", () => {
    expect(decodeProjectDir("relative-name")).toBe("relative-name");
    expect(decodeProjectDir("")).toBe("");
  });
});

describe("listSubagentTranscriptFiles", () => {
  const SESSION = "aaaaaaaa-1111-4222-8333-444444444444";

  function writeSubagent(projectDir: string, sessionDir: string, name: string): void {
    const dir = path.join(root, projectDir, sessionDir, "subagents");
    fs.mkdirSync(dir, { recursive: true });
    writeJsonl(path.join(dir, name), [{ type: "assistant", isSidechain: true }]);
  }

  it("reports an absent directory as a missing source", () => {
    expect(() => listSubagentTranscriptFiles(path.join(root, "gone"))).toThrow(
      SourceMissingError,
    );
  });

  it("finds delegated transcripts and attributes them to the owning session", () => {
    writeSubagent("-tmp-alpha", SESSION, "agent-one.jsonl");
    const { files } = listSubagentTranscriptFiles(root);
    const mine = files.filter((f) => f.ownerSessionId === SESSION);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.sessionId).toBe("agent-one");
    expect(mine[0]!.relativePath).toBe(path.join("subagents", "agent-one.jsonl"));
  });

  it("ignores a sibling directory whose name is not a session id, and counts it", () => {
    // Plugins write their own logs beside the session transcripts. Reading one as
    // delegated work invented an owning session named after the plugin and counted
    // its lines as unreadable subagent history.
    const pluginDir = path.join(root, "-tmp-alpha", "vendor-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJsonl(path.join(pluginDir, "hook-log.jsonl"), [{ event: "hook", summaryOnly: true }]);

    const { files, skipped } = listSubagentTranscriptFiles(root);
    expect(files.map((f) => f.ownerSessionId)).not.toContain("vendor-plugin");
    expect(files.some((f) => f.filePath.includes("hook-log.jsonl"))).toBe(false);
    // Counted, not silently dropped: a skip nobody reports reads as nothing there.
    expect(skipped.nonSessionDirectories).toBeGreaterThanOrEqual(1);
  });

  it("never returns a file the mainline reader already returned", () => {
    writeJsonl(path.join(root, "-tmp-alpha", `${SESSION}.jsonl`), [{ type: "user" }]);
    writeSubagent("-tmp-alpha", SESSION, "agent-two.jsonl");
    const mainline = new Set(listTranscriptFiles(root).map((f) => f.filePath));
    const { files } = listSubagentTranscriptFiles(root);
    expect(files.filter((f) => mainline.has(f.filePath))).toEqual([]);
  });
});

/**
 * The memo every heavy reader shares. Its whole safety property is the key: a
 * transcript is appended to by a live process, so a cache keyed on the path alone
 * would serve a truncated view of an active session for as long as the server ran.
 */
describe("scanCached", () => {
  let cacheRoot: string;
  let filePath: string;

  function statOf(target: string): {
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
  } {
    const stat = fs.statSync(target);
    return { filePath: target, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  }

  beforeEach(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-scan-cache-"));
    filePath = path.join(cacheRoot, "session.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify({ type: "user" })}\n`, "utf8");
    clearScanCache();
  });

  afterEach(() => {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    clearScanCache();
  });

  it("does not let one extractor's sweep evict another's entries", () => {
    // The bound is per extractor for a measured reason. Shared and oldest-first,
    // any reader sweeping more files than the bound evicted its own earliest
    // entries before finishing a pass: the skill-attribution reader walks 1,111
    // files and answered in 14.4s cold and 15.6s warm, never once hitting. A
    // second full-corpus reader then evicted the first.
    const file = statOf(filePath);
    let readsA = 0;
    let readsB = 0;

    scanCached(file, "extractor-a", () => {
      readsA++;
      return "a";
    });
    // A different extractor sweeping the same file must not displace A.
    scanCached(file, "extractor-b", () => {
      readsB++;
      return "b";
    });
    const againA = scanCached(file, "extractor-a", () => {
      readsA++;
      return "a";
    });

    expect(readsA).toBe(1);
    expect(readsB).toBe(1);
    expect(againA).toBe("a");
  });

  it("keeps each extractor's value distinct for the same file", () => {
    const file = statOf(filePath);
    expect(scanCached(file, "counts", () => 7)).toBe(7);
    expect(scanCached(file, "names", () => ["x"])).toEqual(["x"]);
    // Re-reading either must not return the other's value.
    expect(scanCached(file, "counts", () => 99)).toBe(7);
  });

  it("reads the file once and serves the same value after", () => {
    let reads = 0;
    const extract = (target: string): number => {
      reads++;
      return parseTranscript(target).records.length;
    };

    expect(scanCached(statOf(filePath), "test", extract)).toBe(1);
    expect(scanCached(statOf(filePath), "test", extract)).toBe(1);
    expect(reads).toBe(1);
  });

  it("re-reads a file that has been appended to", () => {
    const extract = (target: string): number => parseTranscript(target).records.length;
    expect(scanCached(statOf(filePath), "test", extract)).toBe(1);

    fs.appendFileSync(filePath, `${JSON.stringify({ type: "assistant" })}\n`, "utf8");
    // A new size means a new key, so the shorter read cannot be served back.
    expect(scanCached(statOf(filePath), "test", extract)).toBe(2);
  });

  it("re-reads a file whose contents changed without changing length", () => {
    const extract = (target: string): string =>
      parseTranscript(target).records[0]!.type as string;
    expect(scanCached(statOf(filePath), "test", extract)).toBe("user");

    // Same byte length, different bytes: only the mtime separates these two reads,
    // which is why identity is all three of path, mtime and size rather than size
    // alone.
    fs.writeFileSync(filePath, `${JSON.stringify({ type: "usek" })}\n`, "utf8");
    fs.utimesSync(filePath, new Date(5_000), new Date(5_000));
    expect(scanCached(statOf(filePath), "test", extract)).toBe("usek");
  });

  it("keeps two extractors over one file apart", () => {
    const file = statOf(filePath);
    expect(scanCached(file, "counts", () => 1)).toBe(1);
    // Same file, different question. Sharing one map without the extractor in the
    // key would hand the second reader the first reader's answer.
    expect(scanCached(file, "types", () => "user")).toBe("user");
  });

  it("reports a file that vanished as null rather than throwing", () => {
    // A live Claude Code process rotates these files, and the readers that use this
    // touch every transcript on the machine, so a vanished file is expected traffic.
    const gone = statOf(filePath);
    fs.rmSync(filePath);
    expect(scanCached(gone, "test", (target) => parseTranscript(target))).toBeNull();
  });

  it("lets a read failure that is not a missing file stay loud", () => {
    expect(() =>
      scanCached(statOf(filePath), "test", () => {
        throw new Error("permission denied");
      }),
    ).toThrow(/permission denied/);
  });
});
