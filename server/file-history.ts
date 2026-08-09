import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";
import { listTranscriptFiles, scanCached, streamTranscript } from "./transcripts.js";

/**
 * Reader over the file versions Claude Code keeps for itself.
 *
 * Git shows what survived. This shows every intermediate version Claude wrote,
 * including the ones it later reverted or overwrote, which never reached a commit
 * and are otherwise unrecoverable. That is the whole reason the pillar exists: it
 * is the only record of the edit a session made and then took back.
 *
 * THIS IS THE SECOND MOST SENSITIVE SOURCE THIS TOOL READS, behind prompt
 * history only. Each entry is the FULL TEXT of a file as of one version, so any
 * config, dotfile, or credential file Claude ever edited is sitting here
 * verbatim. It gets the same treatment prompt history gets: strictly read-only;
 * never captured into a fixture, a test, or gate output; and version text
 * returned only for one entry the caller explicitly named. The index below stats
 * entries and never opens one, so listing the history cannot leak its contents -
 * a bulk dump is not a feature this module has.
 *
 * On-disk layout: <fileHistoryDir>/<sessionId>/<hash>@v<N>. Nothing on disk maps
 * a hash back to a path, so this module rebuilds that map from the transcript
 * tree; see buildPathMap.
 */

/**
 * Characters of the path digest that make up an entry's hash.
 *
 * The name is the first 16 hex characters of the sha256 of the file's absolute
 * path. Confirmed by hashing paths recovered from transcripts and reproducing
 * every filename on disk exactly. The width is read from the entry name rather
 * than assumed, so a future change to it degrades to unresolved entries instead
 * of an index that reports no files at all.
 */
const DEFAULT_HASH_CHARS = 16;

/**
 * Narrowest hash this module will present as a file's identity.
 *
 * The pool of candidate paths is whatever the transcripts happened to mention,
 * so it is always incomplete: the path an entry really belongs to may not be in
 * it at all. A unique match therefore only means "the one pooled path whose
 * digest starts this way", and how much that is worth depends entirely on the
 * width. For a pool of a few thousand paths, 8 hex characters is 32 bits and the
 * chance that some unrelated pooled path starts the same way is around one in
 * four million; at 4 hex characters it is about one in fifty per entry, which
 * over a thousand entries fabricates names in bulk. Below this width the entry
 * is reported unresolved, which is what the width-from-the-name reading above
 * promises and what picking the first prefix match silently broke.
 */
const MIN_RESOLVABLE_HASH_CHARS = 8;

/** `<hash>@v<N>`: lowercase hex, then a 1-based version number. */
const ENTRY_NAME = /^([0-9a-f]+)@v(\d+)$/;

/** A hash on its own, for validating one that arrived in a request. */
const HASH_ONLY = /^[0-9a-f]+$/;

/** One stored version of one file. Metadata only; the text is never read here. */
export type FileVersionEntry = {
  sessionId: string;
  version: number;
  sizeBytes: number;
  modifiedAt: string;
};

/**
 * The versions of one file recorded under one session.
 *
 * Version numbers are scoped to the session directory, not to the file. The same
 * `<hash>@v2` under two different sessions is two different pieces of content -
 * verified on a real tree, where every hash present in more than one session
 * reused version numbers and the bytes differed in all of those overlaps. So a
 * version is only addressable as a (session, hash, version) triple, and a
 * "chain" is per session rather than per file.
 */
export type SessionChain = {
  sessionId: string;
  /** Ascending by version. */
  versions: FileVersionEntry[];
  /** Entries actually present under this session. */
  versionCount: number;
  /**
   * Lowest and highest version numbers present.
   *
   * `firstVersion` is frequently not 1: on a real tree a large minority of
   * chains begin at v2 or later, because the earlier versions live under another
   * session or were never kept. Exposed so nothing has to assume a chain starts
   * at the file's original state.
   */
  firstVersion: number;
  highestVersion: number;
};

/** A file whose hash was matched back to a path, with every version of it. */
export type VersionedFile = {
  hash: string;
  /** Absolute path, recovered from the transcript tree. */
  path: string;
  /** Sessions that versioned this file, most versions first. */
  sessions: string[];
  chains: SessionChain[];
  /**
   * Version entries on disk for this file, summed over every session.
   *
   * This is a count of stored versions, not a chain depth and not a highest
   * version number. The three genuinely differ: a file versioned in two sessions
   * has more stored versions than either chain is deep, and a chain that begins
   * at v2 has a highest version number one above its own length. Keeping them as
   * separate fields is deliberate, because a single "versions" number would be
   * wrong for two of the three questions a reader asks of it.
   */
  versionCount: number;
  /** Entries in the deepest single-session chain. */
  longestChainVersions: number;
  /** Largest version number seen, which can exceed longestChainVersions. */
  highestVersion: number;
  totalBytes: number;
  firstModifiedAt: string;
  lastModifiedAt: string;
};

/**
 * Why an entry does or does not get an absolute path put next to it.
 *
 * `ambiguous` means more than one distinct known path shares this truncated
 * hash, so any single one of them would be a guess. `hash-too-short` means
 * exactly one known path matches but the hash is too narrow for that match to
 * mean anything. `no-match` means no known path hashes to it at all.
 */
export type PathStatus = "resolved" | "ambiguous" | "hash-too-short" | "no-match";

/**
 * A file-history entry this module will not put a path next to.
 *
 * Reported rather than dropped. A version that cannot be named is still a
 * version that exists, and silently omitting it would understate how much
 * unrecoverable history is on disk - the one number this pillar is for.
 */
export type UnresolvedFile = {
  hash: string;
  /** Which of the three refusals applies; never `resolved`. */
  pathStatus: Exclude<PathStatus, "resolved">;
  /**
   * Distinct known paths sharing this truncated hash: 0 when nothing matched,
   * 2 or more when the hash is ambiguous. The count is the point of listing an
   * ambiguity at all, since it says how far from identified the entry is.
   */
  candidatePaths: number;
  sessions: string[];
  chains: SessionChain[];
  versionCount: number;
  longestChainVersions: number;
  highestVersion: number;
  totalBytes: number;
  firstModifiedAt: string;
  lastModifiedAt: string;
};

