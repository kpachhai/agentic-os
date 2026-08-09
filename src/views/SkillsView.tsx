import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../api";
import { FailureState, Skeleton } from "../PillarState";

type UsageMatch = "exact" | "name" | "none";
type SkillStaleness = "never" | "active" | "cooling" | "cold";

type SkillInfo = {
  name: string;
  description: string;
  source: string;
  slashCommand: string;
  path: string;
  /**
   * Times invoked, per Claude Code's own counters. Null when no usage source was
   * available, which is different from zero: zero means installed and never used,
   * null means nobody was counting.
   */
  usageCount: number | null;
  lastUsedAt: number | null;
  usageMatch: UsageMatch;
  staleness: SkillStaleness | null;
};

// Fields beyond launchId/prompt/status are absent on the optimistic record
// shown between POST /api/launch and the first server event.
type LaunchRecord = {
  launchId: string;
  prompt: string;
  status: "running" | "done" | "error" | "timed_out" | "cancelled";
  argv?: string[];
  cwd?: string;
  allowedTools?: string;
  exitCode?: number | null;
  result?: string;
  totalCostUsd?: number;
  sessionId?: string;
};

function sourceBadge(source: string): string {
  return source === "global" ? "badge purple" : "badge info";
}

/**
 * The staleness band as a badge. "never" is the one worth acting on, so it is the
 * only band that gets the warn treatment: a catalog that cannot tell you which
 * skills you installed and never once reached for is a list, not an inventory.
 */
function stalenessBadge(band: SkillStaleness): string {
  if (band === "never") return "badge warn";
  if (band === "active") return "badge success";
  if (band === "cooling") return "badge spark";
  return "badge info";
}

/** Days since a recorded invocation, for the tooltip behind the band. */
function daysAgo(lastUsedAt: number): number {
  return Math.max(0, Math.round((Date.now() - lastUsedAt) / 86_400_000));
}

/**
 * Order within a source group: most-used first, then never-used, then by name.
 *
 * Alphabetical was the previous order and it answers nothing. The two questions a
 * reader brings here are "what do I actually reach for" and "what have I installed
 * and never touched", and both are orderings of the same counter. Skills with no
 * counter at all keep alphabetical order rather than being ranked as zero, because
 * null is "nobody was counting" and sorting it against real counts would invent a
 * comparison.
 */
function byHabit(a: SkillInfo, b: SkillInfo): number {
  const left = a.usageCount ?? -1;
  const right = b.usageCount ?? -1;
  if (left !== right) return right - left;
  return a.name.localeCompare(b.name);
}

