import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SourceMissingError } from "./config.js";

/**
 * Low-level reader for Claude Code session transcripts. Its whole job is
 * turning JSONL files on disk into records; anything that counts, groups, or
 * formats them belongs in the module that needs it, so several readers can
 * share this one without inheriting each other's shape.
 *
 * On-disk layout: <transcriptsDir>/<encoded-cwd-dir>/<sessionId>.jsonl.
 * The directory name is the session's working directory with path separators
 * and other punctuation flattened onto hyphens, e.g.
 * "-Users-someone-repos-project"; decodeProjectDir explains why that is not
 * reversible. A *.jsonl sitting directly in a project directory is a session
 * transcript; nested subdirectories hold subagent traffic, which is not a
 * session.
 *
 * Nothing here writes: every filesystem call is a stat, a readdir, or a
 * read-only open. The operator's session history is somebody else's file.
 */

/**
 * One transcript line. Only `type` is guaranteed - it is the field every
 * consumer dispatches on. Everything else varies by record type (assistant
 * records carry token usage, system records carry hook results, user records
 * carry tool output), so callers narrow the keys they need rather than this
 * module tracking a schema it does not own.
 */
export type TranscriptRecord = { type: string; [key: string]: unknown };

export type ParseResult = { records: TranscriptRecord[]; skippedLines: number };

export type TranscriptFile = {
  sessionId: string;
  /** The encoded directory name, e.g. "-Users-someone-repos-project". */
  projectDir: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
};

/**
 * A classified transcript line. The failure arm carries no payload: a line can
 * fail either by being unparseable (expected traffic, see parseTranscript) or
 * by exceeding MAX_LINE_CHARS, and in both cases a caller only needs to know
 * that it happened in order to report it.
 */
export type TranscriptLine =
  | { ok: true; record: TranscriptRecord }
  | { ok: false };

/**
 * Read size for the line reader. Large enough that a multi-megabyte transcript
 * costs few syscalls, small enough that the buffer itself is not a memory
 * concern. Peak memory is this chunk plus the line currently being assembled,
 * which is what MAX_LINE_CHARS exists to bound.
 */
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Longest line the reader will assemble, in UTF-16 characters. Without a cap,
 * a file containing no newline is read wholly into memory no matter how large
 * it is, because a line is only released once its terminator arrives.
 *
 * Real transcript lines embed base64 tool output and reach hundreds of
 * kilobytes, so the cap sits an order of magnitude above that: a line past it
 * is a corrupt or non-transcript file rather than a session record. Such a line
 * is dropped and counted, never thrown on, so one bad file degrades to a high
 * skip count instead of taking out the whole read.
 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/**
 * A line of the file, or the fact that one was dropped for exceeding
 * MAX_LINE_CHARS. The drop is reported rather than swallowed so the caller can
 * count it; silently omitting it would read as a file that simply had fewer
 * records.
 */
type ReadLine = { overlong: false; text: string } | { overlong: true };

/**
 * Open the file for one chunk read. A live Claude Code process can rotate or
 * delete a transcript while it is being read; once the file is gone there is
 * nothing further to read, so the read ends where it ends. Every other failure
 * stays loud, and a failure on the very first chunk is always thrown - a caller
 * that named a file that is not there asked a question, not a truncated
 * version of one.
 *
 * Reopening per chunk rather than holding one descriptor is what keeps an
 * abandoned generator from leaking; the price is that a transcript replaced
 * mid-read continues at the same byte offset in the replacement, which at worst
 * costs one unparseable line and is already counted as a skip.
 */
