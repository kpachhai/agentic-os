import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import {
  diffFileVersions,
  fileHistoryIndex,
  readFileVersion,
} from "../server/file-history.js";
import { clearScanCache } from "../server/transcripts.js";

/**
 * Synthetic fixtures only. The real file-history tree is verbatim file contents
 * for anything Claude ever edited, so none of it is reproduced here - these
 * fixtures are hand-written to the shapes the real files use.
 */

let root = "";
let fileHistoryDir = "";
let transcriptsDir = "";

/** The naming scheme on disk: first 16 hex characters of sha256 of the path. */
function hashOf(absolutePath: string): string {
  return crypto.createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

/** The same digest truncated harder, for the narrowed-name cases. */
function shortHashOf(absolutePath: string, chars: number): string {
  return crypto.createHash("sha256").update(absolutePath).digest("hex").slice(0, chars);
}

/**
 * Synthetic paths whose digests share a short prefix, found by searching.
 *
 * A prefix this narrow is the only ambiguity that can be constructed at test
 * speed; the 16-character names on disk would need a 64-bit collision. Searching
 * is deterministic because sha256 is, and a 4-character prefix needs a few
 * thousand candidates for a three-way group.
 */
function pathsSharingHashPrefix(count: number, chars: number): string[] {
  const byPrefix = new Map<string, string[]>();
  for (let index = 0; index < 500_000; index++) {
    const candidate = `/synthetic/collide/file-${index}.ts`;
    const prefix = shortHashOf(candidate, chars);
    const group = byPrefix.get(prefix) ?? [];
    group.push(candidate);
    byPrefix.set(prefix, group);
    if (group.length === count) return group;
  }
  throw new Error(`no ${count} synthetic paths share a ${chars}-character digest prefix`);
}

/** A version entry written under a hash the caller chose, not one derived here. */
function writeVersionNamed(sessionId: string, hash: string, version: number, text: string): void {
  const dir = path.join(fileHistoryDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hash}@v${version}`), text, "utf8");
}

function writeVersion(
  sessionId: string,
  absolutePath: string,
  version: number,
  text: string,
): string {
  const dir = path.join(fileHistoryDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const hash = hashOf(absolutePath);
  fs.writeFileSync(path.join(dir, `${hash}@v${version}`), text, "utf8");
  return hash;
}

/** A transcript carrying the tool results that name the paths Claude touched. */
function writeTranscript(projectDir: string, sessionId: string, filePaths: string[]): void {
  const dir = path.join(transcriptsDir, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const lines = filePaths.map((filePath) =>
    JSON.stringify({ type: "user", toolUseResult: { filePath } }),
  );
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-file-history-"));
  fileHistoryDir = path.join(root, "file-history");
  transcriptsDir = path.join(root, "projects");
  fs.mkdirSync(fileHistoryDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fileHistoryIndex", () => {
  it("resolves a hash back to its path by hashing paths found in transcripts", () => {
    const target = "/synthetic/repo/alpha.ts";
    writeVersion("session-a", target, 1, "one\n");
    writeVersion("session-a", target, 2, "one\ntwo\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.files).toHaveLength(1);
    expect(index.files[0]!.path).toBe(target);
    expect(index.files[0]!.hash).toBe(hashOf(target));
    expect(index.unresolved).toEqual([]);
    expect(index.stats.knownPaths).toBe(1);
  });

  it("reports a hash it cannot name as unresolved rather than dropping it", () => {
    // A version that cannot be named is still a version that exists, and hiding
    // it would understate how much unrecoverable history is on disk.
    writeVersion("session-a", "/synthetic/repo/never-in-a-transcript.ts", 1, "x\n");
    writeTranscript("-synthetic-repo", "session-a", ["/synthetic/repo/other.ts"]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.files).toEqual([]);
    expect(index.unresolved).toHaveLength(1);
    expect(index.unresolved[0]!.versionCount).toBe(1);
    expect(index.stats.unresolvedHashes).toBe(1);
    expect(index.stats.unresolvedVersions).toBe(1);
    expect(index.stats.totalVersions).toBe(1);
  });

  it("counts stored versions, not the highest version number", () => {
    // The distinction is real on a working tree: many chains begin at v2 because
    // the earlier versions live under a different session. Reporting the highest
    // version number as a version count claims a file that is not there.
    const target = "/synthetic/repo/resumed.ts";
    writeVersion("session-a", target, 2, "b\n");
    writeVersion("session-a", target, 3, "c\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    const file = index.files[0]!;
    expect(file.versionCount).toBe(2);
    expect(file.highestVersion).toBe(3);
    expect(file.chains[0]!.firstVersion).toBe(2);
    expect(index.stats.deepestChainVersions).toBe(2);
    expect(index.stats.highestVersionNumber).toBe(3);
  });

  it("keeps a version number scoped to its session rather than to the file", () => {
    // Verified on a real tree: every hash present in more than one session reuses
    // version numbers, and the bytes differ in every one of those overlaps. So
    // treating (hash, version) as a key would silently merge two different files.
    const target = "/synthetic/repo/shared.ts";
    writeVersion("session-a", target, 1, "from a\n");
    writeVersion("session-b", target, 1, "from b\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    const file = index.files[0]!;
    expect(file.versionCount).toBe(2);
    expect(file.chains).toHaveLength(2);
    // Two stored versions, but neither chain is deeper than one entry.
    expect(file.longestChainVersions).toBe(1);
    expect(file.sessions.sort()).toEqual(["session-a", "session-b"]);

    const fromA = readFileVersion(fileHistoryDir, transcriptsDir, "session-a", file.hash, 1);
    const fromB = readFileVersion(fileHistoryDir, transcriptsDir, "session-b", file.hash, 1);
    expect(fromA!.text).toBe("from a\n");
    expect(fromB!.text).toBe("from b\n");
  });

  it("leads with the most-versioned file", () => {
    const few = "/synthetic/repo/few.ts";
    const many = "/synthetic/repo/many.ts";
    writeVersion("session-a", few, 1, "a\n");
    for (const version of [1, 2, 3]) writeVersion("session-a", many, version, `v${version}\n`);
    writeTranscript("-synthetic-repo", "session-a", [few, many]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.files.map((file) => file.path)).toEqual([many, few]);
    expect(index.stats.filesWithMultipleVersions).toBe(1);
    expect(index.stats.chainsWithMultipleVersions).toBe(1);
  });

  it("never returns version text from the index", () => {
    // The index is the view most likely to be left open, so it is built to carry
    // no file contents at all; readFileVersion is the only door to the text.
    const target = "/synthetic/repo/secrets.ts";
    writeVersion("session-a", target, 1, "SYNTHETIC-SENTINEL-CONTENT\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(JSON.stringify(index)).not.toContain("SYNTHETIC-SENTINEL-CONTENT");
    expect(index.stats.totalBytes).toBeGreaterThan(0);
  });

  it("ignores a name that is not a version entry, and counts what it ignored", () => {
    writeVersion("session-a", "/synthetic/repo/alpha.ts", 1, "a\n");
    fs.writeFileSync(path.join(fileHistoryDir, "session-a", "notes.txt"), "x", "utf8");
    fs.writeFileSync(path.join(fileHistoryDir, "session-a", "ZZZZ@v1"), "x", "utf8");
    writeTranscript("-synthetic-repo", "session-a", ["/synthetic/repo/alpha.ts"]);

    const stats = fileHistoryIndex(fileHistoryDir, transcriptsDir).stats;
    expect(stats.totalVersions).toBe(1);
    expect(stats.skipped.unparsedNames).toBe(2);
  });

  it("counts every name it declined, so a short total cannot read as complete", () => {
    // The failure this pins: if the on-disk naming scheme ever gains a suffix or
    // changes separator, an uncounted skip makes the pillar say "no versions on
    // disk" when the truth is "names I could not parse", which a reader acts on
    // very differently.
    const target = "/synthetic/repo/alpha.ts";
    const hash = writeVersion("session-a", target, 1, "a\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);
    const sessionDir = path.join(fileHistoryDir, "session-a");

    // A symlink named exactly like a version entry: understood and refused, which
    // is not the same as a name this module does not recognise.
    fs.symlinkSync(path.join(sessionDir, `${hash}@v1`), path.join(sessionDir, `${hash}@v2`));
    fs.writeFileSync(path.join(sessionDir, `${hash}@v3.bak`), "x", "utf8");
    fs.writeFileSync(path.join(sessionDir, `${hash}-v4`), "x", "utf8");
    fs.mkdirSync(path.join(sessionDir, `${hash}@v5`));
    fs.symlinkSync(sessionDir, path.join(fileHistoryDir, "linked-session"), "dir");
    fs.writeFileSync(path.join(fileHistoryDir, "stray-file"), "x", "utf8");

    const stats = fileHistoryIndex(fileHistoryDir, transcriptsDir).stats;
    expect(stats.totalVersions).toBe(1);
    expect(stats.skipped).toEqual({
      unparsedNames: 2,
      symlinkedEntries: 1,
      nonFileEntries: 1,
      vanishedEntries: 0,
      symlinkedSessionDirs: 1,
      unreadableSessionDirs: 0,
      nonDirectoryRootEntries: 1,
      unparsedTranscriptLines: 0,
    });
  });

  it("counts transcript lines it could not parse, which bound the path pool", () => {
    // An unparsable line might have named a path, so it bounds how much of the
    // resolution pool is missing. Without the count, an entry listed unresolved is
    // indistinguishable from one whose path was in a line that could not be read.
    const target = "/synthetic/repo/alpha.ts";
    writeVersion("session-a", target, 1, "a\n");
    const dir = path.join(transcriptsDir, "-synthetic-repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session-a.jsonl"),
      `${JSON.stringify({ type: "user", toolUseResult: { filePath: target } })}\n` +
        `{"type":"user","toolUseResult":\n` +
        `["not","an","object"]\n`,
      "utf8",
    );

    const stats = fileHistoryIndex(fileHistoryDir, transcriptsDir).stats;
    expect(stats.knownPaths).toBe(1);
    expect(stats.skipped.unparsedTranscriptLines).toBe(2);
  });

  it("refuses to name an entry whose hash several paths share", () => {
    // Three distinct paths share this truncated hash, so any one of them is a
    // guess. An absolute path on screen reads as authoritative, and naming the
    // wrong file is worse than naming none.
    const colliding = pathsSharingHashPrefix(3, 4);
    const shared = shortHashOf(colliding[0]!, 4);
    writeVersionNamed("session-a", shared, 1, "ambiguous\n");
    writeTranscript("-synthetic-collide", "session-a", colliding);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.files).toEqual([]);
    expect(index.unresolved).toHaveLength(1);
    expect(index.unresolved[0]!.pathStatus).toBe("ambiguous");
    expect(index.unresolved[0]!.candidatePaths).toBe(3);
    expect(index.stats.unresolvedByReason.ambiguous).toEqual({ hashes: 1, versions: 1 });
    // Every path in the group counts, so a three-way ambiguity reports three and
    // is distinguishable from a two-way one.
    expect(index.stats.hashAmbiguities).toEqual([
      { hashChars: 4, ambiguousHashes: 1, pathsInvolved: 3 },
    ]);
  });

  it("refuses to name an entry whose hash is too narrow to identify a file", () => {
    // One pooled path matches, but the pool only holds paths the transcripts
    // happened to mention: at four hex characters a match is a coincidence, and
    // the width-read-from-the-name design is only safe if it degrades to
    // unresolved rather than to a confident wrong name.
    const target = "/synthetic/repo/alpha.ts";
    writeVersionNamed("session-a", shortHashOf(target, 4), 1, "narrow\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.files).toEqual([]);
    expect(index.unresolved[0]!.pathStatus).toBe("hash-too-short");
    expect(index.unresolved[0]!.candidatePaths).toBe(1);
    expect(index.stats.unresolvedByReason["hash-too-short"]).toEqual({ hashes: 1, versions: 1 });
    expect(index.stats.hashAmbiguities).toEqual([]);
  });

  it("says which of the three refusals applies to an entry no path matches", () => {
    writeVersion("session-a", "/synthetic/repo/never-in-a-transcript.ts", 1, "x\n");
    writeTranscript("-synthetic-repo", "session-a", ["/synthetic/repo/other.ts"]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.unresolved[0]!.pathStatus).toBe("no-match");
    expect(index.unresolved[0]!.candidatePaths).toBe(0);
    expect(index.stats.unresolvedByReason["no-match"]).toEqual({ hashes: 1, versions: 1 });
  });

  it("records a zero-byte version as a version", () => {
    // A file truncated to empty is a real intermediate state, and one of the
    // states most worth recovering.
    const target = "/synthetic/repo/emptied.ts";
    writeVersion("session-a", target, 1, "had content\n");
    writeVersion("session-a", target, 2, "");
    writeTranscript("-synthetic-repo", "session-a", [target]);

    const file = fileHistoryIndex(fileHistoryDir, transcriptsDir).files[0]!;
    expect(file.versionCount).toBe(2);
    expect(file.chains[0]!.versions[1]!.sizeBytes).toBe(0);
  });

  it("ignores a relative path in a transcript, which cannot name any entry", () => {
    // The digest is taken over an absolute path, so a relative one is noise.
    const target = "/synthetic/repo/alpha.ts";
    writeVersion("session-a", target, 1, "a\n");
    writeTranscript("-synthetic-repo", "session-a", ["alpha.ts", target]);

    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.stats.knownPaths).toBe(1);
    expect(index.files[0]!.path).toBe(target);
  });

  it("names the missing file-history source rather than returning an empty index", () => {
    expect(() => fileHistoryIndex(path.join(root, "absent"), transcriptsDir)).toThrow(
      SourceMissingError,
    );
    expect(() => fileHistoryIndex(path.join(root, "absent"), transcriptsDir)).toThrow(
      /absent/,
    );
  });

  it("treats a path that is not a directory as a missing source, not a crash", () => {
    // A mistyped config path must reach the reader as "not configured", never as
    // a broken install.
    const notADir = path.join(root, "a-file");
    fs.writeFileSync(notADir, "x", "utf8");
    expect(() => fileHistoryIndex(notADir, transcriptsDir)).toThrow(SourceMissingError);
    expect(() => fileHistoryIndex(path.join(notADir, "nested"), transcriptsDir)).toThrow(
      SourceMissingError,
    );
  });

  it("reports an empty tree as no versions rather than failing", () => {
    const index = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(index.files).toEqual([]);
    expect(index.unresolved).toEqual([]);
    expect(index.stats.totalVersions).toBe(0);
    expect(index.stats.sessionDirs).toBe(0);
    expect(index.stats.deepestChainVersions).toBe(0);
    expect(index.stats.highestVersionNumber).toBe(0);
  });

  it("names the missing transcripts source, since nothing can be resolved without it", () => {
    writeVersion("session-a", "/synthetic/repo/alpha.ts", 1, "a\n");
    expect(() => fileHistoryIndex(fileHistoryDir, path.join(root, "absent"))).toThrow(
      SourceMissingError,
    );
  });
});

describe("readFileVersion", () => {
  const target = "/synthetic/repo/alpha.ts";

  beforeEach(() => {
    writeVersion("session-a", target, 1, "line one\nline two\n");
    writeTranscript("-synthetic-repo", "session-a", [target]);
  });

  it("returns the text of one named entry with its path", () => {
    const version = readFileVersion(
      fileHistoryDir,
      transcriptsDir,
      "session-a",
      hashOf(target),
      1,
    );
    expect(version!.text).toBe("line one\nline two\n");
    expect(version!.path).toBe(target);
    expect(version!.lines).toBe(2);
    expect(version!.sizeBytes).toBe(18);
  });

  it("serves an unresolved entry with a null path", () => {
    const orphan = "/synthetic/repo/orphan.ts";
    writeVersion("session-a", orphan, 1, "orphaned\n");
    const version = readFileVersion(
      fileHistoryDir,
      transcriptsDir,
      "session-a",
      hashOf(orphan),
      1,
    );
    expect(version!.path).toBeNull();
    expect(version!.pathStatus).toBe("no-match");
    expect(version!.text).toBe("orphaned\n");
  });

  it("serves the text but no path when several paths share the entry's hash", () => {
    // Stopping the transcript walk at the first prefix match would hand back one
    // of the three candidates as this version's identity. The text is still
    // served: not knowing a version's name is no reason to withhold it.
    const colliding = pathsSharingHashPrefix(3, 4);
    const shared = shortHashOf(colliding[0]!, 4);
    writeVersionNamed("session-b", shared, 1, "ambiguous\n");
    writeTranscript("-synthetic-collide", "session-b", colliding);

    const version = readFileVersion(fileHistoryDir, transcriptsDir, "session-b", shared, 1)!;
    expect(version.text).toBe("ambiguous\n");
    expect(version.path).toBeNull();
    expect(version.pathStatus).toBe("ambiguous");
    expect(version.candidatePaths).toBe(3);
  });

  it("refuses a traversal attempt in the session id", () => {
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "MUST-NOT-BE-SERVED", "utf8");
    for (const sessionId of ["..", "../..", "session-a/../..", "/etc"]) {
      expect(
        readFileVersion(fileHistoryDir, transcriptsDir, sessionId, hashOf(target), 1),
      ).toBeNull();
    }
  });

  it("refuses a hash that is not plain hex", () => {
    for (const hash of ["../../outside", "alpha.ts", "", "ABC123"]) {
      expect(readFileVersion(fileHistoryDir, transcriptsDir, "session-a", hash, 1)).toBeNull();
    }
  });

  it("refuses a version that is not a positive integer", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(
        readFileVersion(fileHistoryDir, transcriptsDir, "session-a", hashOf(target), version),
      ).toBeNull();
    }
  });

  it("returns null for an entry that is not on disk", () => {
    expect(
      readFileVersion(fileHistoryDir, transcriptsDir, "session-a", hashOf(target), 99),
    ).toBeNull();
    expect(
      readFileVersion(fileHistoryDir, transcriptsDir, "no-such-session", hashOf(target), 1),
    ).toBeNull();
  });
});

describe("diffFileVersions", () => {
  const target = "/synthetic/repo/alpha.ts";
  const hash = hashOf(target);

  function ref(sessionId: string, version: number) {
    return { sessionId, hash, version };
  }

  beforeEach(() => {
    writeTranscript("-synthetic-repo", "session-a", [target]);
  });

  it("counts a one-line edit as one added and one removed", () => {
    // The failure this pins has bitten this repo before: a diff metric counted
    // the unchanged context lines surrounding a change and reported a one-line
    // edit as seven. Context lines are counted separately and never folded in.
    const before = ["a", "b", "c", "d", "e", "f", "g", "OLD", "h", "i", "j", "k", "l"];
    const after = [...before];
    after[7] = "NEW";
    writeVersion("session-a", target, 1, `${before.join("\n")}\n`);
    writeVersion("session-a", target, 2, `${after.join("\n")}\n`);

    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.stats.added).toBe(1);
    expect(diff.stats.removed).toBe(1);
    expect(diff.stats.unchanged).toBe(12);
    expect(diff.stats.minimal).toBe(true);
    expect(diff.stats.contextLines).toBe(6);
    // The change count must not grow with the context shown around it.
    expect(diff.stats.added + diff.stats.removed).toBe(2);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines.filter((line) => line.kind !== "context")).toHaveLength(2);
  });

  it("reports no change between identical versions", () => {
    writeVersion("session-a", target, 1, "same\ncontent\n");
    writeVersion("session-a", target, 2, "same\ncontent\n");
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.stats.added).toBe(0);
    expect(diff.stats.removed).toBe(0);
    expect(diff.stats.unchanged).toBe(2);
    expect(diff.hunks).toEqual([]);
    expect(diff.truncated).toBe(false);
  });

  it("numbers lines against each version, leaving the other side null", () => {
    writeVersion("session-a", target, 1, "keep\ngone\nkeep two\n");
    writeVersion("session-a", target, 2, "keep\nfresh\nkeep two\n");
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    const removed = diff.hunks[0]!.lines.find((line) => line.kind === "remove")!;
    const added = diff.hunks[0]!.lines.find((line) => line.kind === "add")!;
    expect(removed.oldLine).toBe(2);
    expect(removed.newLine).toBeNull();
    expect(added.newLine).toBe(2);
    expect(added.oldLine).toBeNull();
    expect(diff.hunks[0]!.oldStart).toBe(1);
    expect(diff.hunks[0]!.newStart).toBe(1);
  });

  it("positions a hunk that opens on an added line at the right old-file line", () => {
    // A hunk starting with an addition has no old line of its own; reporting zero
    // or the new-file number would put the change in the wrong place.
    writeVersion("session-a", target, 1, "a\nb\n");
    writeVersion("session-a", target, 2, "new first\na\nb\n");
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    const hunk = diff.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.oldLines).toBe(2);
    expect(hunk.newLines).toBe(3);
  });

  it("splits distant changes into separate hunks and merges nearby ones", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
    const after = [...lines];
    after[2] = "changed near top";
    after[3] = "also near top";
    after[50] = "changed near bottom";
    writeVersion("session-a", target, 1, `${lines.join("\n")}\n`);
    writeVersion("session-a", target, 2, `${after.join("\n")}\n`);

    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.hunks).toHaveLength(2);
    expect(diff.stats.added).toBe(3);
    expect(diff.stats.removed).toBe(3);
  });

  it("reports a trailing-newline-only change, which the hunks cannot show", () => {
    writeVersion("session-a", target, 1, "a\nb\n");
    writeVersion("session-a", target, 2, "a\nb");
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.trailingNewlineChanged).toBe(true);
    expect(diff.stats.added).toBe(0);
    expect(diff.stats.removed).toBe(0);
  });

  it("truncates rather than hanging on two large, wholly different files", () => {
    // Two files with no shared prefix or suffix defeat the trim, so the
    // comparison table is the full product and has to be refused.
    const older = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join("\n");
    const newer = Array.from({ length: 3000 }, (_, index) => `new ${index}`).join("\n");
    writeVersion("session-a", target, 1, `${older}\n`);
    writeVersion("session-a", target, 2, `${newer}\n`);

    const started = Date.now();
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(diff.truncated).toBe(true);
    expect(diff.stats.minimal).toBe(false);
    expect(diff.truncationReason).toMatch(/upper bounds/);
    // The coarse fallback still describes both sides in full.
    expect(diff.stats.removed).toBe(3000);
    expect(diff.stats.added).toBe(3000);
  });

  it("stays minimal for a one-line change inside a large file", () => {
    // The prefix and suffix trim is what keeps the common case cheap: only the
    // differing middle reaches the comparison table.
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`);
    const after = [...lines];
    after[9_000] = "changed";
    writeVersion("session-a", target, 1, `${lines.join("\n")}\n`);
    writeVersion("session-a", target, 2, `${after.join("\n")}\n`);

    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.truncated).toBe(false);
    expect(diff.stats.minimal).toBe(true);
    expect(diff.stats.added).toBe(1);
    expect(diff.stats.removed).toBe(1);
    expect(diff.stats.unchanged).toBe(19_999);
  });

  it("caps the hunk lines it will return", () => {
    // A wholesale replacement is cheap to compute and enormous to serialize, so
    // the fixture has to be big enough to actually reach the cap: 11000 wholly
    // different lines each side is 22000 edit lines against a 20000-line ceiling.
    // At 3000 lines each side the script is only 6000 lines long and this branch
    // never runs, which is coverage in name only.
    const older = Array.from({ length: 11_000 }, (_, index) => `old ${index}`).join("\n");
    const newer = Array.from({ length: 11_000 }, (_, index) => `new ${index}`).join("\n");
    writeVersion("session-a", target, 1, `${older}\n`);
    writeVersion("session-a", target, 2, `${newer}\n`);
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    const emitted = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    expect(emitted).toBe(20_000);
    // The response says it stopped, and says by how much: "later changes are not
    // shown" on its own leaves a reader unable to tell two lines from two thousand.
    expect(diff.truncated).toBe(true);
    expect(diff.truncationReason).toMatch(/response cap/);
    expect(diff.changesNotShown).toBe(2_000);
    expect(diff.truncationReason).toMatch(/2000 change/);
  });

  it("reports nothing missing from a diff that was not capped", () => {
    writeVersion("session-a", target, 1, "a\nb\n");
    writeVersion("session-a", target, 2, "a\nc\n");
    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.changesNotShown).toBe(0);
    expect(diff.truncated).toBe(false);
  });

  it("gives no shared-line count when the comparison was capped", () => {
    // Rotating a file by one line leaves 2499 of 2500 lines shared while defeating
    // the prefix and suffix trim, so the comparison table is refused and the
    // fallback has nothing but the trim to count. Reporting that as the total said
    // two versions differing by one moved line share nothing at all.
    const lines = Array.from({ length: 2500 }, (_, index) => `shared line ${index}`);
    const rotated = [lines[lines.length - 1]!, ...lines.slice(0, -1)];
    writeVersion("session-a", target, 1, `${lines.join("\n")}\n`);
    writeVersion("session-a", target, 2, `${rotated.join("\n")}\n`);

    const diff = diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2))!;
    expect(diff.stats.minimal).toBe(false);
    expect(diff.stats.unchanged).toBeNull();
    // The set of fields a caller must distrust has to be complete, so the reason
    // names unchanged alongside added and removed.
    expect(diff.truncationReason).toMatch(/unchanged/);
    expect(diff.truncationReason).toMatch(/upper bounds/);
  });

  it("refuses a diff between two different files", () => {
    const other = "/synthetic/repo/beta.ts";
    writeVersion("session-a", target, 1, "a\n");
    writeVersion("session-a", other, 1, "b\n");
    expect(
      diffFileVersions(
        fileHistoryDir,
        transcriptsDir,
        ref("session-a", 1),
        { sessionId: "session-a", hash: hashOf(other), version: 1 },
      ),
    ).toBeNull();
  });

  it("returns null when either side is not on disk", () => {
    writeVersion("session-a", target, 1, "a\n");
    expect(
      diffFileVersions(fileHistoryDir, transcriptsDir, ref("session-a", 1), ref("session-a", 2)),
    ).toBeNull();
  });

  it("diffs the same version number across two sessions, which is a real comparison", () => {
    writeVersion("session-a", target, 1, "from a\n");
    writeVersion("session-b", target, 1, "from b\n");
    const diff = diffFileVersions(
      fileHistoryDir,
      transcriptsDir,
      ref("session-a", 1),
      ref("session-b", 1),
    )!;
    expect(diff.stats.added).toBe(1);
    expect(diff.stats.removed).toBe(1);
    expect(diff.from.sessionId).toBe("session-a");
    expect(diff.to.sessionId).toBe("session-b");
  });
});