/** Render one streamed event as a short progress line (best-effort). */
function eventLine(e: Record<string, unknown>): string | null {
  if (e.type === "stdout") return String(e.text);
  if (e.type === "stderr") return `[stderr] ${String(e.text)}`;
  if (e.type === "system" && e.subtype === "init") return "[init] session started";
  if (e.type === "assistant") {
    const msg = e.message as { content?: { type: string; text?: string; name?: string }[] } | undefined;
    const parts = (msg?.content ?? [])
      .map((c) => (c.type === "text" ? c.text : c.type === "tool_use" ? `[tool: ${c.name}]` : null))
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  if (e.type === "result") return `[result] ${String(e.result ?? "").slice(0, 400)}`;
  if (e.type === "exit") return `[exit] code=${String(e.exitCode)} status=${String(e.status)}`;
  if (e.type === "timeout") return `[timeout] killed after ${String(e.afterSeconds)}s`;
  if (e.type === "spawn_error") return `[spawn error] ${String(e.message)}`;
  return null;
}

export function SkillsView() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [launching, setLaunching] = useState<SkillInfo | null>(null);
  const [args, setArgs] = useState("");
  const [record, setRecord] = useState<LaunchRecord | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const params = q ? `?q=${encodeURIComponent(q)}` : "";
    apiGet<SkillInfo[]>(`/api/skills${params}`)
      .then((rows) => {
        setSkills(rows);
        setError(null);
      })
      .catch(setError);
  }, [q]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  useEffect(() => () => esRef.current?.close(), []);

  async function startLaunch(skill: SkillInfo, extraArgs: string) {
    setLines([]);
    setRecord(null);
    const prompt = extraArgs.trim()
      ? `${skill.slashCommand} ${extraArgs.trim()}`
      : skill.slashCommand;
    try {
      const { launchId } = await apiPost<{ launchId: string }>("/api/launch", {
        prompt,
      });
      const es = new EventSource(`/api/launch/${launchId}/stream`);
      esRef.current = es;
      es.addEventListener("progress", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
          const line = eventLine(parsed);
          if (line) setLines((prev) => [...prev.slice(-500), line]);
        } catch {
          /* non-JSON payloads are ignored */
        }
      });
      es.addEventListener("done", (ev) => {
        try {
          setRecord(JSON.parse((ev as MessageEvent).data) as LaunchRecord);
        } catch {
          /* ignore */
        }
        es.close();
      });
      es.onerror = () => es.close();
      setRecord({ launchId, prompt, status: "running" });
    } catch (e) {
      setError(e);
    }
  }

  async function cancelLaunch(launchId: string) {
    try {
      await apiPost(`/api/launch/${launchId}/cancel`, {});
    } catch (e) {
      setError(e);
    }
  }

  const grouped = new Map<string, SkillInfo[]>();
  for (const s of skills ?? []) {
    const list = grouped.get(s.source) ?? [];
    list.push(s);
    grouped.set(s.source, list);
  }

  return (
    <div>
      <h1 className="view-title">
        Skills + <span className="accent">Launch</span>
      </h1>
      <p className="view-sub">
        one catalog, one click - runs headlessly via claude -p
      </p>

      <div className="toolbar">
        <input
          type="search"
          placeholder="filter by name or description"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 320 }}
        />
        {skills && <span className="row-meta">{skills.length} skills</span>}
      </div>

      {/* The distribution, not just the total. A count of installed skills says
          nothing a reader can act on; the split between what they reach for and
          what has been sitting there unused since it was installed does. */}
      {skills && skills.some((s) => s.staleness !== null) && (
        <p className="row-meta" style={{ marginTop: -8, marginBottom: 16, lineHeight: 1.55 }}>
          {(["never", "cold", "cooling", "active"] as const)
            .map((band) => ({ band, n: skills.filter((s) => s.staleness === band).length }))
            .filter((row) => row.n > 0)
            .map((row) => `${row.n} ${row.band}`)
            .join(", ")}
          {". "}
          Counted from Claude Code's own invocation counters, which count invocations
          rather than the records a skill produced - the Skill Trend pillar counts the
          other unit, and the two rank differently and are never summed.
        </p>
      )}

      {error != null && <FailureState error={error} />}
      {skills === null && !error && <Skeleton kind="rows" count={6} label="scanning skill roots..." />}

      <div className="split">
        <div>
          {[...grouped.entries()].map(([source, list]) => (
            <div key={source} style={{ marginBottom: 18 }}>
              <h3
                style={{
                  borderLeft: "3px solid var(--primary)",
                  paddingLeft: 8,
                  fontSize: 13,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {source} <span className="row-meta">({list.length})</span>
              </h3>
              {[...list].sort(byHabit).map((s) => (
                <div key={s.slashCommand} className="card">
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text)", fontWeight: 700 }}>{s.name}</span>
                    <span className={sourceBadge(s.source)}>{s.source}</span>
                    <code className="row-meta">{s.slashCommand}</code>
                    {s.staleness !== null && (
                      <span
                        className={stalenessBadge(s.staleness)}
                        title={
                          s.lastUsedAt
                            ? `last invoked ${daysAgo(s.lastUsedAt)} day(s) ago`
                            : "no invocation ever recorded for it"
                        }
                      >
                        {s.staleness}
                      </span>
                    )}
                    {s.usageCount !== null && s.usageCount > 0 && (
                      <span
                        className="row-meta"
                        title={
                          s.usageMatch === "exact"
                            ? "counter matched this skill's full command"
                            : "counter matched on the bare name only, so it may belong to a namesake"
                        }
                      >
                        {s.usageCount}x{s.usageMatch === "name" ? " (by name)" : ""}
                      </span>
                    )}
                    <button
                      className="primary"
                      style={{ marginLeft: "auto" }}
                      onClick={() => {
                        setLaunching(s);
                        setArgs("");
                      }}
                    >
                      launch
                    </button>
                  </div>
                  <div className="row-meta" style={{ fontFamily: "var(--font-ui)", marginTop: 6 }}>
                    {s.description.slice(0, 220)}
                    {s.description.length > 220 ? "..." : ""}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="detail-pane">
          {launching ? (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>
                launch <code>{launching.slashCommand}</code>
              </h3>
              <div className="toolbar">
                <input
                  type="text"
                  placeholder="optional arguments"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="ember"
                  disabled={record?.status === "running"}
                  onClick={() => void startLaunch(launching, args)}
                >
                  {record?.status === "running" ? "running..." : "run"}
                </button>
                {record?.status === "running" && (
                  <button onClick={() => void cancelLaunch(record.launchId)}>
                    cancel
                  </button>
                )}
              </div>
              {record && (
                <div style={{ marginBottom: 8 }}>
                  <span
                    className={`badge ${
                      record.status === "done"
                        ? "success"
                        : record.status === "running"
                          ? "spark"
                          : "warn"
                    }`}
                  >
                    {record.status}
                  </span>{" "}
                  {record.exitCode !== null && record.exitCode !== undefined && (
                    <span className="row-meta">exit {record.exitCode} </span>
                  )}
                  {record.totalCostUsd !== undefined && (
                    <span className="row-meta">
                      cost ${record.totalCostUsd.toFixed(4)}{" "}
                    </span>
                  )}
                  {record.allowedTools && (
                    <div className="row-meta" style={{ marginTop: 4 }}>
                      tools: {record.allowedTools}
                    </div>
                  )}
                  {record.cwd && <div className="row-meta">cwd: {record.cwd}</div>}
                </div>
              )}
              <pre
                ref={logRef}
                style={{ maxHeight: 420, overflowY: "auto", fontSize: 12 }}
              >
                {lines.length ? lines.join("\n") : "streamed progress appears here"}
              </pre>
            </div>
          ) : (
            <div className="empty-state">
              pick a skill and hit launch; progress streams here live
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
