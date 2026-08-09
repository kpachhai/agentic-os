import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";
import {
  decodeProjectDir,
  listSubagentTranscriptFiles,
  type SubagentSkips,
  listTranscriptFiles,
  scanCached,
  streamTranscript,
  type SubagentTranscriptFile,
  type TranscriptFile,
  type TranscriptRecord,
} from "./transcripts.js";

/**
 * What work the operator handed to subagents, and what that work produced.
 *
 * Under-delegation leaves no trace. A session that did everything itself and a
 * session that farmed half of it out look identical from the outside, so the
 * question "am I actually handing work off?" has had no local answer. Every
 * dispatch, though, is a tool call written into the session transcript that made
 * it, so counting those calls - per specialist, per project, per month - is real
 * evidence of a habit that is otherwise invisible.
 *
 * Two sides, never mixed. A dispatch is a request: it says which specialist was
 * asked, how long the briefing was, and what the launch turned out to be. A
 * subagent transcript is what came back: the records that delegated run wrote, its
 * tool calls, its output tokens, and how long it was alive. Those two disagree in
 * both directions on a real machine - a dispatch can leave no transcript, and a
 * transcript can sit beside a session that recorded no dispatch - so they are
 * reported in separately named fields and the disagreement is itself a figure.
 *
 * Prompt and description text never leaves this module. A dispatch prompt is the
 * operator's own prose about their own work, and a length answers "how much
 * briefing did this take" without reproducing any of it. The same holds for the
 * delegated side: records, tokens, tool calls and durations are counted, and no
 * subagent's words are read out.
 */

/**
 * Tool names known to dispatch a subagent.
 *
 * Both are accepted because the name is not stable across installs: every dispatch
 * recorded on this machine is named "Agent", while "Task" is the name the same call
 * carries elsewhere. That is why the name is only half of the test below.
 */
const DISPATCH_TOOL_NAMES = new Set(["Task", "Agent"]);

/**
 * Stands in for a value the record did not carry - a dispatch that named no
 * specialist, or a call with no tool name. The dispatch still happened, so it is
 * labelled rather than dropped.
 */
const UNSPECIFIED_TYPE = "(unspecified)";

/**
 * Stands in for a subagent transcript that names no specialist anywhere in the
 * file. Its records are real delegated work, so folding them into a specialist
 * that may not have done them would be worse than labelling them; the count of
 * such files is reported too.
 */
const UNATTRIBUTED_TYPE = "(unattributed)";

/**
 * The field a subagent record names its specialist in. Present on the model turns
 * of a delegated run, which is enough to attribute the whole file: one transcript
 * is one run by one specialist.
 */
const ATTRIBUTION_FIELD = "attributionAgent";

/**
 * Result statuses that mean the run was launched detached, and the one that means
 * it ran to completion inline while the caller waited.
 *
 * This is the only trustworthy evidence of launch mode. The request's own
 * background parameter is opt-out, so its absence means detached, and reading
 * absence as "ran inline" reported 17 of 60 dispatches as detached on this machine
 * where the paired results say 52. The status vocabulary can grow, so an
 * unrecognised value is reported rather than bucketed to either side.
 */
const DETACHED_LAUNCH_STATUSES = new Set(["async_launched", "teammate_spawned"]);
const INLINE_LAUNCH_STATUSES = new Set(["completed"]);

/**
 * Directory names in the nested layout beside a session. A *.jsonl under
 * "subagents" is a delegated run; one under a further "workflows" level belongs to
 * an agent an orchestration script spawned rather than a dispatch tool call.
 */
const SUBAGENT_DIR = "subagents";
const WORKFLOW_DIR = "workflows";

/**
 * Most month buckets the trend may contain, counting back from the month it was
 * read in.
 *
 * A bound is needed because a bucket per calendar month between the first and last
 * dispatch makes the response size a function of one record's content: a single
 * parseable-but-absurd timestamp ("0001-02-03") produced 24306 buckets and an
 * 850 KB payload from a two-dispatch corpus. Ten years of monthly buckets is more
 * history than any Claude Code install has, and what falls outside the window is
 * counted rather than dropped in silence.
 */
const MAX_TREND_MONTHS = 120;

export type DelegationProjectUse = {
  /** Encoded transcript directory name, which is how the corpus addresses it. */
  projectDir: string;
  /** Display form of the same directory; not a usable filesystem path. */
  label: string;
  dispatches: number;
};

/**
 * What a specialist's delegated runs actually produced, read from the subagent
 * transcripts themselves rather than inferred from the dispatch.
 */
export type DelegatedWork = {
  /** Subagent transcripts attributed to this specialist. */
  transcripts: number;
  /** Mainline sessions those transcripts sit beside, by owning session id. */
  owningSessions: number;
  records: number;
  /** tool_use blocks in those records: what the delegated run did, not asked for. */
  toolCalls: number;
  /**
   * Output tokens summed from the usage blocks that carry one, or null when none
   * did. Zero would read as a run that wrote nothing, which is a different claim
   * from a run whose records carry no usage.
   */
  outputTokens: number | null;
  /** How many records carried a usage block, so a thin denominator is visible. */
  recordsWithUsage: number;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  /**
   * First to last record within each transcript, summed over them. A sum of spans
   * rather than one span across all of them: the outer range covers months of
   * calendar time, where this answers how long the runs themselves were alive.
   */
  wallClockMs: number | null;
  /** Transcripts with fewer than two usable timestamps, so no span exists. */
  transcriptsWithoutSpan: number;
};

export type SubagentDelegation = {
  /** `subagent_type` exactly as recorded, "(unspecified)", or "(unattributed)". */
  subagentType: string;
  dispatches: number;
  /** Projects the specialist was dispatched in, busiest first. */
  projects: DelegationProjectUse[];
  /** Distinct sessions that dispatched it. */
  sessions: number;
  firstDispatchAt: string | null;
  lastDispatchAt: string | null;
  /** Dispatches that named a model instead of inheriting the caller's. */
  modelOverrides: number;
  /** The distinct models those dispatches asked for, sorted. */
  modelsRequested: string[];
  /**
   * Dispatches whose paired result recorded a detached launch. Read from the
   * result and not from the request, because the request's flag is opt-out.
   */
  backgroundDispatches: number;
  /** Dispatches whose paired result recorded an inline run the caller waited for. */
  inlineDispatches: number;
  /**
   * Dispatches with no paired result, or one whose status this module does not
   * recognise. Reported rather than counted as inline: the three add up to
   * `dispatches`, so a guess is never hiding inside either side.
   */
  launchModeUnknownDispatches: number;
  /** Dispatches that asked for an isolated worktree, meaning they write files. */
  worktreeIsolatedDispatches: number;
  /**
   * Median length of the briefing, in characters - a length, never the text. An
   * observed value rather than an average of two, so the number is one real
   * dispatch's size.
   */
  medianPromptChars: number | null;
  /** Dispatches whose record carried no prompt string, so no length exists. */
  promptCharsMissing: number;
  /**
   * What this specialist's delegated runs produced, or null when no subagent
   * transcript is attributed to it. Null is not "produced nothing": a detached run
   * whose transcript was deleted, and a teammate that writes its own session
   * elsewhere, both leave a dispatch with nothing on disk to show for it.
   */
  delegatedWork: DelegatedWork | null;
};

