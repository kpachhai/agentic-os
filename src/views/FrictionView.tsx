import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { renderMarkdown } from "../markdown";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type FrictionEntry = {
  date: string;
  type: "Friction" | "Resolution" | "Notice" | "Lesson" | "Pattern" | "Decision";
  text: string;
  supersedes: string | null;
  format: "pipe" | "section" | "table";
  raw: string;
  status?: "open" | "resolved";
  resolvedBy?: { date: string; text: string } | null;
  resolves?: { date: string; text: string } | null;
  ageDays?: number;
  ageBand?: "today" | "week" | "month" | "quarter" | "stale";
};

type FrictionAging = {
  openCount: number;
  resolvedCount: number;
  openByBand: Array<{ band: string; count: number }>;
  oldestOpenDays: number;
  medianDaysToResolve: number;
  resolutionRate: number;
};

/** An open loop past this many days is called out rather than merely listed. */
const STALE_DAYS = 92;

const TYPES = [
  "Friction",
  "Resolution",
  "Notice",
  "Lesson",
  "Pattern",
  "Decision",
] as const;

// Friction = warn red, Resolution = success emerald, rest = purple/spark accents.
function typeBadge(type: FrictionEntry["type"]): string {
  switch (type) {
    case "Friction":
      return "badge warn";
    case "Resolution":
      return "badge success";
    case "Notice":
      return "badge spark";
    case "Lesson":
      return "badge info";
    default:
      return "badge purple";
  }
}

type NamedCount = { name: string; count: number };

type FrictionGapEntry = {
  sessionId: string;
  projectPath: string;
  startedAt: string;
  endedAt: string;
  detectedCount: number;
  categories: NamedCount[];
  detail: string;
  outcome: string;
  loggedInWindow: number;
  status: "unlogged" | "logged";
};

type FrictionGapReport = {
  entries: FrictionGapEntry[];
  unloggedCount: number;
  loggedCount: number;
  unwindowedCount: number;
  graceHours: number;
  frictionLogEntries: number;
  coverage: {
    sessionMetaCount: number;
    facetsCount: number;
    transcriptCount: number;
    generatedAt: string | null;
    facetsGeneratedAt: string | null;
    unreadableFiles: number;
  };
};

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** Last path segment, or the whole path when it has none. */
function repoName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || "no working directory";
}

/**
 * Friction the analysis found in a session that left no entry in the log.
 *
 * Held apart from the timeline above it because it is a different kind of claim.
 * The timeline is what the operator wrote; this is what a model read out of the
 * transcripts, over whichever sessions happened to be judged the last time
 * `/insights` ran. Every figure here is bounded by that coverage, which is why
 * the counts are amber and the panel leads with what it covers.
 */
