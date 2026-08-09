import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type PromptEntry = {
  timestamp: number;
  text: string;
  project: string;
  projectPath: string;
  sessionId: string;
  hadPaste: boolean;
};

type HistoryStats = {
  totalPrompts: number;
  byProject: Array<{ project: string; projectPath: string; count: number }>;
  byHour: number[];
  byDay: Array<{ date: string; count: number }>;
  withPaste: number;
  firstAt: number;
  lastAt: number;
  medianLength: number;
};

function shortPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || fullPath;
}

function when(epochMs: number): string {
  if (!epochMs) return "unknown";
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

export function HistoryView() {
  const [prompts, setPrompts] = useState<PromptEntry[] | null>(null);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<HistoryStats>("/api/history/stats").then(setStats).catch(setError);
  }, []);

  useEffect(() => {
    setPrompts(null);
    const params = new URLSearchParams({ limit: "80" });
    if (query) params.set("q", query);
    if (project) params.set("project", project);
    apiGet<PromptEntry[]>(`/api/history?${params}`)
      .then((rows) => {
        setPrompts(rows);
        setError(null);
      })
      .catch(setError);
  }, [query, project]);

  const header = (
    <>
      <h1 className="view-title">
        What You <span className="accent">Asked For</span>
      </h1>
      <p className="view-sub">
        every prompt you have typed, across every project - the one record of
        intent rather than of what Claude did with it
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

  const peakHour = stats
    ? stats.byHour.indexOf(Math.max(...stats.byHour))
    : 0;
  const busiestDay = stats?.byDay.reduce(
    (best, day) => (best === null || day.count > best.count ? day : best),
    null as { date: string; count: number } | null,
  );

  return (
    <div>
      {header}

      {stats && (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="num">{stats.totalPrompts.toLocaleString()}</div>
              <div className="row-meta">prompts</div>
            </div>
            <div className="stat-tile">
              <div className="num">{stats.byProject.length}</div>
              <div className="row-meta">projects</div>
            </div>
            <div className="stat-tile">
              <div className="num">
                {String(peakHour).padStart(2, "0")}:00
              </div>
              <div className="row-meta">busiest hour</div>
            </div>
            <div className="stat-tile derived">
              <div className="num">{stats.medianLength}</div>
              <div className="row-meta">median chars</div>
            </div>
          </div>
          <p className="row-meta" style={{ marginTop: -8, marginBottom: 16 }}>
            {when(stats.firstAt)} to {when(stats.lastAt)}. {stats.withPaste} prompts
            included pasted content, which is recorded here as a flag only - this
            view never reads what was pasted.
            {busiestDay && ` Busiest day: ${busiestDay.date} (${busiestDay.count}).`}
          </p>

          <h3>By hour of day</h3>
          {/* Each column is a fixed-height track with the bar anchored to its
              bottom. Sizing the bar alone would let the columns grow downward from
              a shared top edge, which reads as an inverted chart. */}
          <div className="hour-chart">
            {stats.byHour.map((count, hour) => {
              const peak = Math.max(...stats.byHour) || 1;
              return (
                <div
                  className="hour-col"
                  key={hour}
                  title={`${String(hour).padStart(2, "0")}:00 - ${count} prompts`}
                >
                  <div className="hour-track">
                    <div
                      className={`hour-bar${hour === peakHour ? " peak" : ""}`}
                      style={{ height: `${Math.max((count / peak) * 100, 1)}%` }}
                    />
                  </div>
                  <div className="hour-tick">{hour % 3 === 0 ? hour : ""}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="search your prompts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 320 }}
        />
        <button
          className={`chip${project === "" ? " active" : ""}`}
          onClick={() => setProject("")}
        >
          all projects
        </button>
        {stats?.byProject.slice(0, 5).map((entry) => (
          <button
            key={entry.project}
            className={`chip${project === entry.project ? " active" : ""}`}
            onClick={() => setProject(entry.project)}
            title={entry.projectPath}
          >
            {shortPath(entry.projectPath)} ({entry.count})
          </button>
        ))}
      </div>
      <RailLegend present={["measured", "derived"]} />

      {prompts === null && <Skeleton kind="rows" count={6} label="reading history..." />}
      {prompts !== null && prompts.length === 0 && (
        <div className="empty-state">no prompts match this filter</div>
      )}

      {prompts?.map((prompt, index) => (
        <div className="card" key={`${prompt.timestamp}-${index}`}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className="row-meta">{when(prompt.timestamp)}</span>
            <span className="row-meta" title={prompt.projectPath}>
              {shortPath(prompt.projectPath)}
            </span>
            {prompt.hadPaste && (
              <span
                className="badge spark"
                title="this prompt included pasted content, which is not read or shown here"
              >
                paste
              </span>
            )}
          </div>
          <div style={{ margin: "7px 0 0", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {prompt.text}
          </div>
        </div>
      ))}

      {prompts !== null && prompts.length > 0 && (
        <p className="row-meta" style={{ marginTop: 14 }}>
          Prompts are shown as bounded excerpts, not in full. This is the most
          sensitive file the panel reads - it is every prompt verbatim, including
          anything ever pasted into one - so it is read-only and never captured into
          a fixture or test.
        </p>
      )}
    </div>
  );
}