export type DelegationTotals = {
  dispatches: number;
  /** Distinct specialists that were dispatched, whatever they produced. */
  subagentTypes: number;
  projects: number;
  sessions: number;
  modelOverrides: number;
  /** Detached, inline and unknown add up to `dispatches`; see the row fields. */
  backgroundDispatches: number;
  inlineDispatches: number;
  launchModeUnknownDispatches: number;
  worktreeIsolatedDispatches: number;
  firstDispatchAt: string | null;
  lastDispatchAt: string | null;
  medianPromptChars: number | null;
  /** Result side. Named apart from the dispatch figures because they disagree. */
  delegatedTranscripts: number;
  delegatedRecords: number;
  delegatedToolCalls: number;
  delegatedOutputTokens: number | null;
  delegatedWallClockMs: number | null;
  /** Mainline sessions that have delegated work on disk beside them. */
  sessionsWithDelegatedWork: number;
};

export type DelegationMonth = {
  /** Calendar month in UTC, "YYYY-MM". */
  month: string;
  dispatches: number;
};

/**
 * The measurements behind the limitation wording, so a reader can check it rather
 * than take it on trust, and so a fork whose corpus differs gets its own numbers
 * instead of this machine's assumptions.
 */
export type DelegationEvidence = {
  sessionTranscriptsScanned: number;
  sessionRecordsRead: number;
  /** Lines that could not be parsed; a live session's torn last line is normal. */
  unparseableLines: number;
  /**
   * Transcripts that were gone before a single byte was read. A live Claude Code
   * process can rotate a file between the listing and the read, and this scan
   * touches every transcript on the machine, so it happens. Counted rather than
   * hidden: a dispatch inside a file that vanished is missing from the totals.
   */
  transcriptsVanishedDuringScan: number;
  /**
   * Transcripts that changed under the reader after it had already read part of
   * them, so the read stopped early with no error to catch.
   *
   * This is the loss that used to be invisible. The line reader reopens the file
   * per chunk and stops, without raising, once the file is gone, so a transcript
   * deleted after its first chunk looks exactly like a short file: on a real
   * reproduction half the records and one of two dispatches disappeared while
   * every counter still read as complete. How many records were missed cannot be
   * known, which is why the count is of files and the limitation says so.
   */
  transcriptsTruncatedMidScan: number;
  /** Tool names the dispatches were recorded under, for cross-install drift. */
  toolNames: string[];
  /**
   * Dispatch records seen more than once and counted once. A forked or resumed
   * session can replay earlier records, and counting a replay as a second
   * dispatch would inflate the only figure this pillar exists to report. The copy
   * that is kept is the one in the most recently modified transcript.
   */
  duplicateDispatchRecordsIgnored: number;
  /** Dispatches with no usable timestamp; the monthly trend cannot see these. */
  dispatchesWithoutTimestamp: number;
  /**
   * What the requests asked for, kept apart from what the launches did. The gap
   * between these and `backgroundDispatches` is the whole reason launch mode is
   * read from the result: absence of the flag is not a request to run inline.
   */
  dispatchesRequestingBackgroundExplicitly: number;
  dispatchesRequestingInlineExplicitly: number;
  dispatchesWithNoBackgroundFlag: number;
  /** Every launch status seen on a paired result, commonest first. */
  dispatchOutcomeStatuses: Array<{ status: string; dispatches: number }>;
  /** Dispatches no result record answered, whose launch mode stays unknown. */
  dispatchesWithoutPairedResult: number;
  /**
   * Dispatches whose result named an agent id that a subagent transcript on disk
   * also carries, and those where no such file exists. The second number is the
   * dispatch side and the result side disagreeing, which is worth reporting.
   */
  dispatchesWithMatchingSubagentTranscript: number;
  dispatchesWithoutMatchingSubagentTranscript: number;
  /**
   * Records in the session transcripts marked as subagent traffic, how many carry
   * that marker at all, and how many carry no marker either way. The third number
   * exists because a claim about the first two only covers the records that
   * actually said something.
   */
  sidechainRecordsInSessionTranscripts: number;
  recordsCarryingSidechainFlag: number;
  sessionRecordsWithoutSidechainFlag: number;
  /** Subagent transcript files found in the nested directories beside sessions. */
  subagentTranscriptFiles: number;
  /**
   * The subset of those belonging to agents an orchestration script spawned rather
   * than a dispatch tool call. Those runs are a second delegation channel, so they
   * appear in the delegated-work figures with no dispatch to pair with.
   */
  workflowAgentTranscriptFiles: number;
  subagentTranscriptsRead: number;
  subagentRecordsRead: number;
  subagentUnparseableLines: number;
  /** Delegated records that carry the subagent marker, as a cross-check. */
  subagentRecordsMarkedSidechain: number;
  /** Read files that name no specialist, reported under "(unattributed)". */
  subagentTranscriptsWithoutAgentType: number;
  /** Read files whose records name more than one specialist; the first one wins. */
  subagentTranscriptsWithMixedAgentType: number;
  subagentTranscriptsVanishedDuringScan: number;
  subagentTranscriptsTruncatedMidScan: number;
  /**
   * Files nested beside a session that are not delegated runs, so they are not
   * read. They sit outside the subagents directory and hold a different kind of
   * log; counting them keeps the skip visible.
   */
  nestedFilesNotSubagentTranscripts: number;
  /**
   * Sibling directories the shared reader declined to walk because their name is
   * not a session id. A plugin writes its own hook log beside the transcripts, and
   * reading one as delegated work invented an owning session named for the plugin.
   */
  directoriesNotNamedForASession: number;
  subagentDirectoriesUnreadable: number;
  subagentDirectoriesBeyondWalkDepth: number;
  subagentSymlinksNotFollowed: number;
  /**
   * Subagent transcripts whose owning session recorded no dispatch at all. The
   * other direction of the same disagreement, and how an orchestration script's
   * agents show up.
   */
  subagentTranscriptsWhoseOwnerSessionNeverDispatched: number;
  /**
   * Dispatch calls recorded inside the delegated transcripts themselves, which is
   * a subagent handing work on again. Not in the dispatch figures above, which are
   * about what a mainline session handed off, and not dropped either.
   */
  dispatchesInsideDelegatedWork: number;
  /** The month the trend's zero-fill runs to, which is the month it was read in. */
  trendThroughMonth: string | null;
  /** Bucket cap, and what the cap and the read month between them left out. */
  trendMonthCap: number;
  trendMonthsOmitted: number;
  dispatchesBeforeTrendWindow: number;
  dispatchesAfterTrendWindow: number;
};

export type DelegationReport = {
  /** Busiest specialist first. */
  bySubagentType: SubagentDelegation[];
  totals: DelegationTotals;
  /**
   * Oldest month first, with quiet months present as zero so a gap reads as one,
   * and running to the month it was read in so a stretch of silence at the end
   * cannot draw as a live bar. Bounded; see MAX_TREND_MONTHS and the evidence.
   */
  byMonth: DelegationMonth[];
  evidence: DelegationEvidence;
  /** What these numbers do not say. Rendered, not just commented. */
  limitation: string;
};

/** One dispatch, kept only long enough to aggregate it. */
type Dispatch = {
  subagentType: string;
  projectDir: string;
  sessionId: string;
  /** Epoch milliseconds, or null when the record carried no usable timestamp. */
  atMs: number | null;
  promptChars: number | null;
  requestedModel: string | null;
  /**
   * The request's background flag as recorded, or null when it carried none. Kept
   * as three states on purpose: it is a statement of intent and not of outcome, so
   * it is reported next to the launch mode rather than standing in for it.
   */
  requestedBackground: boolean | null;
  worktreeIsolated: boolean;
  toolName: string;
  /** tool_use id, or null when the record carried none; how a result is paired. */
  toolUseId: string | null;
};

