import type {
  Caveat,
  DelegationEvidence,
  DelegationTotals,
  SubagentDelegation,
} from "./delegation-types";

/**
 * The pure core of the delegation view: formatting, with no React and no IO.
 *
 * Extracted from DelegationView.tsx, which had grown to a thousand lines with these
 * four helpers buried at the top. They are the only part of that file that can be
 * called without rendering anything, so they are the only part that was ever
 * testable - and until this module existed, nothing tested them.
 *
 * Every function here is total: same input, same output, no clock, no locale beyond
 * the explicit "en-US", no filesystem. That is the property that makes the tests
 * next door meaningful rather than decorative.
 */

/** A whole number with thousands separators, pinned to en-US so it never follows the host locale. */
export const count = (value: number): string => value.toLocaleString("en-US");

/** A duration, at whatever unit keeps it readable. Never a wait, always a span. */
export function span(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** The date half of an ISO timestamp, or a stated absence rather than an empty cell. */
export const day = (iso: string | null): string => (iso === null ? "no date" : iso.slice(0, 10));

/**
 * The tail of an encoded project directory.
 *
 * The corpus addresses a project by a directory name whose path separators were
 * already flattened to hyphens, so the whole thing is one token and the usual path
 * shortener cannot split it. The leading segments are the reader's home directory
 * and repeat on every row, so only the tail is shown as the label and the value the
 * corpus actually uses stays in the title.
 */
export function shortProject(label: string): string {
  const tokens = label.replace(/^\//, "").split("-").filter(Boolean);
  if (tokens.length === 0) return label;
  if (tokens.length <= 2) return tokens.join("-");
  return `...${tokens.slice(-2).join("-")}`;
}

/**
 * The seven figures the view derives from the specialist rows.
 *
 * The totals the server sends carry no denominator for their delegated figures and
 * the rows do, so these are summed from the rows rather than reported: every
 * specialist the delegated scan found becomes a row, so the sum covers the same
 * corpus the totals were built from. Kept as a visible sum for that reason.
 */
export type DelegationSummary = {
  recordsWithUsage: number;
  transcriptsWithoutSpan: number;
  promptCharsMissing: number;
  /** Rows that dispatched but have nothing attributed on disk. */
  dispatchedWithNothingBack: number;
  /** Rows with work attributed but no dispatch recorded. */
  workWithoutADispatch: number;
  /**
   * Largest dispatch count, floored at 1.
   *
   * These two are bar denominators, so the floor is load-bearing rather than
   * defensive: an all-zero corpus would otherwise divide by zero.
   */
  mostDispatches: number;
  /** Largest attributed-record count, floored at 1, for the same reason. */
  mostRecords: number;
};

export function summarize(rows: readonly SubagentDelegation[]): DelegationSummary {
  return {
    recordsWithUsage: rows.reduce((sum, row) => sum + (row.delegatedWork?.recordsWithUsage ?? 0), 0),
    transcriptsWithoutSpan: rows.reduce(
      (sum, row) => sum + (row.delegatedWork?.transcriptsWithoutSpan ?? 0),
      0,
    ),
    promptCharsMissing: rows.reduce((sum, row) => sum + row.promptCharsMissing, 0),
    dispatchedWithNothingBack: rows.filter(
      (row) => row.dispatches > 0 && row.delegatedWork === null,
    ).length,
    workWithoutADispatch: rows.filter((row) => row.dispatches === 0 && row.delegatedWork !== null)
      .length,
    mostDispatches: rows.reduce((max, row) => Math.max(max, row.dispatches), 1),
    mostRecords: rows.reduce((max, row) => Math.max(max, row.delegatedWork?.records ?? 0), 1),
  };
}

/**
 * The caveat rows, one per way the scan can be incomplete.
 *
 * Moved verbatim out of DelegationView.tsx. Each row wires one counter to one
 * sentence; a row pointed at the wrong counter still renders a plausible number,
 * which is why tests/delegation-report.test.ts pins all 23 by sentinel rather
 * than sampling a few.
 *
 * Takes the summary rather than recomputing, so the figures here and the ones in
 * the panels above them cannot drift apart.
 */
export function buildCaveats(
  evidence: DelegationEvidence,
  totals: DelegationTotals,
  summary: DelegationSummary,
): Caveat[] {
  const { promptCharsMissing, transcriptsWithoutSpan } = summary;
  return [
  {
    label: "session transcripts gone before a byte was read",
    value: evidence.transcriptsVanishedDuringScan,
    why: "A live Claude Code process rotates these files, and this scan touches every one on the machine. Any dispatch inside one that vanished is not in the totals.",
  },
  {
    label: "session transcripts that changed while being read",
    value: evidence.transcriptsTruncatedMidScan,
    why: "The reader stops where the file stops and raises nothing, so an unknown number of records past that point are missing from every dispatch figure.",
  },
  {
    label: "session lines that would not parse",
    value: evidence.unparseableLines,
    why: "A live session's last line is often torn mid-write. Those lines carry no dispatch that could have been counted.",
  },
  {
    label: "replayed dispatch records counted once",
    value: evidence.duplicateDispatchRecordsIgnored,
    why: "A resumed or forked session replays earlier records, and a replay is not a second dispatch. The copy kept is the one in the most recently modified transcript.",
  },
  {
    label: "dispatches with no usable timestamp",
    value: evidence.dispatchesWithoutTimestamp,
    why: "They are in the totals and have no bucket in the monthly trend, because stamping them with the read time would put them in this month's column.",
  },
  {
    label: "dispatches with no paired result record",
    value: evidence.dispatchesWithoutPairedResult,
    why: "Nothing on disk says how they were launched, so they are reported as unknown rather than assumed to have run inline.",
  },
  {
    label: "dispatches whose launch mode stays unknown",
    value: totals.launchModeUnknownDispatches,
    why: "Detached, inline and unknown add up to every dispatch, so a guess is never hiding inside either side.",
  },
  {
    label: "delegated transcripts gone mid-scan",
    value: evidence.subagentTranscriptsVanishedDuringScan,
    why: "None of their records reached the delegated figures.",
  },
  {
    label: "delegated transcripts that changed while being read",
    value: evidence.subagentTranscriptsTruncatedMidScan,
    why: "As with the session files, the read stopped early with no error, so records past that point are missing from the records, tool calls, tokens and wall clock.",
  },
  {
    label: "delegated lines that would not parse",
    value: evidence.subagentUnparseableLines,
    why: "Skipped rather than guessed at.",
  },
  {
    label: "delegated transcripts naming no specialist",
    value: evidence.subagentTranscriptsWithoutAgentType,
    why: 'Real delegated work whose file names nobody. Reported under "(unattributed)" rather than folded into a specialist that may not have done it.',
  },
  {
    label: "delegated transcripts naming more than one specialist",
    value: evidence.subagentTranscriptsWithMixedAgentType,
    why: "The first name in the file wins, so the whole file counts as that specialist's work.",
  },
  {
    label: "delegated transcripts too short to have a span",
    value: transcriptsWithoutSpan,
    why: "Fewer than two usable timestamps, so no span exists and they add nothing to the wall clock.",
  },
  {
    label: "nested files skipped as not being delegated runs",
    value: evidence.nestedFilesNotSubagentTranscripts,
    why: "They sit outside the subagents directory and hold a different kind of log, so they were not read.",
  },
  {
    label: "sibling directories not named for a session",
    value: evidence.directoriesNotNamedForASession,
    why: "Not walked at all. A plugin writes its own log beside the transcripts, and reading one as delegated work invented an owning session named for the plugin.",
  },
  {
    label: "directories that could not be read",
    value: evidence.subagentDirectoriesUnreadable,
    why: "Whatever they hold is in no figure here.",
  },
  {
    label: "directories past the walk depth",
    value: evidence.subagentDirectoriesBeyondWalkDepth,
    why: "The walk is bounded, so anything nested deeper was not looked at.",
  },
  {
    label: "symlinks not followed",
    value: evidence.subagentSymlinksNotFollowed,
    why: "Following one could leave the transcript tree entirely, or count the same file twice.",
  },
  {
    label: "dispatch calls made inside delegated work",
    value: evidence.dispatchesInsideDelegatedWork,
    why: "A subagent handing work on again. Counted here and deliberately not in the dispatch figures, which are about what a mainline session handed off.",
  },
  {
    label: "dispatches with no prompt to measure",
    value: promptCharsMissing,
    why: "No briefing length exists for them, so they sit outside the median rather than counting as an empty briefing.",
  },
  {
    label: "months dropped by the trend cap",
    value: evidence.trendMonthsOmitted,
    why: `The trend holds at most ${count(evidence.trendMonthCap)} monthly buckets, ending in the month it was read, so one absurd timestamp cannot decide the size of this page.`,
  },
  {
    label: "dispatches older than the trend window",
    value: evidence.dispatchesBeforeTrendWindow,
    why: "In the totals, with no bucket in the chart above.",
  },
  {
    label: "dispatches dated after the month this was read in",
    value: evidence.dispatchesAfterTrendWindow,
    why: "They get no bucket rather than a bucket in the future, which is what a clock skew or a mistyped timestamp looks like.",
  },
  ];
}
