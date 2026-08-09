import fs from "node:fs";
import { SourceMissingError } from "./config.js";
import {
  listSubagentTranscriptFiles,
  listTranscriptFiles,
  scanCached,
  streamTranscript,
  type TranscriptFile,
} from "./transcripts.js";

/**
 * When skills were actually used, and which ones are safe to delete.
 *
 * Claude Code already keeps a per-skill counter: a lifetime invocation total plus
 * the timestamp of the most recent one. That answers "how often" and "how recently"
 * and nothing else. It cannot tell seventeen uses spread evenly over six months
 * from seventeen uses that all happened in one week last spring, and only the
 * second of those is a skill worth deleting. The distribution the counter lacks is
 * sitting in the transcripts, where each assistant record carries the name of the
 * skill it was produced under along with its timestamp.
 *
 * TWO SOURCES, TWO UNITS, NEVER COMBINED. This is the whole design constraint of
 * this module, so it is stated before anything else:
 *
 *   - The counter counts INVOCATIONS: how many times a skill was reached for.
 *   - Transcript attribution counts RECORDS PRODUCED under a skill's attribution,
 *     which is a measure of how much work happened inside it.
 *
 * A skill invoked once that then drove two hundred turns and a skill invoked
 * twenty times for a single answer each are opposite shapes, and the two sources
 * rank them in opposite orders. Adding the numbers, averaging them, or labelling
 * either one "usage" without naming its unit would produce a figure that means
 * nothing while looking authoritative. So every field here carries its unit in its
 * name and the two are only ever reported side by side.
 *
 * Timestamps are the exception, and only because they genuinely share a unit: the
 * newest evidence of use is the later of the two dates, which is a comparison
 * between two moments rather than a sum of two different measures.
 *
 * DELEGATED WORK COUNTS, AND IS ALSO REPORTED ON ITS OWN. A skill invoked inside a
 * dispatched subagent was invoked, so its records belong in the total. Those records
 * live in transcripts nested below a session directory, which the mainline session
 * reader deliberately skips; reading only the mainline files left two records in five
 * out of the total on a real tree here, enough to change which skill ranked heaviest.
 * But "I reached for this skill" and "an agent I dispatched used it" are different
 * facts about a habit, so each count is carried in its own named field beside the
 * total rather than only summed.
 *
 * TWO SPANS, AND THEY ARE NOT INTERCHANGEABLE. The corpus span is how much history
 * the transcripts on disk cover. The attribution window is the stretch that actually
 * carries attribution, which is shorter, because the attribution field is newer than
 * some of the history and the first and last attributed records can sit anywhere
 * inside the corpus. A sentence reporting that nothing was found has to quote the
 * corpus span, because that is what was searched: quoting the attribution span turns
 * "one attributed record in a year of transcripts" into "0 days of transcripts on
 * disk", which reads as no evidence having been available when a year of it was read.
 *
 * Nothing in this file writes, moves, or removes anything. deletionShortlist
 * returns a ranked opinion and the sentence behind it; acting on it is the
 * operator's job and there is deliberately no code path here that could do it.
 */

/** Milliseconds in a day, for turning timestamp gaps into readable ages. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a skill must go untouched before it reaches the shortlist as stale.
 *
 * A quarter plus a month of grace. A quarter is the shortest span in which a
 * genuinely recurring need would have recurred for most working rhythms, and the
 * extra month keeps a skill used at the start of one quarter and the end of the
 * next off the list.
 *
 * Sanity-checked against a real machine rather than picked in the abstract, because
 * a threshold above the whole observed range is a knob that does nothing. There, the
 * idle ages of the skills with any recorded use cluster inside three months with a
 * clear gap before the two oldest at roughly four and a half; anything from about
 * ninety to a hundred and thirty days separates the same two skills, so the answer
 * is not sensitive to the exact value chosen inside that gap. Six months, which was
 * the first choice, sat above every observed age and produced an empty bucket.
 *
 * A skill for genuinely annual work will still surface here. That is acceptable
 * because this is a list to read with the age stated on every row, not a deletion.
 */
export const STALE_DAYS = 120;

/**
 * How long the quiet after a single-month burst must have lasted before that burst
 * counts against the skill.
 *
 * A quarter. One month of concentrated use followed by three months of silence is
 * the signature of a skill adopted for one specific project and then left behind,
 * which is different from a skill still in rotation. Below a quarter the silence is
 * just as likely to be the gap between two pieces of similar work.
 */
export const BURST_STALE_DAYS = 90;

/**
 * How wide the attribution window must be, in elapsed days, before a single-month
 * burst is allowed to mean anything.
 *
 * This guard exists because of a real and badly misleading measurement. Transcripts
 * are pruned, and the attribution field itself only appears in recent Claude Code
 * versions, so the evidence window is far shorter than the operator's history: on
 * the machine this was built against the counter reaches back five months while the
 * transcripts on disk reach back about one. In a window that narrow, almost every
 * skill has all of its records inside a single month, and a naive burst test
 * flagged twenty-two of twenty-nine skills as one-month wonders. That is a property
 * of the window, not of anybody's habits. Three months is the minimum span at which
 * "one month of use and nothing either side" is a shape the data could actually
 * have refuted.
 *
 * Elapsed days, not calendar months touched, because a count of months answers a
 * different question and answers it inconsistently: 33 days starting on the 31st of a
 * month touches three calendar months and would clear a three-month guard, while the
 * same 33 days starting mid-month touches two and would not. Identical width of
 * evidence, opposite verdict, decided only by where the month boundaries fell. Ninety
 * days is three months of history wherever it is placed.
 */