/** What the paired tool result said happened to a dispatch. */
type DispatchOutcome = {
  status: string | null;
  /** The result's own statement of asynchrony, used when the status is unfamiliar. */
  isAsync: boolean | null;
  /** Agent id the run was given, which is what its subagent transcript carries. */
  agentId: string | null;
};

type LaunchMode = "detached" | "inline" | "unknown";

type ToolUseBlock = {
  type?: unknown;
  name?: unknown;
  id?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(input: Record<string, unknown>, key: string): boolean | null {
  const value = input[key];
  return typeof value === "boolean" ? value : null;
}

function readFiniteNumber(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The dispatch's input object, or null when the block is not a dispatch.
 *
 * Two independent tests, because either half of the shape can drift. An input
 * carrying a `subagent_type` is a dispatch whatever the call is named, and a call
 * with a known dispatch name counts even if it records no type. Reporting "no
 * delegation" because the tool was renamed would be the one wrong answer this
 * pillar must not give, so it over-collects rather than under-collects; the tool
 * names it actually matched are reported alongside the counts.
 */
function dispatchInput(block: ToolUseBlock): Record<string, unknown> | null {
  if (block.type !== "tool_use") return null;
  const input = asRecord(block.input);
  if (input && typeof input.subagent_type === "string") return input;
  if (typeof block.name === "string" && DISPATCH_TOOL_NAMES.has(block.name)) {
    return input ?? {};
  }
  return null;
}

/**
 * Epoch milliseconds from a record's timestamp, or null.
 *
 * Parsed rather than string-sliced so a month bucket is never read out of a
 * string that only looks like a date, and null rather than now, because stamping
 * an undated dispatch with the current time would put it in this month's column.
 */
function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Nearest-rank median: the value at the midpoint of the sorted list, never an
 * average of two neighbours. Every length reported is therefore a length some
 * dispatch really had.
 */
function medianOf(sortedValues: number[]): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.floor(sortedValues.length / 2)] ?? null;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Whether a transcript changed under the reader while it was being read.
 *
 * The line reader reopens the file for each chunk and stops, without raising, once
 * the file is gone, so a transcript deleted after its first chunk ends the read
 * early and is indistinguishable from a short file. Comparing the file as it was
 * listed against the file as it is now is the only signal left afterwards, so a
 * file that has disappeared or shrunk since it was listed is reported as
 * possibly-truncated. A file that grew is not: a live session appends to its own
 * transcript while this reads, and a prefix of a growing file is a complete read
 * of everything that existed when it was listed.
 *
 * Deliberately conservative. A file deleted after its last chunk was read lost
 * nothing yet still counts here, because nothing on disk can tell that case from
 * the one that lost half its records.
 */
function readMayHaveStoppedShort(filePath: string, listedSizeBytes: number): boolean {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat) return true;
  return stat.size < listedSizeBytes;
}

/** Accumulator for one subagent type's dispatches, before it becomes a report row. */
type TypeAccumulator = {
  dispatches: number;
  projects: Map<string, number>;
  sessions: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  modelOverrides: number;
  models: Set<string>;
  detached: number;
  inline: number;
  launchModeUnknown: number;
  worktreeIsolated: number;
  promptChars: number[];
  promptCharsMissing: number;
};

function newAccumulator(): TypeAccumulator {
  return {
    dispatches: 0,
    projects: new Map(),
    sessions: new Set(),
    firstMs: null,
    lastMs: null,
    modelOverrides: 0,
    models: new Set(),
    detached: 0,
    inline: 0,
    launchModeUnknown: 0,
    worktreeIsolated: 0,
    promptChars: [],
    promptCharsMissing: 0,
  };
}

function absorb(
  accumulator: TypeAccumulator,
  dispatch: Dispatch,
  mode: LaunchMode,
): void {
  accumulator.dispatches++;
  accumulator.projects.set(
    dispatch.projectDir,
    (accumulator.projects.get(dispatch.projectDir) ?? 0) + 1,
  );
  accumulator.sessions.add(dispatch.sessionId);
  if (dispatch.atMs !== null) {
    accumulator.firstMs =
      accumulator.firstMs === null
        ? dispatch.atMs
        : Math.min(accumulator.firstMs, dispatch.atMs);
    accumulator.lastMs =
      accumulator.lastMs === null
        ? dispatch.atMs
        : Math.max(accumulator.lastMs, dispatch.atMs);
  }
  if (dispatch.requestedModel !== null) {
    accumulator.modelOverrides++;
    accumulator.models.add(dispatch.requestedModel);
  }
  if (mode === "detached") accumulator.detached++;
  else if (mode === "inline") accumulator.inline++;
  else accumulator.launchModeUnknown++;
  if (dispatch.worktreeIsolated) accumulator.worktreeIsolated++;
  if (dispatch.promptChars === null) accumulator.promptCharsMissing++;
  else accumulator.promptChars.push(dispatch.promptChars);
}

/** Read one dispatch out of a tool_use block, given where it was found. */
function toDispatch(
  block: ToolUseBlock,
  input: Record<string, unknown>,
  where: { projectDir: string; sessionId: string; atMs: number | null },
): Dispatch {
  const prompt = input.prompt;
  const isolation = readString(input, "isolation");
  return {
    subagentType: readString(input, "subagent_type") ?? UNSPECIFIED_TYPE,
    projectDir: where.projectDir,
    sessionId: where.sessionId,
    atMs: where.atMs,
    // A missing prompt reports as absent, not as zero: zero characters would
    // read as an empty briefing, which is a different claim.
    promptChars: typeof prompt === "string" ? prompt.length : null,
    requestedModel: readString(input, "model"),
    requestedBackground: readBoolean(input, "run_in_background"),
    worktreeIsolated: isolation !== null && isolation.toLowerCase() === "worktree",
    toolName: typeof block.name === "string" ? block.name : UNSPECIFIED_TYPE,
    toolUseId: typeof block.id === "string" && block.id.length > 0 ? block.id : null,
  };
}

/**
 * Everything the pass over the session transcripts accumulates.
 *
 * One bag of counters rather than a return value per transcript, because the same
 * records that carry dispatches carry the evidence the limitation wording is built
 * from, and reading them twice would double the cost of the pillar for no extra
 * answer.
 *
 * Dispatches are held as a list rather than folded as they are found: a dispatch's
 * launch mode lives in a different record, which a replayed or resumed session can
 * put anywhere in the corpus, so the fold waits until every result has been seen.
 * That is a list of one small object per dispatch, and the deduplicating id set was
 * already the same order of magnitude.
 */
type SessionScanState = {
  dispatches: Dispatch[];
  /** Tool-call ids already counted, which is how a replayed record is caught. */
  seenDispatchIds: Set<string>;
  /** Launch outcome per dispatch tool-call id, from the paired result record. */
  outcomes: Map<string, DispatchOutcome>;
  duplicates: number;
  transcriptsScanned: number;
  recordsRead: number;
  unparseableLines: number;
  sidechainRecords: number;
  recordsWithSidechainFlag: number;
  vanished: number;
  truncated: number;
};

function newSessionScanState(): SessionScanState {
  return {
    dispatches: [],
    seenDispatchIds: new Set(),
    outcomes: new Map(),
    duplicates: 0,
    transcriptsScanned: 0,
    recordsRead: 0,
    unparseableLines: 0,
    sidechainRecords: 0,
    recordsWithSidechainFlag: 0,
    vanished: 0,
    truncated: 0,
  };
}