/**
 * What the scan saw and did not count, with the reason it did not.
 *
 * A version total that reads complete while being partial is the failure this
 * exists to prevent. If the on-disk naming scheme ever gains a suffix or changes
 * separator, the pillar has to be able to say "these names I could not parse"
 * rather than "no versions on disk" - a different claim entirely, and the one a
 * reader would act on wrongly.
 */
export type FileHistorySkips = {
  /** Names under a session directory that are not `<hash>@v<N>`. */
  unparsedNames: number;
  /** Entries skipped for being symlinks, which are never followed. */
  symlinkedEntries: number;
  /** Entries named like a version but which are not regular files. */
  nonFileEntries: number;
  /** Entries that disappeared between the directory read and the stat. */
  vanishedEntries: number;
  /** Session directories skipped for being symlinks. */
  symlinkedSessionDirs: number;
  /** Session directories that could not be read at all. */
  unreadableSessionDirs: number;
  /** Names directly under the history root that are not directories. */
  nonDirectoryRootEntries: number;
  /**
   * Transcript lines that could not be parsed while building the path pool.
   *
   * Each one might have named a path, so this bounds how much of the pool is
   * missing - and therefore how much of the unresolved count is the shape of the
   * transcripts rather than a real absence.
   */
  unparsedTranscriptLines: number;
};

/**
 * Truncated hashes that more than one distinct path maps to, at one hash width.
 *
 * Reported per width rather than as one scalar, because the same pair of paths
 * can be ambiguous at a narrow width and distinct at a wider one; adding those
 * together describes neither. `pathsInvolved` counts every path in an ambiguous
 * group, so a three-way ambiguity reports three rather than the two that
 * counting only the losers of each comparison would give. No hash counted here
 * is resolved to any of its candidates.
 */
export type HashAmbiguity = {
  hashChars: number;
  ambiguousHashes: number;
  pathsInvolved: number;
};

/** Unresolved entries split by the refusal that applies, hashes and versions. */
export type UnresolvedBreakdown = Record<
  Exclude<PathStatus, "resolved">,
  { hashes: number; versions: number }
>;

export type FileHistoryStats = {
  /** Session directories under the file-history root. */
  sessionDirs: number;
  /**
   * Version entries the scan parsed, resolved and unresolved together.
   *
   * Not "every entry on disk": anything the scan refused is counted in `skipped`
   * instead, and a reader wanting the on-disk total has to add the two.
   */
  totalVersions: number;
  /** Everything the scan declined to count, by reason. */
  skipped: FileHistorySkips;
  resolvedFiles: number;
  unresolvedHashes: number;
  /** Version entries belonging to hashes that were not resolved to a path. */
  unresolvedVersions: number;
  /** `unresolvedHashes` and `unresolvedVersions` split by reason. */
  unresolvedByReason: UnresolvedBreakdown;
  /** Resolved files holding more than one stored version, in any session. */
  filesWithMultipleVersions: number;
  /** Per-session chains holding more than one stored version. */
  chainsWithMultipleVersions: number;
  /** Entries in the deepest single-session chain anywhere. */
  deepestChainVersions: number;
  /**
   * Highest version number anywhere, which is normally above
   * deepestChainVersions because chains do not all begin at v1.
   */
  highestVersionNumber: number;
  totalBytes: number;
  /** Distinct absolute paths recovered from transcripts, the resolution pool. */
  knownPaths: number;
  /**
   * Ambiguous truncated hashes in that pool, one row per hash width in use.
   *
   * A 16-hex-character prefix is 64 bits, so an ambiguity among a few thousand
   * paths is not expected and this is normally empty. Reported anyway, because
   * these are exactly the hashes whose entries are listed unresolved rather than
   * named, and the reader needs to be able to tell that apart from an entry no
   * path was ever seen for.
   */
  hashAmbiguities: HashAmbiguity[];
  /** Transcripts read to build the path map. */
  transcriptsScanned: number;
};

export type FileHistoryIndex = {
  /** Most stored versions first. */
  files: VersionedFile[];
  unresolved: UnresolvedFile[];
  stats: FileHistoryStats;
  note: string;
};

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Reductions rather than `Math.max(...array)`.
 *
 * The tree holds over a thousand version entries on a working machine and
 * nothing bounds that; spreading a large array into Math.max overflows the
 * argument list and throws, so these walk instead. Both require a non-empty
 * array, which every call site guarantees by construction.
 */
function largest(values: number[]): number {
  return values.reduce((best, value) => (value > best ? value : best), values[0]!);
}

function smallest(values: number[]): number {
  return values.reduce((best, value) => (value < best ? value : best), values[0]!);
}

/** A single filename component: no separators, no traversal, not empty. */
function isPlainSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    !name.includes("\0")
  );
}

type RawEntry = {
  sessionId: string;
  hash: string;
  version: number;
  sizeBytes: number;
  mtimeMs: number;
};

function emptySkips(): FileHistorySkips {
  return {
    unparsedNames: 0,
    symlinkedEntries: 0,
    nonFileEntries: 0,
    vanishedEntries: 0,
    symlinkedSessionDirs: 0,
    unreadableSessionDirs: 0,
    nonDirectoryRootEntries: 0,
    unparsedTranscriptLines: 0,
  };
}

type ScanResult = { entries: RawEntry[]; sessionDirs: number; skipped: FileHistorySkips };

/**
 * Every `<hash>@v<N>` under the file-history root.
 *
 * Stat only; no entry is opened. Symlinks are skipped rather than followed, for
 * the same reason the transcript reader skips them: a link placed here would aim
 * the scan at an arbitrary tree, and the check holds only because Dirent answers
 * for the link itself and not its target.
 *
 * Every skip is counted and the counts travel with the entries. A skipped entry
 * that leaves no trace turns a partial list into one that reads complete, and
 * the caller cannot tell the difference from the outside.
 */
