import { SourceMissingError } from "./config.js";
import {
  decodeProjectDir,
  listTranscriptFiles,
  resolveTranscriptPath,
  streamTranscript,
  type TranscriptRecord,
} from "./transcripts.js";

export type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type NamedCount = { name: string; count: number };

export type SessionSummary = {
  sessionId: string;
  /** Encoded directory name, and the handle a detail request must pass back. */
  projectDir: string;
  /**
   * Working directory. Taken from a record when one carries it, because the
   * directory name is a lossy encoding; `cwdSource` says which it was so a
   * reader knows whether the path is exact or reconstructed.
   */
  cwd: string;
  cwdSource: "record" | "decoded";
  title: string;
  /**
   * Where the title came from. Claude Code writes a plain-English title into the
   * transcript itself, which is the best available name and needs no generation;
   * the fallbacks exist because older or very short sessions have none.
   */
  titleSource: "ai-title" | "first-prompt" | "session-id";
  startedAt: string;
  endedAt: string;
  /** Claude Code version seen on the records, for reading schema-dependent views. */
  version: string;
  gitBranch: string;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  models: NamedCount[];
  tokens: TokenTotals;
  toolCalls: NamedCount[];
  skills: NamedCount[];
  mcpServers: NamedCount[];
  hookInvocations: number;
  hookErrorRecords: number;
  toolDenials: NamedCount[];
  /**
   * Lines the parser could not read. Surfaced rather than swallowed: a schema
   * change upstream shows up here as a rising count, which is distinguishable
   * from a session that genuinely had fewer records.
   */
  skippedLines: number;
  sizeBytes: number;
  mtimeMs: number;
};

export type TimelineEntry = {
  uuid: string;
  parentUuid: string | null;
  type: string;
  timestamp: string;
  role: string | null;
  model: string | null;
  /** Prose content, truncated; the full body stays on disk. */
  text: string;
  textTruncated: boolean;
  toolUses: NamedCount[];
  tokens: TokenTotals | null;
  attributionSkill: string | null;
  attributionMcpServer: string | null;
  isSidechain: boolean;
  isMeta: boolean;
  denialKind: string | null;
  /**
   * More than one record claims this entry as its parent, which is what a
   * rewind looks like from the file: the conversation forked here.
   */
  isBranchPoint: boolean;
};

/**
 * One file a session touched.
 *
 * This is a truer answer than `git diff` gives, and a different question: it
 * records every file the session actually edited, in order, INCLUDING files whose
 * changes were later reverted, rewound, or overwritten. A diff shows the surviving
 * result; this shows the blast radius.
 */
export type TouchedFile = {
  path: string;
  edits: number;
  /** Lines added across every edit, from the recorded diff hunks. */
  linesAdded: number;
  linesRemoved: number;
  firstTouchedAt: string;
  lastTouchedAt: string;
  /**
   * The operator changed the file themselves after an edit. Worth surfacing: it
   * usually marks a spot where the agent's version was not right.
   */
  userModified: boolean;
};

export type SessionDetail = SessionSummary & {
  timeline: TimelineEntry[];
  filePath: string;
  /** Files touched, most-edited first. */
  touchedFiles: TouchedFile[];
  blastRadius: {
    files: number;
    edits: number;
    linesAdded: number;
    linesRemoved: number;
    filesUserModified: number;
  };
};

/** Longest prose excerpt kept per timeline entry. */
const TEXT_EXCERPT_CHARS = 600;

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function addTokens(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreation += from.cacheCreation;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string) : "";
}

function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageTokens(message: Record<string, unknown>): TokenTotals | null {
  const usage = asRecord(message.usage);
  if (!usage) return null;
  return {
    input: num(usage, "input_tokens"),
    output: num(usage, "output_tokens"),
    cacheRead: num(usage, "cache_read_input_tokens"),
    cacheCreation: num(usage, "cache_creation_input_tokens"),
  };
}

/**
 * Message content is either a plain string or an array of typed blocks. Pull the
 * prose out of both shapes and note every tool call, ignoring block kinds that
 * carry no text a reader would want.
 */
