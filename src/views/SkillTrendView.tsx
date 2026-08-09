import { useEffect, useState } from "react";
import { SourceMissing, useApi } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

/*
 * Payload types, restated from the server module that produces them. The UI does
 * not import server code, so these are copies; the meanings below are the
 * server's own and the two units it keeps apart are kept apart here too.
 */

/** One month of a skill's attributed records, keyed YYYY-MM in UTC. */
type SkillMonth = { month: string; attributedRecords: number };

type SkillActivity = {
  name: string;
  /**
   * Records produced under this skill's attribution, mainline and delegated
   * together. NOT invocations: one invocation can produce hundreds of records.
   */
  attributedRecords: number;
  mainlineAttributedRecords: number;
  delegatedAttributedRecords: number;
  /** Attributed records with no usable timestamp, and therefore in no month. */
  recordsWithoutTimestamp: number;
  firstAttributedAt: string | null;
  lastAttributedAt: string | null;
  sessionsAttributed: number;
  projectsAttributed: number;
  /** Observed months only, ascending. A month with no records is simply absent. */
  months: SkillMonth[];
  distinctMonths: number;
  busiestMonth: string | null;
};

type AttributionWindow = {
  firstAttributedAt: string | null;
  lastAttributedAt: string | null;
  /** Every calendar month the window covers, ascending, gaps included. */
  months: string[];
  /** Days between the first and last attributed record, not the age of the corpus. */
  spanDays: number | null;
};

type TranscriptCorpus = {
  firstRecordAt: string | null;
  lastRecordAt: string | null;
  spanDays: number | null;
  /** Records read across every transcript, of any type and any attribution. */
  records: number;
  /** Of those, the ones with no usable timestamp, and so outside the span. */
  recordsWithoutTimestamp: number;
};

type SkillActivityReport = {
  skills: SkillActivity[];
  window: AttributionWindow;
  corpus: TranscriptCorpus;
  stats: {
    transcriptsScanned: number;
    mainlineTranscriptsScanned: number;
    subagentTranscriptsScanned: number;
    transcriptsVanished: number;
    skippedLines: number;
    attributedRecords: number;
    mainlineAttributedRecords: number;
    delegatedAttributedRecords: number;
    skillsAttributed: number;
    recordsWithoutTimestamp: number;
  };
  note: string;
};

type DeletionVerdict = "no-evidence" | "stale" | "bursty" | "keep";

type EvidenceSource =
  | "counter-and-attribution"
  | "counter-only"
  | "attribution-only"
  | "none";

type ShortlistItem = {
  name: string;
  verdict: DeletionVerdict;
  /** The sentence behind the verdict, written by the module that decided it. */
  reason: string;
  /** Times reached for, per Claude Code's counter. Never added to the next field. */
  invocations: number;
  /** Records produced under attribution. Never added to the previous field. */
  attributedRecords: number;
  mainlineAttributedRecords: number;
  delegatedAttributedRecords: number;
  recordsWithoutTimestamp: number;
  lastInvokedAt: string | null;
  lastAttributedAt: string | null;
  /** Days since the later of the two dates above, which is a comparison of moments. */
  daysSinceNewestEvidence: number | null;
  evidence: EvidenceSource;
  /** "absent" is missing evidence, not a zero. */
  attributionEvidence: "found" | "absent";
  months: SkillMonth[];
  distinctMonths: number;
};

type DeletionShortlist = {
  items: ShortlistItem[];
  counts: Record<DeletionVerdict, number>;
  /** Attribution names that matched no counter entry. Not deletion candidates. */
  attributionWithoutCounter: string[];
  window: AttributionWindow;
  corpus: TranscriptCorpus;
  /** False suppresses every bursty verdict: the window is too narrow to mean anything. */
  burstClassificationAvailable: boolean;
  thresholds: {
    staleDays: number;
    burstStaleDays: number;
    burstMinWindowDays: number;
  };
  note: string;
};

/**
 * Whether the invocation counter could be read at all.
 *
 * An absent or unparseable counter file and a counter that recorded nothing both yield an
 * empty list, and only the second is a measurement. This is what lets the page say
 * "we could not look" instead of "nothing has been invoked".
 */
type CounterSource = { readable: boolean; path: string; skillsRecorded: number };