export const BURST_MIN_WINDOW_DAYS = 90;

/** One month of a skill's attributed records, keyed YYYY-MM in UTC. */
export type SkillMonth = { month: string; attributedRecords: number };

export type SkillActivity = {
  /** Attribution name exactly as the transcripts record it, e.g. "plugin:skill". */
  name: string;
  /**
   * Records produced under this skill's attribution, mainline and delegated
   * together. NOT invocations: one invocation can produce hundreds of records, and
   * this number says how much work happened inside the skill rather than how often
   * it was started.
   */
  attributedRecords: number;
  /**
   * Of those, the ones from mainline session transcripts: work the operator's own
   * conversation did under this skill.
   */
  mainlineAttributedRecords: number;
  /**
   * Of those, the ones from transcripts written by dispatched subagents. Split out
   * because reaching for a skill and dispatching an agent that reached for it are
   * different facts about a habit, and a skill whose records are entirely delegated
   * is one the operator may never have invoked directly at all.
   */
  delegatedAttributedRecords: number;
  /**
   * Attributed records whose timestamp was absent or unparseable, and which are
   * therefore in no month. Reported rather than dropped so the histogram can be
   * checked against the total instead of being trusted.
   */
  recordsWithoutTimestamp: number;
  firstAttributedAt: string | null;
  lastAttributedAt: string | null;
  /**
   * Distinct sessions carrying at least one record attributed to this skill. A
   * delegated transcript counts toward the session that dispatched it, so a skill
   * used by six subagents of one conversation is one session rather than six.
   */
  sessionsAttributed: number;
  /** Distinct project directories, which is a rough count of repos it was used in. */
  projectsAttributed: number;
  /** Observed months only, ascending. A month with no records is simply absent. */
  months: SkillMonth[];
  distinctMonths: number;
  /** Heaviest month; ties go to the earlier one so the value is deterministic. */
  busiestMonth: string | null;
};

/**
 * The span of history the transcripts can actually speak about.
 *
 * Reported as a first-class part of the answer because every conclusion drawn from
 * attribution is bounded by it, and a reader who cannot see the window has no way
 * to tell "not used lately" from "not recorded lately".
 */
export type AttributionWindow = {
  firstAttributedAt: string | null;
  lastAttributedAt: string | null;
  /** Every calendar month the window covers, ascending, gaps included. */
  months: string[];
  /**
   * Days between the first and last attributed record. Not the age of the corpus: a
   * single attributed record inside a year of transcripts makes this 0. Use the
   * corpus span for how much history was searched.
   */
  spanDays: number | null;
};

/**
 * How much history the transcripts on disk actually cover, attribution or not.
 *
 * Separate from the attribution window because it answers the other half of the
 * question. The window says how much of the corpus carries attribution; this says how
 * much was read. Only this number can back a sentence of the form "nothing was found
 * in N days", and it is measured over every record rather than the attributed ones,
 * so it cannot shrink to zero just because attribution is sparse.
 */
export type TranscriptCorpus = {
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  spanDays: number | null;
  /** Records read across every transcript, of any type and any attribution. */
  records: number;
  /**
   * Of those, the ones with no usable timestamp, which are therefore outside the span
   * above. Reported so the span is never read as speaking for every record.
   */
  recordsWithoutTimestamp: number;
};

export type SkillActivityReport = {
  /** Heaviest by attributed records first, name ascending as a stable tiebreaker. */
  skills: SkillActivity[];
  window: AttributionWindow;
  corpus: TranscriptCorpus;
  stats: {
    /**
     * Transcripts whose contents are reflected in this report, mainline plus
     * delegated. A tally served from the memo cache counts here: the file was read,
     * and every number the cache replays is that file's own.
     */
    transcriptsScanned: number;
    /** Of those, mainline session transcripts. */
    mainlineTranscriptsScanned: number;
    /** Of those, transcripts written by dispatched subagents. */
    subagentTranscriptsScanned: number;
    /** Transcripts that disappeared mid-scan, which a live session can cause. */
    transcriptsVanished: number;
    /**
     * Lines the shared transcript reader could not parse, surfaced not swallowed.
     * Memoized alongside each file's tally, so a warm call reports the same skip
     * count as the cold one; a count that reset to 0 once the cache filled would
     * quietly retire the tripwire this number exists to be.
     */
    skippedLines: number;
    attributedRecords: number;
    mainlineAttributedRecords: number;
    delegatedAttributedRecords: number;
    skillsAttributed: number;
    recordsWithoutTimestamp: number;
  };
  note: string;
};

/** Per-skill tally for a single transcript, which is one session in one project. */
type FileTally = Map<
  string,
  {
    records: number;
    first: string;
    last: string;
    months: Map<string, number>;
    recordsWithoutTimestamp: number;
  }
>;

/**
 * Everything one transcript contributes to the report.
 *
 * The whole result is memoized, not just the tally. A cache that held the tally alone
 * would replay the per-skill counts on a warm call and silently drop the file's skip
 * count and corpus dates, so the same tree would answer differently depending on
 * whether it had been read before in this process; the warm path is the one a
 * long-running server actually serves, so the dropped numbers would be the normal
 * answer rather than the exception.
 */