function readContent(message: Record<string, unknown>): {
  text: string;
  toolUses: string[];
} {
  const content = message.content;
  if (typeof content === "string") return { text: content, toolUses: [] };
  if (!Array.isArray(content)) return { text: "", toolUses: [] };

  const parts: string[] = [];
  const toolUses: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const blockType = str(block, "type");
    if (blockType === "text") {
      const text = str(block, "text");
      if (text) parts.push(text);
    } else if (blockType === "tool_use") {
      toolUses.push(str(block, "name") || "unknown");
    }
  }
  return { text: parts.join("\n\n"), toolUses };
}

function tally(counts: Map<string, number>, key: string): void {
  if (!key) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Counts as a list, most frequent first, with the name as a stable tiebreaker. */
function toNamedCounts(counts: Map<string, number>): NamedCount[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

type Accumulator = {
  aiTitle: string;
  firstPrompt: string;
  cwd: string;
  version: string;
  gitBranch: string;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  models: Map<string, number>;
  tools: Map<string, number>;
  skills: Map<string, number>;
  mcpServers: Map<string, number>;
  denials: Map<string, number>;
  hookInvocations: number;
  hookErrorRecords: number;
  tokens: TokenTotals;
  timeline: TimelineEntry[];
  childCounts: Map<string, number>;
  touched: Map<string, TouchedFile>;
};

function newAccumulator(): Accumulator {
  return {
    aiTitle: "",
    firstPrompt: "",
    cwd: "",
    version: "",
    gitBranch: "",
    firstTimestamp: "",
    lastTimestamp: "",
    messageCount: 0,
    userTurns: 0,
    assistantTurns: 0,
    models: new Map(),
    tools: new Map(),
    skills: new Map(),
    mcpServers: new Map(),
    denials: new Map(),
    hookInvocations: 0,
    hookErrorRecords: 0,
    tokens: emptyTokens(),
    timeline: [],
    childCounts: new Map(),
    touched: new Map(),
  };
}

/**
 * Record a file edit from a tool result.
 *
 * The diff hunks carry their own line counts, so added and removed lines come
 * straight from the record rather than being re-derived from the text. A hunk with
 * no counts contributes nothing instead of a guess.
 */
function absorbEdit(accumulator: Accumulator, record: TranscriptRecord): void {
  const result = asRecord(record.toolUseResult);
  if (!result) return;
  const filePath = str(result, "filePath");
  if (!filePath) return;
  // A patch is what separates a write from a read. Read results also name a file,
  // and counting one as an edit would make this panel claim the session changed
  // something it only looked at.
  if (!Array.isArray(result.structuredPatch)) return;

  const timestamp = str(record, "timestamp");
  let existing = accumulator.touched.get(filePath);
  if (!existing) {
    existing = {
      path: filePath,
      edits: 0,
      linesAdded: 0,
      linesRemoved: 0,
      firstTouchedAt: timestamp,
      lastTouchedAt: timestamp,
      userModified: false,
    };
    accumulator.touched.set(filePath, existing);
  }

  existing.edits++;
  if (timestamp) {
    if (!existing.firstTouchedAt || timestamp < existing.firstTouchedAt) {
      existing.firstTouchedAt = timestamp;
    }
    if (timestamp > existing.lastTouchedAt) existing.lastTouchedAt = timestamp;
  }
  if (result.userModified === true) existing.userModified = true;

  for (const rawHunk of result.structuredPatch) {
    const hunk = asRecord(rawHunk);
    if (!hunk) continue;
    // Count the prefixed lines, not the hunk's newLines/oldLines. Those two are the
    // size of the changed *region* including its unchanged context, so a one-line
    // edit inside three lines of context reports as seven added and seven removed.
    // The prefixes are the only place the actual change size is recorded.
    const lines = hunk.lines;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) existing.linesAdded++;
        else if (line.startsWith("-")) existing.linesRemoved++;
      }
    } else {
      // Never seen in practice; every recorded hunk carries its lines. Kept as an
      // upper bound rather than a zero, so a shape change shows up as too large a
      // number instead of silently reporting no change at all.
      existing.linesAdded += num(hunk, "newLines");
      existing.linesRemoved += num(hunk, "oldLines");
    }
  }
}