/**
 * One tool result that could belong to a dispatch, as the file recorded it.
 *
 * Kept as an ordered list of candidates rather than as a decided outcome, because
 * whether a result belongs to a dispatch is not a property of the file it sits in.
 * Naming an agent settles it locally; otherwise the only evidence is that the
 * tool-call id was dispatched, and the dispatch may be in an earlier transcript.
 * A per-file scan that resolved this on its own would drop exactly those outcomes.
 *
 * Two admission routes, and both are needed. Naming an agent is what makes a
 * result a dispatch's result: a backgrounded shell command reports the same async
 * status and there are more of those than there are dispatches. Already knowing
 * the tool-call id is the second route, for an install that stops writing the
 * agent id but still answers the call.
 *
 * Results that can never be admitted - no agent id and no status - are not
 * recorded at all, which is what keeps this list near the size of the outcomes it
 * can produce rather than the size of every tool result in the transcript.
 */
type ScannedResult = {
  toolUseId: string;
  status: string | null;
  isAsync: boolean | null;
  agentId: string | null;
  /** True when this same file already carried the dispatch for this id, above. */
  pairedInFile: boolean;
};

/**
 * Everything one session transcript contributes, with nothing about the rest of
 * the corpus folded in.
 *
 * Deduplication and result pairing both need state that spans files, so neither is
 * settled here: the dispatch list is deduplicated only against this file, and the
 * results carry the evidence the fold needs instead of a verdict. `truncated` is
 * decided here rather than in the fold because it is a statement about the read
 * that produced these records, and re-deciding it on a warm call would make the
 * counter describe the cache instead of the read.
 */
type ScannedSession = {
  dispatches: Dispatch[];
  results: ScannedResult[];
  /** Ids this file dispatched twice; ids an earlier file already had are the fold's. */
  duplicates: number;
  recordsRead: number;
  unparseableLines: number;
  sidechainRecords: number;
  recordsWithSidechainFlag: number;
  truncated: boolean;
};

/** Identifies this module's session scans in the shared per-file cache. */
const EXTRACTOR_ID = "delegation-session";

/**
 * Read one session transcript into a summary of what it holds.
 *
 * Dispatches ride in the content array of the record that made the call, and the
 * result of one rides in the content array of the record that answered it. Every
 * record type is examined rather than only the assistant turn, because the same
 * call can be replayed under another type; deduplicating by tool-call id is what
 * makes looking that wide safe.
 *
 * The project and session this file belongs to are passed in rather than looked
 * up, and they are safe to bake into the cached value because both are fixed by
 * the file's own path.
 */
function scanSessionFile(
  filePath: string,
  where: { sizeBytes: number; projectDir: string; sessionId: string },
): ScannedSession {
  const dispatches: Dispatch[] = [];
  const results: ScannedResult[] = [];
  const seenInFile = new Set<string>();
  let duplicates = 0;
  let recordsRead = 0;
  let unparseableLines = 0;
  let sidechainRecords = 0;
  let recordsWithSidechainFlag = 0;

  for (const line of streamTranscript(filePath)) {
    if (!line.ok) {
      unparseableLines++;
      continue;
    }
    const record = line.record;
    recordsRead++;
    if (record.isSidechain !== undefined) recordsWithSidechainFlag++;
    if (record.isSidechain === true) sidechainRecords++;

    const message = asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const raw of content) {
      const asBlock = asRecord(raw);
      if (!asBlock) continue;
      const block = asBlock as ToolUseBlock;

      if (block.type === "tool_result") {
        const toolUseId = block.tool_use_id;
        if (typeof toolUseId !== "string" || toolUseId.length === 0) continue;
        const result = asRecord(record.toolUseResult);
        if (!result) continue;
        const agentId =
          readString(result, "agentId") ?? readString(result, "agent_id");
        const status = readString(result, "status");
        // Neither piece of evidence, so no admission route can ever apply to it.
        if (agentId === null && status === null) continue;
        results.push({
          toolUseId,
          status,
          isAsync: readBoolean(result, "isAsync"),
          agentId,
          pairedInFile: seenInFile.has(toolUseId),
        });
        continue;
      }

      const input = dispatchInput(block);
      if (!input) continue;

      const id = block.id;
      if (typeof id === "string" && id.length > 0) {
        if (seenInFile.has(id)) {
          duplicates++;
          continue;
        }
        seenInFile.add(id);
      }

      dispatches.push(
        toDispatch(block, input, {
          projectDir: where.projectDir,
          sessionId: where.sessionId,
          atMs: timestampMs(record.timestamp),
        }),
      );
    }
  }

  return {
    dispatches,
    results,
    duplicates,
    recordsRead,
    unparseableLines,
    sidechainRecords,
    recordsWithSidechainFlag,
    truncated: readMayHaveStoppedShort(filePath, where.sizeBytes),
  };
}

/**
 * Fold one scanned transcript into the corpus-wide state.
 *
 * Results are resolved before this file's own dispatch ids are added, and that
 * order is the whole point. A result is paired by a dispatch that came earlier -
 * earlier in this file, which `pairedInFile` already records, or in a file already
 * folded, which the shared id set records. A dispatch further down this same file
 * must not pair it, because the sequential read this replaces could not have seen
 * it yet.
 */
function foldScannedSession(scanned: ScannedSession, state: SessionScanState): void {
  // Read off the scan, never incremented where the file is read: every number here
  // has to be the same on a warm call as on a cold one.
  state.recordsRead += scanned.recordsRead;
  state.unparseableLines += scanned.unparseableLines;
  state.sidechainRecords += scanned.sidechainRecords;
  state.recordsWithSidechainFlag += scanned.recordsWithSidechainFlag;
  state.duplicates += scanned.duplicates;

  for (const result of scanned.results) {
    if (state.outcomes.has(result.toolUseId)) continue;
    const paired = result.pairedInFile || state.seenDispatchIds.has(result.toolUseId);
    if (result.agentId === null && !paired) continue;
    state.outcomes.set(result.toolUseId, {
      status: result.status,
      isAsync: result.isAsync,
      agentId: result.agentId,
    });
  }

  for (const dispatch of scanned.dispatches) {
    if (dispatch.toolUseId !== null) {
      if (state.seenDispatchIds.has(dispatch.toolUseId)) {
        state.duplicates++;
        continue;
      }
      state.seenDispatchIds.add(dispatch.toolUseId);
    }
    state.dispatches.push(dispatch);
  }
}

/**
 * Read one session transcript into the scan state.
 *
 * A transcript that disappears before the first byte is read is counted and
 * skipped: a live Claude Code process rotates these files, and this scan touches
 * every one on the machine, so a vanished file is expected traffic rather than a
 * fault worth failing the whole pillar over. Every other read failure stays loud,
 * because a permission problem or an unreadable disk is a real fault and a pillar
 * that quietly reported fewer dispatches would be answering a different question.
 *
 * A file that disappears after the first byte raises nothing at all, so it is
 * checked for by `truncated` inside the scan rather than caught.
 */
function scanTranscript(file: TranscriptFile, state: SessionScanState): void {
  state.transcriptsScanned++;
  const scanned = scanCached(file, EXTRACTOR_ID, (filePath) =>
    scanSessionFile(filePath, {
      sizeBytes: file.sizeBytes,
      projectDir: file.projectDir,
      sessionId: file.sessionId,
    }),
  );
  if (scanned === null) {
    state.vanished++;
    console.warn(
      `delegation: ${file.filePath} was gone before any of it could be read; its dispatches ` +
        `are not counted`,
    );
    return;
  }
  if (scanned.truncated) {
    state.truncated++;
    console.warn(
      `delegation: ${file.filePath} changed while it was being read; the read may have ` +
        `stopped early and any dispatches past that point are not counted`,
    );
  }
  foldScannedSession(scanned, state);
}