describe("what bounds a no-match answer", () => {
  it("counts the transcript lines it could not read, on the read and the diff", () => {
    // A `no-match` status means no known path hashes to this entry, and the set of
    // known paths is only as complete as the transcripts that parsed. The index
    // already reported its unparsed lines; the two single-entry payloads make the
    // same claim and so need the same bound travelling with them.
    const absolutePath = "/tmp/demo-project/orphan.ts";
    const hash = writeVersion("session-a", absolutePath, 1, "one\n");
    writeVersion("session-a", absolutePath, 2, "two\n");

    const dir = path.join(transcriptsDir, "-tmp-demo-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session-a.jsonl"), "{ not json\nalso not json\n", "utf8");

    const version = readFileVersion(fileHistoryDir, transcriptsDir, "session-a", hash, 1);
    expect(version).not.toBeNull();
    expect(version!.pathStatus).toBe("no-match");
    expect(version!.path).toBeNull();
    expect(version!.unparsedTranscriptLines).toBe(2);

    const diff = diffFileVersions(
      fileHistoryDir,
      transcriptsDir,
      { sessionId: "session-a", hash, version: 1 },
      { sessionId: "session-a", hash, version: 2 },
    );
    expect(diff).not.toBeNull();
    expect(diff!.pathStatus).toBe("no-match");
    expect(diff!.unparsedTranscriptLines).toBe(2);
  });

  it("reports zero unparsed lines when every transcript line parsed", () => {
    const absolutePath = "/tmp/demo-project/known.ts";
    const hash = writeVersion("session-a", absolutePath, 1, "one\n");
    writeTranscript("-tmp-demo-project", "session-a", [absolutePath]);

    const version = readFileVersion(fileHistoryDir, transcriptsDir, "session-a", hash, 1);
    expect(version!.pathStatus).toBe("resolved");
    expect(version!.unparsedTranscriptLines).toBe(0);
  });
});