function absorb(
  accumulator: Accumulator,
  record: TranscriptRecord,
  keepTimeline: boolean,
): void {
  const recordType = record.type;

  if (recordType === "ai-title") {
    // Claude Code's own plain-English name for the session. Later records win
    // so a renamed session shows its current name.
    const title = str(record, "aiTitle");
    if (title) accumulator.aiTitle = title;
    return;
  }

  const timestamp = str(record, "timestamp");
  if (timestamp) {
    if (!accumulator.firstTimestamp || timestamp < accumulator.firstTimestamp) {
      accumulator.firstTimestamp = timestamp;
    }
    if (timestamp > accumulator.lastTimestamp) accumulator.lastTimestamp = timestamp;
  }
  if (!accumulator.cwd) accumulator.cwd = str(record, "cwd");
  if (!accumulator.version) accumulator.version = str(record, "version");
  if (!accumulator.gitBranch) accumulator.gitBranch = str(record, "gitBranch");

  const parentUuid = str(record, "parentUuid");
  // Only conversation records count toward a fork. Attachments, mode changes and
  // file-history snapshots all hang off the record they annotate, so counting
  // every child would call almost every turn a branch point: on one real session
  // that produced 121 candidates where exactly 4 were genuine forks, the rest
  // being an attachment sitting alongside the user turn it belongs to.
  if (parentUuid && (recordType === "user" || recordType === "assistant")) {
    tally(accumulator.childCounts, parentUuid);
  }

  const isSidechain = record.isSidechain === true;
  const isMeta = record.isMeta === true;
  const message = asRecord(record.message);
  const content = message ? readContent(message) : { text: "", toolUses: [] };
  let tokens: TokenTotals | null = null;

  if (recordType === "user") {
    accumulator.messageCount++;
    accumulator.userTurns++;
    // A meta record is context the harness injected and a sidechain record
    // belongs to a subagent; neither is something the operator typed, so
    // neither should become the session's name.
    if (!accumulator.firstPrompt && !isMeta && !isSidechain && content.text) {
      accumulator.firstPrompt = content.text;
    }
    const denial = str(record, "toolDenialKind");
    if (denial) tally(accumulator.denials, denial);
    // Edit results ride on the user record that reports the tool's outcome.
    absorbEdit(accumulator, record);
  } else if (recordType === "assistant") {
    accumulator.messageCount++;
    accumulator.assistantTurns++;
    if (message) {
      tally(accumulator.models, str(message, "model"));
      tokens = usageTokens(message);
      if (tokens) addTokens(accumulator.tokens, tokens);
    }
    for (const toolName of content.toolUses) tally(accumulator.tools, toolName);
    tally(accumulator.skills, str(record, "attributionSkill"));
    tally(accumulator.mcpServers, str(record, "attributionMcpServer"));
  } else if (recordType === "system") {
    accumulator.hookInvocations += num(record, "hookCount");
    const hookErrors = record.hookErrors;
    if (Array.isArray(hookErrors) && hookErrors.length > 0) {
      accumulator.hookErrorRecords++;
    }
  }

  if (!keepTimeline) return;
  if (recordType !== "user" && recordType !== "assistant" && recordType !== "system") {
    return;
  }

  const toolCounts = new Map<string, number>();
  for (const toolName of content.toolUses) tally(toolCounts, toolName);

  accumulator.timeline.push({
    uuid: str(record, "uuid"),
    parentUuid: parentUuid || null,
    type: recordType,
    timestamp,
    role: message ? str(message, "role") || null : null,
    model: message ? str(message, "model") || null : null,
    text: content.text.slice(0, TEXT_EXCERPT_CHARS),
    textTruncated: content.text.length > TEXT_EXCERPT_CHARS,
    toolUses: toNamedCounts(toolCounts),
    tokens,
    attributionSkill: str(record, "attributionSkill") || null,
    attributionMcpServer: str(record, "attributionMcpServer") || null,
    isSidechain,
    isMeta,
    denialKind: str(record, "toolDenialKind") || null,
    isBranchPoint: false,
  });
}