function openChunkReader(filePath: string, isFirstChunk: boolean): number | null {
  try {
    return fs.openSync(filePath, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!isFirstChunk && code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Yield the lines of a file without holding the file in memory. Node's own line
 * readers are async, and every reader in this server is synchronous, so this
 * walks the file in fixed chunks instead. StringDecoder carries a multi-byte
 * character that straddles a chunk boundary into the next chunk; decoding each
 * chunk on its own would corrupt it.
 *
 * Two properties are deliberate and load-bearing:
 *
 * No descriptor is held across a yield. The file is opened, one chunk is read,
 * and it is closed again before any line is handed out. A generator abandoned
 * mid-file therefore cannot leak a descriptor, which matters because a caller
 * that peeks the first record of every transcript drives the generator by hand
 * and drops it - `finally` blocks only run for a generator that is returned to,
 * so a descriptor held across a yield would leak once per peek and eventually
 * hit EMFILE.
 *
 * Every byte is scanned for a newline exactly once. Newlines are searched for
 * in the freshly decoded chunk, and the line under construction is kept as an
 * array of parts rather than one growing string. Appending to a string and then
 * searching the whole accumulation re-scans and re-flattens it on every chunk,
 * which made one very long line cost quadratic time.
 */
function* readLines(filePath: string): Generator<ReadLine> {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let pendingChars = 0;
  // True while discarding the tail of a line that already exceeded the cap and
  // has already been reported, so it is reported once rather than per chunk.
  let dropping = false;
  let position = 0;

  for (;;) {
    const fd = openChunkReader(filePath, position === 0);
    if (fd === null) break;
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    } finally {
      fs.closeSync(fd);
    }
    if (bytesRead === 0) break;
    position += bytesRead;

    const text = decoder.write(buffer.subarray(0, bytesRead));
    let searchFrom = 0;
    for (;;) {
      const newlineAt = text.indexOf("\n", searchFrom);
      if (newlineAt === -1) break;
      if (dropping) {
        // This newline terminates the over-long line, whose parts were never
        // kept; the next line starts clean.
        dropping = false;
      } else {
        const segment = text.slice(searchFrom, newlineAt);
        // The cap is enforced on completed lines as well as on the unterminated
        // remainder below. A line whose terminator arrives in the same chunk
        // that carries it past the cap has to be dropped here, or the effective
        // limit would be the cap plus a whole chunk.
        if (pendingChars + segment.length > MAX_LINE_CHARS) {
          yield { overlong: true };
        } else {
          parts.push(segment);
          yield { overlong: false, text: parts.join("") };
        }
      }
      parts = [];
      pendingChars = 0;
      searchFrom = newlineAt + 1;
    }

    if (!dropping) {
      const rest = text.slice(searchFrom);
      if (rest.length > 0) parts.push(rest);
      pendingChars += rest.length;
      if (pendingChars > MAX_LINE_CHARS) {
        yield { overlong: true };
        dropping = true;
        parts = [];
        pendingChars = 0;
      }
    }
  }

  const trailing = decoder.end();
  if (dropping) return;
  if (trailing.length > 0) {
    parts.push(trailing);
    pendingChars += trailing.length;
  }
  // A final line with no trailing newline: the live process appends here.
  if (pendingChars > MAX_LINE_CHARS) yield { overlong: true };
  else if (pendingChars > 0) yield { overlong: false, text: parts.join("") };
}

/**
 * Stream one transcript as classified lines, holding a single line at a time.
 * Use this instead of parseTranscript whenever the caller aggregates or wants
 * only the first few records: a single real transcript reaches thousands of
 * records and the tree reaches hundreds of megabytes, so materializing every
 * record is the expensive path. Abandoning the generator early stops reading
 * and releases everything it held, however it is abandoned - see readLines.
 */
export function* streamTranscript(filePath: string): Generator<TranscriptLine> {
  for (const line of readLines(filePath)) {
    // A line past the length cap is a failure the caller should see, not a line
    // to parse: it was never assembled, so there is nothing to hand out.
    if (line.overlong) {
      yield { ok: false };
      continue;
    }

    // Blank lines carry no data and are not evidence of a parse problem, so
    // they are ignored rather than counted as failures.
    if (line.text.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      yield { ok: false };
      continue;
    }

    // A line that parses but is not an object with a string `type` cannot be
    // handed out as a TranscriptRecord without lying about its shape, so it
    // counts as a failure rather than being cast.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      yield { ok: false };
      continue;
    }

    yield { ok: true, record: parsed as TranscriptRecord };
  }
}

/**
 * Parse a whole transcript into records plus a count of the lines that could
 * not be parsed.
 *
 * Unparseable lines are skipped rather than thrown on, because a live Claude
 * Code process appends to these files: reading one mid-write normally catches
 * a half-written final line, which is not an error. The count is returned
 * rather than swallowed so the other failure mode stays visible - if a schema
 * change breaks parsing wholesale, a high skip count says so, where a silently
 * short record list would look like a session that did nothing. A line over
 * MAX_LINE_CHARS counts here too, for the same reason.
 */
export function parseTranscript(filePath: string): ParseResult {
  const records: TranscriptRecord[] = [];
  let skippedLines = 0;
  for (const line of streamTranscript(filePath)) {
    if (line.ok) records.push(line.record);
    else skippedLines += 1;
  }
  return { records, skippedLines };
}

/**
 * Require the configured transcripts directory to be a directory.
 *
 * Absent and present-but-not-a-directory are the same operator mistake - a
 * mistyped config path - so both raise SourceMissingError naming the path,
 * which the route layer answers as 503. Letting a path that points at a file
 * fall through to readdir would surface a raw ENOTDIR as a 500 and make this
 * one pillar report a config typo differently from every other pillar.
 */
function requireTranscriptsDir(transcriptsDir: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(transcriptsDir, { throwIfNoEntry: false });
  } catch (err) {
    // ENOTDIR here means a leading component of the path is a file, so nothing
    // can exist at this path; that is the missing-source case. Anything else,
    // a permission problem for instance, is a real fault and stays loud.
    if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
  }
  if (!stat || !stat.isDirectory()) {
    throw new SourceMissingError("transcripts", transcriptsDir);
  }
}