function scanEntries(fileHistoryDir: string): ScanResult {
  // Absent, and present-but-not-a-directory, are the same operator mistake - a
  // mistyped config path - so both name the path as a missing source, which the
  // route layer answers as 503. Letting either fall through to readdir would
  // report a config typo as a 500 and make this pillar's first-run state read as
  // a broken install instead of an unconfigured one.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(fileHistoryDir, { throwIfNoEntry: false });
  } catch (err) {
    // ENOTDIR means a leading component of the path is a file, so nothing can
    // exist here; that is the missing-source case. Anything else, a permission
    // problem for instance, is a real fault and stays loud.
    if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
  }
  if (!stat || !stat.isDirectory()) {
    throw new SourceMissingError("file history", fileHistoryDir);
  }

  const entries: RawEntry[] = [];
  const skipped = emptySkips();
  let sessionDirs = 0;

  for (const sessionEntry of fs.readdirSync(fileHistoryDir, { withFileTypes: true })) {
    if (sessionEntry.isSymbolicLink()) {
      skipped.symlinkedSessionDirs += 1;
      console.warn(
        `file-history: not following symlink ${path.join(fileHistoryDir, sessionEntry.name)}; ` +
          `any versions behind it are excluded`,
      );
      continue;
    }
    if (!sessionEntry.isDirectory()) {
      skipped.nonDirectoryRootEntries += 1;
      continue;
    }
    sessionDirs += 1;
    const sessionPath = path.join(fileHistoryDir, sessionEntry.name);

    let versionFiles: fs.Dirent[];
    try {
      versionFiles = fs.readdirSync(sessionPath, { withFileTypes: true });
    } catch (err) {
      // One unreadable session must not blank out the other thirty-six, but it
      // is reported rather than hidden.
      skipped.unreadableSessionDirs += 1;
      console.warn(`file-history: skipping unreadable ${sessionPath}:`, err);
      continue;
    }

    for (const file of versionFiles) {
      const match = ENTRY_NAME.exec(file.name);
      if (!match) {
        skipped.unparsedNames += 1;
        continue;
      }
      // Counted apart from an unparsable name: a symlink here is a name this
      // module understands and refuses, which is a different thing from a name it
      // does not recognise, and only the second one hints at a format change.
      if (file.isSymbolicLink()) {
        skipped.symlinkedEntries += 1;
        continue;
      }
      if (!file.isFile()) {
        skipped.nonFileEntries += 1;
        continue;
      }
      // A live session writes here, so an entry can vanish between the readdir
      // and the stat; that is a skip, not a failure.
      const fileStat = fs.statSync(path.join(sessionPath, file.name), {
        throwIfNoEntry: false,
      });
      if (!fileStat) {
        skipped.vanishedEntries += 1;
        continue;
      }
      entries.push({
        sessionId: sessionEntry.name,
        hash: match[1]!,
        version: Number(match[2]),
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  warnAboutSkippedEntries(fileHistoryDir, skipped);
  return { entries, sessionDirs, skipped };
}

/**
 * One log line for the entry-level skips, so they are as loud as the
 * directory-level ones.
 *
 * A symlinked session directory has always been logged while a symlinked version
 * entry vanished without a word; that asymmetry meant the noisier failure was the
 * visible one. Summarised in a single line rather than one per entry, because a
 * naming-scheme change would otherwise log once per entry on a tree with over a
 * thousand of them.
 */
function warnAboutSkippedEntries(fileHistoryDir: string, skipped: FileHistorySkips): void {
  const entryLevel =
    skipped.unparsedNames +
    skipped.symlinkedEntries +
    skipped.nonFileEntries +
    skipped.vanishedEntries;
  if (entryLevel === 0) return;
  console.warn(
    `file-history: ${entryLevel} name(s) under ${fileHistoryDir} not counted as versions ` +
      `(${skipped.unparsedNames} unparsed, ${skipped.symlinkedEntries} symlinked, ` +
      `${skipped.nonFileEntries} not a regular file, ${skipped.vanishedEntries} vanished mid-scan)`,
  );
}

/**
 * What one truncated digest matched in the pool.
 *
 * `candidatePaths` is kept next to the path rather than derived later, because a
 * lookup that returns only the path cannot tell its caller whether that path was
 * the sole match or one of several - and that is the whole difference between an
 * identification and a guess.
 */
type PoolSlot = { path: string; candidatePaths: number };

type PathMap = {
  /** Truncated digest to its pool slot, one map per hash width in use. */
  byWidth: Map<number, Map<string, PoolSlot>>;
  knownPaths: number;
  ambiguities: HashAmbiguity[];
  transcriptsScanned: number;
  unparsedTranscriptLines: number;
};

function digestPath(absolutePath: string): string {
  return crypto.createHash("sha256").update(absolutePath).digest("hex");
}

/**
 * The absolute path a transcript record names, if it names one.
 *
 * Only absolute paths qualify: the digest is taken over an absolute path, so a
 * relative one cannot match any entry and would only add noise to the map.
 */
function filePathFrom(record: { [key: string]: unknown }): string | null {
  const result = record.toolUseResult;
  if (typeof result !== "object" || result === null) return null;
  const filePath = (result as { filePath?: unknown }).filePath;
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  return filePath;
}

/**
 * Everything one transcript contributes to the candidate path pool.
 *
 * Distinct paths, because a path named by a hundred tool results is one candidate
 * and the pool is a set either way; deduplicating here keeps the memo small enough
 * that the whole tree fits in it.
 */
type ScannedPaths = {
  paths: string[];
  /**
   * Torn or oversized lines in this file. Ordinary traffic here - one can only
   * cost a candidate path, and the entry it would have named stays unresolved
   * rather than being reported as something else - but carried out so a reader
   * can tell a pool that is short from one that is complete.
   */
  unparsedLines: number;
};

/**
 * Identifies this scan in the shared per-file cache. Both readers below want the
 * same thing from a transcript - the absolute paths it names - so they share one
 * extractor and the second one to run pays nothing.
 */
const PATHS_EXTRACTOR_ID = "file-history-paths";

/** The distinct absolute paths one transcript names, and its unreadable lines. */
function scanPaths(filePath: string): ScannedPaths {
  const paths = new Set<string>();
  let unparsedLines = 0;
  for (const line of streamTranscript(filePath)) {
    if (!line.ok) {
      unparsedLines += 1;
      continue;
    }
    const found = filePathFrom(line.record);
    if (found !== null) paths.add(found);
  }
  return { paths: [...paths], unparsedLines };
}

/**
 * Rebuild the hash-to-path map by walking the transcript tree.
 *
 * Nothing on disk records which path a file-history hash came from, so the only
 * way to name an entry is to find the paths Claude touched and hash them back.
 * Every absolute path appearing as `toolUseResult.filePath` is a candidate; a
 * path that was only read still costs nothing but a map slot, whereas missing
 * one leaves a real version permanently unnamed.
 *
 * `widths` says which digest prefix lengths the entries on disk actually use, so
 * the map is keyed the way the lookups will be rather than at a width this code
 * assumed.
 */
function buildPathMap(transcriptsDir: string, widths: Set<number>): PathMap {
  const transcripts = listTranscriptFiles(transcriptsDir);
  const paths = new Set<string>();
  let unparsedTranscriptLines = 0;
  let transcriptsScanned = 0;

  for (const transcript of transcripts) {
    // Read off the scan rather than accumulated where the file is read, so a warm
    // call reports the same pool as a cold one.
    const scanned = scanCached(transcript, PATHS_EXTRACTOR_ID, scanPaths);
    // A live session can rotate a transcript between the listing and the read.
    // Counting only what was actually read keeps `transcriptsScanned` a statement
    // about evidence rather than about the directory listing.
    if (scanned === null) continue;
    transcriptsScanned += 1;
    unparsedTranscriptLines += scanned.unparsedLines;
    for (const filePath of scanned.paths) paths.add(filePath);
  }

  const byWidth = new Map<number, Map<string, PoolSlot>>();
  for (const width of widths) byWidth.set(width, new Map());

  for (const candidate of paths) {
    const full = digestPath(candidate);
    for (const [width, map] of byWidth) {
      const key = full.slice(0, width);
      const existing = map.get(key);
      // `paths` is a set, so every candidate reaching here is distinct from every
      // path already counted; incrementing per arrival gives the number of
      // distinct paths sharing the key, first one included.
      if (existing === undefined) map.set(key, { path: candidate, candidatePaths: 1 });
      else existing.candidatePaths += 1;
    }
  }

  const ambiguities: HashAmbiguity[] = [...byWidth.entries()]
    .map(([hashChars, map]) => {
      const groups = [...map.values()].filter((slot) => slot.candidatePaths > 1);
      return {
        hashChars,
        ambiguousHashes: groups.length,
        pathsInvolved: groups.reduce((sum, slot) => sum + slot.candidatePaths, 0),
      };
    })
    .filter((row) => row.ambiguousHashes > 0)
    .sort((a, b) => a.hashChars - b.hashChars);

  return {
    byWidth,
    knownPaths: paths.size,
    ambiguities,
    transcriptsScanned,
    unparsedTranscriptLines,
  };
}

/**
 * A union rather than a nullable path plus a separate status, so a null path and
 * a `resolved` status cannot be written next to each other by accident.
 */
type PathClaim =
  | { path: string; pathStatus: "resolved"; candidatePaths: number }
  | { path: null; pathStatus: Exclude<PathStatus, "resolved">; candidatePaths: number };

/**
 * Decide whether one truncated hash may be presented as a file's identity.
 *
 * Naming the wrong file is worse than naming none, because an absolute path on
 * screen reads as authoritative. So two distinct candidates make an ambiguity
 * that is reported with its count rather than broken by picking one, and a hash
 * too narrow to identify anything is refused even when exactly one candidate
 * happens to match it.
 */
function claimPath(hash: string, slot: PoolSlot | undefined): PathClaim {
  if (slot === undefined) return { path: null, pathStatus: "no-match", candidatePaths: 0 };
  if (slot.candidatePaths > 1) {
    return { path: null, pathStatus: "ambiguous", candidatePaths: slot.candidatePaths };
  }
  if (hash.length < MIN_RESOLVABLE_HASH_CHARS) {
    return { path: null, pathStatus: "hash-too-short", candidatePaths: 1 };
  }
  return { path: slot.path, pathStatus: "resolved", candidatePaths: 1 };
}

function buildChains(entries: RawEntry[]): SessionChain[] {
  const bySession = new Map<string, FileVersionEntry[]>();
  for (const entry of entries) {
    const list = bySession.get(entry.sessionId) ?? [];
    list.push({
      sessionId: entry.sessionId,
      version: entry.version,
      sizeBytes: entry.sizeBytes,
      modifiedAt: toIso(entry.mtimeMs),
    });
    bySession.set(entry.sessionId, list);
  }

  return [...bySession.entries()]
    .map(([sessionId, versions]) => {
      versions.sort((a, b) => a.version - b.version);
      return {
        sessionId,
        versions,
        versionCount: versions.length,
        firstVersion: versions[0]!.version,
        highestVersion: versions[versions.length - 1]!.version,
      };
    })
    .sort((a, b) => b.versionCount - a.versionCount || a.sessionId.localeCompare(b.sessionId));
}

/** The per-file totals shared by resolved and unresolved groups. */
function summarize(entries: RawEntry[], chains: SessionChain[]) {
  const mtimes = entries.map((entry) => entry.mtimeMs);
  return {
    sessions: chains.map((chain) => chain.sessionId),
    chains,
    versionCount: entries.length,
    longestChainVersions: largest(chains.map((chain) => chain.versionCount)),
    highestVersion: largest(entries.map((entry) => entry.version)),
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    firstModifiedAt: toIso(smallest(mtimes)),
    lastModifiedAt: toIso(largest(mtimes)),
  };
}

/**
 * Index of every stored file version on this machine, most-versioned file first.
 *
 * Metadata only. No version entry is opened, so nothing this returns can carry
 * file contents; readFileVersion is the single door to the text and it opens for
 * one named entry at a time.
 */
export function fileHistoryIndex(
  fileHistoryDir: string,
  transcriptsDir: string,
): FileHistoryIndex {
  const { entries, sessionDirs, skipped } = scanEntries(fileHistoryDir);

  const widths = new Set(entries.map((entry) => entry.hash.length));
  // An empty tree still has to ask for the documented width, so the map is built
  // consistently whether or not there is anything to resolve.
  if (widths.size === 0) widths.add(DEFAULT_HASH_CHARS);
  const pathMap = buildPathMap(transcriptsDir, widths);

  const byHash = new Map<string, RawEntry[]>();
  for (const entry of entries) {
    const list = byHash.get(entry.hash) ?? [];
    list.push(entry);
    byHash.set(entry.hash, list);
  }

  const files: VersionedFile[] = [];
  const unresolved: UnresolvedFile[] = [];

  for (const [hash, hashEntries] of byHash) {
    const chains = buildChains(hashEntries);
    const summary = summarize(hashEntries, chains);
    const claim = claimPath(hash, pathMap.byWidth.get(hash.length)?.get(hash));
    if (claim.path === null) {
      unresolved.push({
        hash,
        pathStatus: claim.pathStatus,
        candidatePaths: claim.candidatePaths,
        ...summary,
      });
    } else {
      files.push({ hash, path: claim.path, ...summary });
    }
  }

  // Most stored versions first; path breaks ties so the order is stable.
  files.sort((a, b) => b.versionCount - a.versionCount || a.path.localeCompare(b.path));
  unresolved.sort((a, b) => b.versionCount - a.versionCount || a.hash.localeCompare(b.hash));

  const allChains = [...files, ...unresolved].flatMap((file) => file.chains);

  const unresolvedByReason: UnresolvedBreakdown = {
    ambiguous: { hashes: 0, versions: 0 },
    "hash-too-short": { hashes: 0, versions: 0 },
    "no-match": { hashes: 0, versions: 0 },
  };
  for (const file of unresolved) {
    const bucket = unresolvedByReason[file.pathStatus];
    bucket.hashes += 1;
    bucket.versions += file.versionCount;
  }

  return {
    files,
    unresolved,
    stats: {
      sessionDirs,
      totalVersions: entries.length,
      skipped: { ...skipped, unparsedTranscriptLines: pathMap.unparsedTranscriptLines },
      resolvedFiles: files.length,
      unresolvedHashes: unresolved.length,
      unresolvedVersions: unresolved.reduce((sum, file) => sum + file.versionCount, 0),
      unresolvedByReason,
      filesWithMultipleVersions: files.filter((file) => file.versionCount > 1).length,
      chainsWithMultipleVersions: allChains.filter((chain) => chain.versionCount > 1).length,
      // Zero for an empty tree; these two normally differ, because a chain that
      // begins at v2 is one shorter than its own highest version number.
      deepestChainVersions:
        allChains.length > 0 ? largest(allChains.map((chain) => chain.versionCount)) : 0,
      highestVersionNumber:
        entries.length > 0 ? largest(entries.map((entry) => entry.version)) : 0,
      totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      knownPaths: pathMap.knownPaths,
      hashAmbiguities: pathMap.ambiguities,
      transcriptsScanned: pathMap.transcriptsScanned,
    },
    note:
      "Version numbers are scoped to a session, so the same version number under " +
      "two sessions is two different files; a version is only addressable as " +
      "(session, hash, version). versionCount counts stored entries, which is " +
      "neither a chain depth nor a highest version number. Paths are recovered by " +
      "hashing paths found in transcripts; an entry is listed as unresolved rather " +
      "than dropped when no path matches it, when several paths share its " +
      `truncated hash, or when the hash is under ${MIN_RESOLVABLE_HASH_CHARS} hex ` +
      "characters and so cannot identify a file - never resolved to a guess. " +
      "totalVersions counts the entries the scan parsed; anything it refused is " +
      "counted in stats.skipped instead.",
  };
}

/**
 * Turn a requested (session, hash, version) into a path inside the root, or null.
 *
 * All three values reach a route from a client. Rejecting beats sanitising, and
 * an unsafe request answers exactly like an absent one so a probe learns nothing
 * from the difference; the warning keeps it loud in the server log instead.
 */
function resolveEntryPath(
  fileHistoryDir: string,
  sessionId: string,
  hash: string,
  version: number,
): string | null {
  if (!isPlainSegment(sessionId) || !HASH_ONLY.test(hash)) {
    console.warn("file-history: refusing a request whose session or hash is not a plain name");
    return null;
  }
  if (!Number.isInteger(version) || version < 1) return null;

  const candidate = path.join(fileHistoryDir, sessionId, `${hash}@v${version}`);
  // The component checks above already exclude traversal; asserting containment
  // on the resolved path as well means loosening them later cannot silently
  // widen what this serves.
  const root = path.resolve(fileHistoryDir);
  const relative = path.relative(root, path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    console.warn("file-history: refusing a request that resolves outside the history root");
    return null;
  }
  return candidate;
}

export type FileVersionText = {
  /** Absolute path this version belongs to, or null when the hash is unresolved. */
  path: string | null;
  /** Why the path is or is not given; `resolved` whenever `path` is non-null. */
  pathStatus: PathStatus;
  /** Distinct known paths sharing this truncated hash. */
  candidatePaths: number;
  /**
   * Transcript lines that did not parse while looking for this hash's path.
   *
   * A `no-match` status rests on having read every path a transcript recorded, so a
   * non-zero count here weakens that specific claim; zero is the usual case.
   */
  unparsedTranscriptLines: number;
  hash: string;
  sessionId: string;
  version: number;
  text: string;
  sizeBytes: number;
  lines: number;
  modifiedAt: string;
};

/**
 * The text of one stored version.
 *
 * Serves only entries this module's own scan lists. The index's entry set is
 * exactly that scan's entry set - resolved and unresolved together - so checking
 * against it is the same containment guarantee readWorkflowScript gets from
 * checking against its inventory, without making a single read pay for the
 * transcript walk that only supplies a display path. An unresolved hash is still
 * served, with a null path: not knowing a version's name is no reason to
 * pretend it is not there.
 */
export function readFileVersion(
  fileHistoryDir: string,
  transcriptsDir: string,
  sessionId: string,
  hash: string,
  version: number,
): FileVersionText | null {
  const { entries } = scanEntries(fileHistoryDir);
  const located = locateEntry(fileHistoryDir, entries, sessionId, hash, version);
  if (!located) return null;
  const text = readEntryText(located.entryPath);
  if (text === null) return null;

  const claim = findPathForHash(transcriptsDir, hash);
  return {
    path: claim.path,
    pathStatus: claim.pathStatus,
    candidatePaths: claim.candidatePaths,
    unparsedTranscriptLines: claim.unparsedTranscriptLines,
    hash,
    sessionId,
    version,
    text,
    sizeBytes: located.entry.sizeBytes,
    lines: splitLines(text).length,
    modifiedAt: toIso(located.entry.mtimeMs),
  };
}

type LocatedEntry = { entry: RawEntry; entryPath: string };

/**
 * Confirm a requested entry is one the scan lists, and say where it is.
 *
 * The scan's entry set is exactly the index's entry set, resolved and unresolved
 * together, so checking against it gives the same containment guarantee
 * readWorkflowScript gets from checking against its inventory - without making
 * every read pay for the transcript walk that only supplies a display path.
 */
function locateEntry(
  fileHistoryDir: string,
  entries: RawEntry[],
  sessionId: string,
  hash: string,
  version: number,
): LocatedEntry | null {
  const entryPath = resolveEntryPath(fileHistoryDir, sessionId, hash, version);
  if (entryPath === null) return null;
  const entry = entries.find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.hash === hash &&
      candidate.version === version,
  );
  if (!entry) return null;
  return { entry, entryPath };
}

function readEntryText(entryPath: string): string | null {
  try {
    return fs.readFileSync(entryPath, "utf8");
  } catch (err) {
    // A live session can replace an entry between the scan and the read; that is
    // a null rather than a throw, but it is never silent.
    console.warn(`file-history: could not read ${entryPath}:`, err);
    return null;
  }
}

/**
 * The absolute path behind one hash, with why it is or is not given.
 *
 * The walk covers the whole transcript tree rather than stopping at the first
 * prefix match, because a first match cannot be shown to be the only one and
 * stopping there is exactly what let a coincidental match be handed back as the
 * file's identity. The alternative was a confidently wrong absolute path, which is
 * not a trade this pillar can make.
 *
 * The reading is shared with buildPathMap through the per-file memo, so this is a
 * second pass over the paths rather than a second pass over the bytes: matching is
 * done here, on the extracted candidates, precisely so the expensive half does not
 * depend on the hash being looked for. Before that it was a full re-read of the
 * tree on every diff request, costing about a second each time.
 *
 * Only distinct paths count, so the same path named by a hundred tool results is
 * one candidate and not an ambiguity.
 */
function findPathForHash(
  transcriptsDir: string,
  hash: string,
): PathClaim & { unparsedTranscriptLines: number } {
  const matches = new Set<string>();
  let unparsedTranscriptLines = 0;
  for (const transcript of listTranscriptFiles(transcriptsDir)) {
    const scanned = scanCached(transcript, PATHS_EXTRACTOR_ID, scanPaths);
    if (scanned === null) continue;
    // An unparsable line can only cost a candidate path. That makes it the bound on
    // how much to trust a `no-match`: a status meaning "no known path hashes to it"
    // is only as strong as the set of paths that could be read, so the count travels
    // with the answer instead of staying behind in the index.
    unparsedTranscriptLines += scanned.unparsedLines;
    for (const candidate of scanned.paths) {
      if (digestPath(candidate).slice(0, hash.length) === hash) matches.add(candidate);
    }
  }

  const first = matches.values().next();
  return {
    ...claimPath(
      hash,
      first.done === true ? undefined : { path: first.value, candidatePaths: matches.size },
    ),
    unparsedTranscriptLines,
  };
}

/**
 * Split into lines of content, dropping the empty element a trailing newline
 * leaves behind.
 *
 * Keeping it would put a phantom final blank line in every diff. The cost is
 * that a change to the trailing newline alone becomes invisible in the hunks,
 * which is why the diff reports it as its own flag rather than letting it vanish.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export type DiffLineKind = "context" | "add" | "remove";

export type DiffLine = {
  kind: DiffLineKind;
  /** 1-based line number in the older version, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the newer version, or null for a removed line. */
  newLine: number | null;
  text: string;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffStats = {
  /** Lines present only in the newer version. Never counts a context line. */
  added: number;
  /** Lines present only in the older version. Never counts a context line. */
  removed: number;
  /**
   * Lines the two versions share over the whole comparison, or null when that is
   * not knowable.
   *
   * Null exactly when `minimal` is false. Working out which lines two versions
   * share IS the comparison the cell cap refused, so the capped fallback has no
   * count to give: it can only see the shared prefix and suffix it trimmed, and
   * reporting that as the total said two versions differing by one moved line
   * shared nothing at all. Null rather than a floor, because a number here is
   * read as the answer.
   */
  unchanged: number | null;
  /** Unchanged lines emitted inside hunks to give the changes surroundings. */
  contextLines: number;
  /**
   * Whether the change counts come from a real longest-common-subsequence run.
   *
   * False when the comparison was capped, in which case the differing region is
   * reported as one wholesale replacement, `added`/`removed` are upper bounds well
   * above the true edit size, and `unchanged` is null. Those three are the whole
   * set of fields a caller must distrust when this is false.
   */
  minimal: boolean;
};

export type FileVersionDiff = {
  path: string | null;
  /** Why the path is or is not given; `resolved` whenever `path` is non-null. */
  pathStatus: PathStatus;
  /** Distinct known paths sharing this truncated hash. */
  candidatePaths: number;
  /**
   * Transcript lines that did not parse while looking for this hash's path. Bounds
   * how much a `no-match` status is worth; zero is the usual case.
   */
  unparsedTranscriptLines: number;
  hash: string;
  from: { sessionId: string; version: number; lines: number; sizeBytes: number };
  to: { sessionId: string; version: number; lines: number; sizeBytes: number };
  hunks: DiffHunk[];
  stats: DiffStats;
  /**
   * Add and remove lines this edit script has that the hunks stopped short of.
   *
   * Zero unless the response cap fired. A truncated diff saying only "later
   * changes are not shown" leaves the reader unable to tell whether it lost two
   * lines or two thousand, which is the same partial-total-reading-as-complete
   * problem the skip counters exist for.
   */
  changesNotShown: number;
  /** True when either version ends in a newline and the other does not. */
  trailingNewlineChanged: boolean;
  truncated: boolean;
  /** Why the diff was capped, or null when it was computed in full. */
  truncationReason: string | null;
};

/**
 * Unchanged lines shown either side of a change, the usual unified-diff amount.
 * Enough to place a hunk in the file without turning the response into the file.
 */
const CONTEXT_LINES = 3;

/**
 * Cells the line-level comparison table may occupy.
 *
 * A longest-common-subsequence table is the product of the two line counts, so
 * two big files multiply into something that hangs the request. Four million
 * cells is a 2000-by-2000 differing region, comfortably above a normal source
 * edit, and costs 16MB as a Uint32Array. Past it the differing region is
 * reported wholesale instead, which is coarse but bounded and says so.
 */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Lines the hunks may carry in total.
 *
 * Separate from the cell cap because a wholesale replacement of two large files
 * is cheap to compute and enormous to serialize. A response that ships a
 * hundred thousand lines is not readable by the thing asking for it.
 */
const MAX_HUNK_LINES = 20_000;

type Edit = { kind: DiffLineKind; text: string };

/**
 * Longest-common-subsequence edit script over two line arrays.
 *
 * Written here rather than pulled in, because the whole point of this tool is
 * that it stays small. The table is Uint32Array-backed and the caller has
 * already trimmed the shared prefix and suffix, so this only ever sees the
 * region that genuinely differs.
 */
function lcsEdits(oldLines: string[], newLines: string[]): Edit[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);

  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row * width + column] =
        oldLines[row] === newLines[column]
          ? table[(row + 1) * width + column + 1]! + 1
          : Math.max(table[(row + 1) * width + column]!, table[row * width + column + 1]!);
    }
  }

  const edits: Edit[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (oldLines[row] === newLines[column]) {
      edits.push({ kind: "context", text: oldLines[row]! });
      row++;
      column++;
    } else if (table[(row + 1) * width + column]! >= table[row * width + column + 1]!) {
      edits.push({ kind: "remove", text: oldLines[row]! });
      row++;
    } else {
      edits.push({ kind: "add", text: newLines[column]! });
      column++;
    }
  }
  while (row < rows) edits.push({ kind: "remove", text: oldLines[row++]! });
  while (column < columns) edits.push({ kind: "add", text: newLines[column++]! });
  return edits;
}