type SkillTrend = {
  activity: SkillActivityReport;
  shortlist: DeletionShortlist;
  counterSource: CounterSource;
};

function num(value: number): string {
  return value.toLocaleString();
}

function plural(count: number, word: string): string {
  return `${num(count)} ${word}${count === 1 ? "" : "s"}`;
}

function day(iso: string | null): string {
  return iso === null ? "unrecorded" : iso.slice(0, 10);
}

/**
 * How each verdict reads on screen.
 *
 * "no-evidence" is spelled out rather than shown as the raw key, because the
 * difference between "nothing was found" and "this was proven unused" is the whole
 * point of the field and a terse label loses it. Stale and bursty share a colour
 * because the module gives them the same rank: both say the skill went quiet, and
 * which is the better deletion depends on the skill.
 */
const VERDICT: Record<DeletionVerdict, { text: string; badge: string; title: string }> = {
  "no-evidence": {
    text: "no evidence found",
    badge: "badge purple",
    title:
      "The lifetime counter records zero invocations and no attributed records were found. That is the strongest signal available here, and it still reports what was recorded rather than proving the skill was never used.",
  },
  stale: {
    text: "stale",
    badge: "badge spark",
    title:
      "The newest trace from either source is older than the staleness threshold.",
  },
  bursty: {
    text: "bursty",
    badge: "badge spark",
    title:
      "Every dated attributed record falls inside one month, and nothing has been recorded from either source since.",
  },
  keep: {
    text: "keep",
    badge: "badge success",
    // Deliberately does not claim recency: a keep verdict is also what an unknown-age
    // skill gets, and the row's own reason text says which of the two it is.
    title:
      "Not a deletion candidate. The row's reason says whether that is because it is recent or because its age could not be established.",
  },
};

const EVIDENCE_SENTENCE: Record<EvidenceSource, string> = {
  "counter-and-attribution":
    "Both sources have something to say about this skill: the counter recorded invocations and the transcripts carry records.",
  "counter-only":
    "Only the lifetime counter recorded anything. The transcripts on disk carry no records under this name, which is missing evidence rather than zero use.",
  "attribution-only":
    "Only the transcripts carry records. The lifetime counter has never recorded an invocation of this name, which can happen for a skill an agent used rather than one you started.",
  none: "Neither source recorded anything for this name.",
};

/**
 * Columns for a month histogram: the whole attributed window, so a quiet stretch
 * renders as empty columns rather than being left out. Any month a skill carries
 * that the window somehow does not is added rather than dropped.
 */
function monthColumns(windowMonths: string[], months: SkillMonth[]): string[] {
  const columns = new Set(windowMonths);
  for (const entry of months) columns.add(entry.month);
  return [...columns].sort();
}

/**
 * A skill's records per month, drawn as div heights.
 *
 * A month with no records is drawn at zero height on purpose. Giving empty months
 * a minimum sliver would make a single-month burst look like a spread, which is
 * the exact shape this chart exists to expose. Each column keeps a baseline rule so
 * an empty month still reads as a measured zero rather than as a chart that stops.
 */
