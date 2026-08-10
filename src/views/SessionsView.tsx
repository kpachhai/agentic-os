import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { compact } from "../format";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type NamedCount = { name: string; count: number };
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
  cwdSource: "record" | "decoded";
  title: string;
  titleSource: "ai-title" | "first-prompt" | "session-id";
  startedAt: string;
  endedAt: string;
  version: string;
  gitBranch: string;
  messageCount: number;
  userTurns: number;
  assistantTurns: number;
  models: NamedCount[];
  tokens: TokenTotals;
  toolCalls: NamedCount[];
  skills: NamedCount[];
  mcpServers: NamedCount[];
  hookInvocations: number;
  toolDenials: NamedCount[];
  skippedLines: number;
};

type TimelineEntry = {
  uuid: string;
  type: string;
  timestamp: string;
  model: string | null;
  text: string;
  textTruncated: boolean;
  toolUses: NamedCount[];
  tokens: TokenTotals | null;
  attributionSkill: string | null;
  attributionMcpServer: string | null;
  isSidechain: boolean;
  isMeta: boolean;
  denialKind: string | null;
  isBranchPoint: boolean;
};

type TouchedFile = {
  path: string;
  edits: number;
  linesAdded: number;
  linesRemoved: number;
  firstTouchedAt: string;
  lastTouchedAt: string;
  userModified: boolean;
};

type SessionDetail = SessionSummary & {
  timeline: TimelineEntry[];
  touchedFiles: TouchedFile[];
  blastRadius: {
    files: number;
    edits: number;
    linesAdded: number;
    linesRemoved: number;
    filesUserModified: number;
  };
};

type Totals = {
  sessionsScanned: number;
  tokens: TokenTotals;
  models: NamedCount[];
  toolCalls: NamedCount[];
  skills: NamedCount[];
  mcpServers: NamedCount[];
  toolDenials: NamedCount[];
  hookInvocations: number;
  skippedLines: number;
};

/**
 * Absolute paths are long and their distinguishing part is at the end, so the tail
 * is kept and the head dropped. The full path stays available on hover, because a
 * shortened path is ambiguous between two projects with the same layout.
 */
function shortFile(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.length <= 3 ? fullPath : `.../${parts.slice(-3).join("/")}`;
}

function shortDate(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "unknown";
}

/** Where the session's name came from, said plainly rather than as a field name. */
function titleProvenance(source: SessionSummary["titleSource"]): string {
  if (source === "ai-title") return "named by Claude Code";
  if (source === "first-prompt") return "first prompt";
  return "no title recorded";
}

/**
 * What Claude Code's `/insights` command concluded about this session, when it
 * ran at all. A judgement rather than a measurement, so it sits apart from the
 * counted figures and says whose opinion it is.
 */
type OutcomeJudgement = {
  outcome: string;
  claudeHelpfulness: string;
  sessionType: string;
  primarySuccess: string;
  briefSummary: string;
  frictionCount: number;
  /** Present on the not-judged response, which is the common case. */
  judged?: false;
};