/** Shared leading lines, which no real edit needs compared. */
function commonPrefixLength(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit && a[count] === b[count]) count++;
  return count;
}

/** Shared trailing lines, excluding anything the prefix already claimed. */
function commonSuffixLength(a: string[], b: string[], prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let count = 0;
  while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) count++;
  return count;
}

/**
 * Full edit script for two versions, capped.
 *
 * The prefix and suffix trim is what makes a one-line change in a large file
 * cheap: only the middle reaches the comparison table. When even that middle is
 * too large, it is emitted as a wholesale removal followed by a wholesale
 * addition and the caller is told the counts are no longer minimal.
 */
function buildEdits(
  oldLines: string[],
  newLines: string[],
): { edits: Edit[]; minimal: boolean; reason: string | null } {
  const prefix = commonPrefixLength(oldLines, newLines);
  const suffix = commonSuffixLength(oldLines, newLines, prefix);
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  const head: Edit[] = oldLines
    .slice(0, prefix)
    .map((text) => ({ kind: "context" as const, text }));
  const tail: Edit[] = oldLines
    .slice(oldLines.length - suffix)
    .map((text) => ({ kind: "context" as const, text }));

  const cells = (oldMiddle.length + 1) * (newMiddle.length + 1);
  if (cells > MAX_DIFF_CELLS) {
    return {
      edits: [
        ...head,
        ...oldMiddle.map((text) => ({ kind: "remove" as const, text })),
        ...newMiddle.map((text) => ({ kind: "add" as const, text })),
        ...tail,
      ],
      minimal: false,
      reason:
        `differing region is ${oldMiddle.length} by ${newMiddle.length} lines, past the ` +
        `${MAX_DIFF_CELLS}-cell comparison cap, so it is reported as one wholesale ` +
        `replacement; added and removed are upper bounds, not the real edit size, and ` +
        `unchanged is null because counting shared lines is the comparison that was refused`,
    };
  }

  return {
    edits: [...head, ...lcsEdits(oldMiddle, newMiddle), ...tail],
    minimal: true,
    reason: null,
  };
}

