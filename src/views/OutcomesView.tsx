import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type NamedCount = { name: string; count: number };

type OutcomeSession = {
  sessionId: string;
  projectPath: string;
  startedAt: string;
  durationMinutes: number;
  outcome: string;
  claudeHelpfulness: string;
  sessionType: string;
  primarySuccess: string;
  goalCategories: NamedCount[];
  underlyingGoal: string;
  briefSummary: string;
  frictionCount: number;
  satisfaction: NamedCount[];
  userMessages: number;
  assistantMessages: number;
  toolErrors: number;
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
  gitCommits: number;
};

type OutcomesReport = {
  sessions: OutcomeSession[];
  byOutcome: NamedCount[];
  byHelpfulness: NamedCount[];
  bySessionType: NamedCount[];
  byPrimarySuccess: NamedCount[];
  topGoalCategories: NamedCount[];
  unjudgedWithStats: number;
  coverage: {
    sessionMetaCount: number;
    facetsCount: number;
    transcriptCount: number;
    generatedAt: string | null;
    facetsGeneratedAt: string | null;
    unreadableFiles: number;
  };
};

/** Outcomes that mean the work did not land, for the headline count. */
const MISSED = new Set(["not_achieved", "partially_achieved"]);

function human(value: string): string {
  return value.replace(/_/g, " ") || "unrecorded";
}

function shortDate(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "no start time";
}

function repoName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "no working directory";
}

function outcomeBadge(outcome: string): string {
  if (outcome === "fully_achieved") return "badge success";
  if (outcome === "mostly_achieved") return "badge info";
  if (outcome === "not_achieved") return "badge warn";
  if (outcome === "unclear_from_transcript") return "badge purple";
  return "badge spark";
}

/** A labelled distribution, widest bar first. */
function Distribution({ title, rows }: { title: string; rows: NamedCount[] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return null;
  return (
    <div className="card">
      <div className="row-meta" style={{ marginBottom: 8 }}>
        {title}
      </div>
      {rows.map((row) => (
        <div className="dist-row" key={row.name}>
          <span className="dist-label">{human(row.name)}</span>
          <span className="dist-bar">
            <span
              className="dist-fill"
              style={{ width: `${Math.round((row.count / total) * 100)}%` }}
            />
          </span>
          <span className="dist-count">{row.count}</span>
        </div>
      ))}
    </div>
  );
}

export function OutcomesView() {
  const [report, setReport] = useState<OutcomesReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missedOnly, setMissedOnly] = useState(false);

  useEffect(() => {
    apiGet<OutcomesReport>("/api/outcomes").then(setReport).catch(setError);
  }, []);

  if (error != null) {
    return (
      <div>
        <h1 className="view-title">
          Session <span className="accent">Outcomes</span>
        </h1>
        <FailureState error={error} />
      </div>
    );
  }
  if (report === null) {
    return (
      <div>
        <h1 className="view-title">
          Session <span className="accent">Outcomes</span>
        </h1>
        <Skeleton kind="rows" count={5} label="reading the insights store..." />
      </div>
    );
  }

  const judged = report.coverage.facetsCount;
  const population = report.coverage.transcriptCount;
  const missed = report.sessions.filter((s) => MISSED.has(s.outcome)).length;
  const shown = missedOnly
    ? report.sessions.filter((s) => MISSED.has(s.outcome))
    : report.sessions;

  return (
    <div>
      <h1 className="view-title">
        Session <span className="accent">Outcomes</span>
      </h1>
      <p className="view-sub">
        whether the work went anywhere - the one thing the transcripts do not record
      </p>

      <div className="stat-grid">
        <div className="stat-tile bounded">
          <div className="num">
            {judged}
            <span className="num-sub">/{population}</span>
          </div>
          <div className="row-meta">sessions judged</div>
        </div>
        <div className="stat-tile unknown">
          <div className={`num${missed > 0 ? " accent" : ""}`}>{missed}</div>
          <div className="row-meta">judged short of the goal</div>
        </div>
        <div className="stat-tile unknown">
          <div className="num">
            {report.sessions.filter((s) => s.outcome === "fully_achieved").length}
          </div>
          <div className="row-meta">judged fully achieved</div>
        </div>
        <div className="stat-tile bounded">
          <div className="num">{report.unjudgedWithStats}</div>
          <div className="row-meta">counted but never judged</div>
        </div>
      </div>

      <p className="row-meta" style={{ marginTop: -8, marginBottom: 14 }}>
        Every verdict here is a model's reading of a transcript, not a measurement,
        so nothing on this page is averaged into a score - a single number over
        opinions would be the most confident-looking and least defensible figure in
        this tool. It covers {judged} of {population} sessions, judged when{" "}
        {report.coverage.facetsGeneratedAt
          ? `/insights last ran on ${shortDate(report.coverage.facetsGeneratedAt)}`
          : "/insights last ran"}
        , and that store is written in one pass and never refreshed.
        {report.coverage.unreadableFiles > 0 &&
          ` ${report.coverage.unreadableFiles} file(s) in the store could not be read.`}
      </p>
      <RailLegend present={["bounded", "unknown"]} />

      <div className="dist-grid">
        <Distribution title="outcome" rows={report.byOutcome} />
        <Distribution title="how helpful" rows={report.byHelpfulness} />
        <Distribution title="session shape" rows={report.bySessionType} />
        <Distribution title="what went well" rows={report.byPrimarySuccess} />
        <Distribution title="what you were doing" rows={report.topGoalCategories.slice(0, 8)} />
      </div>

      <h2 className="section-title">Judged sessions</h2>
      <div className="toolbar">
        <button
          className={`chip${missedOnly ? "" : " active"}`}
          onClick={() => setMissedOnly(false)}
        >
          all judged
        </button>
        <button
          className={`chip${missedOnly ? " active" : ""}`}
          onClick={() => setMissedOnly(true)}
        >
          fell short
        </button>
        <span className="row-meta">{shown.length} shown</span>
      </div>

      {shown.length === 0 && <div className="empty-state">no judged session matches</div>}

      {shown.map((session) => (
        <div className="card" key={session.sessionId}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className={outcomeBadge(session.outcome)}>{human(session.outcome)}</span>
            <span className="row-meta">{shortDate(session.startedAt)}</span>
            <span className="row-meta">{repoName(session.projectPath)}</span>
            <span className="badge info">{human(session.claudeHelpfulness)}</span>
            <span className="badge purple">{human(session.sessionType)}</span>
            {session.frictionCount > 0 && (
              <span className="badge warn">{session.frictionCount} friction</span>
            )}
          </div>
          {session.briefSummary && (
            <p style={{ margin: "8px 0 6px" }}>{session.briefSummary}</p>
          )}
          <div className="row-meta">
            {session.durationMinutes}m &middot; {session.userMessages} prompts &middot;{" "}
            {session.assistantMessages} replies
            {session.filesModified > 0 && ` · ${session.filesModified} files`}
            {(session.linesAdded > 0 || session.linesRemoved > 0) &&
              ` · +${session.linesAdded}/-${session.linesRemoved}`}
            {session.gitCommits > 0 && ` · ${session.gitCommits} commits`}
            {session.toolErrors > 0 && ` · ${session.toolErrors} tool errors`}
            {" · counted by /insights, not here"}
          </div>
        </div>
      ))}
    </div>
  );
}
