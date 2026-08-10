import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

type SessionSummary = {
  sessionId: string;
  projectDir: string;
  cwd: string;
  title: string;
  startedAt: string;
  messageCount: number;
};

type DiffStep = {
  index: number;
  timestamp: string;
  type: string;
  role: string | null;
  toolUses: string[];
  excerpt: string;
  tokens: TokenTotals | null;
};

type DiffOp =
  | { kind: "same"; a: DiffStep; b: DiffStep }
  | { kind: "a-only"; a: DiffStep }
  | { kind: "b-only"; b: DiffStep };

type RunRef = {
  projectDir: string;
  sessionId: string;
  title: string;
  startedAt: string;
  endedAt: string;
};

type RunDiff = {
  a: RunRef;
  b: RunRef;
  ops: DiffOp[];
  divergenceIndex: number;
  similarity: number;
  alignedSteps: number;
  comparedSteps: number;
  shortRun: boolean;
  deltas: {
    durationMs: { a: number; b: number };
    messageCount: { a: number; b: number };
    tokens: { a: TokenTotals; b: TokenTotals };
    costUsd: { a: number | null; b: number | null };
    tools: Array<{ name: string; a: number; b: number }>;
    files: { onlyA: string[]; onlyB: string[]; both: string[] };
    sidechainTurns: { a: number; b: number };
  };
  truncated: boolean;
};

/** A dash, never a zero, when the price table could not cover a run. */
function money(usd: number | null): string {
  return usd === null ? "-" : `$${usd.toFixed(2)}`;
}

