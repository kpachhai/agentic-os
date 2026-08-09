import fs from "node:fs";
import { SourceMissingError } from "./config.js";
import { decodeProjectDir } from "./transcripts.js";

/**
 * Reader over Claude Code's global prompt history.
 *
 * One flat newline-delimited JSON file holding every prompt the operator has
 * typed, across every project. It answers a question none of the other pillars
 * can: not what Claude did, but what was actually asked of it.
 *
 * THIS IS THE MOST SENSITIVE FILE THIS TOOL READS. It is every prompt verbatim,
 * which includes anything ever pasted into one - keys, tokens, client names,
 * personal detail. Three consequences, all enforced here or in the tests:
 * strictly read-only; never rendered wholesale, only as bounded excerpts the
 * caller asked for; and never captured into a fixture, a snapshot, or gate
 * output. The same rule the memory vault gets, for the same reason.
 */

export type PromptEntry = {
  /** Epoch milliseconds, as recorded. */
  timestamp: number;
  /** The prompt text as typed. */
  text: string;
  /** Encoded project directory the prompt was typed in. */
  project: string;
  /** Best-effort readable form of that directory. */
  projectPath: string;
  sessionId: string;
  /** Whether the entry recorded pasted content alongside the typed text. */
  hadPaste: boolean;
};

export type HistoryQuery = {
  q?: string;
  /** Encoded project directory to restrict to. */
  project?: string;
  limit?: number;
  offset?: number;
};

type RawEntry = {
  display?: unknown;
  timestamp?: unknown;
  project?: unknown;
  sessionId?: unknown;
  pastedContents?: unknown;
};

/**
 * Longest excerpt returned per prompt.
 *
 * Prompts run to thousands of characters, and a list view that returned them
 * whole would put the operator's entire prompt corpus on one screen. The cap is
 * about proportion rather than performance: a browsable history should show enough
 * to recognise an entry, not reproduce it.
 */
const EXCERPT_CHARS = 400;

function parseLine(line: string): PromptEntry | null {
  let raw: RawEntry;
  try {
    raw = JSON.parse(line) as RawEntry;
  } catch {
    // The file is appended to by a live process, so a partial trailing line is
    // ordinary. Counted by the caller, never thrown on.
    return null;
  }

  const text = typeof raw.display === "string" ? raw.display : "";
  const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : 0;
  if (!text.trim()) return null;

  const project = typeof raw.project === "string" ? raw.project : "";
  const pasted = raw.pastedContents;

  return {
    timestamp,
    text,
    project,
    projectPath: project ? decodeProjectDir(project) : "",
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
    // Only whether a paste happened, never what was pasted. Pasted content is
    // the likeliest place for a secret to be sitting, and nothing here needs it.
    hadPaste:
      typeof pasted === "object" &&
      pasted !== null &&
      Object.keys(pasted as Record<string, unknown>).length > 0,
  };
}

function readAll(historyPath: string): PromptEntry[] {
  if (!fs.existsSync(historyPath)) {
    throw new SourceMissingError("prompt history", historyPath);
  }
  return fs
    .readFileSync(historyPath, "utf8")
    .split("\n")
    .map((line) => (line.trim() ? parseLine(line) : null))
    .filter((entry): entry is PromptEntry => entry !== null);
}

/** Prompts, newest first, optionally filtered by text and project. */
export function listPrompts(
  historyPath: string,
  query: HistoryQuery = {},
): PromptEntry[] {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  let entries = readAll(historyPath).sort((a, b) => b.timestamp - a.timestamp);

  if (query.project) {
    entries = entries.filter((entry) => entry.project === query.project);
  }
  if (query.q && query.q.trim()) {
    const needle = query.q.trim().toLowerCase();
    entries = entries.filter((entry) => entry.text.toLowerCase().includes(needle));
  }

  return entries.slice(offset, offset + limit).map((entry) => ({
    ...entry,
    text:
      entry.text.length > EXCERPT_CHARS
        ? `${entry.text.slice(0, EXCERPT_CHARS)}...`
        : entry.text,
  }));
}

export type HistoryStats = {
  totalPrompts: number;
  /** Prompts per project, most active first. */
  byProject: Array<{ project: string; projectPath: string; count: number }>;
  /** Prompts per hour of the day, 0-23, in local time. */
  byHour: number[];
  /** Prompts per day, newest first, for a working-rhythm view. */
  byDay: Array<{ date: string; count: number }>;
  withPaste: number;
  firstAt: number;
  lastAt: number;
  /** Median prompt length in characters, a rough proxy for how much gets typed. */
  medianLength: number;
};

/**
 * Aggregates over the whole history.
 *
 * Counts and shapes only - no prompt text leaves this function. That split is
 * deliberate: the stats view is the one a reader is most likely to leave open or
 * screenshot, so it is built to carry no content at all.
 */
export function historyStats(historyPath: string): HistoryStats {
  const entries = readAll(historyPath);

  const byProject = new Map<string, { projectPath: string; count: number }>();
  const byHour = new Array<number>(24).fill(0);
  const byDay = new Map<string, number>();
  const lengths: number[] = [];
  let withPaste = 0;
  let firstAt = Number.MAX_SAFE_INTEGER;
  let lastAt = 0;

  for (const entry of entries) {
    const project = byProject.get(entry.project) ?? {
      projectPath: entry.projectPath,
      count: 0,
    };
    project.count++;
    byProject.set(entry.project, project);

    if (entry.timestamp > 0) {
      const when = new Date(entry.timestamp);
      byHour[when.getHours()]!++;
      const day = when.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      firstAt = Math.min(firstAt, entry.timestamp);
      lastAt = Math.max(lastAt, entry.timestamp);
    }

    if (entry.hadPaste) withPaste++;
    lengths.push(entry.text.length);
  }

  lengths.sort((a, b) => a - b);

  return {
    totalPrompts: entries.length,
    byProject: [...byProject.entries()]
      .map(([project, value]) => ({ project, ...value }))
      .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project)),
    byHour,
    byDay: [...byDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
    withPaste,
    firstAt: entries.length > 0 && firstAt !== Number.MAX_SAFE_INTEGER ? firstAt : 0,
    lastAt,
    medianLength: lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)]! : 0,
  };
}
