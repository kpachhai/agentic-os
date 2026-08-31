import { useEffect, useState } from "react";
import { useApi } from "../api";
import { compact } from "../format";
import { FailureState, RailLegend, Skeleton } from "../PillarState";
import { useSorted, useSortState } from "../sortable";

import type { Caveat, DelegationMonth, DelegationReport } from "../delegation-types";
import { count, day, shortProject, span } from "../delegation-report";

/**
 * The caveat figures, with the zeros collapsed into one line.
 *
 * A zero is worth stating quietly - the scan looked and found nothing, which is not
 * the same as never looking - while a non-zero one gets a row of its own, because it
 * names records that are missing from the totals above it.
 */
function Caveats({ caveats }: { caveats: Caveat[] }) {
  const present = caveats.filter((caveat) => caveat.value > 0);
  const absent = caveats.filter((caveat) => caveat.value === 0);
  return (
    <>
      {present.length === 0 ? (
        <p className="row-meta">
          Nothing was lost, skipped or clamped on this scan; every count below is zero.
        </p>
      ) : (
        <table className="data-table">
          <tbody>
            {present.map((caveat) => (
              <tr key={caveat.label}>
                <td className="num-cell" style={{ width: 96 }}>
                  {count(caveat.value)}
                </td>
                <td>
                  <div style={{ color: "var(--text)" }}>{caveat.label}</div>
                  <div className="row-meta" style={{ marginTop: 3, lineHeight: 1.5 }}>
                    {caveat.why}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {absent.length > 0 && (
        <p className="row-meta" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Zero on this scan, all of them looked for: {absent.map((c) => c.label).join("; ")}.
        </p>
      )}
    </>
  );
}

/**
 * Dispatches per calendar month.
 *
 * Every month between the first dispatch and the month this was read is present,
 * quiet ones as zero, so the series is continuous and a gap in the habit draws as a
 * gap rather than closing up.
 */
function MonthTrend({ months }: { months: DelegationMonth[] }) {
  const peak = months.reduce((max, month) => Math.max(max, month.dispatches), 1);
  // With ten years of buckets available every tick would collide, so roughly a
  // dozen labels are kept and the rest read from the hover title.
  const step = Math.max(1, Math.ceil(months.length / 12));
  return (
    <div className="hour-chart">
      {months.map((month, index) => (
        // Capped rather than left to fill the row: a corpus one month old has two
        // buckets, and two columns sharing the whole width drew a figure the size of
        // a banner out of 60 dispatches.
        <div className="hour-col" key={month.month} style={{ maxWidth: 54 }}>
          <div
            className="hour-track"
            title={`${month.month}: ${count(month.dispatches)} dispatches`}
          >
            <div
              className="hour-bar"
              style={{ height: `${(month.dispatches / peak) * 100}%` }}
            />
          </div>
          <div className="hour-tick">
            {index === months.length - 1 || index % step === 0
              ? month.month.slice(2)
              : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 7 }}>
      <div className="row-meta" style={{ width: 132, flexShrink: 0 }}>
        {label}
      </div>
      <div style={{ minWidth: 0 }}>
        <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
          {value}
        </span>
        {note !== undefined && (
          <div className="row-meta" style={{ marginTop: 2, lineHeight: 1.5 }}>
            {note}
          </div>
        )}
      </div>
    </div>
  );
}

/** The result side reads in blue throughout, so it is never mistaken for a request. */
const RESULT_COLOR = "var(--info)";

export function DelegationView() {
  const { data: report, error } = useApi<DelegationReport>("/api/delegation");
  const [openType, setOpenType] = useState<string | null>(null);

  const [sort, onSort] = useSortState();

  // Ordering only. A specialist's figures are whatever the payload said; nothing
  // here recomputes a total or a share from the order on screen. Called above the
  // early returns because a hook that runs only on the loaded render is a hook
  // order violation, which React fails on rather than tolerates.
  const sortedTypes = useSorted(
    report?.bySubagentType ?? [],
    {
      dispatches: (row) => row.dispatches,
      records: (row) => row.delegatedWork?.records ?? null,
      tokens: (row) => row.delegatedWork?.outputTokens ?? null,
      wallClock: (row) => row.delegatedWork?.wallClockMs ?? null,
    },
    sort,
  );

  const header = (
    <>
      <h1 className="view-title">
        What You <span className="accent">Handed Off</span>
      </h1>
      <p className="view-sub">
        under-delegation leaves no trace, so this counts both sides separately: the
        dispatch tool calls your sessions recorded, and the subagent transcripts that
        came back and sit on disk beside them
      </p>
    </>
  );

  if (error) {
    return (
      <div>
        {header}
        <FailureState error={error} />
      </div>
    );
  }
  if (!report) {
    return (
      <div>
        {header}
        <Skeleton kind="tiles" count={4} label="reading every transcript on this machine..." />
      </div>
    );
  }

  const { totals, evidence, byMonth, bySubagentType, limitation } = report;


  // The totals carry no denominator for their delegated figures and the rows do.
  // Every specialist the delegated scan found becomes a row, so summing the rows
  // covers the same corpus the totals were built from; kept as a visible sum rather
  // than presented as a figure the server reported.
  const recordsWithUsage = bySubagentType.reduce(
    (sum, row) => sum + (row.delegatedWork?.recordsWithUsage ?? 0),
    0,
  );
  const transcriptsWithoutSpan = bySubagentType.reduce(
    (sum, row) => sum + (row.delegatedWork?.transcriptsWithoutSpan ?? 0),
    0,
  );
  const promptCharsMissing = bySubagentType.reduce(
    (sum, row) => sum + row.promptCharsMissing,
    0,
  );
  const dispatchedWithNothingBack = bySubagentType.filter(
    (row) => row.dispatches > 0 && row.delegatedWork === null,
  ).length;
  const workWithoutADispatch = bySubagentType.filter(
    (row) => row.dispatches === 0 && row.delegatedWork !== null,
  ).length;

  const mostDispatches = bySubagentType.reduce(
    (max, row) => Math.max(max, row.dispatches),
    1,
  );
  const mostRecords = bySubagentType.reduce(
    (max, row) => Math.max(max, row.delegatedWork?.records ?? 0),
    1,
  );

  // Opening on the busiest specialist rather than an empty pane: the first thing
  // worth reading is where the work actually went.
  const selected =
    bySubagentType.find((row) => row.subagentType === openType) ??
    bySubagentType[0] ??
    null;
  const work = selected?.delegatedWork ?? null;

  const caveats: Caveat[] = [
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

  return (
    <div>
      {header}

      <RailLegend present={["measured", "derived", "bounded"]} />

      <h3 style={{ marginTop: 0 }}>Dispatches: the requests</h3>
      <div className="stat-grid" style={{ marginBottom: 10 }}>
        <div className="stat-tile">
          <div className="num">{count(totals.dispatches)}</div>
          <div className="row-meta">dispatch tool calls</div>
        </div>
        <div className="stat-tile">
          <div className="num">{count(totals.subagentTypes)}</div>
          <div className="row-meta">specialists asked</div>
        </div>
        <div className="stat-tile">
          <div className="num">{count(totals.sessions)}</div>
          <div className="row-meta">sessions that delegated</div>
        </div>
        <div className="stat-tile">
          <div className="num">{count(totals.projects)}</div>
          <div className="row-meta">projects</div>
        </div>
        <div className="stat-tile derived">
          <div className="num">
            {totals.medianPromptChars === null
              ? "none"
              : count(totals.medianPromptChars)}
          </div>
          <div className="row-meta">median briefing, chars</div>
        </div>
      </div>
      <p className="row-meta" style={{ lineHeight: 1.6, marginTop: 0 }}>
        {count(totals.backgroundDispatches)} were launched detached and{" "}
        {count(totals.inlineDispatches)} ran inline while the caller waited
        {totals.launchModeUnknownDispatches > 0
          ? `, and ${count(totals.launchModeUnknownDispatches)} cannot be told apart`
          : ""}
        . Which side a dispatch falls on is read from the result record and never from
        the request, because the request's own flag is opt-out:{" "}
        {count(evidence.dispatchesRequestingBackgroundExplicitly)} asked for detached
        explicitly, {count(evidence.dispatchesRequestingInlineExplicitly)} asked for
        inline, and {count(evidence.dispatchesWithNoBackgroundFlag)} carried no flag at
        all, which does not mean they ran inline. The median briefing is one real
        dispatch's length rather than an average of two neighbours, and no prompt text
        leaves the server.{" "}
        {totals.modelOverrides > 0
          ? `${count(totals.modelOverrides)} dispatches named a model instead of inheriting the caller's. `
          : "No dispatch named a model; every one inherited the caller's. "}
        {totals.worktreeIsolatedDispatches > 0
          ? `${count(totals.worktreeIsolatedDispatches)} asked for an isolated worktree, which means they write files. `
          : ""}
        First on {day(totals.firstDispatchAt)}, last on {day(totals.lastDispatchAt)}.
      </p>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="row-meta">launch statuses the results reported:</span>
        {evidence.dispatchOutcomeStatuses.length === 0 ? (
          <span className="row-meta">none</span>
        ) : (
          evidence.dispatchOutcomeStatuses.map((outcome) => (
            <span className="chip static" key={outcome.status}>
              {outcome.status} {count(outcome.dispatches)}
            </span>
          ))
        )}
      </div>

      <h3 style={{ marginTop: 22, color: RESULT_COLOR }}>
        Delegated transcripts: what came back
      </h3>
      <div className="stat-grid" style={{ marginBottom: 10 }}>
        <div className="stat-tile" style={{ borderTop: `2px solid ${RESULT_COLOR}` }}>
          <div className="num">{count(totals.delegatedTranscripts)}</div>
          <div className="row-meta">delegated transcripts</div>
        </div>
        <div className="stat-tile" style={{ borderTop: `2px solid ${RESULT_COLOR}` }}>
          <div className="num">{count(totals.delegatedRecords)}</div>
          <div className="row-meta">records they wrote</div>
        </div>
        <div className="stat-tile" style={{ borderTop: `2px solid ${RESULT_COLOR}` }}>
          <div className="num">{count(totals.delegatedToolCalls)}</div>
          <div className="row-meta">tool calls they made</div>
        </div>
        <div className="stat-tile derived" style={{ borderTop: `2px solid ${RESULT_COLOR}` }}>
          <div className="num">
            {totals.delegatedOutputTokens === null
              ? "none"
              : compact(totals.delegatedOutputTokens)}
          </div>
          <div className="row-meta">output tokens, not a cost</div>
        </div>
        <div className="stat-tile bounded" style={{ borderTop: `2px solid ${RESULT_COLOR}` }}>
          <div className="num">
            {totals.delegatedWallClockMs === null
              ? "none"
              : span(totals.delegatedWallClockMs)}
          </div>
          <div className="row-meta">delegated span, not a wait</div>
        </div>
        <div className="stat-tile" style={{ borderTop: `2px solid ${RESULT_COLOR}` }}>
          <div className="num">{count(totals.sessionsWithDelegatedWork)}</div>
          <div className="row-meta">sessions with work on disk</div>
        </div>
      </div>
      <p className="row-meta" style={{ lineHeight: 1.6, marginTop: 0 }}>
        The span is each run's first record to its last, summed over the transcripts -
        not time anybody spent waiting, and not billable time; a detached run's span
        keeps counting while you work on something else, which is why several of these
        overlap.{" "}
        {transcriptsWithoutSpan > 0
          ? `${count(transcriptsWithoutSpan)} transcripts have fewer than two usable timestamps, so no span exists for them and they add nothing to that figure. `
          : ""}
        {totals.delegatedOutputTokens === null
          ? "No delegated record carried a usage block, so no token figure is shown rather than a zero, which would read as runs that wrote nothing. "
          : `Output tokens are summed from the ${count(recordsWithUsage)} of ${count(
              totals.delegatedRecords,
            )} delegated records that carried a usage block, so the rest of them contribute nothing to it. `}
        These are files on disk, not answers: nothing here says whether any of this
        work was read, used, or thrown away.
      </p>

      <h3 style={{ marginTop: 22 }}>What these numbers do not mean</h3>
      <div
        className="card"
        style={{ borderLeft: "2px solid var(--primary)", maxWidth: 860 }}
      >
        <p style={{ margin: 0, color: "var(--text-body)", lineHeight: 1.65 }}>
          {limitation}
        </p>
      </div>

      <h3 style={{ marginTop: 22 }}>Where the two sides disagree</h3>
      <p className="row-meta" style={{ lineHeight: 1.6, marginTop: -6 }}>
        A dispatch is a request and a delegated transcript is what came back. They are
        counted separately and are not required to agree, so the gap is itself a
        figure rather than something to reconcile away.
      </p>
      <table className="data-table" style={{ maxWidth: 860 }}>
        <tbody>
          <tr>
            <td className="num-cell" style={{ width: 96 }}>
              {count(evidence.dispatchesWithMatchingSubagentTranscript)}
            </td>
            <td>
              of {count(totals.dispatches)} dispatches have a transcript on disk
              carrying the agent id their result named.
            </td>
          </tr>
          <tr>
            <td className="num-cell">
              {count(evidence.dispatchesWithoutMatchingSubagentTranscript)}
            </td>
            <td>
              do not. A detached run whose transcript was deleted and a teammate that
              writes its own session elsewhere both leave a request with nothing on
              disk to show for it.
            </td>
          </tr>
          <tr>
            <td className="num-cell">
              {count(evidence.subagentTranscriptsWhoseOwnerSessionNeverDispatched)}
            </td>
            <td>
              delegated transcripts sit beside a session that recorded no dispatch at
              all - the same disagreement in the other direction.
            </td>
          </tr>
          <tr>
            <td className="num-cell">
              {count(evidence.workflowAgentTranscriptFiles)}
            </td>
            <td>
              of {count(evidence.subagentTranscriptFiles)} delegated transcripts were
              written by agents an orchestration script spawned rather than by a
              dispatch tool call, so they appear in the result figures with no request
              to pair with.
            </td>
          </tr>
          <tr>
            <td className="num-cell">{count(workWithoutADispatch)}</td>
            <td>
              specialists below have delegated work on disk and not one dispatch;{" "}
              {count(dispatchedWithNothingBack)} have dispatches and nothing on disk.
            </td>
          </tr>
        </tbody>
      </table>

      <h3 style={{ marginTop: 22 }}>Dispatches by month</h3>
      {byMonth.length === 0 ? (
        <div className="empty-state">
          no dispatch carried a usable timestamp, so there is no trend to draw
        </div>
      ) : (
        <>
          <MonthTrend months={byMonth} />
          <p className="row-meta" style={{ lineHeight: 1.6, marginTop: -12 }}>
            Quiet months are present as zero, so this is a continuous series and a
            gap in the habit reads as a gap. The last bucket is the month this was
            read in
            {evidence.trendThroughMonth === null
              ? ""
              : ` (${evidence.trendThroughMonth})`}
            , not the last month with any activity - a bar at zero on the right means
            nothing was handed off this month.
          </p>
        </>
      )}

      <h3 style={{ marginTop: 22 }}>By specialist</h3>
      {/* A card list, so ordering is offered as chips rather than as column
          headings. The result side was only ever readable in dispatch order, which
          hid that the busiest specialist by request is not the one that produced the
          most work. */}
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <span className="row-meta">order by</span>
        {(
          [
            ["dispatches", "times asked"],
            ["records", "records produced"],
            ["tokens", "output tokens"],
            ["wallClock", "delegated span"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`chip${sort?.key === key ? " active" : ""}`}
            onClick={() => onSort(key)}
          >
            {label}
            {sort?.key === key && (sort.direction === "asc" ? " up" : " down")}
          </button>
        ))}
      </div>
      <p className="row-meta" style={{ marginTop: -6, marginBottom: 12 }}>
        purple is what was asked of it; blue is what came back. Busiest first, and a
        specialist with work on disk but no dispatch keeps its place rather than
        disappearing.
      </p>
      <div className="split">
        <div>
          {sortedTypes.map((row) => {
            const rowWork = row.delegatedWork;
            return (
              <div
                className={`card list-row${
                  selected?.subagentType === row.subagentType ? " selected" : ""
                }`}
                key={row.subagentType}
                onClick={() => setOpenType(row.subagentType)}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ color: "var(--text)" }}>{row.subagentType}</span>
                  {row.dispatches === 0 && (
                    <span
                      className="badge info"
                      title="work on disk that no dispatch tool call asked for; an orchestration script's agents arrive this way"
                    >
                      no dispatch
                    </span>
                  )}
                  {rowWork === null && (
                    <span
                      className="badge warn"
                      title="dispatched, but no transcript on disk is attributed to it; that is not the same as having produced nothing"
                    >
                      nothing on disk
                    </span>
                  )}
                </div>

                <div className="bar-cell" style={{ marginTop: 8 }}>
                  <span className="row-meta" style={{ width: 116, flexShrink: 0 }}>
                    {count(row.dispatches)} dispatched
                  </span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(row.dispatches / mostDispatches) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="bar-cell" style={{ marginTop: 5 }}>
                  <span className="row-meta" style={{ width: 116, flexShrink: 0 }}>
                    {count(rowWork?.records ?? 0)} records
                  </span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${((rowWork?.records ?? 0) / mostRecords) * 100}%`,
                        background: RESULT_COLOR,
                      }}
                    />
                  </div>
                </div>

                <div className="row-meta" style={{ marginTop: 7 }}>
                  {row.dispatches === 0
                    ? `no dispatching session on record; ${count(
                        rowWork?.transcripts ?? 0,
                      )} transcripts beside ${count(
                        rowWork?.owningSessions ?? 0,
                      )} sessions`
                    : `${count(row.sessions)} session${
                        row.sessions === 1 ? "" : "s"
                      } dispatched it, ${count(
                        rowWork?.transcripts ?? 0,
                      )} transcript${
                        (rowWork?.transcripts ?? 0) === 1 ? "" : "s"
                      } back`}
                </div>
              </div>
            );
          })}
        </div>

        <div className="detail-pane">
          {selected === null ? (
            <div className="empty-state">
              no dispatch and no delegated transcript anywhere in the corpus
            </div>
          ) : (
            <div className="card">
              <div style={{ color: "var(--text)", marginBottom: 12 }}>
                {selected.subagentType}
              </div>

              <div className="row-meta" style={{ marginBottom: 8 }}>
                the request side
              </div>
              {selected.dispatches === 0 ? (
                <p className="row-meta" style={{ lineHeight: 1.55, marginTop: 0 }}>
                  No dispatch tool call anywhere in the corpus named this specialist.
                  Its work below was found on disk beside a session, which is how an
                  orchestration script's agents and a run whose caller was never
                  recorded both arrive.
                </p>
              ) : (
                <>
                  <Field
                    label="dispatches"
                    value={count(selected.dispatches)}
                    note={`across ${count(selected.sessions)} session${
                      selected.sessions === 1 ? "" : "s"
                    } and ${count(selected.projects.length)} project${
                      selected.projects.length === 1 ? "" : "s"
                    }`}
                  />
                  <Field
                    label="first, last"
                    value={`${day(selected.firstDispatchAt)} to ${day(
                      selected.lastDispatchAt,
                    )}`}
                  />
                  <Field
                    label="launch"
                    value={`${count(selected.backgroundDispatches)} detached, ${count(
                      selected.inlineDispatches,
                    )} inline${
                      selected.launchModeUnknownDispatches > 0
                        ? `, ${count(selected.launchModeUnknownDispatches)} unknown`
                        : ""
                    }`}
                    note="read from the paired result, never from the request's opt-out flag"
                  />
                  <Field
                    label="median briefing"
                    value={
                      selected.medianPromptChars === null
                        ? "no prompt recorded"
                        : `${count(selected.medianPromptChars)} chars`
                    }
                    note={
                      selected.promptCharsMissing > 0
                        ? `${count(
                            selected.promptCharsMissing,
                          )} dispatches carried no prompt string, so they are outside this median`
                        : "an observed length, so it is the size of one real briefing"
                    }
                  />
                  <Field
                    label="model"
                    value={
                      selected.modelOverrides === 0
                        ? "inherited the caller's"
                        : `${count(selected.modelOverrides)} overrode it`
                    }
                    note={
                      selected.modelsRequested.length === 0
                        ? undefined
                        : `asked for ${selected.modelsRequested.join(", ")}`
                    }
                  />
                  {selected.worktreeIsolatedDispatches > 0 && (
                    <Field
                      label="isolated"
                      value={`${count(selected.worktreeIsolatedDispatches)} in a worktree`}
                      note="an isolated worktree means the run writes files"
                    />
                  )}
                  {selected.projects.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="row-meta" style={{ marginBottom: 6 }}>
                        where it was dispatched
                      </div>
                      {selected.projects.map((project) => (
                        <div
                          className="bar-cell"
                          key={project.projectDir}
                          style={{ marginBottom: 5 }}
                        >
                          <span
                            className="row-meta"
                            style={{
                              width: 168,
                              flexShrink: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={`${project.label} - a transcript directory name whose separators were flattened, so it is not a usable path`}
                          >
                            {shortProject(project.label)}
                          </span>
                          <div className="bar-track">
                            <div
                              className="bar-fill"
                              style={{
                                width: `${
                                  (project.dispatches / selected.dispatches) * 100
                                }%`,
                              }}
                            />
                          </div>
                          <span className="row-meta">{count(project.dispatches)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div
                className="row-meta"
                style={{
                  margin: "16px 0 8px",
                  borderTop: "1px solid var(--steel-border)",
                  paddingTop: 12,
                  color: RESULT_COLOR,
                }}
              >
                what came back
              </div>
              {work === null ? (
                <p className="row-meta" style={{ lineHeight: 1.55, marginTop: 0 }}>
                  No subagent transcript on disk is attributed to this specialist. That
                  is not "produced nothing": a detached run whose transcript was
                  deleted, and a teammate that writes its own session elsewhere, both
                  leave a dispatch with nothing on disk to show for it.
                </p>
              ) : (
                <>
                  <Field
                    label="transcripts"
                    value={count(work.transcripts)}
                    note={`beside ${count(work.owningSessions)} session${
                      work.owningSessions === 1 ? "" : "s"
                    }`}
                  />
                  <Field label="records" value={count(work.records)} />
                  <Field
                    label="tool calls"
                    value={count(work.toolCalls)}
                    note="what the delegated run did, not what it was asked for"
                  />
                  <Field
                    label="output tokens"
                    value={
                      work.outputTokens === null
                        ? "no usage recorded"
                        : count(work.outputTokens)
                    }
                    note={
                      work.outputTokens === null
                        ? "no record carried a usage block, which is not the same as a run that wrote nothing"
                        : `from ${count(work.recordsWithUsage)} of ${count(
                            work.records,
                          )} records that carried a usage block; a token count, not a cost`
                    }
                  />
                  <Field
                    label="span"
                    value={
                      work.wallClockMs === null
                        ? "no span"
                        : span(work.wallClockMs)
                    }
                    note={
                      work.wallClockMs === null
                        ? "no transcript here has two usable timestamps, so there is nothing to measure"
                        : "first to last record within each run, summed; not time anybody spent waiting"
                    }
                  />
                  {work.transcriptsWithoutSpan > 0 && (
                    <Field
                      label="without a span"
                      value={count(work.transcriptsWithoutSpan)}
                      note="fewer than two usable timestamps, so these add nothing to the span above"
                    />
                  )}
                  <Field
                    label="first, last"
                    value={`${day(work.firstRecordAt)} to ${day(work.lastRecordAt)}`}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>What the scan covered, and what it missed</h3>
      <p className="row-meta" style={{ lineHeight: 1.6, marginTop: -6 }}>
        {count(evidence.sessionTranscriptsScanned)} session transcripts were opened for
        reading - a file that vanished before a byte came back is counted here too, which is
        what the vanished and truncated figures below separate out -
        {" "}{count(evidence.sessionRecordsRead)} records in all, and dispatches were
        recorded under the tool name{" "}
        {evidence.toolNames.length === 0 ? "none seen" : evidence.toolNames.join(", ")}{" "}
        on this machine - the name differs between installs, so both known names are
        accepted. On the delegated side{" "}
        {count(evidence.subagentTranscriptsRead)} of{" "}
        {count(evidence.subagentTranscriptFiles)} transcripts were read, holding{" "}
        {count(evidence.subagentRecordsRead)} records, of which{" "}
        {count(evidence.subagentRecordsMarkedSidechain)} carry the marker that says
        they are subagent traffic.
      </p>
      <Caveats caveats={caveats} />
    </div>
  );
}
