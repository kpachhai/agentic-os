/**
 * The delegation payload shapes, and the caveat row they feed.
 *
 * Restated from the server module that produces them - the UI does not import
 * server code, and there is no shared types module across that seam, so tsc
 * cannot catch a server shape change here. Change both sides together.
 *
 * Moved out of DelegationView.tsx unchanged. Types erase at compile, so this
 * cannot alter runtime behaviour and a green tsc is the whole proof.
 */

/**
 * The payload shapes, restated from the server module that produces them - the UI
 * does not import server code. The comments kept here are the ones that change
 * what a figure may be read as; the rest of the field names say enough.
 */
export type DelegationProjectUse = {
  projectDir: string;
  /** Display form of the directory name, with its separators flattened to hyphens. */
  label: string;
  dispatches: number;
};

export type DelegatedWork = {
  transcripts: number;
  owningSessions: number;
  records: number;
  toolCalls: number;
  /** null when no record carried a usage block, which is a different claim from zero. */
  outputTokens: number | null;
  recordsWithUsage: number;
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  /** First to last record within each transcript, summed over them. */
  wallClockMs: number | null;
  transcriptsWithoutSpan: number;
};

export type SubagentDelegation = {
  subagentType: string;
  dispatches: number;
  projects: DelegationProjectUse[];
  sessions: number;
  firstDispatchAt: string | null;
  lastDispatchAt: string | null;
  modelOverrides: number;
  modelsRequested: string[];
  /** Read from the paired result, not from the request's own opt-out flag. */
  backgroundDispatches: number;
  inlineDispatches: number;
  launchModeUnknownDispatches: number;
  worktreeIsolatedDispatches: number;
  medianPromptChars: number | null;
  promptCharsMissing: number;
  /** null means nothing on disk is attributed to it, not that it produced nothing. */
  delegatedWork: DelegatedWork | null;
};

export type DelegationTotals = {
  dispatches: number;
  subagentTypes: number;
  projects: number;
  sessions: number;
  modelOverrides: number;
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
  sessionsWithDelegatedWork: number;
};

export type DelegationMonth = {
  /** Calendar month in UTC, "YYYY-MM". */
  month: string;
  dispatches: number;
};

export type DelegationEvidence = {
  sessionTranscriptsScanned: number;
  sessionRecordsRead: number;
  unparseableLines: number;
  transcriptsVanishedDuringScan: number;
  transcriptsTruncatedMidScan: number;
  toolNames: string[];
  duplicateDispatchRecordsIgnored: number;
  dispatchesWithoutTimestamp: number;
  dispatchesRequestingBackgroundExplicitly: number;
  dispatchesRequestingInlineExplicitly: number;
  dispatchesWithNoBackgroundFlag: number;
  dispatchOutcomeStatuses: Array<{ status: string; dispatches: number }>;
  dispatchesWithoutPairedResult: number;
  dispatchesWithMatchingSubagentTranscript: number;
  dispatchesWithoutMatchingSubagentTranscript: number;
  sidechainRecordsInSessionTranscripts: number;
  recordsCarryingSidechainFlag: number;
  sessionRecordsWithoutSidechainFlag: number;
  subagentTranscriptFiles: number;
  workflowAgentTranscriptFiles: number;
  subagentTranscriptsRead: number;
  subagentRecordsRead: number;
  subagentUnparseableLines: number;
  subagentRecordsMarkedSidechain: number;
  subagentTranscriptsWithoutAgentType: number;
  subagentTranscriptsWithMixedAgentType: number;
  subagentTranscriptsVanishedDuringScan: number;
  subagentTranscriptsTruncatedMidScan: number;
  nestedFilesNotSubagentTranscripts: number;
  directoriesNotNamedForASession: number;
  subagentDirectoriesUnreadable: number;
  subagentDirectoriesBeyondWalkDepth: number;
  subagentSymlinksNotFollowed: number;
  subagentTranscriptsWhoseOwnerSessionNeverDispatched: number;
  dispatchesInsideDelegatedWork: number;
  /** The month the trend's zero-fill runs to, which is the month it was read in. */
  trendThroughMonth: string | null;
  trendMonthCap: number;
  trendMonthsOmitted: number;
  dispatchesBeforeTrendWindow: number;
  dispatchesAfterTrendWindow: number;
};

export type DelegationReport = {
  bySubagentType: SubagentDelegation[];
  totals: DelegationTotals;
  byMonth: DelegationMonth[];
  evidence: DelegationEvidence;
  /** What these numbers do not say. Rendered verbatim, never paraphrased. */
  limitation: string;
};

export type Caveat = { label: string; value: number; why: string };
