import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";

/**
 * One Claude Code process that registered itself on disk. `processAlive` and
 * `heartbeatAgeMs` are reported separately from `live` on purpose: they are two
 * independent signals and neither alone is trustworthy, so a reader who
 * disagrees with the combined verdict can see why.
 */
export type LiveSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Claude Code's own label for the session; "derived" when auto-generated. */
  name: string;
  nameSource: string;
  /** "interactive" for a session someone is typing in. */
  kind: string;
  entrypoint: string;
  version: string;
  /** Claude Code's self-reported state, e.g. busy or idle. Not proof of life. */
  status: string;
  startedAt: number;
  uptimeMs: number;
  /** Age of the last heartbeat write, in ms. Large means the file is stale. */
  heartbeatAgeMs: number;
  /** The PID answers signal 0, i.e. some process holds it. */
  processAlive: boolean;
  live: boolean;
  path: string;
};

/**
 * A registration file whose heartbeat is older than this is treated as stale
 * even when its PID still answers, because PIDs get reused: a crashed session
 * leaves its file behind, and the number can later belong to an unrelated
 * process. Requiring a recent heartbeat as well as a live PID is what stops a
 * dead session reappearing as somebody else's process.
 */
const STALE_HEARTBEAT_MS = 15 * 60 * 1000;

/**
 * Does any process hold this PID? Signal 0 performs the permission and
 * existence checks without delivering anything. EPERM means the process exists
 * but belongs to another user, which still counts as alive; only ESRCH means
 * nothing holds the PID.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readSessionFile(filePath: string, now: number): LiveSession | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    // A registration file is rewritten by a live process, so a torn read is
    // expected rather than exceptional. Skip and log; never fail the pillar
    // because one file was mid-write.
    console.warn(`live: skipping unreadable session file ${filePath}:`, err);
    return null;
  }

  const pid = typeof raw.pid === "number" ? raw.pid : Number.NaN;
  if (!Number.isInteger(pid)) {
    console.warn(`live: skipping session file with no usable pid: ${filePath}`);
    return null;
  }

  const startedAt = typeof raw.startedAt === "number" ? raw.startedAt : 0;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : startedAt;
  const alive = processAlive(pid);
  const heartbeatAgeMs = updatedAt > 0 ? Math.max(now - updatedAt, 0) : Number.MAX_SAFE_INTEGER;

  const str = (key: string, fallback = ""): string =>
    typeof raw[key] === "string" ? (raw[key] as string) : fallback;

  return {
    pid,
    sessionId: str("sessionId"),
    cwd: str("cwd"),
    name: str("name"),
    nameSource: str("nameSource"),
    kind: str("kind"),
    entrypoint: str("entrypoint"),
    version: str("version"),
    status: str("status", "unknown"),
    startedAt,
    uptimeMs: startedAt > 0 ? Math.max(now - startedAt, 0) : 0,
    heartbeatAgeMs,
    processAlive: alive,
    live: alive && heartbeatAgeMs < STALE_HEARTBEAT_MS,
    path: filePath,
  };
}

/**
 * Every session registration on disk, live ones first, then by most recent
 * heartbeat.
 *
 * Stale entries are returned rather than filtered out. A registration file left
 * behind by a crashed session is information - it explains why a working tree
 * looks claimed - and dropping it silently would leave the operator wondering
 * where a session went. The caller decides what to show; this reader only
 * decides what is true.
 */
export function listLiveSessions(liveSessionsDir: string): LiveSession[] {
  if (!fs.existsSync(liveSessionsDir)) {
    throw new SourceMissingError("live sessions", liveSessionsDir);
  }
  const now = Date.now();
  return fs
    .readdirSync(liveSessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readSessionFile(path.join(liveSessionsDir, entry.name), now))
    .filter((session): session is LiveSession => session !== null)
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.heartbeatAgeMs - b.heartbeatAgeMs;
    });
}

/**
 * The working directories currently claimed by a live session.
 *
 * This exists for the launcher: starting a headless run inside a directory an
 * interactive session already owns puts two agents on one working tree, which
 * is how a rebase or an amend lands on somebody else's commit. Naming the
 * conflict before the launch is cheaper than untangling it after.
 */
export function liveCwds(liveSessionsDir: string): string[] {
  return [
    ...new Set(
      listLiveSessions(liveSessionsDir)
        .filter((session) => session.live && session.cwd)
        .map((session) => session.cwd),
    ),
  ].sort();
}