function summarize(
  accumulator: Accumulator,
  file: { sessionId: string; projectDir: string; mtimeMs: number; sizeBytes: number },
  skippedLines: number,
): SessionSummary {
  const title = accumulator.aiTitle || accumulator.firstPrompt || file.sessionId;
  const titleSource: SessionSummary["titleSource"] = accumulator.aiTitle
    ? "ai-title"
    : accumulator.firstPrompt
      ? "first-prompt"
      : "session-id";

  return {
    sessionId: file.sessionId,
    projectDir: file.projectDir,
    cwd: accumulator.cwd || decodeProjectDir(file.projectDir),
    cwdSource: accumulator.cwd ? "record" : "decoded",
    // A first-prompt fallback can be a whole paragraph, so trim it to a
    // single-line label; the full text stays visible in the timeline.
    title: title.replace(/\s+/g, " ").trim().slice(0, 140),
    titleSource,
    startedAt: accumulator.firstTimestamp,
    endedAt: accumulator.lastTimestamp,
    version: accumulator.version,
    gitBranch: accumulator.gitBranch,
    messageCount: accumulator.messageCount,
    userTurns: accumulator.userTurns,
    assistantTurns: accumulator.assistantTurns,
    models: toNamedCounts(accumulator.models),
    tokens: accumulator.tokens,
    toolCalls: toNamedCounts(accumulator.tools),
    skills: toNamedCounts(accumulator.skills),
    mcpServers: toNamedCounts(accumulator.mcpServers),
    hookInvocations: accumulator.hookInvocations,
    hookErrorRecords: accumulator.hookErrorRecords,
    toolDenials: toNamedCounts(accumulator.denials),
    skippedLines,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
  };
}

function scan(
  filePath: string,
  keepTimeline: boolean,
): { accumulator: Accumulator; skippedLines: number } {
  const accumulator = newAccumulator();
  let skippedLines = 0;
  for (const line of streamTranscript(filePath)) {
    if (!line.ok) {
      skippedLines++;
      continue;
    }
    absorb(accumulator, line.record, keepTimeline);
  }
  return { accumulator, skippedLines };
}

/**
 * Summaries are memoized on the file's identity, not just its path: a transcript
 * that has been appended to has a different size and mtime, so a stale entry can
 * never be served. This is an in-process cache and nothing more - it holds no
 * data the files do not, and losing it costs one re-read.
 */
const summaryCache = new Map<string, SessionSummary>();

function cacheKey(filePath: string, mtimeMs: number, sizeBytes: number): string {
  return `${filePath}:${mtimeMs}:${sizeBytes}`;
}

export type ListSessionsOptions = {
  /**
   * How many of the newest transcripts to read. Every summary field requires
   * parsing the file, and a real corpus runs to hundreds of megabytes, so the
   * list is bounded by default rather than quietly taking seconds. Ask for more
   * deliberately.
   */
  limit?: number;
  offset?: number;
  /** Substring match against the title, working directory and git branch. */
  q?: string;
};

export function listSessions(
  transcriptsDir: string,
  options: ListSessionsOptions = {},
): SessionSummary[] {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const files = listTranscriptFiles(transcriptsDir).slice(offset, offset + limit);
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    const key = cacheKey(file.filePath, file.mtimeMs, file.sizeBytes);
    const cached = summaryCache.get(key);
    if (cached) {
      summaries.push(cached);
      continue;
    }
    const { accumulator, skippedLines } = scan(file.filePath, false);
    const summary = summarize(accumulator, file, skippedLines);
    summaryCache.set(key, summary);
    summaries.push(summary);
  }

  if (!options.q) return summaries;
  const needle = options.q.toLowerCase();
  return summaries.filter(
    (session) =>
      session.title.toLowerCase().includes(needle) ||
      session.cwd.toLowerCase().includes(needle) ||
      session.gitBranch.toLowerCase().includes(needle),
  );
}

