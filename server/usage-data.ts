import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";

/**
 * The store Claude Code's `/insights` command writes: per-session statistics it
 * derived from the transcripts, plus a smaller set of semantic judgements a
 * model produced about how each session went.
 *
 * THE PROPERTY THAT GOVERNS EVERY VIEW BUILT ON THIS: it is generated on demand
 * and never maintained. Running `/insights` writes the whole store in one pass
 * and nothing touches it again, so on this machine all 200 statistics files
 * shared a single mtime and the judgements another one a minute later. It is
 * therefore optional, stale by default, and sparse - far fewer sessions have
 * judgements than have transcripts. Anything rendered from it carries its
 * coverage counts and the time it was generated, because presented without
 * those it reads as a statement about all of the operator's work when it is a
 * statement about whichever sessions existed the last time a command was run.
 *
 * Read-only, like every other source here. This module never writes and never
 * asks Claude Code to regenerate anything.
 */

/** Per-session statistics, derived by Claude Code from the transcript. */
export type SessionMeta = {
  sessionId: string;
  projectPath: string;
  startTime: string;
  durationMinutes: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCounts: Record<string, number>;
  languages: Record<string, number>;
  gitCommits: number;
  gitPushes: number;
  inputTokens: number;
  outputTokens: number;
  userInterruptions: number;
  toolErrors: number;
  toolErrorCategories: Record<string, number>;
  usesTaskAgent: boolean;
  usesMcp: boolean;
  usesWebSearch: boolean;
  usesWebFetch: boolean;
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
  /**
   * Deliberately not carried: this store's `first_prompt` field. The session
   * reader already derives a title from the transcript and holds it to the label
   * rule, so re-exposing a raw prompt here would put a second, unlabelled name
   * for the same session on screen.
   */
};

/**
 * A model's reading of one session. Every field here is a judgement, not a
 * measurement, which is why nothing in this repo computes with them: they are
 * displayed as the categories they are and never summed against anything the
 * transcripts say.
 */
export type SessionFacets = {
  sessionId: string;
  underlyingGoal: string;
  goalCategories: Record<string, number>;
  outcome: string;
  userSatisfactionCounts: Record<string, number>;
  claudeHelpfulness: string;
  sessionType: string;
  frictionCounts: Record<string, number>;
  frictionDetail: string;
  primarySuccess: string;
  briefSummary: string;
};

/**
 * What the store actually covers, carried alongside every answer derived from
 * it. `transcripts` is the denominator that makes the other two mean something:
 * 32 judgements is a different claim depending on whether there are 40 sessions
 * or 480.
 */
export type UsageDataCoverage = {
  sessionMetaCount: number;
  facetsCount: number;
  transcriptCount: number;
  /** Newest mtime across the statistics files; null when none were readable. */
  generatedAt: string | null;
  /** Newest mtime across the judgement files. */
  facetsGeneratedAt: string | null;
  /** Files present but unreadable or malformed, surfaced rather than swallowed. */
  unreadableFiles: number;
};

export type UsageData = {
  meta: Map<string, SessionMeta>;
  facets: Map<string, SessionFacets>;
  coverage: UsageDataCoverage;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string) : "";
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/** Numeric maps only: a category whose count is not a number is dropped. */
function counts(source: Record<string, unknown>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(asRecord(source[key]))) {
    if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
  }
  return out;
}

function readJsonDir(
  dirPath: string,
): { records: Record<string, unknown>[]; newestMtimeMs: number; unreadable: number } {
  const records: Record<string, unknown>[] = [];
  let newestMtimeMs = 0;
  let unreadable = 0;

  let names: string[];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return { records, newestMtimeMs, unreadable };
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(dirPath, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
      records.push(asRecord(JSON.parse(fs.readFileSync(filePath, "utf8"))));
    } catch {
      // One malformed file must not take down the pillar; it is counted so a
      // regression shows up as a rising number instead of as missing sessions.
      unreadable += 1;
    }
  }
  return { records, newestMtimeMs, unreadable };
}

function toIso(mtimeMs: number): string | null {
  return mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null;
}

/**
 * How many transcripts exist, for the coverage denominator. Counted by walking
 * the tree rather than by parsing anything, because this only needs the size of
 * the population the store is a sample of.
 */
function countTranscripts(transcriptsDir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      for (const name of fs.readdirSync(path.join(transcriptsDir, entry.name))) {
        if (name.endsWith(".jsonl")) total += 1;
      }
    } catch {
      // A directory that vanished between the listing and the read contributes
      // nothing, which is the honest answer for a denominator.
    }
  }
  return total;
}

export function readUsageData(usageDataDir: string, transcriptsDir: string): UsageData {
  if (!fs.existsSync(usageDataDir)) {
    throw new SourceMissingError("usage data", usageDataDir);
  }

  const metaRead = readJsonDir(path.join(usageDataDir, "session-meta"));
  const facetsRead = readJsonDir(path.join(usageDataDir, "facets"));

  const meta = new Map<string, SessionMeta>();
  for (const record of metaRead.records) {
    const sessionId = str(record, "session_id");
    if (!sessionId) continue;
    meta.set(sessionId, {
      sessionId,
      projectPath: str(record, "project_path"),
      startTime: str(record, "start_time"),
      durationMinutes: num(record, "duration_minutes"),
      userMessageCount: num(record, "user_message_count"),
      assistantMessageCount: num(record, "assistant_message_count"),
      toolCounts: counts(record, "tool_counts"),
      languages: counts(record, "languages"),
      gitCommits: num(record, "git_commits"),
      gitPushes: num(record, "git_pushes"),
      inputTokens: num(record, "input_tokens"),
      outputTokens: num(record, "output_tokens"),
      userInterruptions: num(record, "user_interruptions"),
      toolErrors: num(record, "tool_errors"),
      toolErrorCategories: counts(record, "tool_error_categories"),
      usesTaskAgent: bool(record, "uses_task_agent"),
      usesMcp: bool(record, "uses_mcp"),
      usesWebSearch: bool(record, "uses_web_search"),
      usesWebFetch: bool(record, "uses_web_fetch"),
      linesAdded: num(record, "lines_added"),
      linesRemoved: num(record, "lines_removed"),
      filesModified: num(record, "files_modified"),
    });
  }

  const facets = new Map<string, SessionFacets>();
  for (const record of facetsRead.records) {
    const sessionId = str(record, "session_id");
    if (!sessionId) continue;
    facets.set(sessionId, {
      sessionId,
      underlyingGoal: str(record, "underlying_goal"),
      goalCategories: counts(record, "goal_categories"),
      outcome: str(record, "outcome"),
      userSatisfactionCounts: counts(record, "user_satisfaction_counts"),
      claudeHelpfulness: str(record, "claude_helpfulness"),
      sessionType: str(record, "session_type"),
      frictionCounts: counts(record, "friction_counts"),
      frictionDetail: str(record, "friction_detail"),
      primarySuccess: str(record, "primary_success"),
      briefSummary: str(record, "brief_summary"),
    });
  }

  return {
    meta,
    facets,
    coverage: {
      sessionMetaCount: meta.size,
      facetsCount: facets.size,
      transcriptCount: countTranscripts(transcriptsDir),
      generatedAt: toIso(metaRead.newestMtimeMs),
      facetsGeneratedAt: toIso(facetsRead.newestMtimeMs),
      unreadableFiles: metaRead.unreadable + facetsRead.unreadable,
    },
  };
}

/** Total judged friction events in one session, across every category. */
export function frictionTotal(facets: SessionFacets): number {
  return Object.values(facets.frictionCounts).reduce((sum, count) => sum + count, 0);
}