type ScannedFile = {
  tally: FileTally;
  skippedLines: number;
  records: number;
  recordsWithoutTimestamp: number;
  /** Oldest and newest readable record timestamp in this file, "" when it has none. */
  corpusFirst: string;
  corpusLast: string;
};

/**
 * Identifies this module's scans in the shared per-file cache. The whole result is
 * memoized, for the reason ScannedFile gives.
 */
const EXTRACTOR_ID = "skill-trend";

/**
 * The UTC month a timestamp falls in, or null when the value is not a timestamp.
 *
 * Slicing an ISO-8601 string is deliberate: it needs no date parsing, and the
 * shape check is what keeps a malformed value from being silently filed under a
 * nonsense month like "not-a" instead of being counted as undated.
 */
function monthOf(timestamp: string): string | null {
  return /^\d{4}-\d{2}-/.test(timestamp) ? timestamp.slice(0, 7) : null;
}

/** Next month in YYYY-MM form, for walking a window month by month. */
function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return monthNumber === 12
    ? `${year + 1}-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
}

/**
 * Days between the end of a calendar month and `now`, or null if the month is
 * unreadable. Measured from the month's end rather than its start so a burst is
 * never reported as older than it is.
 */
function daysSinceMonthEnd(month: string, now: number): number | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) return null;
  // Day 1 of the following month, which is the instant the month ended.
  const end = Date.UTC(year, monthNumber, 1);
  return Math.floor((now - end) / DAY_MS);
}

/**
 * Scan one transcript: its attributed records per skill, plus the dates and counts
 * that describe the file as a whole.
 *
 * Records are not filtered by type. In practice only assistant records carry the
 * attribution field, but the field this feeds is named "records produced under the
 * skill's attribution", and filtering by a type this module does not own would make
 * the number quietly narrower than its own name.
 */
function scanFile(filePath: string): ScannedFile {
  const tally: FileTally = new Map();
  let skippedLines = 0;
  let records = 0;
  let recordsWithoutTimestamp = 0;
  let corpusFirst = "";
  let corpusLast = "";

  for (const line of streamTranscript(filePath)) {
    if (!line.ok) {
      skippedLines++;
      continue;
    }
    records++;

    const timestamp =
      typeof line.record.timestamp === "string" ? line.record.timestamp : "";
    // Dated before the attribution check on purpose. The corpus span has to cover
    // every record, or it would collapse back onto the attribution span and stop
    // being able to say how much history was searched.
    const recordMonth = timestamp ? monthOf(timestamp) : null;
    if (recordMonth) {
      if (!corpusFirst || timestamp < corpusFirst) corpusFirst = timestamp;
      if (timestamp > corpusLast) corpusLast = timestamp;
    } else {
      recordsWithoutTimestamp++;
    }

    const skill = line.record.attributionSkill;
    if (typeof skill !== "string" || skill.length === 0) continue;

    let entry = tally.get(skill);
    if (!entry) {
      entry = {
        records: 0,
        first: "",
        last: "",
        months: new Map(),
        recordsWithoutTimestamp: 0,
      };
      tally.set(skill, entry);
    }
    entry.records++;

    if (!recordMonth) {
      entry.recordsWithoutTimestamp++;
      continue;
    }
    entry.months.set(recordMonth, (entry.months.get(recordMonth) ?? 0) + 1);
    // Transcript timestamps are ISO-8601 in UTC, so string order is time order and
    // no parsing is needed to find the ends of a range.
    if (!entry.first || timestamp < entry.first) entry.first = timestamp;
    if (timestamp > entry.last) entry.last = timestamp;
  }

  return {
    tally,
    skippedLines,
    records,
    recordsWithoutTimestamp,
    corpusFirst,
    corpusLast,
  };
}

/** Running per-skill totals across every transcript. */
type SkillAccumulator = {
  records: number;
  mainlineRecords: number;
  delegatedRecords: number;
  recordsWithoutTimestamp: number;
  first: string;
  last: string;
  sessions: Set<string>;
  projects: Set<string>;
  months: Map<string, number>;
};

function newSkillAccumulator(): SkillAccumulator {
  return {
    records: 0,
    mainlineRecords: 0,
    delegatedRecords: 0,
    recordsWithoutTimestamp: 0,
    first: "",
    last: "",
    sessions: new Set(),
    projects: new Set(),
    months: new Map(),
  };
}

function busiestMonth(months: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  // Ascending so that a tie resolves to the earlier month every time.
  for (const month of [...months.keys()].sort()) {
    const count = months.get(month) ?? 0;
    if (count > bestCount) {
      best = month;
      bestCount = count;
    }
  }
  return best;
}

/** Whole days between two ISO timestamps, or null when either will not parse. */
function spanDaysBetween(first: string, last: string): number | null {
  const firstMs = Date.parse(first);
  const lastMs = Date.parse(last);
  return Number.isFinite(firstMs) && Number.isFinite(lastMs)
    ? Math.round((lastMs - firstMs) / DAY_MS)
    : null;
}

function buildWindow(first: string, last: string): AttributionWindow {
  if (!first || !last) {
    return {
      firstAttributedAt: null,
      lastAttributedAt: null,
      months: [],
      spanDays: null,
    };
  }
  const firstMonth = monthOf(first);
  const lastMonth = monthOf(last);
  const months: string[] = [];
  if (firstMonth && lastMonth) {
    // Gaps are filled on purpose: a caller drawing a histogram needs the empty
    // months to exist, or a quiet stretch renders as if it were not in the window.
    let cursor = firstMonth;
    for (let guard = 0; cursor <= lastMonth && guard < 1200; guard++) {
      months.push(cursor);
      cursor = nextMonth(cursor);
    }
  }
  return {
    firstAttributedAt: first,
    lastAttributedAt: last,
    months,
    spanDays: spanDaysBetween(first, last),
  };
}

/**
 * Require the transcript tree to exist before reading it.
 *
 * A path that is present but is not a directory is the same operator mistake as an
 * absent one (a mistyped config value), so both raise the same named error and the
 * route layer answers 503 with the path in it. Never an empty skill list: an empty
 * list reads as "you have used no skills", which is a different and false claim.
 */
function requireTranscripts(transcriptsDir: string): void {
  const stat = fs.statSync(transcriptsDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new SourceMissingError("skill attribution", transcriptsDir);
  }
}

/**
 * Per-skill attribution activity across the whole transcript tree.
 *
 * The tree is read in full rather than bounded to the newest N sessions, which is
 * the opposite of what the session list does and is deliberate. The point of this
 * pillar is the distribution over time, and reading only recent transcripts biases
 * every histogram toward recent months: a skill last used in the oldest transcripts
 * would come back as having no records at all, which is exactly the wrong answer to
 * "is this safe to delete". The cost is bounded instead by memoizing each file's
 * scan on its identity, so only new or appended transcripts are re-read.
 *
 * Both readers of the tree are used. Mainline session transcripts and the nested
 * transcripts written by dispatched subagents hold different halves of the same
 * question, and the delegated half is large: leaving it out understated the total by
 * two records in five here and reordered the ranking. Each half is also counted on
 * its own, so a total can never hide which of the two it came from.
 */
export function skillActivity(transcriptsDir: string): SkillActivityReport {
  requireTranscripts(transcriptsDir);

  // The session id a record is credited to. A delegated transcript is credited to the
  // conversation that dispatched it, since that is the session the operator had open;
  // crediting the subagent's own id would report one conversation as several.
  const targets: { file: TranscriptFile; sessionKey: string; delegated: boolean }[] = [
    ...listTranscriptFiles(transcriptsDir).map((file) => ({
      file,
      sessionKey: file.sessionId,
      delegated: false,
    })),
    ...listSubagentTranscriptFiles(transcriptsDir).files.map((file) => ({
      file: file as TranscriptFile,
      sessionKey: file.ownerSessionId,
      delegated: true,
    })),
  ];

  const bySkill = new Map<string, SkillAccumulator>();
  let skippedLines = 0;
  let transcriptsVanished = 0;
  let mainlineScanned = 0;
  let subagentScanned = 0;
  let corpusRecords = 0;
  let corpusRecordsWithoutTimestamp = 0;
  let corpusFirst = "";
  let corpusLast = "";
  let windowFirst = "";
  let windowLast = "";

  for (const { file, sessionKey, delegated } of targets) {
    // A live session can rotate or delete a transcript between the directory
    // listing and the read; scanCached reports that race as null. That is counted,
    // not hidden, and every other failure stays loud.
    const scanned = scanCached(file, EXTRACTOR_ID, scanFile);
    if (scanned === null) {
      transcriptsVanished++;
      continue;
    }

    // Read off the scan, not accumulated inside the cache-miss branch. Every number
    // below has to be the same on a warm call as on a cold one, or the report would
    // describe the cache rather than the tree.
    if (delegated) subagentScanned++;
    else mainlineScanned++;
    skippedLines += scanned.skippedLines;
    corpusRecords += scanned.records;
    corpusRecordsWithoutTimestamp += scanned.recordsWithoutTimestamp;
    if (scanned.corpusFirst && (!corpusFirst || scanned.corpusFirst < corpusFirst)) {
      corpusFirst = scanned.corpusFirst;
    }
    if (scanned.corpusLast > corpusLast) corpusLast = scanned.corpusLast;

    for (const [name, entry] of scanned.tally) {
      let accumulator = bySkill.get(name);
      if (!accumulator) {
        accumulator = newSkillAccumulator();
        bySkill.set(name, accumulator);
      }
      accumulator.records += entry.records;
      if (delegated) accumulator.delegatedRecords += entry.records;
      else accumulator.mainlineRecords += entry.records;
      accumulator.recordsWithoutTimestamp += entry.recordsWithoutTimestamp;
      accumulator.sessions.add(sessionKey);
      accumulator.projects.add(file.projectDir);
      for (const [month, count] of entry.months) {
        accumulator.months.set(month, (accumulator.months.get(month) ?? 0) + count);
      }
      if (entry.first && (!accumulator.first || entry.first < accumulator.first)) {
        accumulator.first = entry.first;
      }
      if (entry.last > accumulator.last) accumulator.last = entry.last;
      if (entry.first && (!windowFirst || entry.first < windowFirst)) {
        windowFirst = entry.first;
      }
      if (entry.last > windowLast) windowLast = entry.last;
    }
  }

  const skills: SkillActivity[] = [...bySkill.entries()]
    .map(([name, accumulator]) => ({
      name,
      attributedRecords: accumulator.records,
      mainlineAttributedRecords: accumulator.mainlineRecords,
      delegatedAttributedRecords: accumulator.delegatedRecords,
      recordsWithoutTimestamp: accumulator.recordsWithoutTimestamp,
      firstAttributedAt: accumulator.first || null,
      lastAttributedAt: accumulator.last || null,
      sessionsAttributed: accumulator.sessions.size,
      projectsAttributed: accumulator.projects.size,
      months: [...accumulator.months.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, count]) => ({ month, attributedRecords: count })),
      distinctMonths: accumulator.months.size,
      busiestMonth: busiestMonth(accumulator.months),
    }))
    .sort(
      (a, b) =>
        b.attributedRecords - a.attributedRecords || a.name.localeCompare(b.name),
    );

  return {
    skills,
    window: buildWindow(windowFirst, windowLast),
    corpus: {
      firstRecordAt: corpusFirst || null,
      lastRecordAt: corpusLast || null,
      spanDays:
        corpusFirst && corpusLast ? spanDaysBetween(corpusFirst, corpusLast) : null,
      records: corpusRecords,
      recordsWithoutTimestamp: corpusRecordsWithoutTimestamp,
    },
    stats: {
      transcriptsScanned: mainlineScanned + subagentScanned,
      mainlineTranscriptsScanned: mainlineScanned,
      subagentTranscriptsScanned: subagentScanned,
      transcriptsVanished,
      skippedLines,
      attributedRecords: skills.reduce((sum, s) => sum + s.attributedRecords, 0),
      mainlineAttributedRecords: skills.reduce(
        (sum, s) => sum + s.mainlineAttributedRecords,
        0,
      ),
      delegatedAttributedRecords: skills.reduce(
        (sum, s) => sum + s.delegatedAttributedRecords,
        0,
      ),
      skillsAttributed: skills.length,
      recordsWithoutTimestamp: skills.reduce(
        (sum, s) => sum + s.recordsWithoutTimestamp,
        0,
      ),
    },
    note:
      "Counts are records produced under a skill's attribution, not invocations. " +
      "One invocation can produce hundreds of records, so this measures how much " +
      "work happened inside a skill and never how often it was started. Records " +
      "written by dispatched subagents are included in every total and also counted " +
      "on their own, since a skill an agent used is a different fact about the " +
      "operator than one they reached for themselves. Only the transcripts still on " +
      "disk are covered: the corpus field says how much history that is, and the " +
      "window field how much of it carries attribution at all.",
  };
}

/**
 * One entry of Claude Code's own per-skill counter, passed in rather than read.
 *
 * This module does not open the config file. The skills pillar already reads and
 * joins those counters, and a second reader would be a second chance to disagree
 * with it about which recorded key belongs to which installed skill.
 */
export type CounterEntry = {
  /** Skill name or slash command; a leading "/" is tolerated and ignored. */
  name: string;
  /** Times the skill was reached for. Invocations, not records. */
  usageCount: number;
  /** Epoch milliseconds of the most recent invocation; 0 when unrecorded. */
  lastUsedAt: number;
};

export type DeletionVerdict = "no-evidence" | "stale" | "bursty" | "keep";

/** Which of the two sources had anything to say about a skill. */
export type EvidenceSource =
  | "counter-and-attribution"
  | "counter-only"
  | "attribution-only"
  | "none";

export type ShortlistItem = {
  name: string;
  verdict: DeletionVerdict;
  /** Why, in a sentence the operator can act on without reading this file. */
  reason: string;
  /** Times reached for, per Claude Code's counter. Never added to the next field. */
  invocations: number;
  /** Records produced under attribution. Never added to the previous field. */
  attributedRecords: number;
  /** Of those, records from the operator's own mainline sessions. */
  mainlineAttributedRecords: number;
  /**
   * Of those, records from transcripts written by dispatched subagents. A skill whose
   * records are all delegated is one the operator may never have invoked by hand,
   * which is a different reason to keep it than daily personal use.
   */
  delegatedAttributedRecords: number;
  /**
   * Attributed records carrying no timestamp, and so in no month. Carried here
   * because the verdict sentences name months: without this number a reader cannot
   * tell why a record total exceeds the months histogram beside it.
   */
  recordsWithoutTimestamp: number;
  lastInvokedAt: string | null;
  lastAttributedAt: string | null;
  /**
   * Days since the later of the two dates above, or null when neither source
   * recorded a usable one. Taking the later of two timestamps is a comparison
   * between moments, which is legitimate; the two counts above are different units
   * and are never combined.
   */
  daysSinceNewestEvidence: number | null;
  evidence: EvidenceSource;
  /**
   * Whether the transcripts had anything to say. "absent" means no attributed
   * record was found in the window, which is missing evidence and not a zero:
   * attribution is newer than some of the history, and old transcripts get pruned.
   */
  attributionEvidence: "found" | "absent";
  /** The skill's own attributed months, so a burst is visible without a second call. */
  months: SkillMonth[];
  distinctMonths: number;
};

export type DeletionShortlist = {
  /** Most deletable first. A report and nothing more; see the module note. */
  items: ShortlistItem[];
  counts: Record<DeletionVerdict, number>;
  /**
   * Attribution names that matched none of the counter entries passed in. Not a
   * fault: built-in skills and bundled commands are attributed in transcripts and
   * never appear in a skills inventory. Listed rather than dropped, so attribution
   * the shortlist could not join stays visible instead of vanishing, and never
   * turned into a deletion candidate for something that may not even be installed.
   */
  attributionWithoutCounter: string[];
  window: AttributionWindow;
  /**
   * How much history was searched, which is what every "nothing was found" sentence
   * here quotes. Wider than the attribution window whenever transcripts predate the
   * attribution field.
   */
  corpus: TranscriptCorpus;
  /**
   * Whether the attribution window is wide enough for a single-month burst to mean
   * anything, measured in elapsed days. False suppresses every bursty verdict; see
   * BURST_MIN_WINDOW_DAYS.
   */
  burstClassificationAvailable: boolean;
  thresholds: {
    staleDays: number;
    burstStaleDays: number;
    burstMinWindowDays: number;
  };
  note: string;
};

/** Strip a leading slash so "/foo:bar" and "foo:bar" are the same skill. */
function normalizeName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

/** The part after the last namespace separator, e.g. "bar" from "foo:bar". */
function bareName(name: string): string {
  return name.split(":").pop() ?? name;
}

/** Names appearing exactly once in a list, which is what makes them safe keys. */
function uniqueValues(names: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const unique = new Set<string>();
  for (const [name, count] of counts) if (count === 1) unique.add(name);
  return unique;
}

/**
 * Match counter entries to attribution records by name.
 *
 * Both sources use the same spelling for a skill in the common case, so an exact
 * match on the normalized name comes first. The bare-name fallback exists because a
 * caller may pass plain skill names where the transcripts record namespaced ones,
 * and it is restricted to bare names that are unique on both sides: two plugins can
 * ship a skill of the same name, and crediting one skill's records to both would
 * silently double them.
 */
function matchActivity(
  entries: CounterEntry[],
  activityByName: Map<string, SkillActivity>,
): Map<string, SkillActivity> {
  const uniqueCounterBare = uniqueValues(
    entries.map((entry) => bareName(normalizeName(entry.name))),
  );
  const uniqueActivityBare = uniqueValues(
    [...activityByName.keys()].map((name) => bareName(name)),
  );
  const activityByBare = new Map<string, SkillActivity>();
  for (const [name, activity] of activityByName) {
    const bare = bareName(name);
    if (uniqueActivityBare.has(bare)) activityByBare.set(bare, activity);
  }

  const matched = new Map<string, SkillActivity>();
  for (const entry of entries) {
    const name = normalizeName(entry.name);
    const exact = activityByName.get(name);
    if (exact) {
      matched.set(entry.name, exact);
      continue;
    }
    const bare = bareName(name);
    if (uniqueCounterBare.has(bare) && uniqueActivityBare.has(bare)) {
      const byBare = activityByBare.get(bare);
      if (byBare) matched.set(entry.name, byBare);
    }
  }
  return matched;
}

function isoOrNull(epochMs: number): string | null {
  return epochMs > 0 ? new Date(epochMs).toISOString() : null;
}

/** Days between a moment and now, floored, or null when the moment is unknown. */
function ageDays(epochMs: number, now: number): number | null {
  return epochMs > 0 ? Math.floor((now - epochMs) / DAY_MS) : null;
}

/**
 * The later of the two sources' timestamps, in epoch milliseconds, or 0 when
 * neither recorded one. Both are moments in time, so this is a comparison and not
 * an attempt to combine the two incompatible counts.
 */
function newestEvidenceMs(entry: CounterEntry, activity: SkillActivity | null): number {
  const attributed = activity?.lastAttributedAt
    ? Date.parse(activity.lastAttributedAt)
    : NaN;
  const attributedMs = Number.isFinite(attributed) ? attributed : 0;
  return Math.max(entry.lastUsedAt > 0 ? entry.lastUsedAt : 0, attributedMs);
}

function evidenceSource(
  entry: CounterEntry,
  activity: SkillActivity | null,
): EvidenceSource {
  const hasCounter = entry.usageCount > 0;
  const hasAttribution = (activity?.attributedRecords ?? 0) > 0;
  if (hasCounter && hasAttribution) return "counter-and-attribution";
  if (hasCounter) return "counter-only";
  if (hasAttribution) return "attribution-only";
  return "none";
}

/** "3 days" / "1 day", so a reason reads as a sentence rather than a field dump. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Attributed records that landed in a month, which is what a month claim covers. */
function datedRecords(activity: SkillActivity): number {
  return activity.attributedRecords - activity.recordsWithoutTimestamp;
}

/**
 * "3 attributed records across 2 months", with undated records named rather than
 * folded in.
 *
 * The months histogram only holds records that carried a timestamp, so quoting a full
 * record total beside a month count claims those months contain records that may sit
 * in any month at all. Where the two differ the sentence has to say so, because this
 * is the sentence a deletion gets read from.
 */
function recordsAcrossMonths(activity: SkillActivity): string {
  const undated = activity.recordsWithoutTimestamp;
  const dated = datedRecords(activity);
  if (undated === 0) {
    return (
      `${plural(activity.attributedRecords, "attributed record")} across ` +
      `${plural(activity.distinctMonths, "month")}`
    );
  }
  if (dated === 0) {
    return (
      `${plural(activity.attributedRecords, "attributed record")}, none of which ` +
      "carry a timestamp, so no month can be named for any of them"
    );
  }
  return (
    `${plural(dated, "dated attributed record")} across ` +
    `${plural(activity.distinctMonths, "month")}, plus ` +
    `${plural(undated, "record")} with no timestamp and so in no month`
  );
}

/**
 * The sentence explaining a no-evidence verdict.
 *
 * Careful wording, because this is the verdict that gets a skill deleted. The
 * counter is a lifetime total, which makes zero the strongest signal available, and
 * it is still only a count of what the counter has been recording. The reason says
 * so rather than claiming the skill was proven unused.
 */
function noEvidenceReason(searchedDescription: string): string {
  return (
    "The lifetime invocation counter records 0 invocations, and no attributed " +
    `records were found${searchedDescription}. A lifetime zero is the strongest ` +
    "signal available here; it reports what the counter has recorded rather than " +
    "proving the skill was unused."
  );
}

function staleReason(
  entry: CounterEntry,
  activity: SkillActivity | null,
  newestAgeDays: number,
  searchedDescription: string,
): string {
  const invoked = plural(entry.usageCount, "invocation");
  const age = plural(newestAgeDays, "day");
  if (activity && activity.attributedRecords > 0) {
    return (
      `${invoked} and ${recordsAcrossMonths(activity)}, and the newest trace of ` +
      `either is ${age} old, past the ${STALE_DAYS}-day threshold.`
    );
  }
  return (
    `${invoked}, the most recent ${age} ago. No attributed records were ` +
    `found${searchedDescription}, so how those invocations were spread is unknown; ` +
    "that is missing evidence rather than zero use."
  );
}

/**
 * The sentence behind a bursty verdict.
 *
 * The month claim is made about dated records only. A skill can carry attributed
 * records with no timestamp, which are in no month at all, and saying "all N records
 * fall inside March" while some of the N are undated asserts a placement nobody
 * measured; the undated ones are counted out loud instead.
 */
function burstReason(
  entry: CounterEntry,
  activity: SkillActivity,
  monthAgeDays: number,
  newestAgeDays: number,
): string {
  const dated = datedRecords(activity);
  const undated = activity.recordsWithoutTimestamp;
  const placement =
    undated === 0
      ? `All ${plural(dated, "attributed record")} ${dated === 1 ? "falls" : "fall"}`
      : `All ${plural(dated, "dated attributed record")} ${dated === 1 ? "falls" : "fall"}`;
  const undatedClause =
    undated === 0
      ? ""
      : ` A further ${plural(undated, "attributed record")} ` +
        `${undated === 1 ? "carries" : "carry"} no timestamp and could fall in any ` +
        "month, so the burst covers only the records that are dated.";
  return (
    `${placement} inside ${activity.busiestMonth ?? "one month"}, which ended ` +
    `${plural(monthAgeDays, "day")} ago, and the newest trace from either source is ` +
    `${plural(newestAgeDays, "day")} old; ` +
    `${plural(entry.usageCount, "invocation")} recorded overall.${undatedClause} One ` +
    "month of use followed by a quiet quarter reads as one project's worth rather " +
    "than a standing habit."
  );
}

function keepReason(
  entry: CounterEntry,
  activity: SkillActivity | null,
  newestAgeDays: number | null,
  searchedDescription: string,
): string {
  if (newestAgeDays === null) {
    return (
      `${plural(entry.usageCount, "invocation")} recorded but no usable date from ` +
      `either source${searchedDescription}, so age cannot be established. Kept off ` +
      "the shortlist rather than guessed at."
    );
  }
  const attributed = activity
    ? `, and ${recordsAcrossMonths(activity)}`
    : ", with no attributed records in the transcript window";
  return (
    `${plural(entry.usageCount, "invocation")}, most recently ` +
    `${plural(newestAgeDays, "day")} ago${attributed}. Inside the ` +
    `${STALE_DAYS}-day threshold, so not a deletion candidate.`
  );
}

/**
 * Ranked so the most deletable verdict sorts first.
 *
 * Stale and bursty deliberately share a rank. Both say the skill has gone quiet, and
 * claiming one is worse than the other would be a precision this data does not
 * support: a skill quiet for a year but spread over six months is a stopped habit,
 * while one quiet for four months after a single month of use is a finished project,
 * and which of those is the better deletion depends on the skill. Age breaks the tie
 * instead, which is what a reader sorts by anyway.
 */
const VERDICT_RANK: Record<DeletionVerdict, number> = {
  "no-evidence": 0,
  bursty: 1,
  stale: 1,
  keep: 2,
};

/**
 * A ranked, report-only shortlist of skills that look safe to delete.
 *
 * Report-only is structural, not a promise: this function takes two plain data
 * arguments, touches no filesystem, and returns a verdict plus the sentence behind
 * it. There is no code path in this module that can remove a skill, and none should
 * be added; a deletion belongs to the operator, after reading the reason.
 *
 * The counter data arrives as a parameter so this module never reads the config
 * file itself, and the two sources stay in separate named fields throughout. The
 * one place they interact is the newest-timestamp comparison, which is a comparison
 * between two moments rather than a sum of two different units.
 */
export function deletionShortlist(
  activity: SkillActivityReport,
  usageIndexEntries: CounterEntry[],
  now: number,
): DeletionShortlist {
  const activityByName = new Map(activity.skills.map((skill) => [skill.name, skill]));
  const matched = matchActivity(usageIndexEntries, activityByName);

  const windowSpanDays = activity.window.spanDays;
  const burstClassificationAvailable =
    windowSpanDays !== null && windowSpanDays >= BURST_MIN_WINDOW_DAYS;

  // Every "no attributed records" sentence has to say how much history was actually
  // searched, and that is the span of the transcripts read, never the span of the
  // attributed records found. The two are wildly different when attribution is
  // sparse: one attributed record inside a year of transcripts makes the attribution
  // span 0 days, and "no records in the 0 days of transcripts on disk" would justify
  // deleting a skill on the strength of a year of evidence that was never mentioned.
  const searchedDescription = (() => {
    if (activity.stats.transcriptsScanned === 0) {
      return " in the transcripts on disk, of which there are none";
    }
    const scope =
      activity.corpus.spanDays === null
        ? ` in the ${plural(activity.stats.transcriptsScanned, "transcript")} on disk, ` +
          "whose records carry no readable dates"
        : ` in the ${plural(activity.corpus.spanDays, "day")} of transcripts on disk`;
    // Absence of the field everywhere is a recording gap, not a finding about any one
    // skill, and it has to be said in the same breath as the absence itself.
    return activity.stats.attributedRecords === 0
      ? `${scope}, none of which record skill attribution at all, so attribution can ` +
          "say nothing here either way"
      : scope;
  })();

  const items: ShortlistItem[] = usageIndexEntries.map((entry) => {
    const skill = matched.get(entry.name) ?? null;
    const newestMs = newestEvidenceMs(entry, skill);
    const newestAgeDays = ageDays(newestMs, now);
    const hasAnyUse = entry.usageCount > 0 || (skill?.attributedRecords ?? 0) > 0;

    const monthAgeDays =
      skill && skill.distinctMonths === 1 && skill.busiestMonth
        ? daysSinceMonthEnd(skill.busiestMonth, now)
        : null;

    let verdict: DeletionVerdict;
    let reason: string;
    if (!hasAnyUse) {
      verdict = "no-evidence";
      reason = noEvidenceReason(searchedDescription);
    } else if (
      // Burst is tested before staleness because it is the more specific statement
      // about the same quiet period, and it demands more: not only that the burst
      // month is over, but that nothing has been recorded from either source since.
      // Without that second condition a skill invoked last week would be shortlisted
      // on the strength of attribution that simply has not caught up with it.
      burstClassificationAvailable &&
      skill !== null &&
      skill.attributedRecords > 0 &&
      skill.distinctMonths === 1 &&
      monthAgeDays !== null &&
      monthAgeDays > BURST_STALE_DAYS &&
      newestAgeDays !== null &&
      newestAgeDays > BURST_STALE_DAYS
    ) {
      verdict = "bursty";
      reason = burstReason(entry, skill, monthAgeDays, newestAgeDays);
    } else if (newestAgeDays !== null && newestAgeDays > STALE_DAYS) {
      verdict = "stale";
      reason = staleReason(entry, skill, newestAgeDays, searchedDescription);
    } else {
      verdict = "keep";
      reason = keepReason(entry, skill, newestAgeDays, searchedDescription);
    }

    return {
      name: entry.name,
      verdict,
      reason,
      invocations: entry.usageCount,
      attributedRecords: skill?.attributedRecords ?? 0,
      mainlineAttributedRecords: skill?.mainlineAttributedRecords ?? 0,
      delegatedAttributedRecords: skill?.delegatedAttributedRecords ?? 0,
      recordsWithoutTimestamp: skill?.recordsWithoutTimestamp ?? 0,
      lastInvokedAt: isoOrNull(entry.lastUsedAt),
      lastAttributedAt: skill?.lastAttributedAt ?? null,
      daysSinceNewestEvidence: newestAgeDays,
      evidence: evidenceSource(entry, skill),
      attributionEvidence: skill && skill.attributedRecords > 0 ? "found" : "absent",
      months: skill?.months ?? [],
      distinctMonths: skill?.distinctMonths ?? 0,
    };
  });

  items.sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      // Oldest evidence first within a verdict. An unknown age sorts last rather
      // than leading the list, since it is the least certain candidate.
      (b.daysSinceNewestEvidence ?? -1) - (a.daysSinceNewestEvidence ?? -1) ||
      a.name.localeCompare(b.name),
  );

  const consumed = new Set([...matched.values()].map((skill) => skill.name));
  const counts: Record<DeletionVerdict, number> = {
    "no-evidence": 0,
    stale: 0,
    bursty: 0,
    keep: 0,
  };
  for (const item of items) counts[item.verdict]++;

  const burstNote = burstClassificationAvailable
    ? ""
    : " Bursty verdicts are suppressed: the attributed records on disk span " +
      `${windowSpanDays === null ? "no measurable stretch of time" : plural(windowSpanDays, "day")}, ` +
      `short of the ${BURST_MIN_WINDOW_DAYS} days needed for "all use in one month" to ` +
      "describe a habit rather than the width of the window.";

  return {
    items,
    counts,
    attributionWithoutCounter: activity.skills
      .filter((skill) => !consumed.has(skill.name))
      .map((skill) => skill.name)
      .sort(),
    window: activity.window,
    corpus: activity.corpus,
    burstClassificationAvailable,
    thresholds: {
      staleDays: STALE_DAYS,
      burstStaleDays: BURST_STALE_DAYS,
      burstMinWindowDays: BURST_MIN_WINDOW_DAYS,
    },
    note:
      "A recommendation to read, never an action. Invocations come from Claude " +
      "Code's lifetime counter and attributed records from the transcripts; they " +
      "are different units, they rank skills differently, and they are never " +
      "added or averaged together. An absent attributed record is missing " +
      "evidence, not a zero: attribution is newer than some of the history and " +
      "old transcripts are pruned. A sentence reporting that nothing was found " +
      "quotes the corpus span, which is how much history was read; the window " +
      "field is narrower because it covers only the stretch that carries " +
      `attribution.${burstNote}`,
  };
}