/** Accumulator for one subagent type's delegated work. */
type SubagentAccumulator = {
  transcripts: number;
  owners: Set<string>;
  records: number;
  toolCalls: number;
  outputTokens: number;
  recordsWithUsage: number;
  firstMs: number | null;
  lastMs: number | null;
  wallClockMs: number;
  transcriptsWithSpan: number;
  transcriptsWithoutSpan: number;
};

function newSubagentAccumulator(): SubagentAccumulator {
  return {
    transcripts: 0,
    owners: new Set(),
    records: 0,
    toolCalls: 0,
    outputTokens: 0,
    recordsWithUsage: 0,
    firstMs: null,
    lastMs: null,
    wallClockMs: 0,
    transcriptsWithSpan: 0,
    transcriptsWithoutSpan: 0,
  };
}

/** One subagent transcript's own figures, before they join a specialist's row. */
type SubagentFileTally = {
  records: number;
  toolCalls: number;
  outputTokens: number;
  recordsWithUsage: number;
  firstMs: number | null;
  lastMs: number | null;
  attributedType: string | null;
  mixedAttribution: boolean;
  sidechainRecords: number;
  unparseableLines: number;
  agentIds: Set<string>;
  /** Dispatch calls the delegated run made itself, handing work on again. */
  nestedDispatches: number;
  /**
   * Whether the read may have stopped early. Decided with the rest of the scan
   * rather than by the fold, because it is a statement about the read that
   * produced these records; deciding it again on a warm call would make the
   * counter describe the cache instead of the read.
   */
  truncated: boolean;
};

type SubagentScanState = {
  byType: Map<string, SubagentAccumulator>;
  /** Agent ids seen inside the delegated records, for pairing with a dispatch. */
  agentIds: Set<string>;
  owners: Set<string>;
  filesFound: number;
  workflowFiles: number;
  transcriptsRead: number;
  recordsRead: number;
  unparseableLines: number;
  sidechainRecords: number;
  withoutAttribution: number;
  mixedAttribution: number;
  vanished: number;
  truncated: number;
  nestedNonSubagentFiles: number;
  nestedDispatches: number;
  /** What the shared reader itself declined to walk, before this scan saw a file. */
  readerSkips: SubagentSkips;
};

function newSubagentScanState(): SubagentScanState {
  return {
    byType: new Map(),
    agentIds: new Set(),
    owners: new Set(),
    filesFound: 0,
    workflowFiles: 0,
    transcriptsRead: 0,
    recordsRead: 0,
    unparseableLines: 0,
    sidechainRecords: 0,
    withoutAttribution: 0,
    mixedAttribution: 0,
    vanished: 0,
    truncated: 0,
    nestedNonSubagentFiles: 0,
    readerSkips: {
      nonSessionDirectories: 0,
      symlinks: 0,
      unreadableDirectories: 0,
      directoriesBeyondDepth: 0,
    },
    nestedDispatches: 0,
  };
}

/**
 * Count the tool_use blocks and the reported output tokens of one record.
 *
 * A dispatch call found here is a subagent handing work on again, which is a third
 * delegation channel. It is counted under its own name rather than added to the
 * dispatch figures, which describe what an operator handed off from a mainline
 * session, and rather than passed over, which would leave a real handoff in no
 * count at all.
 */
function readDelegatedTurn(record: TranscriptRecord, tally: SubagentFileTally): void {
  const message = asRecord(record.message);
  if (!message) return;
  const usage = asRecord(message.usage);
  if (usage) {
    const output = readFiniteNumber(usage, "output_tokens");
    if (output !== null) {
      tally.outputTokens += output;
      tally.recordsWithUsage++;
    }
  }
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block || block.type !== "tool_use") continue;
    tally.toolCalls++;
    if (dispatchInput(block as ToolUseBlock)) tally.nestedDispatches++;
  }
}

/**
 * Read one subagent transcript into a tally of its own.
 *
 * Per file rather than per record because a transcript is one run by one
 * specialist: the specialist is named on the model turns and nowhere else, so
 * attributing the file lets the run's own tool results and attachments count as
 * that specialist's work too.
 *
 * The tally is already everything the file contributes and nothing about the rest
 * of the corpus, which is what makes it cacheable as it stands. The one thing that
 * had to move out is the vanished and truncated counting: those belong to the
 * fold, or a warm call would report the read it did not do.
 */
function scanSubagentTranscript(
  filePath: string,
  listedSizeBytes: number,
): SubagentFileTally {
  const tally: SubagentFileTally = {
    records: 0,
    toolCalls: 0,
    outputTokens: 0,
    recordsWithUsage: 0,
    firstMs: null,
    lastMs: null,
    attributedType: null,
    mixedAttribution: false,
    sidechainRecords: 0,
    unparseableLines: 0,
    agentIds: new Set(),
    nestedDispatches: 0,
    truncated: false,
  };

  for (const line of streamTranscript(filePath)) {
    if (!line.ok) {
      tally.unparseableLines++;
      continue;
    }
    const record = line.record;
    tally.records++;
    if (record.isSidechain === true) tally.sidechainRecords++;
    const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
    if (agentId.length > 0) tally.agentIds.add(agentId);
    const attributed =
      typeof record[ATTRIBUTION_FIELD] === "string"
        ? (record[ATTRIBUTION_FIELD] as string).trim()
        : "";
    if (attributed.length > 0) {
      if (tally.attributedType === null) tally.attributedType = attributed;
      else if (tally.attributedType !== attributed) tally.mixedAttribution = true;
    }
    const atMs = timestampMs(record.timestamp);
    if (atMs !== null) {
      tally.firstMs = tally.firstMs === null ? atMs : Math.min(tally.firstMs, atMs);
      tally.lastMs = tally.lastMs === null ? atMs : Math.max(tally.lastMs, atMs);
    }
    readDelegatedTurn(record, tally);
  }

  tally.truncated = readMayHaveStoppedShort(filePath, listedSizeBytes);
  return tally;
}

/** Identifies the subagent scans in the shared per-file cache. */
const SUBAGENT_EXTRACTOR_ID = "delegation-subagent";

function foldSubagentTally(
  state: SubagentScanState,
  file: SubagentTranscriptFile,
  tally: SubagentFileTally,
): void {
  state.transcriptsRead++;
  state.recordsRead += tally.records;
  state.unparseableLines += tally.unparseableLines;
  state.sidechainRecords += tally.sidechainRecords;
  state.nestedDispatches += tally.nestedDispatches;
  state.owners.add(file.ownerSessionId);
  for (const agentId of tally.agentIds) state.agentIds.add(agentId);
  if (tally.mixedAttribution) state.mixedAttribution++;
  if (tally.attributedType === null) state.withoutAttribution++;

  const type = tally.attributedType ?? UNATTRIBUTED_TYPE;
  const accumulator = state.byType.get(type) ?? newSubagentAccumulator();
  accumulator.transcripts++;
  accumulator.owners.add(file.ownerSessionId);
  accumulator.records += tally.records;
  accumulator.toolCalls += tally.toolCalls;
  accumulator.outputTokens += tally.outputTokens;
  accumulator.recordsWithUsage += tally.recordsWithUsage;
  if (tally.firstMs !== null && tally.lastMs !== null && tally.lastMs > tally.firstMs) {
    accumulator.wallClockMs += tally.lastMs - tally.firstMs;
    accumulator.transcriptsWithSpan++;
  } else {
    accumulator.transcriptsWithoutSpan++;
  }
  if (tally.firstMs !== null) {
    accumulator.firstMs =
      accumulator.firstMs === null
        ? tally.firstMs
        : Math.min(accumulator.firstMs, tally.firstMs);
  }
  if (tally.lastMs !== null) {
    accumulator.lastMs =
      accumulator.lastMs === null
        ? tally.lastMs
        : Math.max(accumulator.lastMs, tally.lastMs);
  }
  state.byType.set(type, accumulator);
}