/**
 * List session transcripts across every project directory, newest first.
 *
 * File bodies are never read here. The corpus reaches hundreds of megabytes on
 * a working machine, so the caller decides which transcripts are worth parsing
 * and eager reading would make every request pay for the whole tree.
 *
 * Symlinks are excluded on purpose, and warned about rather than dropped in
 * silence. Excluding them keeps the scan inside the configured directory: a
 * link placed here could otherwise aim the reader at an arbitrary tree. The
 * exclusion holds because Dirent.isDirectory() and Dirent.isFile() answer for
 * the link itself and not its target, so anything that replaces them with a
 * target-following stat reopens the hole - that is a behaviour to preserve, not
 * an implementation detail. The warning matters because a symlinked project
 * directory holding real sessions would otherwise report as simply absent.
 */
export function listTranscriptFiles(transcriptsDir: string): TranscriptFile[] {
  requireTranscriptsDir(transcriptsDir);

  const files: TranscriptFile[] = [];
  for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      console.warn(
        `transcripts: not following symlink ${path.join(transcriptsDir, entry.name)}; ` +
          `any sessions behind it are excluded`,
      );
      continue;
    }
    // Only project directories hold sessions. A stray file at this level is
    // not a transcript, and nested directories hold subagent traffic.
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(transcriptsDir, entry.name);

    let projectEntries: fs.Dirent[];
    try {
      projectEntries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch (err) {
      // One unreadable project directory must not blank out every other
      // project, but it is reported rather than hidden.
      console.warn(`transcripts: skipping unreadable ${projectPath}:`, err);
      continue;
    }

    for (const file of projectEntries) {
      if (!file.name.endsWith(".jsonl")) continue;
      if (file.isSymbolicLink()) {
        console.warn(
          `transcripts: not following symlink ${path.join(projectPath, file.name)}; ` +
            `that session is excluded`,
        );
        continue;
      }
      if (!file.isFile()) continue;
      const sessionId = file.name.slice(0, -".jsonl".length);
      // A file named exactly ".jsonl" has no session id. An empty id cannot
      // address the file back through resolveTranscriptPath and would render as
      // a blank row, so the file is not a session as far as this reader goes.
      if (sessionId.length === 0) continue;
      const filePath = path.join(projectPath, file.name);
      // A live session can rotate or delete a transcript between the readdir
      // and the stat, so a vanished file is skipped instead of throwing.
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (!stat) continue;
      files.push({
        sessionId,
        projectDir: entry.name,
        filePath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * What the subagent walk declined to read.
 *
 * Carried out of the reader rather than warned about and forgotten, because a file
 * count that reads as complete while being partial is the failure this whole reader
 * exists to avoid in its consumers.
 */
export type SubagentSkips = {
  /** Sibling directories whose name is not a session id, so not delegated work. */
  nonSessionDirectories: number;
  symlinks: number;
  unreadableDirectories: number;
  directoriesBeyondDepth: number;
};

export type SubagentTranscriptResult = {
  files: SubagentTranscriptFile[];
  skipped: SubagentSkips;
};

/** A subagent transcript, plus the mainline session that spawned it. */
export type SubagentTranscriptFile = TranscriptFile & {
  /** Session id of the mainline conversation this work was dispatched from. */
  ownerSessionId: string;
  /** Path from the owning session directory down to the file, for display. */
  relativePath: string;
};

/** How deep below a session directory a subagent transcript may sit. */
const SUBAGENT_MAX_DEPTH = 6;

/**
 * Session ids are uuids, and the directory holding a session's delegated work is
 * named for that session.
 *
 * Requiring the shape is what keeps unrelated directories out. Plugins and other
 * tooling also write beside the session transcripts - a plugin hook log directory
 * here holds six `.jsonl` files with no transcript records in them - and accepting
 * any sibling directory attributed those files to a nonexistent session named after
 * the plugin, inflating the file count and inventing an owner id.
 */
const SESSION_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every subagent transcript, which `listTranscriptFiles` deliberately excludes.
 *
 * The two readers answer different questions and must stay separate. A session's
 * message count, timeline and hook cost are about the mainline conversation, so
 * folding delegated turns into them would inflate figures the operator reads as
 * "this session". But a skill invoked inside a subagent was still invoked, and an
 * MCP server a subagent called was still called - for those questions the
 * delegated records are the point, and omitting them understates by a lot: on a
 * real tree here they hold 40% of all skill-attributed records, enough to change
 * which skill ranks heaviest.
 *
 * Nesting is bounded rather than unbounded because a cycle through a symlink would
 * otherwise walk forever; symlinks are refused for the same reason the mainline
 * reader refuses them.
 */
export function listSubagentTranscriptFiles(
  transcriptsDir: string,
): SubagentTranscriptResult {
  requireTranscriptsDir(transcriptsDir);

  const files: SubagentTranscriptFile[] = [];
  const skipped: SubagentSkips = {
    nonSessionDirectories: 0,
    symlinks: 0,
    unreadableDirectories: 0,
    directoriesBeyondDepth: 0,
  };

  const walk = (
    dirPath: string,
    projectDir: string,
    ownerSessionId: string,
    sessionRoot: string,
    depth: number,
  ): void => {
    if (depth > SUBAGENT_MAX_DEPTH) {
      skipped.directoriesBeyondDepth++;
      console.warn(
        `transcripts: subagent walk stopped at depth ${SUBAGENT_MAX_DEPTH} in ${dirPath}; ` +
          `anything deeper is excluded`,
      );
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      skipped.unreadableDirectories++;
      console.warn(`transcripts: skipping unreadable ${dirPath}:`, err);
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.symlinks++;
        console.warn(
          `transcripts: not following symlink ${entryPath}; anything behind it is excluded`,
        );
        continue;
      }
      if (entry.isDirectory()) {
        walk(entryPath, projectDir, ownerSessionId, sessionRoot, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (sessionId.length === 0) continue;
      const stat = fs.statSync(entryPath, { throwIfNoEntry: false });
      if (!stat) continue;
      files.push({
        sessionId,
        ownerSessionId,
        projectDir,
        filePath: entryPath,
        relativePath: path.relative(sessionRoot, entryPath),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  };

  for (const project of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (project.isSymbolicLink()) {
      skipped.symlinks++;
      continue;
    }
    if (!project.isDirectory()) continue;
    const projectPath = path.join(transcriptsDir, project.name);
    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch (err) {
      skipped.unreadableDirectories++;
      console.warn(`transcripts: skipping unreadable ${projectPath}:`, err);
      continue;
    }
    // The directory holding a session's delegated work is named for that session,
    // which is how a subagent record is attributed back to the conversation that
    // asked for it. A sibling directory with any other kind of name belongs to
    // something else and is counted rather than walked.
    for (const sessionDir of sessionDirs) {
      if (sessionDir.isSymbolicLink()) {
        skipped.symlinks++;
        continue;
      }
      if (!sessionDir.isDirectory()) continue;
      if (!SESSION_ID_SHAPE.test(sessionDir.name)) {
        skipped.nonSessionDirectories++;
        continue;
      }
      const sessionRoot = path.join(projectPath, sessionDir.name);
      walk(sessionRoot, project.name, sessionDir.name, sessionRoot, 1);
    }
  }

  return { files: files.sort((a, b) => b.mtimeMs - a.mtimeMs), skipped };
}

/**
 * How many per-file scan results to keep in memory, across every extractor
 * sharing this cache. Bounded because a long-running server would otherwise grow
 * without limit as transcripts are appended to: every append produces a new key,
 * so the old entry becomes dead weight rather than being replaced.
 */
const MAX_CACHED_FILES = 1000;

/**
 * Per-file scan results, keyed on the file's identity rather than its path.
 *
 * One map shared by every extractor, with the extractor's id in the key, so the
 * bound above is a bound on the whole server rather than one per reader. It holds
 * nothing the files do not; losing it costs a re-read of the tree.
 */
const scanCache = new Map<string, unknown>();

/**
 * Read one transcript through a memo on the file's identity, or null when the
 * file was gone before any of it could be read.
 *
 * The key is path, mtime and size together, so a transcript that has been
 * appended to has a different key and a stale result can never be served. That
 * matters more than it sounds: these files are appended to by a live process, and
 * a path-keyed cache would serve a truncated view of an active session forever.
 *
 * Two rules for callers, and both are load-bearing:
 *
 * Cache the whole per-file result, never a part of it. A cache holding only the
 * interesting half replays that half on a warm call and silently drops the file's
 * skip counts and date range, so the same tree answers differently depending on
 * whether it has been read before in this process - and the warm path is the one
 * a long-running server actually serves, so the dropped numbers become the normal
 * answer rather than the exception.
 *
 * Accumulate from the returned value, never inside the miss branch. Anything
 * incremented where the extraction happens is counted once per cold read and not
 * at all per warm one, which is the same defect wearing different clothes.
 *
 * What must not go in: anything that is not a function of the file's bytes.
 * Wall-clock time, the caller's window, and the file's role in this particular
 * request all change between calls that share a key. Summaries only, too - the
 * parsed records of the whole tree are far larger than the tree on disk.
 *
 * ENOENT becomes null rather than a throw because a live Claude Code process
 * rotates these files and this cache is used by readers that touch every
 * transcript on the machine, so a vanished file is expected traffic. Every other
 * failure is a real fault and stays loud.
 */
export function scanCached<T>(
  file: { filePath: string; mtimeMs: number; sizeBytes: number },
  extractorId: string,
  extract: (filePath: string) => T,
): T | null {
  const key = `${file.filePath}:${file.mtimeMs}:${file.sizeBytes}:${extractorId}`;
  const cached = scanCache.get(key);
  if (cached !== undefined) return cached as T;

  let scanned: T;
  try {
    scanned = extract(file.filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  scanCache.set(key, scanned);
  while (scanCache.size > MAX_CACHED_FILES) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = scanCache.keys().next();
    if (oldest.done) break;
    scanCache.delete(oldest.value);
  }
  return scanned;
}

/**
 * Drop every memoized scan. For tests that need a cold read on purpose; nothing
 * in the server calls it, because the identity key already makes staleness
 * impossible and the bound already caps the size.
 */
export function clearScanCache(): void {
  scanCache.clear();
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

/**
 * Path of one transcript, from a project directory name and a session id, or
 * null when either is not a single plain filename component.
 *
 * Both values reach a route from the client, and joining an unvalidated ".."
 * onto the transcripts directory would read any .jsonl on disk, so this is the
 * one sanctioned way to turn a request into a transcript path. Rejecting beats
 * sanitising: a caller that gets null answers "no such session" rather than
 * quietly reading a different one.
 *
 * Existence is not checked. A caller that needs to tell a bad name from an
 * absent session stats the returned path itself.
 */
export function resolveTranscriptPath(
  transcriptsDir: string,
  projectDir: string,
  sessionId: string,
): string | null {
  if (!isPlainSegment(projectDir) || !isPlainSegment(sessionId)) return null;
  const filePath = path.join(transcriptsDir, projectDir, `${sessionId}.jsonl`);
  // The component checks above already exclude traversal; asserting containment
  // on the resolved path as well means loosening them later cannot silently
  // widen what this function hands back.
  const root = path.resolve(transcriptsDir);
  const relative = path.relative(root, path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return filePath;
}

/**
 * Turn an encoded project directory name into a label for display.
 *
 * The encoder collapses several different characters onto "-": path separators,
 * dots, and hyphens that were already part of a directory name all arrive here
 * as "-". So "/Users/someone/repos/github.com/someone/web-app" and  // pii-allow: generic placeholder path in an example, not a real user
 * "/Users/someone/repos/github/com/someone/web/app" encode identically, and  // pii-allow: generic placeholder path in an example, not a real user
 * no function of the encoded name alone can tell them apart.
 *
 * Recoverable: the leading root separator, since an absolute path always
 * encodes to a leading "-". Not recoverable: every separator after it. This
 * therefore restores the root and leaves the rest of the name as it is, rather
 * than mapping "-" back to "/" - that mapping invents path levels that never
 * existed ("github.com" becoming "github/com", "web-app" becoming
 * "web/app"), and a fabricated path reads as authoritative while being
 * wrong, which is worse than showing the encoded name.
 *
 * Never build a filesystem path from the result. Use the transcript's own
 * filePath, or the `cwd` field the records carry, when a real path is needed.
 */
export function decodeProjectDir(encoded: string): string {
  return encoded.startsWith("-") ? `/${encoded.slice(1)}` : encoded;
}
