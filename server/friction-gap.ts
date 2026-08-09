import { readFrictionLog } from "./friction.js";
import type { NamedCount } from "./sessions.js";
import {
  frictionTotal,
  readUsageData,
  type UsageDataCoverage,
} from "./usage-data.js";

/**
 * Friction the machine noticed that the operator never wrote down.
 *
 * Two independent records of the same thing already exist on this machine. The
 * friction log is what the operator chose to capture, by hand, in the moment.
 * The `/insights` judgements are what a model found reading the transcripts
 * afterwards. Neither is authoritative and the interesting rows are where they
 * disagree in one direction: a session the analysis says went badly that left no
 * entry in the log at all. That is the loop leaking, and it is invisible from
 * either source on its own.
 *
 * WHAT THIS DOES NOT DO. It does not match a detected friction to a logged one
 * by meaning. The two vocabularies are disjoint - the log is organised by the
 * operator's capture prefixes while the judgements use categories like
 * `buggy_code` and `missing_configuration` - and pretending a mapping exists
 * would invent a correspondence neither source supports. So the question asked
 * here is deliberately weaker and answerable: was ANYTHING logged while this
 * session was running. A session with a logged entry is not claimed to have
 * logged *that* friction, only to have been a session the operator was
 * capturing during.
 */

/** Hours after a session ends during which a log entry still counts as its own. */
const LOG_GRACE_HOURS = 24;

export type FrictionGapEntry = {
  sessionId: string;
  projectPath: string;
  startedAt: string;
  endedAt: string;
  /** Friction events the judgement counted, summed across its categories. */
  detectedCount: number;
  categories: NamedCount[];
  /**
   * The judgement's own prose. Model-written text, so it stays untrusted and
   * goes through the existing sanitizer like every other model output here.
   */
  detail: string;
  outcome: string;
  /** Log entries of any kind written inside the window. */
  loggedInWindow: number;
  status: "unlogged" | "logged";
};

export type FrictionGapReport = {
  /** Sessions the analysis found friction in, newest first. */
  entries: FrictionGapEntry[];
  unloggedCount: number;
  loggedCount: number;
  /**
   * Sessions with judged friction whose statistics file carries no usable start
   * time, so no window could be built. Reported apart from the counts rather
   * than folded into either, because "not checkable" is not "not logged".
   */
  unwindowedCount: number;
  /** The window rule, on screen, so the number is interpretable. */
  graceHours: number;
  /** Entries in the friction log overall, as the denominator for the logged side. */
  frictionLogEntries: number;
  coverage: UsageDataCoverage;
};

function toNamedCounts(counts: Record<string, number>): NamedCount[] {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Milliseconds for a log entry's date.
 *
 * The log carries two shapes: most entries are full ISO timestamps, twenty are
 * a bare date. A bare date is taken as the whole day rather than as midnight,
 * because reading it as an instant would put every same-day entry before every
 * session that started after 00:00 and silently call those sessions unlogged.
 */
function entryWindow(date: string): { start: number; end: number } | null {
  const asDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const parsed = Date.parse(asDay ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(parsed)) return null;
  return { start: parsed, end: asDay ? parsed + 24 * 60 * 60 * 1000 : parsed };
}

export function frictionGapReport(
  usageDataDir: string,
  transcriptsDir: string,
  frictionLogPath: string,
  resolveWindowDays: number,
): FrictionGapReport {
  const usage = readUsageData(usageDataDir, transcriptsDir);
  const logEntries = readFrictionLog(frictionLogPath, resolveWindowDays);

  const logWindows = logEntries
    .map((entry) => entryWindow(entry.date))
    .filter((window): window is { start: number; end: number } => window !== null);

  const entries: FrictionGapEntry[] = [];
  let unwindowedCount = 0;

  for (const facets of usage.facets.values()) {
    const detectedCount = frictionTotal(facets);
    if (detectedCount === 0) continue;

    const meta = usage.meta.get(facets.sessionId);
    const startedMs = meta ? Date.parse(meta.startTime) : Number.NaN;
    if (!meta || Number.isNaN(startedMs)) {
      unwindowedCount += 1;
      continue;
    }

    const endedMs = startedMs + Math.max(meta.durationMinutes, 0) * 60 * 1000;
    const graceEndMs = endedMs + LOG_GRACE_HOURS * 60 * 60 * 1000;
    const loggedInWindow = logWindows.filter(
      (window) => window.end >= startedMs && window.start <= graceEndMs,
    ).length;

    entries.push({
      sessionId: facets.sessionId,
      projectPath: meta.projectPath,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      detectedCount,
      categories: toNamedCounts(facets.frictionCounts),
      detail: facets.frictionDetail,
      outcome: facets.outcome,
      loggedInWindow,
      status: loggedInWindow > 0 ? "logged" : "unlogged",
    });
  }

  entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return {
    entries,
    unloggedCount: entries.filter((entry) => entry.status === "unlogged").length,
    loggedCount: entries.filter((entry) => entry.status === "logged").length,
    unwindowedCount,
    graceHours: LOG_GRACE_HOURS,
    frictionLogEntries: logEntries.length,
    coverage: usage.coverage,
  };
}