function DetectedNeverLogged() {
  const [report, setReport] = useState<FrictionGapReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showLogged, setShowLogged] = useState(false);

  useEffect(() => {
    apiGet<FrictionGapReport>("/api/friction/gap").then(setReport).catch(setError);
  }, []);

  if (error != null) {
    return (
      <section className="gap-panel">
        <h2 className="section-title">Detected, never logged</h2>
        <FailureState error={error} />
      </section>
    );
  }
  if (report === null) {
    return (
      <section className="gap-panel">
        <h2 className="section-title">Detected, never logged</h2>
        <Skeleton kind="rows" count={2} label="comparing the analysis against your log..." />
      </section>
    );
  }

  const shown = report.entries.filter(
    (entry) => showLogged || entry.status === "unlogged",
  );
  const judged = report.coverage.facetsCount;
  const population = report.coverage.transcriptCount;

  return (
    <section className="gap-panel">
      <h2 className="section-title">Detected, never logged</h2>
      <p className="view-sub">
        sessions the analysis found friction in that you never wrote an entry for
      </p>

      <div className="stat-grid">
        <div className="stat-tile bounded">
          <div className={`num${report.unloggedCount > 0 ? " accent" : ""}`}>
            {report.unloggedCount}
          </div>
          <div className="row-meta">detected, never logged</div>
        </div>
        <div className="stat-tile bounded">
          <div className="num">{report.loggedCount}</div>
          <div className="row-meta">detected, and you were capturing</div>
        </div>
        <div className="stat-tile bounded">
          <div className="num">
            {judged}
            <span className="num-sub">/{population}</span>
          </div>
          <div className="row-meta">sessions judged</div>
        </div>
        {report.unwindowedCount > 0 && (
          <div className="stat-tile unknown">
            <div className="num">{report.unwindowedCount}</div>
            <div className="row-meta">no start time, not checkable</div>
          </div>
        )}
      </div>

      <p className="row-meta" style={{ marginTop: -8, marginBottom: 14 }}>
        Covers {judged} of {population} sessions, judged when{" "}
        {report.coverage.facetsGeneratedAt
          ? `/insights last ran on ${shortDate(report.coverage.facetsGeneratedAt)}`
          : "/insights last ran"}
        . That store is written in one pass and never refreshed, so anything since
        is invisible here; run <code>/insights</code> again to widen it. "Logged"
        means an entry of any kind was written between the session starting and{" "}
        {report.graceHours}h after it ended - it does not claim that entry was
        about this friction, because the two vocabularies do not map onto each
        other.
      </p>

      <div className="toolbar">
        <button
          className={`chip${showLogged ? "" : " active"}`}
          onClick={() => setShowLogged(false)}
        >
          never logged
        </button>
        <button
          className={`chip${showLogged ? " active" : ""}`}
          onClick={() => setShowLogged(true)}
        >
          all judged friction
        </button>
        <span className="row-meta">{shown.length} shown</span>
      </div>

      {shown.length === 0 && (
        <div className="empty-state">
          {report.entries.length === 0
            ? "no judged session recorded any friction"
            : "every session the analysis flagged has an entry alongside it"}
        </div>
      )}

      {shown.map((entry) => (
        <div className="card" key={entry.sessionId}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className={`badge ${entry.status === "unlogged" ? "warn" : "success"}`}>
              {entry.status === "unlogged" ? "never logged" : "was capturing"}
            </span>
            <span className="row-meta">{shortDate(entry.startedAt)}</span>
            <span className="row-meta">{repoName(entry.projectPath)}</span>
            <span className="badge info">{entry.outcome.replace(/_/g, " ")}</span>
            {entry.categories.map((category) => (
              <span className="badge purple" key={category.name}>
                {category.name.replace(/_/g, " ")}
                {category.count > 1 ? ` x${category.count}` : ""}
              </span>
            ))}
          </div>
          {entry.detail && (
            <div
              className="md-body"
              // Model-written text, sanitized via DOMPurify in renderMarkdown.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.detail) }}
            />
          )}
        </div>
      ))}
      <RailLegend present={["bounded", "unknown"]} />
    </section>
  );
}

type StatusFilter = "all" | "open" | "resolved";