function minutes(ms: number): string {
  if (ms <= 0) return "-";
  const total = Math.round(ms / 60000);
  return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`;
}

function key(session: SessionSummary): string {
  return `${session.projectDir}::${session.sessionId}`;
}

function repoName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || cwd;
}

export function DiffView() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [aKey, setAKey] = useState("");
  const [bKey, setBKey] = useState("");
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiGet<SessionSummary[]>("/api/sessions?limit=60").then(setSessions).catch(setError);
  }, []);

  useEffect(() => {
    if (!aKey || !bKey || aKey === bKey) {
      setDiff(null);
      return;
    }
    const [aProject, aSession] = aKey.split("::");
    const [bProject, bSession] = bKey.split("::");
    setLoading(true);
    apiGet<RunDiff>(
      `/api/sessions/diff?aProject=${encodeURIComponent(aProject!)}` +
        `&aSession=${encodeURIComponent(aSession!)}` +
        `&bProject=${encodeURIComponent(bProject!)}` +
        `&bSession=${encodeURIComponent(bSession!)}`,
    )
      .then((result) => {
        setDiff(result);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [aKey, bKey]);

  return (
    <div>
      <h1 className="view-title">
        Run <span className="accent">Diff</span>
      </h1>
      <p className="view-sub">
        two runs of the same task, aligned on tool-call structure - where did they part
      </p>

      {error != null && <FailureState error={error} />}
      {sessions === null && error == null && (
        <Skeleton kind="rows" count={3} label="loading sessions..." />
      )}

      {sessions && (
        <div className="toolbar">
          <select
            className="run-picker"
            value={aKey}
            onChange={(event) => setAKey(event.target.value)}
            aria-label="first run"
          >
            <option value="">pick the first run</option>
            {sessions.map((session) => (
              <option key={key(session)} value={key(session)}>
                {session.startedAt.slice(0, 10)} · {repoName(session.cwd)} · {session.title}
              </option>
            ))}
          </select>
          <select
            className="run-picker"
            value={bKey}
            onChange={(event) => setBKey(event.target.value)}
            aria-label="second run"
          >
            <option value="">pick the second run</option>
            {sessions.map((session) => (
              <option key={key(session)} value={key(session)}>
                {session.startedAt.slice(0, 10)} · {repoName(session.cwd)} · {session.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && <Skeleton kind="rows" count={4} label="aligning the two runs..." />}

      {!loading && diff === null && sessions !== null && error == null && (
        <div className="empty-state">
          {aKey && aKey === bKey
            ? "pick two different runs"
            : "pick two runs to compare"}
        </div>
      )}

      {diff && !loading && (
        <>
          <div className="stat-grid">
            <div className="stat-tile bounded">
              <div className="num">
                {diff.alignedSteps}
                <span className="num-sub">/{diff.comparedSteps}</span>
              </div>
              <div className="row-meta">steps aligned</div>
            </div>
            <div className="stat-tile derived">
              <div className="num">
                {diff.divergenceIndex < 0 ? "none" : `#${diff.divergenceIndex}`}
              </div>
              <div className="row-meta">first divergence</div>
            </div>
            <div className="stat-tile derived">
              <div className="num">
                {minutes(diff.deltas.durationMs.a)} / {minutes(diff.deltas.durationMs.b)}
              </div>
              <div className="row-meta">duration, A / B</div>
            </div>
            <div className="stat-tile derived">
              <div className="num">
                {diff.deltas.messageCount.a} / {diff.deltas.messageCount.b}
              </div>
              <div className="row-meta">messages, A / B</div>
            </div>
            {/* A dash rather than a zero when a run used a model the vendored
                table cannot price: absent is not free. */}
            <div className="stat-tile derived">
              <div className="num">{money(diff.deltas.costUsd.a)} / {money(diff.deltas.costUsd.b)}</div>
              <div className="row-meta">cost, A / B</div>
            </div>
            <div className="stat-tile derived">
              <div className="num">
                {diff.deltas.sidechainTurns.a} / {diff.deltas.sidechainTurns.b}
              </div>
              <div className="row-meta">delegated turns, A / B</div>
            </div>
          </div>

          <p className="row-meta" style={{ marginTop: -8, marginBottom: 14 }}>
            {diff.alignedSteps} of {diff.comparedSteps} steps took the same shape. This
            measures SHAPE, not sameness of task: sampling 70 real pairs found four
            scoring a perfect match and three of those were unrelated work.
            {diff.shortRun && (
              <>
                {" "}
                <strong>This pair is short enough that a match means little</strong> -
                pairs matching at 90% or better averaged 7 turns, against 256 for the
                rest, because a short run has few shapes available to it.
              </>
            )}
            {diff.truncated && " One run was longer than the alignment cap and was cut short."}
          </p>
          <RailLegend present={["derived", "bounded"]} />

          {diff.deltas.tools.length > 0 && (
            <div className="card">
              <div className="row-meta" style={{ marginBottom: 6 }}>
                tools called a different number of times
              </div>
              {diff.deltas.tools.map((tool) => (
                <div className="dist-row" key={tool.name}>
                  <span className="dist-label">{tool.name}</span>
                  <span className="row-meta">
                    {tool.a} &rarr; {tool.b}
                  </span>
                  <span className="dist-count">{tool.b - tool.a > 0 ? `+${tool.b - tool.a}` : tool.b - tool.a}</span>
                </div>
              ))}
            </div>
          )}

          {(diff.deltas.files.onlyA.length > 0 || diff.deltas.files.onlyB.length > 0) && (
            <div className="card">
              <div className="row-meta" style={{ marginBottom: 6 }}>
                files only one run touched
              </div>
              {diff.deltas.files.onlyA.map((path) => (
                <div className="row-meta" key={`a${path}`}>
                  <span className="badge warn">A only</span> {path}
                </div>
              ))}
              {diff.deltas.files.onlyB.map((path) => (
                <div className="row-meta" key={`b${path}`}>
                  <span className="badge info">B only</span> {path}
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Aligned steps</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>A</th>
                <th>B</th>
              </tr>
            </thead>
            <tbody>
              {diff.ops.map((op, index) => {
                const diverged = index === diff.divergenceIndex;
                return (
                  <tr key={index} className={diverged ? "diverged" : undefined}>
                    <td className="num-cell">{index}</td>
                    <td>
                      {op.kind !== "b-only" ? (
                        <>
                          <span className="row-meta">
                            {op.a.toolUses.join(", ") || op.a.role || op.a.type}
                          </span>
                          <div>{op.a.excerpt}</div>
                        </>
                      ) : (
                        <span className="row-meta">-</span>
                      )}
                    </td>
                    <td>
                      {op.kind !== "a-only" ? (
                        <>
                          <span className="row-meta">
                            {op.b.toolUses.join(", ") || op.b.role || op.b.type}
                          </span>
                          <div>{op.b.excerpt}</div>
                        </>
                      ) : (
                        <span className="row-meta">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