/**
 * One session in full, including its timeline.
 *
 * Returns null for an unknown session or for identifiers that are not plain path
 * segments; the containment check lives in resolveTranscriptPath so a caller
 * cannot reach a file outside the transcript tree by passing traversal in a
 * route parameter.
 */
export function getSession(
  transcriptsDir: string,
  projectDir: string,
  sessionId: string,
): SessionDetail | null {
  const filePath = resolveTranscriptPath(transcriptsDir, projectDir, sessionId);
  if (!filePath) return null;

  let scanned: { accumulator: Accumulator; skippedLines: number };
  try {
    scanned = scan(filePath, true);
  } catch (err) {
    // A named file that is not there is a 404 rather than a broken pillar; a
    // missing transcripts root is still a missing source.
    if (err instanceof SourceMissingError) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const { accumulator, skippedLines } = scanned;
  if (accumulator.timeline.length === 0 && accumulator.messageCount === 0) {
    return null;
  }

  // A record with more than one child is where the conversation forked, which is
  // what a rewind leaves behind in the file.
  for (const entry of accumulator.timeline) {
    if (entry.uuid && (accumulator.childCounts.get(entry.uuid) ?? 0) > 1) {
      entry.isBranchPoint = true;
    }
  }

  const summary = summarize(
    accumulator,
    { sessionId, projectDir, mtimeMs: 0, sizeBytes: 0 },
    skippedLines,
  );

  const touchedFiles = [...accumulator.touched.values()].sort(
    (a, b) => b.edits - a.edits || a.path.localeCompare(b.path),
  );

  return {
    ...summary,
    timeline: accumulator.timeline,
    filePath,
    touchedFiles,
    blastRadius: {
      files: touchedFiles.length,
      edits: touchedFiles.reduce((sum, file) => sum + file.edits, 0),
      linesAdded: touchedFiles.reduce((sum, file) => sum + file.linesAdded, 0),
      linesRemoved: touchedFiles.reduce((sum, file) => sum + file.linesRemoved, 0),
      filesUserModified: touchedFiles.filter((file) => file.userModified).length,
    },
  };
}

/**
 * Totals across the newest `limit` sessions.
 *
 * Deliberately not a whole-corpus figure: it reports how many sessions it read
 * so a reader never mistakes a bounded sample for a lifetime total. Cost in
 * dollars is absent on purpose, because deriving it needs a pricing table this
 * tool will not fetch at runtime.
 */
export function sessionTotals(
  transcriptsDir: string,
  limit = 30,
): {
  sessionsScanned: number;
  tokens: TokenTotals;
  models: NamedCount[];
  toolCalls: NamedCount[];
  skills: NamedCount[];
  mcpServers: NamedCount[];
  toolDenials: NamedCount[];
  hookInvocations: number;
  skippedLines: number;
} {
  const sessions = listSessions(transcriptsDir, { limit });
  const tokens = emptyTokens();
  const models = new Map<string, number>();
  const tools = new Map<string, number>();
  const skills = new Map<string, number>();
  const mcpServers = new Map<string, number>();
  const denials = new Map<string, number>();
  let hookInvocations = 0;
  let skippedLines = 0;

  const merge = (into: Map<string, number>, from: NamedCount[]): void => {
    for (const item of from) {
      into.set(item.name, (into.get(item.name) ?? 0) + item.count);
    }
  };

  for (const session of sessions) {
    addTokens(tokens, session.tokens);
    merge(models, session.models);
    merge(tools, session.toolCalls);
    merge(skills, session.skills);
    merge(mcpServers, session.mcpServers);
    merge(denials, session.toolDenials);
    hookInvocations += session.hookInvocations;
    skippedLines += session.skippedLines;
  }

  return {
    sessionsScanned: sessions.length,
    tokens,
    models: toNamedCounts(models),
    toolCalls: toNamedCounts(tools),
    skills: toNamedCounts(skills),
    mcpServers: toNamedCounts(mcpServers),
    toolDenials: toNamedCounts(denials),
    hookInvocations,
    skippedLines,
  };
}
