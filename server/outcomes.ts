import type { NamedCount } from "./sessions.js";
import {
  frictionTotal,
  readUsageData,
  type SessionFacets,
  type SessionMeta,
  type UsageDataCoverage,
} from "./usage-data.js";

/**
 * Whether the work went anywhere.
 *
 * Every other pillar here measures activity: sessions, tokens, tools, skills,
 * hooks, files touched. None of them can distinguish a session that solved the
 * problem from one that burned two hours and achieved nothing, because the
 * transcripts do not record that. The `/insights` store does, and it is the only
 * source on this machine that does.
 *
 * THE EPISTEMICS, WHICH DECIDE HOW THIS RENDERS. Two different kinds of field
 * arrive together here and must not be shown as if they were the same thing:
 *
 *   - Judgements. `outcome`, `claude_helpfulness`, `session_type`,
 *     `primary_success` and the goal categories are a model's reading of a
 *     transcript. They are opinions with no ground truth on disk, so nothing
 *     computes with them, nothing is averaged into a score, and they carry the
 *     unknown rail rather than a measured one.
 *   - Counted fields. Message counts, tool errors, lines and commits were
 *     derived by Claude Code from the same transcripts. They are arithmetic
 *     rather than opinion, but they were counted elsewhere, at a time that has
 *     passed, over a subset of sessions - so they are bounded, never a total.
 *
 * No score is produced from any of this. A single number over a model's opinions
 * would be the most confident-looking and least defensible figure in the tool.
 */

export type OutcomeSession = {
  sessionId: string;
  projectPath: string;
  startedAt: string;
  durationMinutes: number;

  /** Judged fields: a model's reading, never computed with. */
  outcome: string;
  claudeHelpfulness: string;
  sessionType: string;
  primarySuccess: string;
  goalCategories: NamedCount[];
  underlyingGoal: string;
  briefSummary: string;
  frictionCount: number;
  satisfaction: NamedCount[];

  /** Counted elsewhere, from the same transcripts. Bounded by coverage. */
  userMessages: number;
  assistantMessages: number;
  toolErrors: number;
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
  gitCommits: number;
};

export type OutcomesReport = {
  sessions: OutcomeSession[];
  byOutcome: NamedCount[];
  byHelpfulness: NamedCount[];
  bySessionType: NamedCount[];
  byPrimarySuccess: NamedCount[];
  topGoalCategories: NamedCount[];
  /**
   * Sessions carrying statistics but no judgement. Reported so the judged set
   * cannot be mistaken for everything the store knows about.
   */
  unjudgedWithStats: number;
  coverage: UsageDataCoverage;
};

function tally(counts: Map<string, number>, key: string): void {
  if (!key) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toNamedCounts(counts: Map<string, number>): NamedCount[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function recordToNamedCounts(counts: Record<string, number>): NamedCount[] {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function toSession(facets: SessionFacets, meta: SessionMeta | undefined): OutcomeSession {
  return {
    sessionId: facets.sessionId,
    projectPath: meta?.projectPath ?? "",
    startedAt: meta?.startTime ?? "",
    durationMinutes: meta?.durationMinutes ?? 0,

    outcome: facets.outcome,
    claudeHelpfulness: facets.claudeHelpfulness,
    sessionType: facets.sessionType,
    primarySuccess: facets.primarySuccess,
    goalCategories: recordToNamedCounts(facets.goalCategories),
    underlyingGoal: facets.underlyingGoal,
    briefSummary: facets.briefSummary,
    frictionCount: frictionTotal(facets),
    satisfaction: recordToNamedCounts(facets.userSatisfactionCounts),

    userMessages: meta?.userMessageCount ?? 0,
    assistantMessages: meta?.assistantMessageCount ?? 0,
    toolErrors: meta?.toolErrors ?? 0,
    linesAdded: meta?.linesAdded ?? 0,
    linesRemoved: meta?.linesRemoved ?? 0,
    filesModified: meta?.filesModified ?? 0,
    gitCommits: meta?.gitCommits ?? 0,
  };
}

export function outcomesReport(usageDataDir: string, transcriptsDir: string): OutcomesReport {
  const usage = readUsageData(usageDataDir, transcriptsDir);

  const sessions: OutcomeSession[] = [];
  const byOutcome = new Map<string, number>();
  const byHelpfulness = new Map<string, number>();
  const bySessionType = new Map<string, number>();
  const byPrimarySuccess = new Map<string, number>();
  const goalCategories = new Map<string, number>();

  for (const facets of usage.facets.values()) {
    sessions.push(toSession(facets, usage.meta.get(facets.sessionId)));
    tally(byOutcome, facets.outcome);
    tally(byHelpfulness, facets.claudeHelpfulness);
    tally(bySessionType, facets.sessionType);
    tally(byPrimarySuccess, facets.primarySuccess);
    for (const [name, count] of Object.entries(facets.goalCategories)) {
      goalCategories.set(name, (goalCategories.get(name) ?? 0) + count);
    }
  }

  // Newest first, and a session with no statistics file has no start time to
  // sort on; those sink rather than claiming the top of the list.
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  let unjudgedWithStats = 0;
  for (const sessionId of usage.meta.keys()) {
    if (!usage.facets.has(sessionId)) unjudgedWithStats += 1;
  }

  return {
    sessions,
    byOutcome: toNamedCounts(byOutcome),
    byHelpfulness: toNamedCounts(byHelpfulness),
    bySessionType: toNamedCounts(bySessionType),
    byPrimarySuccess: toNamedCounts(byPrimarySuccess),
    topGoalCategories: toNamedCounts(goalCategories),
    unjudgedWithStats,
    coverage: usage.coverage,
  };
}

/**
 * The judged fields for one session, for the session detail view to show beside
 * what the transcript itself says. Null when that session was never judged,
 * which is the common case and must render as absence rather than as a blank
 * verdict.
 */
export function outcomeForSession(
  usageDataDir: string,
  transcriptsDir: string,
  sessionId: string,
): OutcomeSession | null {
  const usage = readUsageData(usageDataDir, transcriptsDir);
  const facets = usage.facets.get(sessionId);
  if (!facets) return null;
  return toSession(facets, usage.meta.get(sessionId));
}