function outcomeBadge(outcome: string): string {
  if (outcome === "fully_achieved") return "badge success";
  if (outcome === "mostly_achieved") return "badge info";
  if (outcome === "not_achieved") return "badge warn";
  return "badge purple";
}

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [outcome, setOutcome] = useState<OutcomeJudgement | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setSessions(null);
    const params = new URLSearchParams({ limit: "40" });
    if (query) params.set("q", query);
    // Debounced, and aborted on supersession. Without the delay, typing eight
    // characters fired eight scans of the transcript tree; without the abort, the
    // rows on screen were whichever of them happened to land last, which need not
    // be the one matching what the box now says.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      apiGet<SessionSummary[]>(`/api/sessions?${params}`, { signal: controller.signal })
        .then((rows) => {
          setSessions(rows);
          setError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    apiGet<Totals>("/api/sessions/totals?limit=40")
      .then(setTotals)
      .catch(() => setTotals(null));
  }, []);

  const open = (session: SessionSummary): void => {
    setSelected(null);
    setOutcome(null);
    apiGet<SessionDetail>(
      `/api/sessions/${encodeURIComponent(session.projectDir)}/${encodeURIComponent(session.sessionId)}`,
    )
      .then(setSelected)
      .catch(setError);
    // A judgement is a bonus, not part of the session. Most sessions have none,
    // and the store may not exist at all, so a failure here leaves the detail
    // panel exactly as it was rather than reaching the error path.
    apiGet<OutcomeJudgement>(`/api/outcomes/${encodeURIComponent(session.sessionId)}`)
      .then((found) => setOutcome("judged" in found ? null : found))
      .catch(() => setOutcome(null));
  };

  // The heading stays even when the source is absent: a bare panel leaves the
  // reader unable to tell which pillar they are looking at.
  const header = (
    <>
      <h1 className="view-title">
        Claude <span className="accent">Sessions</span>
      </h1>
      <p className="view-sub">
        read straight from Claude Code's own transcripts; no plugin required
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

  return (
    <div>
      {header}

      {totals && (
        <div className="stat-grid">
          {/* Bounded, every one of them. The scan is the newest N sessions by
              request, which is why sessionsScanned comes back at all: without it a
              reader adds these up and reads the result as a lifetime total. A
              measured rail here would be the same defect as mislabelling the
              number. */}
          <div className="stat-tile bounded">
            <div className="num">{totals.sessionsScanned}</div>
            <div className="row-meta">sessions read</div>
          </div>
          <div className="stat-tile bounded">
            <div className="num">{compact(totals.tokens.output)}</div>
            <div className="row-meta">output tokens, newest {totals.sessionsScanned}</div>
          </div>
          <div className="stat-tile bounded">
            <div className="num">{compact(totals.tokens.cacheRead)}</div>
            <div className="row-meta">cache read, newest {totals.sessionsScanned}</div>
          </div>
          <div className="stat-tile bounded">
            <div className="num">{totals.hookInvocations}</div>
            <div className="row-meta">hook runs, newest {totals.sessionsScanned}</div>
          </div>
        </div>
      )}
      {totals && <RailLegend present={["bounded"]} />}

      {/* Six ranked lists came back in this payload and four of them were being
          thrown away, so the pillar answered "how much" and not "of what". Each is
          bounded by the same scan as the tiles above, which is said once, above, so
          it is not repeated per strip. */}
      {totals && (
        <div className="stat-grid" style={{ marginTop: 12 }}>
          {(
            [
              ["models", totals.models, "models used"],
              ["tools", totals.toolCalls, "tools called"],
              ["skills", totals.skills, "skills invoked"],
              ["mcp", totals.mcpServers, "MCP servers called"],
              ["denials", totals.toolDenials, "tools denied"],
            ] as const
          )
            .filter(([, rows]) => rows && rows.length > 0)
            .map(([key, rows, label]) => (
              <div key={key} className="card">
                <div className="row-meta" style={{ marginBottom: 6 }}>{label}</div>
                {rows.slice(0, 5).map((row) => (
                  <div
                    key={row.name}
                    style={{ display: "flex", gap: 8, justifyContent: "space-between" }}
                  >
                    <span title={row.name} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.name}
                    </span>
                    <span className="row-meta">{compact(row.count)}</span>
                  </div>
                ))}
                {rows.length > 5 && (
                  <div className="row-meta" style={{ marginTop: 4 }}>
                    +{rows.length - 5} more
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {totals && (
        <p className="row-meta" style={{ marginTop: 12, marginBottom: 16 }}>
          Totals cover the {totals.sessionsScanned} most recent sessions, not your
          whole history. Dollar cost is on the Usage page instead, grouped into the
          five-hour windows your limits are expressed in, because a per-session
          figure invites adding it up across a bounded scan and reading the result as
          a lifetime total.
          {totals.skippedLines > 0 && (
            <>
              {" "}
              {totals.skippedLines} transcript line(s) in that scan would not parse, so
              these figures are a floor even within it.
            </>
          )}
        </p>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="filter by title, directory or branch"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 320 }}
        />
        {sessions && <span className="row-meta">{sessions.length} shown</span>}
      </div>

      {sessions === null && <Skeleton kind="rows" count={6} label="reading transcripts..." />}
      {sessions !== null && sessions.length === 0 && (
        <div className="empty-state">no sessions match this filter</div>
      )}

      <div className="split">
        <div>
          {sessions?.map((session) => (
            <div
              key={`${session.projectDir}/${session.sessionId}`}
              className={`card list-row${
                selected?.sessionId === session.sessionId ? " selected" : ""
              }`}
              onClick={() => open(session)}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="badge purple">{shortDate(session.startedAt)}</span>
                {session.gitBranch && (
                  <span className="badge info">{session.gitBranch}</span>
                )}
                {session.skippedLines > 0 && (
                  <span
                    className="badge warn"
                    title="lines the parser could not read; reported rather than hidden"
                  >
                    {session.skippedLines} skipped
                  </span>
                )}
              </div>
              <div style={{ margin: "7px 0 0", lineHeight: 1.45 }}>{session.title}</div>
              <div className="row-meta" style={{ marginTop: 5 }}>
                {titleProvenance(session.titleSource)} &middot; {session.cwd}
                {session.cwdSource === "decoded" && " (reconstructed)"}
              </div>
              <div className="row-meta" style={{ marginTop: 5 }}>
                {session.userTurns} prompts &middot; {session.assistantTurns} replies
                &middot; {compact(session.tokens.output)} out
                {session.skills.length > 0 && (
                  <> &middot; {session.skills.map((s) => s.name).join(", ")}</>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="detail-pane">
          {selected ? (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>{selected.title}</h2>
              <div className="row-meta">
                {selected.cwd} &middot; Claude Code {selected.version || "unknown"}
              </div>

              {outcome && (
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 10 }}>
                  <span className={outcomeBadge(outcome.outcome)}>
                    {outcome.outcome.replace(/_/g, " ")}
                  </span>
                  <span className="badge info">
                    {outcome.claudeHelpfulness.replace(/_/g, " ")}
                  </span>
                  {outcome.frictionCount > 0 && (
                    <span className="badge warn">{outcome.frictionCount} friction</span>
                  )}
                  {/* Whose claim this is, on the same line as the claim. Every
                      other figure in this panel was counted off the transcript;
                      this one is a model's reading of it. */}
                  <span className="row-meta">judged by /insights, not measured here</span>
                </div>
              )}
              {outcome?.briefSummary && (
                <p style={{ margin: "8px 0 0" }}>{outcome.briefSummary}</p>
              )}

              <div className="stat-grid" style={{ marginTop: 14 }}>
                <div className="stat-tile">
                  <div className="num">{selected.messageCount}</div>
                  <div className="row-meta">messages</div>
                </div>
                <div className="stat-tile">
                  <div className="num">{compact(selected.tokens.cacheRead)}</div>
                  <div className="row-meta">cache read</div>
                </div>
                <div className="stat-tile">
                  <div className="num">
                    {selected.timeline.filter((e) => e.isBranchPoint).length}
                  </div>
                  <div className="row-meta">rewind forks</div>
                </div>
              </div>

              {selected.blastRadius.files > 0 && (
                <>
                  <h3>Blast radius</h3>
                  <p className="row-meta">
                    Every file this session edited, including ones whose changes were
                    later reverted or overwritten. A diff shows what survived; this
                    shows what was touched, which is the question that matters when
                    something broke and you are trying to remember where the session
                    had been. {selected.blastRadius.files} file
                    {selected.blastRadius.files === 1 ? "" : "s"} over{" "}
                    {selected.blastRadius.edits} edit
                    {selected.blastRadius.edits === 1 ? "" : "s"}, +
                    {selected.blastRadius.linesAdded} / -
                    {selected.blastRadius.linesRemoved} lines
                    {selected.blastRadius.filesUserModified > 0 &&
                      `, ${selected.blastRadius.filesUserModified} later changed by hand`}
                    .
                  </p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>file</th>
                        <th className="num-cell">edits</th>
                        <th className="num-cell">+</th>
                        <th className="num-cell">-</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.touchedFiles.slice(0, 20).map((file) => (
                        <tr key={file.path}>
                          <td title={file.path}>
                            {shortFile(file.path)}
                            {file.userModified && (
                              <span
                                className="badge warn"
                                style={{ marginLeft: 6 }}
                                title="you changed this file yourself after an edit, which usually marks a spot where the agent's version was not right"
                              >
                                you fixed it
                              </span>
                            )}
                          </td>
                          <td className="num-cell">{file.edits}</td>
                          <td className="num-cell">{file.linesAdded}</td>
                          <td className="num-cell">{file.linesRemoved}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {selected.touchedFiles.length > 20 && (
                    <p className="row-meta">
                      showing the 20 most-edited of {selected.touchedFiles.length} files
                    </p>
                  )}
                </>
              )}

              {selected.toolCalls.length > 0 && (
                <>
                  <h3>Tools</h3>
                  <table className="data-table">
                    <tbody>
                      {selected.toolCalls.slice(0, 10).map((tool) => {
                        const widest = selected.toolCalls[0]!.count;
                        return (
                          <tr key={tool.name}>
                            <td>{tool.name}</td>
                            <td style={{ width: "55%" }}>
                              <div className="bar-cell">
                                <div className="bar-track">
                                  <div
                                    className="bar-fill"
                                    style={{ width: `${(tool.count / widest) * 100}%` }}
                                  />
                                </div>
                                <span className="num-cell">{tool.count}</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}

              {selected.toolDenials.length > 0 && (
                <>
                  <h3>Denied tool calls</h3>
                  <p className="row-meta">
                    What you keep refusing is the cheapest guide to tuning your
                    allowlist.
                  </p>
                  {selected.toolDenials.map((denial) => (
                    <div key={denial.name} className="row-meta">
                      {denial.name}: {denial.count}
                    </div>
                  ))}
                </>
              )}

              <h3>Timeline</h3>
              {selected.timeline.slice(0, 60).map((entry) => (
                <div
                  key={entry.uuid || entry.timestamp}
                  style={{
                    borderLeft: `2px solid var(--${
                      entry.type === "user" ? "primary" : entry.type === "system" ? "steel-border" : "ember"
                    })`,
                    paddingLeft: 10,
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
                    <span className="row-meta">{entry.type}</span>
                    {entry.isBranchPoint && (
                      <span className="badge spark" title="the conversation forked here">
                        fork
                      </span>
                    )}
                    {entry.attributionSkill && (
                      <span className="badge info">{entry.attributionSkill}</span>
                    )}
                    {entry.isMeta && <span className="row-meta">injected context</span>}
                    {entry.denialKind && (
                      <span className="badge warn">{entry.denialKind}</span>
                    )}
                  </div>
                  {entry.text && (
                    <div style={{ marginTop: 4, lineHeight: 1.45, color: "var(--text-body)" }}>
                      {entry.text}
                      {entry.textTruncated && <span className="row-meta"> ...</span>}
                    </div>
                  )}
                  {entry.toolUses.length > 0 && (
                    <div className="row-meta" style={{ marginTop: 3 }}>
                      {entry.toolUses.map((t) => `${t.name}${t.count > 1 ? ` x${t.count}` : ""}`).join(", ")}
                    </div>
                  )}
                </div>
              ))}
              {selected.timeline.length > 60 && (
                <p className="row-meta">
                  showing the first 60 of {selected.timeline.length} entries
                </p>
              )}
            </div>
          ) : (
            <div className="empty-state">select a session</div>
          )}
        </div>
      </div>
    </div>
  );
}
