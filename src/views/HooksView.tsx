import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";
import { SortHeader, SortNote, useSorted, useSortState } from "../sortable";

type HookStats = {
  label: string;
  command: string;
  invocations: number;
  durationsMissing: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  sessions: number;
};

type HookHealth = {
  sessionsScanned: number;
  sessionsWithoutHooks: number;
  totalInvocations: number;
  errorRecords: number;
  blockedTurns: number;
  totalMs: number;
  hooks: HookStats[];
};

function seconds(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * A hook is slow enough to be worth the operator's attention when its worst runs
 * are measured in seconds, because that cost is paid on every turn it fires.
 */
const SLOW_P95_MS = 500;

export function HooksView() {
  const [health, setHealth] = useState<HookHealth | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sort, onSort] = useSortState();

  // The server sorts by total cost, which answers "what does my setup cost" but not
  // "what makes me wait". p95 and worst run were already in the payload and in the
  // table; only the order stopped them being readable as rankings.
  const sortedHooks = useSorted(
    health?.hooks ?? [],
    {
      hook: (hook) => hook.label,
      runs: (hook) => hook.invocations,
      median: (hook) => hook.medianMs,
      p95: (hook) => hook.p95Ms,
      worst: (hook) => hook.maxMs,
    },
    sort,
  );

  useEffect(() => {
    apiGet<HookHealth>("/api/hooks?limit=40")
      .then((data) => {
        setHealth(data);
        setError(null);
      })
      .catch(setError);
  }, []);

  // The heading stays even when the source is absent: a bare panel leaves the
  // reader unable to tell which pillar they are looking at.
  const header = (
    <>
      <h1 className="view-title">
        Hook <span className="accent">Health</span>
      </h1>
      <p className="view-sub">
        what your hooks cost every turn, derived from records already on disk - no
        collector, no listener, no settings change
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
  if (!health) {
    return (
      <div>
        {header}
        <Skeleton kind="tiles" count={4} label="reading hook records..." />
      </div>
    );
  }

  const widest = health.hooks[0]?.totalMs ?? 1;

  return (
    <div>
      {header}

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="num">{health.hooks.length}</div>
          <div className="row-meta">distinct hooks</div>
        </div>
        <div className="stat-tile">
          <div className="num">{health.totalInvocations}</div>
          <div className="row-meta">invocations</div>
        </div>
        <div className="stat-tile derived">
          <div className="num">{seconds(health.totalMs)}</div>
          <div className="row-meta">total hook time</div>
        </div>
        <div className="stat-tile">
          <div className="num">{health.blockedTurns}</div>
          <div className="row-meta">turns blocked</div>
        </div>
      </div>
      <RailLegend present={["measured", "derived"]} />

      <p className="row-meta" style={{ marginBottom: 16 }}>
        Across the {health.sessionsScanned} most recent sessions
        {health.sessionsWithoutHooks > 0 &&
          `, of which ${health.sessionsWithoutHooks} ran no hooks at all`}
        .{" "}
        {health.errorRecords > 0
          ? `${health.errorRecords} record${health.errorRecords === 1 ? "" : "s"} reported a hook error.`
          : "No hook errors recorded."}
      </p>

      {health.hooks.length === 0 ? (
        <div className="empty-state">
          no hook records in these sessions - either no hooks are configured, or
          they have not fired yet
        </div>
      ) : (
        <>
        <table className="data-table">
          <thead>
            <tr>
              <SortHeader label="hook" sortKey="hook" sort={sort} onSort={onSort} />
              <SortHeader label="runs" sortKey="runs" sort={sort} onSort={onSort} numeric />
              <SortHeader label="median" sortKey="median" sort={sort} onSort={onSort} numeric />
              <SortHeader
                label="p95"
                sortKey="p95"
                sort={sort}
                onSort={onSort}
                numeric
                title="sort by 95th percentile - the run a reader waits through one time in twenty"
              />
              <SortHeader label="worst" sortKey="worst" sort={sort} onSort={onSort} numeric />
              <th style={{ width: "28%" }}>total cost</th>
            </tr>
          </thead>
          <tbody>
            {sortedHooks.map((hook) => (
              <tr key={hook.command}>
                <td>
                  <div>{hook.label}</div>
                  <div className="row-meta" title={hook.command}>
                    {hook.command.length > 72
                      ? `${hook.command.slice(0, 69)}...`
                      : hook.command}
                  </div>
                  {hook.durationsMissing > 0 && (
                    <div className="row-meta">
                      {hook.durationsMissing} run
                      {hook.durationsMissing === 1 ? "" : "s"} recorded no duration,
                      excluded from the percentiles
                    </div>
                  )}
                </td>
                <td className="num-cell">{hook.invocations}</td>
                <td className="num-cell">{hook.medianMs}ms</td>
                <td className={`num-cell${hook.p95Ms >= SLOW_P95_MS ? " accent" : ""}`}>
                  {hook.p95Ms}ms
                </td>
                <td className="num-cell">{seconds(hook.maxMs)}</td>
                <td>
                  <div className="bar-cell">
                    <div className="bar-track">
                      <div
                        className={`bar-fill${hook.p95Ms >= SLOW_P95_MS ? " warn" : ""}`}
                        style={{ width: `${(hook.totalMs / widest) * 100}%` }}
                      />
                    </div>
                    <span className="num-cell">{seconds(hook.totalMs)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <SortNote sort={sort} defaultOrder="total cost, most expensive first" />
        </>
      )}

      <p className="row-meta" style={{ marginTop: 16 }}>
        Percentiles use nearest-rank, so every figure shown is a duration that was
        actually observed rather than one interpolated between two runs. Ranked by
        total cost, because the hook consuming the most time overall matters more
        than the one with a single bad run. Commands are shown with any credential
        removed and are normalised for reading, not for running.
      </p>
    </div>
  );
}