function MonthHistogram({
  months,
  columns,
  height,
  ticks,
}: {
  months: SkillMonth[];
  columns: string[];
  height: number;
  ticks: boolean;
}) {
  const counts = new Map(months.map((entry) => [entry.month, entry.attributedRecords]));
  const peak = Math.max(1, ...months.map((entry) => entry.attributedRecords));
  return (
    <div className="hour-chart" style={{ gap: 2, margin: "6px 0 0" }}>
      {columns.map((month) => {
        const count = counts.get(month) ?? 0;
        return (
          <div
            className="hour-col"
            key={month}
            title={`${month}: ${plural(count, "attributed record")}`}
          >
            <div
              className="hour-track"
              style={{ height, borderBottom: "1px solid var(--steel-border)" }}
            >
              <div className="hour-bar" style={{ height: `${(count / peak) * 100}%` }} />
            </div>
            {ticks && <div className="hour-tick">{month.slice(5)}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function SkillTrendView() {
  const { data: trend, error } = useApi<SkillTrend>("/api/skill-trend");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const header = (
    <>
      <h1 className="view-title">
        Skill Trend <span className="accent">and Deletion Candidates</span>
      </h1>
      <p className="view-sub">
        when each skill was actually used, month by month, and which ones look like
        candidates to remove - a lifetime counter cannot tell seventeen uses spread
        over six months from seventeen in one week last spring, and only the second
        is worth deleting
      </p>
    </>
  );

  if (error) {
    // A transcript tree that is not there is a first-run state, not a fault, so it
    // gets the same calm panel every other pillar uses for the same condition.
    if (error instanceof SourceMissing) {
      return (
        <div>
          {header}
          <div className="not-configured">
            <div className="not-configured-head">
              <span className="badge info">not configured</span>
              <span className="row-meta">{error.pillar}</span>
            </div>
            <p className="not-configured-lead">
              This pillar shows which month each skill's work actually happened in,
              and ranks the ones that look safe to delete. It reads the transcript
              tree, because that is the only place a timestamp is recorded next to
              the name of the skill a record was produced under.
            </p>
            <div className="not-configured-path">
              <span className="row-meta">looked for</span>
              <code>{error.sourcePath}</code>
            </div>
            <p className="not-configured-how">
              Every Claude Code install writes these transcripts. If they are absent,
              either Claude Code has never run as this user, or cleanupPeriodDays has
              aged them out.
            </p>
            <p className="row-meta">
              Set <code>transcriptsDir</code> in <code>config.json</code>, then
              restart. Run <code>npm run doctor</code> to see every source at once.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div>
        {header}
        <FailureState error={error} />
      </div>
    );
  }

  if (!trend) {
    return (
      <div>
        {header}
        <Skeleton kind="tiles" count={4} label="reading skill attribution..." />
      </div>
    );
  }

  const { activity, shortlist, counterSource } = trend;
  const stats = activity.stats;
  const attributedWindow = shortlist.window;
  const corpus = shortlist.corpus;
  const thresholds = shortlist.thresholds;

  // Zero counts are worth one quiet sentence; a non-zero one changes what the
  // totals cover and gets a sentence of its own.
  const gaps: string[] = [];
  const clean: string[] = [];
  if (stats.skippedLines > 0) {
    gaps.push(
      `${plural(stats.skippedLines, "line")} could not be parsed and are counted in nothing above.`,
    );
  } else clean.push("every line parsed");
  if (stats.transcriptsVanished > 0) {
    gaps.push(
      `${plural(stats.transcriptsVanished, "transcript")} disappeared mid-scan, which a live session can cause, so their records are missing from every figure here.`,
    );
  } else clean.push("no transcript vanished mid-scan");
  if (stats.recordsWithoutTimestamp > 0) {
    gaps.push(
      `${plural(stats.recordsWithoutTimestamp, "attributed record")} carry no timestamp and so belong to no month, which is why a month histogram can add up to less than the record total beside it.`,
    );
  } else clean.push("every attributed record carried a timestamp");

  const byInvocations = [...shortlist.items]
    .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name))
    .slice(0, 6);
  const byRecords = activity.skills.slice(0, 6);

  const candidates = shortlist.items.filter((item) => item.verdict !== "keep");
  const listed = showAll ? shortlist.items : candidates;
  const selectedItem = shortlist.items.find((item) => item.name === selected) ?? null;
  // Sessions and repos live on the attribution half only, and only under the name
  // the transcripts spell. An exact match is the only join shown here; the server
  // can also match a bare name, and guessing at that here would be a second
  // chance to disagree with it.
  const selectedActivity =
    selectedItem === null
      ? null
      : (activity.skills.find((skill) => skill.name === selectedItem.name) ?? null);

  return (
    <div>
      {header}

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="num">{num(stats.attributedRecords)}</div>
          <div className="row-meta">attributed records, not invocations</div>
        </div>
        <div className="stat-tile">
          <div className="num">{num(stats.mainlineAttributedRecords)}</div>
          <div className="row-meta">of those, from your own sessions</div>
        </div>
        <div className="stat-tile">
          <div className="num">{num(stats.delegatedAttributedRecords)}</div>
          <div className="row-meta">of those, from dispatched agents</div>
        </div>
        <div className="stat-tile">
          <div className="num">{num(stats.skillsAttributed)}</div>
          <div className="row-meta">skills carrying any attribution</div>
        </div>
        <div className="stat-tile bounded">
          <div className="num">
            {corpus.spanDays === null ? "unknown" : num(corpus.spanDays)}
          </div>
          <div className="row-meta">days of transcripts searched</div>
        </div>
      </div>
      <RailLegend present={["measured", "bounded"]} />

      <p className="row-meta" style={{ marginTop: -8, lineHeight: 1.55 }}>
        {plural(stats.transcriptsScanned, "transcript")} read:{" "}
        {num(stats.mainlineTranscriptsScanned)} from your own sessions and{" "}
        {num(stats.subagentTranscriptsScanned)} written by agents those sessions
        dispatched. A record is one unit of work produced while a skill was
        attributed, so a single invocation can leave hundreds; this measures how much
        work happened inside a skill and never how often you started it.
        {corpus.recordsWithoutTimestamp > 0 &&
          ` Of the ${num(corpus.records)} records read, ${num(corpus.recordsWithoutTimestamp)} carry no usable timestamp and so sit outside the searched span above.`}
      </p>
      {gaps.map((sentence) => (
        <p className="row-meta" key={sentence} style={{ lineHeight: 1.55 }}>
          {sentence}
        </p>
      ))}
      {clean.length > 0 && (
        <p className="row-meta" style={{ marginBottom: 22 }}>
          Nothing was dropped in the read: {clean.join(", ")}.
        </p>
      )}

      <h3>Two counters, two units</h3>
      <p className="row-meta" style={{ marginTop: -4, marginBottom: 10, lineHeight: 1.55 }}>
        These two figures are never added, averaged, or shown as one number. The
        counter says how many times you reached for a skill; attribution says how much
        work happened inside it. They rank the same skills in different orders, and
        both orders are correct about the thing they measure.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 14,
        }}
      >
        <div className="card">
          <div className="row-meta" style={{ marginBottom: 8 }}>
            heaviest by invocations, from Claude Code's lifetime counter
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>skill</th>
                <th className="num-cell">invocations (times reached for)</th>
              </tr>
            </thead>
            <tbody>
              {byInvocations.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td className="num-cell">{num(item.invocations)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="row-meta" style={{ marginBottom: 8 }}>
            heaviest by attribution, from the transcripts on disk
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>skill</th>
                <th className="num-cell">records (work produced inside)</th>
              </tr>
            </thead>
            <tbody>
              {byRecords.map((skill) => (
                <tr key={skill.name}>
                  <td>{skill.name}</td>
                  <td className="num-cell">{num(skill.attributedRecords)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 style={{ marginTop: 26 }}>How much history can answer this</h3>
      <div className="card">
        <p style={{ margin: "0 0 10px", lineHeight: 1.55 }}>
          Transcripts get pruned, and the field that names the skill behind a record
          is newer than some of the history. Two spans follow from that, and they are
          not interchangeable: the corpus is how much history was read, and the
          window is the shorter stretch of it that carries any attribution at all.
          Every sentence on this page reporting that nothing was found quotes the
          corpus, because that is what was searched.
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>span</th>
              <th>from</th>
              <th>to</th>
              <th className="num-cell">days</th>
              <th>what it bounds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>transcripts on disk</td>
              <td>{day(corpus.firstRecordAt)}</td>
              <td>{day(corpus.lastRecordAt)}</td>
              <td className="num-cell">
                {corpus.spanDays === null ? "unknown" : num(corpus.spanDays)}
              </td>
              <td>
                {num(corpus.records)} records read, whatever they were attributed to
              </td>
            </tr>
            <tr>
              <td>attributed window</td>
              <td>{day(attributedWindow.firstAttributedAt)}</td>
              <td>{day(attributedWindow.lastAttributedAt)}</td>
              <td className="num-cell">
                {attributedWindow.spanDays === null ? "unknown" : num(attributedWindow.spanDays)}
              </td>
              <td>
                {plural(attributedWindow.months.length, "calendar month")} covered, gaps
                included; every histogram below is drawn against these
              </td>
            </tr>
          </tbody>
        </table>
        <p className="row-meta" style={{ marginTop: 12, lineHeight: 1.55 }}>
          A skill reaches the list as stale when the newest trace from either source
          is more than {thresholds.staleDays} days old. A single month of use counts
          against a skill only after {thresholds.burstStaleDays} days of silence
          since.
        </p>
        <div style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
          {shortlist.burstClassificationAvailable ? (
            <span className="badge info">burst test available</span>
          ) : (
            <span className="badge ember">burst test unavailable</span>
          )}
          <span className="row-meta" style={{ flex: 1, minWidth: 260, lineHeight: 1.55 }}>
            {shortlist.burstClassificationAvailable
              ? `The attributed window spans ${attributedWindow.spanDays === null ? "an unknown stretch" : plural(attributedWindow.spanDays, "day")}, at or past the ${thresholds.burstMinWindowDays} days needed before "all use in one month" can describe a habit rather than the width of the window.`
              : `Every bursty verdict is suppressed. The attributed window spans ${attributedWindow.spanDays === null ? "no measurable stretch of time" : plural(attributedWindow.spanDays, "day")}, short of the ${thresholds.burstMinWindowDays} days needed before "all use in one month" says anything about a habit. In a window this narrow almost every skill has all of its records in one month, which is a property of the window and not of your habits. Read a single-month histogram below as "the window is short", not as a burst.`}
          </span>
        </div>
      </div>

      <h3 style={{ marginTop: 26 }}>Where attributed work happened</h3>
      {/* Every count here needs its unit in its own header, which makes the row
          wider than a narrow window. It scrolls inside its own box rather than
          pushing the page sideways, and no header is shortened to fit. */}
      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>skill</th>
              <th className="num-cell">records</th>
              <th className="num-cell">mainline records</th>
              <th className="num-cell">delegated records</th>
              <th className="num-cell">sessions</th>
              <th className="num-cell">repos</th>
              <th className="num-cell">months</th>
              <th style={{ width: "20%" }}>records by month, across the window</th>
            </tr>
          </thead>
          <tbody>
            {activity.skills.map((skill) => (
              <tr key={skill.name}>
                <td>
                  <div>{skill.name}</div>
                  <div className="row-meta">
                    {day(skill.firstAttributedAt)} to {day(skill.lastAttributedAt)}
                    {skill.busiestMonth !== null && `, heaviest ${skill.busiestMonth}`}
                    {skill.recordsWithoutTimestamp > 0 &&
                      `, ${num(skill.recordsWithoutTimestamp)} records undated and in no month`}
                  </div>
                </td>
                <td className="num-cell">{num(skill.attributedRecords)}</td>
                <td className="num-cell">{num(skill.mainlineAttributedRecords)}</td>
                <td className="num-cell">{num(skill.delegatedAttributedRecords)}</td>
                <td className="num-cell">{num(skill.sessionsAttributed)}</td>
                <td className="num-cell">{num(skill.projectsAttributed)}</td>
                <td className="num-cell">{num(skill.distinctMonths)}</td>
                <td>
                  <MonthHistogram
                    months={skill.months}
                    columns={monthColumns(attributedWindow.months, skill.months)}
                    height={26}
                    ticks={false}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="row-meta" style={{ marginTop: 12, lineHeight: 1.55 }}>
        Every column here is a record count, never an invocation count. Sessions
        credit a delegated transcript to the conversation that dispatched it, so a
        skill used by six agents of one conversation counts as one session.{" "}
        {activity.note}
      </p>

      <h3 style={{ marginTop: 26 }}>Deletion candidates</h3>
      <p style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
        A ranked list to read, not an instruction. Nothing on this page removes
        anything, and no verdict here is a decision: each row carries the sentence
        behind it and the two spans that bound it, and the choice is yours.
      </p>
      <p className="row-meta" style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
        These names come from Claude Code's own counter, which counts every slash command
        it was asked for - including its built-in ones, which are not installed skills and
        cannot be deleted. A row is a name that was invoked, not a file you own; check that
        a candidate corresponds to something in your skills directory before acting on it.
        The mirror case is listed further down: attributed names that matched no counter
        entry are shown rather than dropped, and are likewise not candidates.
      </p>
      <div className="toolbar">
        <button
          className={`chip${showAll ? "" : " active"}`}
          onClick={() => setShowAll(false)}
        >
          candidates ({candidates.length})
        </button>
        <button
          className={`chip${showAll ? " active" : ""}`}
          onClick={() => setShowAll(true)}
        >
          every counted skill ({shortlist.items.length})
        </button>
        <span className="row-meta">
          {num(shortlist.counts["no-evidence"])} no evidence found,{" "}
          {num(shortlist.counts.stale)} stale, {num(shortlist.counts.bursty)} bursty,{" "}
          {num(shortlist.counts.keep)} keep
          {!shortlist.burstClassificationAvailable &&
            " - bursty reads 0 partly because the test is suppressed on a window this narrow"}
        </span>
      </div>

      {listed.length === 0 ? (
        <div className="empty-state">
          {shortlist.items.length === 0
            ? counterSource.readable
              ? "Claude Code's usage counter is readable and recorded no skills, so no candidate list can be built. Attribution alone cannot judge a deletion: a skill missing from the transcripts may simply predate the field."
              : "Claude Code's usage counter could not be read, so no candidate list can be built. That is a source this panel could not open, not a measurement that nothing has ever been invoked."
            : `No skill met the thresholds. None of the ${num(shortlist.items.length)} counted skills has evidence older than ${thresholds.staleDays} days - and for one whose age could not be established, that means no usable date was found rather than a recent one.`}
        </div>
      ) : (
        <div className="split">
          <div>
            {listed.map((item) => {
              const verdict = VERDICT[item.verdict];
              return (
                <div
                  className={`card list-row${selected === item.name ? " selected" : ""}`}
                  key={item.name}
                  onClick={() => setSelected(item.name)}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                      flexWrap: "wrap",
                    }}
                  >
                    <span className={verdict.badge} title={verdict.title}>
                      {verdict.text}
                    </span>
                    {item.attributionEvidence === "absent" && (
                      <span
                        className="chip static"
                        title="No record under this name was found in the transcripts on disk. Attribution is newer than some of the history and old transcripts are pruned, so this is missing evidence rather than proof of disuse."
                      >
                        no attributed records
                      </span>
                    )}
                    <span className="row-meta">
                      {item.daysSinceNewestEvidence === null
                        ? "no usable date from either source"
                        : `${plural(item.daysSinceNewestEvidence, "day")} since the newest trace`}
                    </span>
                  </div>
                  <div style={{ margin: "7px 0 0", color: "var(--text)" }}>
                    {item.name}
                  </div>
                  <div className="row-meta" style={{ marginTop: 4, lineHeight: 1.5 }}>
                    {plural(item.invocations, "invocation")} (times reached for) and{" "}
                    {plural(item.attributedRecords, "attributed record")} (work
                    produced inside)
                    {item.attributedRecords > 0 &&
                      `, of which ${num(item.mainlineAttributedRecords)} mainline and ${num(item.delegatedAttributedRecords)} delegated`}
                    {item.recordsWithoutTimestamp > 0 &&
                      `; ${num(item.recordsWithoutTimestamp)} of those records carry no timestamp and are in no month`}
                  </div>
                  <p style={{ margin: "9px 0 0", lineHeight: 1.5 }}>{item.reason}</p>
                  {item.months.length > 0 ? (
                    <MonthHistogram
                      months={item.months}
                      columns={monthColumns(attributedWindow.months, item.months)}
                      height={22}
                      ticks={false}
                    />
                  ) : (
                    <div className="row-meta" style={{ marginTop: 7 }}>
                      no month can be drawn: the transcripts read carry no record
                      under this name
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="detail-pane">
            {selectedItem === null ? (
              <div className="empty-state">
                select a skill to see its months, its dates, and what bounds its
                verdict
              </div>
            ) : (
              <div className="card">
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    flexWrap: "wrap",
                    marginBottom: 8,
                  }}
                >
                  <span
                    className={VERDICT[selectedItem.verdict].badge}
                    title={VERDICT[selectedItem.verdict].title}
                  >
                    {VERDICT[selectedItem.verdict].text}
                  </span>
                  <span style={{ color: "var(--text)" }}>{selectedItem.name}</span>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>measure</th>
                      <th className="num-cell">value</th>
                      <th>unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>lifetime counter</td>
                      <td className="num-cell">{num(selectedItem.invocations)}</td>
                      <td>invocations, times the skill was reached for</td>
                    </tr>
                    <tr>
                      <td>transcript attribution</td>
                      <td className="num-cell">
                        {num(selectedItem.attributedRecords)}
                      </td>
                      <td>records produced while this skill was attributed</td>
                    </tr>
                    <tr>
                      <td>of those, mainline</td>
                      <td className="num-cell">
                        {num(selectedItem.mainlineAttributedRecords)}
                      </td>
                      <td>records from your own conversations</td>
                    </tr>
                    <tr>
                      <td>of those, delegated</td>
                      <td className="num-cell">
                        {num(selectedItem.delegatedAttributedRecords)}
                      </td>
                      <td>records from agents a conversation dispatched</td>
                    </tr>
                    <tr>
                      <td>undated records</td>
                      <td className="num-cell">
                        {num(selectedItem.recordsWithoutTimestamp)}
                      </td>
                      <td>
                        attributed records in no month, so absent from the histogram
                      </td>
                    </tr>
                    <tr>
                      <td>months with records</td>
                      <td className="num-cell">{num(selectedItem.distinctMonths)}</td>
                      <td>
                        calendar months touched, out of{" "}
                        {num(attributedWindow.months.length)} in the window
                      </td>
                    </tr>
                    {selectedActivity !== null && (
                      <>
                        <tr>
                          <td>sessions</td>
                          <td className="num-cell">
                            {num(selectedActivity.sessionsAttributed)}
                          </td>
                          <td>conversations carrying at least one such record</td>
                        </tr>
                        <tr>
                          <td>repos</td>
                          <td className="num-cell">
                            {num(selectedActivity.projectsAttributed)}
                          </td>
                          <td>distinct project directories it was used in</td>
                        </tr>
                      </>
                    )}
                  </tbody>
                </table>

                <p className="row-meta" style={{ marginTop: 12, lineHeight: 1.55 }}>
                  Last invoked {day(selectedItem.lastInvokedAt)}; last attributed{" "}
                  {day(selectedItem.lastAttributedAt)}.{" "}
                  {selectedItem.daysSinceNewestEvidence === null
                    ? "Neither source recorded a usable date, so no age can be established and none is guessed at."
                    : `The age used above, ${plural(selectedItem.daysSinceNewestEvidence, "day")}, is measured from the later of those two dates. Comparing two moments is legitimate; the two counts are different units and are never combined.`}
                </p>
                <p className="row-meta" style={{ lineHeight: 1.55 }}>
                  {EVIDENCE_SENTENCE[selectedItem.evidence]}
                  {selectedActivity === null &&
                    " Sessions and repos are shown only when the transcripts spell this skill exactly as the counter does, so they are omitted here rather than joined on a guess."}
                </p>

                <p style={{ margin: "12px 0 0", lineHeight: 1.5 }}>
                  {selectedItem.reason}
                </p>

                {selectedItem.months.length > 0 ? (
                  <>
                    <div className="row-meta" style={{ marginTop: 14 }}>
                      records by month, drawn across the whole attributed window so a
                      quiet month is an empty column
                    </div>
                    <MonthHistogram
                      months={selectedItem.months}
                      columns={monthColumns(attributedWindow.months, selectedItem.months)}
                      height={58}
                      ticks
                    />
                    <div className="row-meta">
                      {selectedItem.months
                        .map(
                          (entry) =>
                            `${entry.month}: ${num(entry.attributedRecords)}`,
                        )
                        .join("   ")}
                    </div>
                  </>
                ) : (
                  <p className="row-meta" style={{ marginTop: 14, lineHeight: 1.55 }}>
                    No histogram can be drawn. The{" "}
                    {corpus.spanDays === null
                      ? "transcripts read"
                      : `${plural(corpus.spanDays, "day")} of transcripts read`}{" "}
                    carry no record under this name, which bounds what can be said
                    about it: absence here is evidence that was never available, not a
                    measured zero.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <p className="row-meta" style={{ marginTop: 16, lineHeight: 1.55 }}>
        {shortlist.attributionWithoutCounter.length === 0
          ? "Every attributed name matched an entry in the counter, so nothing attributed was left out of the list above."
          : `${plural(shortlist.attributionWithoutCounter.length, "attributed name")} matched no counter entry and are listed rather than dropped, because built-in skills and bundled commands are attributed in transcripts yet never appear in a skills inventory. They are not deletion candidates: ${shortlist.attributionWithoutCounter.join(", ")}.`}
      </p>
      <p className="row-meta" style={{ lineHeight: 1.55 }}>
        {shortlist.note}
      </p>
    </div>
  );
}