/**
 * Read every subagent transcript beside the sessions.
 *
 * These files are the delegated work itself, and the mainline reader excludes them
 * on purpose: folding delegated turns into a session's own figures would inflate
 * numbers an operator reads as "this session". Here they are the answer to the
 * other half of the question, so they are read as their own corpus and reported in
 * their own fields.
 *
 * A nested file outside the subagents directory is not a delegated run - a session
 * keeps other logs there - so it is skipped and counted rather than read as one.
 */
function scanSubagentTranscripts(transcriptsDir: string): SubagentScanState {
  const state = newSubagentScanState();
  const subagentScan = listSubagentTranscriptFiles(transcriptsDir);
  // What the shared reader declined to walk is carried through rather than dropped
  // here, so a partial scan cannot read as a complete one further up.
  state.readerSkips = subagentScan.skipped;
  for (const file of subagentScan.files) {
    const segments = file.relativePath.split(path.sep);
    if (!segments.includes(SUBAGENT_DIR)) {
      state.nestedNonSubagentFiles++;
      continue;
    }
    state.filesFound++;
    if (segments.includes(WORKFLOW_DIR)) state.workflowFiles++;
    const tally = scanCached(file, SUBAGENT_EXTRACTOR_ID, (filePath) =>
      scanSubagentTranscript(filePath, file.sizeBytes),
    );
    if (tally === null) {
      state.vanished++;
      console.warn(
        `delegation: ${file.filePath} disappeared mid-scan; its delegated records are not counted`,
      );
      continue;
    }
    if (tally.truncated) {
      state.truncated++;
      console.warn(
        `delegation: ${file.filePath} changed while it was being read; the read may have ` +
          `stopped early and any delegated records past that point are not counted`,
      );
    }
    foldSubagentTally(state, file, tally);
  }
  return state;
}

/**
 * Which side of the launch the paired result put this dispatch on.
 *
 * The request is not consulted. Its background parameter is opt-out, so absence
 * means detached, and a field that read absence as inline reported the complement
 * of 17 as having run inline where only 8 did. An unfamiliar status falls back to
 * the result's own isAsync and then to unknown, so a vocabulary this module has not
 * seen is visible rather than silently sorted into one side.
 */
function launchModeOf(outcome: DispatchOutcome | undefined): LaunchMode {
  if (!outcome) return "unknown";
  if (outcome.status !== null) {
    if (DETACHED_LAUNCH_STATUSES.has(outcome.status)) return "detached";
    if (INLINE_LAUNCH_STATUSES.has(outcome.status)) return "inline";
  }
  if (outcome.isAsync === true) return "detached";
  if (outcome.isAsync === false) return "inline";
  return "unknown";
}

type TrendWindow = {
  months: DelegationMonth[];
  throughMonth: string | null;
  monthsOmitted: number;
  dispatchesBefore: number;
  dispatchesAfter: number;
};

const monthIndexOf = (ms: number): number => {
  const when = new Date(ms);
  return when.getUTCFullYear() * 12 + when.getUTCMonth();
};

const monthLabel = (index: number): string => {
  const year = Math.floor(index / 12);
  const month = index % 12;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
};

/**
 * Contiguous month buckets, oldest first, ending at the month this was read in.
 *
 * Months with no dispatches are present as zero, including the quiet ones at the
 * end. Stopping at the last dispatch made the final bar always non-zero, so a
 * habit that stopped a year ago drew as a current one; that is the exact reading
 * failure the zero-filling exists to prevent, and it was being applied to every
 * gap except the most recent.
 *
 * Bounded at both ends. The window is the last MAX_TREND_MONTHS months up to the
 * read month, so neither an absurdly old timestamp nor a future-dated one can make
 * the payload size a function of one record's content. Dispatches outside the
 * window are counted and reported rather than dropped in silence.
 */
function monthlyTrend(timestamps: number[], nowMs: number): TrendWindow {
  if (timestamps.length === 0) {
    return {
      months: [],
      throughMonth: null,
      monthsOmitted: 0,
      dispatchesBefore: 0,
      dispatchesAfter: 0,
    };
  }

  const counts = new Map<number, number>();
  let lowest = Number.POSITIVE_INFINITY;
  for (const ms of timestamps) {
    const index = monthIndexOf(ms);
    counts.set(index, (counts.get(index) ?? 0) + 1);
    lowest = Math.min(lowest, index);
  }

  const end = monthIndexOf(nowMs);
  // A dispatch dated after the read month gets no bucket rather than a bucket in
  // the future; the window never starts after it ends, so an all-future corpus
  // still renders as the current month at zero.
  const start = Math.max(Math.min(lowest, end), end - MAX_TREND_MONTHS + 1);

  const months: DelegationMonth[] = [];
  for (let index = start; index <= end; index++) {
    months.push({ month: monthLabel(index), dispatches: counts.get(index) ?? 0 });
  }

  let dispatchesBefore = 0;
  let dispatchesAfter = 0;
  for (const [index, count] of counts) {
    if (index < start) dispatchesBefore += count;
    else if (index > end) dispatchesAfter += count;
  }

  return {
    months,
    throughMonth: monthLabel(end),
    monthsOmitted: Math.max(0, start - lowest),
    dispatchesBefore,
    dispatchesAfter,
  };
}

/**
 * Wording for what the numbers do not cover, assembled from what this corpus
 * actually contains.
 *
 * Written from the evidence rather than hardcoded on purpose. A sentence that
 * keeps asserting yesterday's shape after the corpus changes is the most
 * misleading thing this pillar could ship, and it has been wrong once already: it
 * used to say no subagent turns existed anywhere, on the strength of a marker that
 * thousands of records never carried, while hundreds of subagent transcripts sat
 * unread on disk.
 */