/**
 * The transcript scan behind both the index and the single-version lookup is
 * memoized per file, so a warm read has to name the same paths as a cold one. The
 * two readers share one extractor, which is also what stops a version lookup from
 * being a second full walk of the tree.
 */
describe("reading the transcript pool twice", () => {
  it("answers identically warm and cold", () => {
    const absolutePath = "/tmp/demo-project/known.ts";
    const hash = writeVersion("session-a", absolutePath, 1, "one\n");
    writeVersion("session-a", absolutePath, 2, "two\n");
    writeTranscript("-tmp-demo-project", "session-a", [absolutePath]);

    clearScanCache();
    const cold = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(fileHistoryIndex(fileHistoryDir, transcriptsDir)).toEqual(cold);

    // The lookup path reads the same memo, so it has to agree with the index about
    // the path rather than resolving it a second, independent way.
    const version = readFileVersion(fileHistoryDir, transcriptsDir, "session-a", hash, 1);
    expect(version!.pathStatus).toBe("resolved");
    expect(version!.path).toBe(absolutePath);
  });

  it("sees a path named only in a transcript appended to since the last read", () => {
    const known = "/tmp/demo-project/known.ts";
    const added = "/tmp/demo-project/added.ts";
    writeVersion("session-a", added, 1, "one\n");
    writeTranscript("-tmp-demo-project", "session-a", [known]);

    // Before the append the version's path is not in the pool at all.
    const before = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(before.stats.resolvedFiles).toBe(0);

    fs.appendFileSync(
      path.join(transcriptsDir, "-tmp-demo-project", "session-a.jsonl"),
      `${JSON.stringify({ type: "user", toolUseResult: { filePath: added } })}\n`,
      "utf8",
    );
    // The memo is keyed on the file's identity, so the append is a new key and the
    // newly named path resolves rather than staying permanently unnamed.
    const after = fileHistoryIndex(fileHistoryDir, transcriptsDir);
    expect(after.stats.resolvedFiles).toBe(1);
  });
});

