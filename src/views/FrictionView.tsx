import { useEffect, useState } from "react";
import { apiGet } from "../api";
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