function limitationText(
  evidence: DelegationEvidence,
  totals: DelegationTotals,
): string {
  const parts: string[] = [
    "Two sides, counted separately. A dispatch is the tool call that handed work " +
      "off; delegated work is what the subagent transcript beside that session " +
      "recorded. Neither side says whether the answer was used, and no figure here " +
      "is a cost.",
  ];

  if (evidence.recordsCarryingSidechainFlag === 0) {
    parts.push(
      `None of the ${evidence.sessionRecordsRead} session records read carries the ` +
        "marker that distinguishes subagent traffic, so those files neither confirm " +
        "nor deny a subagent turn of their own.",
    );
  } else {
    parts.push(
      `${evidence.sidechainRecordsInSessionTranscripts} of the ${evidence.sessionRecordsRead} ` +
        `session records read are marked as subagent traffic and ` +
        `${evidence.recordsCarryingSidechainFlag} carry that marker either way, leaving ` +
        `${evidence.sessionRecordsWithoutSidechainFlag} that say nothing about it.`,
    );
  }

  // Read against found rather than read alone, so a file that vanished between the
  // listing and the read is visible in the sentence and not only in the evidence.
  parts.push(
    `The delegated figures come from ${evidence.subagentTranscriptsRead} of the ` +
      `${evidence.subagentTranscriptFiles} subagent transcripts in the nested directories ` +
      `beside those sessions, ${evidence.workflowAgentTranscriptFiles} of which were written ` +
      "by agents an orchestration script spawned rather than by a dispatch tool call.",
  );

  if (evidence.subagentTranscriptsWithoutAgentType > 0) {
    parts.push(
      `${evidence.subagentTranscriptsWithoutAgentType} of those name no specialist anywhere in ` +
        `the file, so their records are reported under "${UNATTRIBUTED_TYPE}" instead of being ` +
        "folded into a specialist that may not have done the work.",
    );
  }

  if (evidence.nestedFilesNotSubagentTranscripts > 0) {
    parts.push(
      `${evidence.nestedFilesNotSubagentTranscripts} further nested files were skipped as not ` +
        "being delegated runs: they sit outside the subagents directory and hold a different " +
        "kind of log.",
    );
  }

  parts.push(
    `${evidence.dispatchesWithMatchingSubagentTranscript} of ${totals.dispatches} dispatches have ` +
      `a transcript on disk carrying the agent id their result named and ` +
      `${evidence.dispatchesWithoutMatchingSubagentTranscript} do not, and ` +
      `${evidence.subagentTranscriptsWhoseOwnerSessionNeverDispatched} transcripts sit beside a session ` +
      "that recorded no dispatch at all. The two sides are not required to agree.",
  );

  parts.push(
    "Detached against inline is read from the paired result and never from the request: " +
      `the request's flag is opt-out, and ${evidence.dispatchesWithNoBackgroundFlag} dispatches ` +
      `carried none at all. ${evidence.dispatchesWithoutPairedResult} dispatches have no paired ` +
      "result, so their launch mode is reported as unknown rather than as inline.",
  );

  if (evidence.dispatchesInsideDelegatedWork > 0) {
    parts.push(
      `${evidence.dispatchesInsideDelegatedWork} dispatch calls sit inside the delegated ` +
        "transcripts themselves, a subagent handing work on again; they are counted here and " +
        "not in the dispatch figures, which are about what a mainline session handed off.",
    );
  }

  const truncated =
    evidence.transcriptsTruncatedMidScan + evidence.subagentTranscriptsTruncatedMidScan;
  if (truncated > 0) {
    parts.push(
      `${truncated} transcripts changed while they were being read. The reader stops where the ` +
        "file stops, so an unknown number of records past that point are missing from every " +
        "figure above.",
    );
  }

  if (evidence.trendMonthsOmitted > 0) {
    parts.push(
      `The monthly trend holds at most ${evidence.trendMonthCap} months ending at the month it ` +
        `was read in, so ${evidence.trendMonthsOmitted} earlier months and the ` +
        `${evidence.dispatchesBeforeTrendWindow} dispatches in them are not in it.`,
    );
  }

  if (evidence.dispatchesAfterTrendWindow > 0) {
    parts.push(
      `${evidence.dispatchesAfterTrendWindow} dispatches are dated after the month this was read ` +
        "in and have no bucket in the trend, which is what a clock skew or a mistyped timestamp " +
        "looks like.",
    );
  }

  return parts.join(" ");
}

/**
 * Require the transcripts directory to be a directory.
 *
 * Absent and present-but-a-file are the same operator mistake, a mistyped config
 * path, so both raise SourceMissingError naming the path. Returning an empty
 * report instead would read as "you have never delegated anything", which is a
 * different and much worse claim than "this path is wrong".
 */
function requireTranscriptsDir(transcriptsDir: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(transcriptsDir, { throwIfNoEntry: false });
  } catch (err) {
    // ENOTDIR means a leading component of the path is a file, so nothing can
    // exist here; that is the missing-source case. Anything else, a permission
    // problem for instance, is a real fault and stays loud.
    if ((err as NodeJS.ErrnoException).code !== "ENOTDIR") throw err;
  }
  if (!stat || !stat.isDirectory()) {
    throw new SourceMissingError("subagent dispatches", transcriptsDir);
  }
}

function toDelegatedWork(accumulator: SubagentAccumulator | undefined): DelegatedWork | null {
  if (!accumulator) return null;
  return {
    transcripts: accumulator.transcripts,
    owningSessions: accumulator.owners.size,
    records: accumulator.records,
    toolCalls: accumulator.toolCalls,
    outputTokens: accumulator.recordsWithUsage > 0 ? accumulator.outputTokens : null,
    recordsWithUsage: accumulator.recordsWithUsage,
    firstRecordAt: isoOrNull(accumulator.firstMs),
    lastRecordAt: isoOrNull(accumulator.lastMs),
    wallClockMs: accumulator.transcriptsWithSpan > 0 ? accumulator.wallClockMs : null,
    transcriptsWithoutSpan: accumulator.transcriptsWithoutSpan,
  };
}

/**
 * Every subagent dispatch on this machine and every subagent transcript it left
 * behind, grouped by specialist.
 *
 * The whole transcript tree is scanned rather than a recent slice, because the
 * question is whether delegation is a habit and a habit is only visible over
 * months. Records are streamed one line at a time; the corpus reaches hundreds of
 * megabytes and materializing it would cost more memory than the answer is worth.
 *
 * Dispatches are deduplicated by their tool-call id. A resumed or forked session
 * can replay earlier records, and a replay is not a second dispatch - counting it
 * twice would inflate the one number this pillar exists to report.
 *
 * `nowMs` is the read time the monthly trend zero-fills up to. It is a parameter so
 * a trend can be asserted without depending on the day the assertion runs.
 */