/**
 * Group an edit script into unified-diff hunks with surrounding context.
 *
 * Line numbers come from counters walked over the whole script rather than from
 * the hunks themselves, so a hunk that opens on an added line still reports the
 * old-file position it sits at.
 */
function toHunks(edits: Edit[]): { hunks: DiffHunk[]; contextLines: number; capped: boolean } {
  const positioned = edits.map((edit) => ({ ...edit, oldLine: 0, newLine: 0 }));
  let oldLine = 1;
  let newLine = 1;
  for (const entry of positioned) {
    entry.oldLine = oldLine;
    entry.newLine = newLine;
    if (entry.kind !== "add") oldLine++;
    if (entry.kind !== "remove") newLine++;
  }

  // Windows of interest: every change, padded by context on both sides. Merging
  // overlapping windows is what keeps two nearby edits in one readable hunk.
  const windows: Array<[number, number]> = [];
  for (let index = 0; index < positioned.length; index++) {
    if (positioned[index]!.kind === "context") continue;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(positioned.length - 1, index + CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }

  const hunks: DiffHunk[] = [];
  let contextLines = 0;
  let emitted = 0;
  let capped = false;

  for (const [start, end] of windows) {
    if (emitted >= MAX_HUNK_LINES) {
      capped = true;
      break;
    }
    const slice = positioned.slice(start, end + 1);
    const lines: DiffLine[] = [];
    for (const entry of slice) {
      if (emitted >= MAX_HUNK_LINES) {
        capped = true;
        break;
      }
      lines.push({
        kind: entry.kind,
        oldLine: entry.kind === "add" ? null : entry.oldLine,
        newLine: entry.kind === "remove" ? null : entry.newLine,
        text: entry.text,
      });
      if (entry.kind === "context") contextLines++;
      emitted++;
    }
    if (lines.length === 0) break;
    const first = slice[0]!;
    hunks.push({
      oldStart: first.oldLine,
      oldLines: lines.filter((line) => line.kind !== "add").length,
      newStart: first.newLine,
      newLines: lines.filter((line) => line.kind !== "remove").length,
      lines,
    });
  }

  return { hunks, contextLines, capped };
}

export type VersionRef = { sessionId: string; hash: string; version: number };

/**
 * Structured diff between two stored versions of the same file.
 *
 * Hunks rather than a rendered string, so a UI colours the lines itself instead
 * of re-parsing text this module just formatted.
 *
 * `added` and `removed` count only lines that exist in one version and not the
 * other. Context lines are counted separately and never folded in: a diff metric
 * in this repo once counted the unchanged lines surrounding a change, and
 * reported a one-line edit as seven. Anyone changing these counts should keep
 * them derived from the edit script's kinds rather than from hunk sizes.
 *
 * Both references must name the same hash, since a diff across two different
 * files compares nothing meaningful; a mismatch answers null, like any other
 * request this will not serve.
 */
export function diffFileVersions(
  fileHistoryDir: string,
  transcriptsDir: string,
  from: VersionRef,
  to: VersionRef,
): FileVersionDiff | null {
  if (from.hash !== to.hash) {
    console.warn("file-history: refusing a diff between two different files");
    return null;
  }

  // One scan and one path lookup for the pair. Reading each side through
  // readFileVersion would resolve the same hash twice, and each resolution walks
  // the transcript tree.
  const { entries } = scanEntries(fileHistoryDir);
  const olderEntry = locateEntry(
    fileHistoryDir,
    entries,
    from.sessionId,
    from.hash,
    from.version,
  );
  const newerEntry = locateEntry(fileHistoryDir, entries, to.sessionId, to.hash, to.version);
  if (!olderEntry || !newerEntry) return null;

  const olderText = readEntryText(olderEntry.entryPath);
  const newerText = readEntryText(newerEntry.entryPath);
  if (olderText === null || newerText === null) return null;

  const oldLines = splitLines(olderText);
  const newLines = splitLines(newerText);
  const { edits, minimal, reason } = buildEdits(oldLines, newLines);
  const { hunks, contextLines, capped } = toHunks(edits);

  const added = edits.filter((edit) => edit.kind === "add").length;
  const removed = edits.filter((edit) => edit.kind === "remove").length;
  // Only the real comparison produces context edits for the lines the two
  // versions share. In the capped fallback the context edits are just the trimmed
  // prefix and suffix, so counting them would describe the trim rather than the
  // files, and the number would look like an answer.
  const unchanged = minimal ? edits.filter((edit) => edit.kind === "context").length : null;

  // Counted from the hunks rather than from the cap arithmetic, so the number is
  // what a reader actually received short of what the script held.
  const shownChanges = hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.kind !== "context").length,
    0,
  );
  const changesNotShown = added + removed - shownChanges;

  const cappedReason = capped
    ? `hunks stop at the ${MAX_HUNK_LINES}-line response cap; ${changesNotShown} change ` +
      `line(s) of this edit script are not shown`
    : null;
  const reasons = [reason, cappedReason].filter((entry): entry is string => entry !== null);

  // Both refs name the same hash, so one lookup answers for both sides.
  const claim = findPathForHash(transcriptsDir, from.hash);

  return {
    path: claim.path,
    pathStatus: claim.pathStatus,
    candidatePaths: claim.candidatePaths,
    unparsedTranscriptLines: claim.unparsedTranscriptLines,
    hash: from.hash,
    from: {
      sessionId: from.sessionId,
      version: from.version,
      lines: oldLines.length,
      sizeBytes: olderEntry.entry.sizeBytes,
    },
    to: {
      sessionId: to.sessionId,
      version: to.version,
      lines: newLines.length,
      sizeBytes: newerEntry.entry.sizeBytes,
    },
    hunks,
    stats: { added, removed, unchanged, contextLines, minimal },
    changesNotShown,
    trailingNewlineChanged: olderText.endsWith("\n") !== newerText.endsWith("\n"),
    truncated: reasons.length > 0,
    truncationReason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}
