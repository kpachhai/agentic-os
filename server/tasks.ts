import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";
import { listLiveSessions } from "./live.js";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskRecord = {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: string;
  blocks: string[];
  blockedBy: string[];
};

export type SessionTasks = {
  /** Directory name as found on disk, which is the only stable handle. */
  dirName: string;
  /**
   * Session identifier recovered from the directory name. Full for a UUID-named
   * directory, and an 8-character prefix for the short form, so treat it as a
   * prefix rather than an exact id.
   */
  sessionKey: string;
  /** True when the key is a full identifier rather than a truncated prefix. */
  sessionKeyIsFull: boolean;
  /** A live process still owns this session, so its tasks are in flight. */
  sessionLive: boolean;
  mtimeMs: number;
  tasks: TaskRecord[];
  openTasks: TaskRecord[];
};

/**
 * Task directories come in two shapes on the same machine: a short
 * "session-<8 hex>" form and a full-identifier form. Neither is wrong and both
 * appear side by side, so a reader that assumes one shape silently loses the
 * other's task boards.
 */
const SHORT_DIR_RE = /^session-([0-9a-f]{8})$/i;
const FULL_ID_DIR_RE = /^([0-9a-f-]{16,})$/i;

function sessionKeyFromDirName(
  dirName: string,
): { key: string; isFull: boolean } | null {
  const short = dirName.match(SHORT_DIR_RE);
  if (short) return { key: short[1]!.toLowerCase(), isFull: false };
  const full = dirName.match(FULL_ID_DIR_RE);
  if (full) return { key: full[1]!.toLowerCase(), isFull: true };
  return null;
}

function isOpen(status: string): boolean {
  return status === "pending" || status === "in_progress";
}

function readTaskFile(filePath: string): TaskRecord | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.warn(`tasks: skipping unreadable task ${filePath}:`, err);
    return null;
  }
  const str = (key: string): string =>
    typeof raw[key] === "string" ? (raw[key] as string) : "";
  const list = (key: string): string[] =>
    Array.isArray(raw[key]) ? (raw[key] as unknown[]).map(String) : [];

  const id = str("id");
  const subject = str("subject");
  // A record with neither an id nor a subject carries nothing a reader can act
  // on, and rendering it would produce an anonymous blank row.
  if (!id && !subject) return null;

  return {
    id,
    subject,
    description: str("description"),
    activeForm: str("activeForm"),
    status: str("status") || "pending",
    blocks: list("blocks"),
    blockedBy: list("blockedBy"),
  };
}

/**
 * Numeric task ids are assigned in creation order, so sorting them numerically
 * restores that order. Anything non-numeric falls back to string comparison
 * rather than being dropped.
 */
function byTaskId(a: TaskRecord, b: TaskRecord): number {
  const numA = Number(a.id);
  const numB = Number(b.id);
  if (Number.isInteger(numA) && Number.isInteger(numB)) return numA - numB;
  return a.id.localeCompare(b.id);
}

function readSessionTasks(
  tasksDir: string,
  dirName: string,
  liveKeys: Set<string>,
): SessionTasks | null {
  const parsed = sessionKeyFromDirName(dirName);
  if (!parsed) return null;

  const dirPath = path.join(tasksDir, dirName);
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.warn(`tasks: skipping unreadable task dir ${dirPath}:`, err);
    return null;
  }
  if (entries.length === 0) return null;

  const tasks = entries
    .map((f) => readTaskFile(path.join(dirPath, f)))
    .filter((t): t is TaskRecord => t !== null)
    .sort(byTaskId);
  if (tasks.length === 0) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dirPath).mtimeMs;
  } catch {
    // A directory that vanished between readdir and stat is a live-process
    // race, not a failure worth surfacing; an unknown mtime just sorts last.
  }

  // The short directory form carries only a prefix, so membership is a prefix
  // test in that direction too. Comparing a full id against a set of prefixes
  // would never match.
  const sessionLive = parsed.isFull
    ? liveKeys.has(parsed.key)
    : [...liveKeys].some((liveKey) => liveKey.startsWith(parsed.key));

  return {
    dirName,
    sessionKey: parsed.key,
    sessionKeyIsFull: parsed.isFull,
    sessionLive,
    mtimeMs,
    tasks,
    openTasks: tasks.filter((t) => isOpen(t.status)),
  };
}

/**
 * Every session task board on disk, newest first, each marked with whether a
 * live process still owns it.
 *
 * Boards whose session is gone are the interesting ones: they are work that was
 * left pending when a session was closed or cleared, which is a question none of
 * the file-backed pillars can otherwise answer. Live boards are returned too so
 * the caller can tell "still being worked" apart from "dropped".
 */
export function listSessionTasks(
  tasksDir: string,
  liveSessionsDir: string,
): SessionTasks[] {
  if (!fs.existsSync(tasksDir)) {
    throw new SourceMissingError("tasks dir", tasksDir);
  }

  // A missing live-sessions directory means nothing can be confirmed live, so
  // every board reads as abandoned. That is the honest answer for a machine with
  // no session registry, and it must not take the whole pillar down.
  let liveKeys = new Set<string>();
  try {
    liveKeys = new Set(
      listLiveSessions(liveSessionsDir)
        .filter((session) => session.live && session.sessionId)
        .map((session) => session.sessionId.toLowerCase()),
    );
  } catch (err) {
    if (!(err instanceof SourceMissingError)) throw err;
  }

  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSessionTasks(tasksDir, entry.name, liveKeys))
    .filter((board): board is SessionTasks => board !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Task boards with unfinished work whose owning session is no longer running. */
export function listAbandonedTasks(
  tasksDir: string,
  liveSessionsDir: string,
): SessionTasks[] {
  return listSessionTasks(tasksDir, liveSessionsDir).filter(
    (board) => !board.sessionLive && board.openTasks.length > 0,
  );
}