export function delegationReport(
  transcriptsDir: string,
  options: { nowMs?: number } = {},
): DelegationReport {
  requireTranscriptsDir(transcriptsDir);
  const nowMs = options.nowMs ?? Date.now();

  const sessionScan = newSessionScanState();
  for (const file of listTranscriptFiles(transcriptsDir)) {
    scanTranscript(file, sessionScan);
  }

  const subagentScan = scanSubagentTranscripts(transcriptsDir);

  const byType = new Map<string, TypeAccumulator>();
  const projects = new Set<string>();
  const sessions = new Set<string>();
  const promptChars: number[] = [];
  const timestamps: number[] = [];
  const toolNames = new Set<string>();
  const statusCounts = new Map<string, number>();
  let modelOverrides = 0;
  let detached = 0;
  let inline = 0;
  let launchModeUnknown = 0;
  let worktreeIsolated = 0;
  let requestedBackground = 0;
  let requestedInline = 0;
  let noBackgroundFlag = 0;
  let withoutPairedResult = 0;
  let withMatchingTranscript = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let withoutTimestamp = 0;

  for (const dispatch of sessionScan.dispatches) {
    const outcome =
      dispatch.toolUseId === null
        ? undefined
        : sessionScan.outcomes.get(dispatch.toolUseId);
    const mode = launchModeOf(outcome);

    const accumulator = byType.get(dispatch.subagentType) ?? newAccumulator();
    absorb(accumulator, dispatch, mode);
    byType.set(dispatch.subagentType, accumulator);

    toolNames.add(dispatch.toolName);
    projects.add(dispatch.projectDir);
    sessions.add(dispatch.sessionId);
    if (dispatch.promptChars !== null) promptChars.push(dispatch.promptChars);
    if (dispatch.requestedModel !== null) modelOverrides++;
    if (dispatch.worktreeIsolated) worktreeIsolated++;
    if (mode === "detached") detached++;
    else if (mode === "inline") inline++;
    else launchModeUnknown++;
    if (dispatch.requestedBackground === true) requestedBackground++;
    else if (dispatch.requestedBackground === false) requestedInline++;
    else noBackgroundFlag++;
    if (!outcome) withoutPairedResult++;
    else if (outcome.status !== null) {
      statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);
    }
    if (outcome?.agentId !== undefined && outcome?.agentId !== null) {
      if (subagentScan.agentIds.has(outcome.agentId)) withMatchingTranscript++;
    }

    if (dispatch.atMs === null) {
      withoutTimestamp++;
      continue;
    }
    timestamps.push(dispatch.atMs);
    firstMs = firstMs === null ? dispatch.atMs : Math.min(firstMs, dispatch.atMs);
    lastMs = lastMs === null ? dispatch.atMs : Math.max(lastMs, dispatch.atMs);
  }

  const trend = monthlyTrend(timestamps, nowMs);

  const rowTypes = new Set<string>([...byType.keys(), ...subagentScan.byType.keys()]);
  const bySubagentType: SubagentDelegation[] = [...rowTypes]
    .map((subagentType) => {
      const accumulator = byType.get(subagentType) ?? newAccumulator();
      return {
        subagentType,
        dispatches: accumulator.dispatches,
        projects: [...accumulator.projects.entries()]
          .map(([projectDir, count]) => ({
            projectDir,
            label: decodeProjectDir(projectDir),
            dispatches: count,
          }))
          .sort(
            (a, b) =>
              b.dispatches - a.dispatches || a.projectDir.localeCompare(b.projectDir),
          ),
        sessions: accumulator.sessions.size,
        firstDispatchAt: isoOrNull(accumulator.firstMs),
        lastDispatchAt: isoOrNull(accumulator.lastMs),
        modelOverrides: accumulator.modelOverrides,
        modelsRequested: [...accumulator.models].sort(),
        backgroundDispatches: accumulator.detached,
        inlineDispatches: accumulator.inline,
        launchModeUnknownDispatches: accumulator.launchModeUnknown,
        worktreeIsolatedDispatches: accumulator.worktreeIsolated,
        medianPromptChars: medianOf(
          [...accumulator.promptChars].sort((a, b) => a - b),
        ),
        promptCharsMissing: accumulator.promptCharsMissing,
        delegatedWork: toDelegatedWork(subagentScan.byType.get(subagentType)),
      };
    })
    // Busiest specialist first: the shape of the habit is which one gets the work.
    // A specialist with no dispatch but with delegated work on disk sorts by that
    // work rather than vanishing, since it is exactly the disagreement worth seeing.
    .sort(
      (a, b) =>
        b.dispatches - a.dispatches ||
        (b.delegatedWork?.records ?? 0) - (a.delegatedWork?.records ?? 0) ||
        a.subagentType.localeCompare(b.subagentType),
    );

  let delegatedTranscripts = 0;
  let delegatedRecords = 0;
  let delegatedToolCalls = 0;
  let delegatedOutputTokens = 0;
  let delegatedRecordsWithUsage = 0;
  let delegatedWallClockMs = 0;
  let delegatedSpans = 0;
  for (const accumulator of subagentScan.byType.values()) {
    delegatedTranscripts += accumulator.transcripts;
    delegatedRecords += accumulator.records;
    delegatedToolCalls += accumulator.toolCalls;
    delegatedOutputTokens += accumulator.outputTokens;
    delegatedRecordsWithUsage += accumulator.recordsWithUsage;
    delegatedWallClockMs += accumulator.wallClockMs;
    delegatedSpans += accumulator.transcriptsWithSpan;
  }

  const totals: DelegationTotals = {
    dispatches: sessionScan.dispatches.length,
    subagentTypes: byType.size,
    projects: projects.size,
    sessions: sessions.size,
    modelOverrides,
    backgroundDispatches: detached,
    inlineDispatches: inline,
    launchModeUnknownDispatches: launchModeUnknown,
    worktreeIsolatedDispatches: worktreeIsolated,
    firstDispatchAt: isoOrNull(firstMs),
    lastDispatchAt: isoOrNull(lastMs),
    medianPromptChars: medianOf([...promptChars].sort((a, b) => a - b)),
    delegatedTranscripts,
    delegatedRecords,
    delegatedToolCalls,
    delegatedOutputTokens: delegatedRecordsWithUsage > 0 ? delegatedOutputTokens : null,
    delegatedWallClockMs: delegatedSpans > 0 ? delegatedWallClockMs : null,
    sessionsWithDelegatedWork: subagentScan.owners.size,
  };

  let ownerNeverDispatched = 0;
  for (const owner of subagentScan.owners) {
    if (!sessions.has(owner)) ownerNeverDispatched++;
  }

  const evidence: DelegationEvidence = {
    sessionTranscriptsScanned: sessionScan.transcriptsScanned,
    sessionRecordsRead: sessionScan.recordsRead,
    unparseableLines: sessionScan.unparseableLines,
    transcriptsVanishedDuringScan: sessionScan.vanished,
    transcriptsTruncatedMidScan: sessionScan.truncated,
    toolNames: [...toolNames].sort(),
    duplicateDispatchRecordsIgnored: sessionScan.duplicates,
    dispatchesWithoutTimestamp: withoutTimestamp,
    dispatchesRequestingBackgroundExplicitly: requestedBackground,
    dispatchesRequestingInlineExplicitly: requestedInline,
    dispatchesWithNoBackgroundFlag: noBackgroundFlag,
    dispatchOutcomeStatuses: [...statusCounts.entries()]
      .map(([status, dispatches]) => ({ status, dispatches }))
      .sort((a, b) => b.dispatches - a.dispatches || a.status.localeCompare(b.status)),
    dispatchesWithoutPairedResult: withoutPairedResult,
    dispatchesWithMatchingSubagentTranscript: withMatchingTranscript,
    dispatchesWithoutMatchingSubagentTranscript:
      sessionScan.dispatches.length - withMatchingTranscript,
    sidechainRecordsInSessionTranscripts: sessionScan.sidechainRecords,
    recordsCarryingSidechainFlag: sessionScan.recordsWithSidechainFlag,
    sessionRecordsWithoutSidechainFlag:
      sessionScan.recordsRead - sessionScan.recordsWithSidechainFlag,
    subagentTranscriptFiles: subagentScan.filesFound,
    workflowAgentTranscriptFiles: subagentScan.workflowFiles,
    subagentTranscriptsRead: subagentScan.transcriptsRead,
    subagentRecordsRead: subagentScan.recordsRead,
    subagentUnparseableLines: subagentScan.unparseableLines,
    subagentRecordsMarkedSidechain: subagentScan.sidechainRecords,
    subagentTranscriptsWithoutAgentType: subagentScan.withoutAttribution,
    subagentTranscriptsWithMixedAgentType: subagentScan.mixedAttribution,
    subagentTranscriptsVanishedDuringScan: subagentScan.vanished,
    subagentTranscriptsTruncatedMidScan: subagentScan.truncated,
    nestedFilesNotSubagentTranscripts: subagentScan.nestedNonSubagentFiles,
    // A sibling directory whose name is not a session id belongs to something other
    // than delegated work - a plugin writes its hook log beside the transcripts - so
    // it is counted here rather than read as a session that never existed.
    directoriesNotNamedForASession: subagentScan.readerSkips.nonSessionDirectories,
    subagentDirectoriesUnreadable: subagentScan.readerSkips.unreadableDirectories,
    subagentDirectoriesBeyondWalkDepth: subagentScan.readerSkips.directoriesBeyondDepth,
    subagentSymlinksNotFollowed: subagentScan.readerSkips.symlinks,
    subagentTranscriptsWhoseOwnerSessionNeverDispatched: ownerNeverDispatched,
    dispatchesInsideDelegatedWork: subagentScan.nestedDispatches,
    trendThroughMonth: trend.throughMonth,
    trendMonthCap: MAX_TREND_MONTHS,
    trendMonthsOmitted: trend.monthsOmitted,
    dispatchesBeforeTrendWindow: trend.dispatchesBefore,
    dispatchesAfterTrendWindow: trend.dispatchesAfter,
  };

  return {
    bySubagentType,
    totals,
    byMonth: trend.months,
    evidence,
    limitation: limitationText(evidence, totals),
  };
}