export function FrictionView() {
  const [entries, setEntries] = useState<FrictionEntry[] | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [aging, setAging] = useState<FrictionAging | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    // Computed over the whole log once, so the gauge does not move when the
    // reader filters the timeline below it.
    apiGet<FrictionAging>("/api/friction/aging").then(setAging).catch(() => setAging(null));
  }, []);

  useEffect(() => {
    setEntries(null);
    const params = new URLSearchParams();
    if (typeFilter) params.set("type", typeFilter);
    if (status !== "all") params.set("status", status);
    apiGet<FrictionEntry[]>(`/api/friction?${params}`)
      .then((rows) => {
        setEntries(rows);
        setError(null);
      })
      .catch(setError);
  }, [typeFilter, status]);

  const openCount = entries?.filter((e) => e.status === "open").length ?? 0;

  return (
    <div>
      <h1 className="view-title">
        Friction <span className="accent">Timeline</span>
      </h1>
      <p className="view-sub">
        corrections and their resolutions; open frictions are unclosed loops
      </p>

      {aging && (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className={`num${aging.openCount > aging.resolvedCount ? " accent" : ""}`}>
                {aging.openCount}
              </div>
              <div className="row-meta">still open</div>
            </div>
            <div className="stat-tile derived">
              <div className="num">{(aging.resolutionRate * 100).toFixed(0)}%</div>
              <div className="row-meta">ever closed</div>
            </div>
            <div className="stat-tile derived">
              <div className={`num${aging.oldestOpenDays > STALE_DAYS ? " accent" : ""}`}>
                {aging.oldestOpenDays}d
              </div>
              <div className="row-meta">oldest open loop</div>
            </div>
            <div className="stat-tile derived">
              {/* Log dates are day-granular, so a same-day close measures as zero.
                  Printing "0d" reads as a missing figure rather than a fast one. */}
              <div className="num">
                {aging.resolvedCount === 0
                  ? "-"
                  : aging.medianDaysToResolve === 0
                    ? "same day"
                    : `${aging.medianDaysToResolve}d`}
              </div>
              <div className="row-meta">median time to close</div>
            </div>
          </div>
          <p className="row-meta" style={{ marginTop: -8, marginBottom: 14 }}>
            Open loops by age:{" "}
            {aging.openByBand.length === 0
              ? "none"
              : aging.openByBand.map((b) => `${b.count} ${b.band}`).join(", ")}
            . Status says whether a loop closed; age says how long it stayed open,
            which is the part that applies pressure. These figures cover the whole
            log and do not change when you filter below.
          </p>
        </>
      )}

      <DetectedNeverLogged />

      <h2 className="section-title">What you wrote down</h2>
      <div className="toolbar">
        {(["all", "open", "resolved"] as const).map((s) => (
          <button
            key={s}
            className={`chip${status === s ? " active" : ""}`}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
        <span style={{ width: 12 }} />
        <button
          className={`chip${typeFilter === "" ? " active" : ""}`}
          onClick={() => setTypeFilter("")}
        >
          all types
        </button>
        {TYPES.map((t) => (
          <button
            key={t}
            className={`chip${typeFilter === t ? " active" : ""}`}
            onClick={() => setTypeFilter(t)}
          >
            {t}
          </button>
        ))}
        {entries && (
          <span className="row-meta">
            {entries.length} entries{status === "all" && typeFilter === "" ? `, ${openCount} open` : ""}
          </span>
        )}
      </div>
      <RailLegend present={["measured", "derived"]} />

      {error != null && <FailureState error={error} />}
      {entries === null && !error && (
        <Skeleton kind="rows" count={5} label="parsing friction log..." />
      )}
      {entries !== null && entries.length === 0 && (
        <div className="empty-state">no entries match this filter</div>
      )}

      {entries?.map((e, i) => (
        <div className="card" key={i}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className={typeBadge(e.type)}>{e.type}</span>
            {e.type === "Friction" && e.status && (
              <span className={`badge ${e.status === "open" ? "warn" : "success"}`}>
                {e.status}
              </span>
            )}
            <span className="row-meta">{e.date.slice(0, 10)}</span>
            {e.ageDays !== undefined && (
              <span
                className={
                  e.status === "open" && e.ageDays > STALE_DAYS
                    ? "badge ember"
                    : "row-meta"
                }
                title={
                  e.status === "open"
                    ? "days this loop has stayed open"
                    : "days this loop took to close"
                }
              >
                {e.status === "open" ? `open ${e.ageDays}d` : `closed in ${e.ageDays}d`}
              </span>
            )}
            <span className="row-meta">{e.format}</span>
          </div>
          <div style={{ margin: "7px 0 0", lineHeight: 1.5 }}>{e.text}</div>
          {e.resolvedBy && (
            <div
              style={{
                marginTop: 8,
                paddingLeft: 10,
                borderLeft: "3px solid var(--success)",
                color: "var(--text-sub)",
              }}
            >
              <span className="badge success">resolved by</span>{" "}
              <span className="row-meta">{e.resolvedBy.date.slice(0, 10)}</span>
              <div style={{ marginTop: 4 }}>{e.resolvedBy.text}</div>
            </div>
          )}
          {e.resolves && (
            <div
              style={{
                marginTop: 8,
                paddingLeft: 10,
                borderLeft: "3px solid var(--warn)",
                color: "var(--text-sub)",
              }}
            >
              <span className="badge warn">closes</span>{" "}
              <span className="row-meta">{e.resolves.date.slice(0, 10)}</span>
              <div style={{ marginTop: 4 }}>{e.resolves.text}</div>
            </div>
          )}
          {e.supersedes && !e.resolves && (
            <div className="row-meta" style={{ marginTop: 6 }}>
              supersedes: {e.supersedes}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
