import { useApi } from "../api";
import { compact } from "../format";
import { RailLegend, Skeleton } from "../PillarState";

/**
 * The at-a-glance read.
 *
 * Everything here is already computed by a pillar that explains it properly, so
 * this page makes no claim of its own: it is a routing surface, and every figure
 * links to the pillar that owns it. That is deliberate - a landing page that
 * derived its own numbers would be a second place for them to be wrong.
 *
 * Each block reads from its own source and renders as soon as that source answers,
 * because two of them scan the whole transcript tree and waiting for the slowest
 * would make the fast ones feel broken. A block whose source is absent says so and
 * the rest of the page carries on; a missing source is a first-run state here
 * exactly as it is everywhere else.
 */

type NamedCount = { name: string; count: number };

type Totals = {
  sessionsScanned: number;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  models: NamedCount[];
  toolCalls: NamedCount[];
  skills: NamedCount[];
  mcpServers: NamedCount[];
  toolDenials: NamedCount[];
  hookInvocations: number;
};

type HistoryStats = {
  totalPrompts: number;
  byProject: Array<{ project: string; projectPath: string; count: number }>;
  byHour: number[];
  byDay: Array<{ date: string; count: number }>;
};

type HookHealth = { hooks: Array<{ label: string; totalMs: number }>; totalMs: number };

type SkillInfo = { name: string; usageCount: number; staleness: string };

type FrictionAging = {
  openCount: number;
  oldestOpenDays: number;
  resolutionRate: number;
};

type McpUsage = { decay: { stats: { configuredNamesNeverCalled: number } } };

type Instructions = {
  buckets: Array<{ bucket: string; chars: number; files: number }>;
  alwaysLoaded: { ceilingChars: number; percentOfCeilingLargestFile: number | null };
};

type Delegation = {
  totals: { dispatches: number; delegatedRecords: number; delegatedOutputTokens: number | null };
};

/** A short ranked strip. Five is enough to show a shape without becoming a table. */
function TopFive({
  title,
  rows,
  href,
  unit,
}: {
  title: string;
  rows: NamedCount[] | undefined;
  href: string;
  unit: string;
}) {
  if (!rows || rows.length === 0) return null;
  const widest = rows[0]!.count || 1;
  return (
    <div className="card">
      <a className="overview-strip-title" href={href}>
        {title}
      </a>
      <div className="row-meta" style={{ marginBottom: 7 }}>
        {unit}
      </div>
      {rows.slice(0, 5).map((row) => (
        <div className="overview-row" key={row.name}>
          <span className="overview-row-name" title={row.name}>
            {row.name}
          </span>
          <span className="bar-cell" style={{ flex: 1 }}>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${Math.max((row.count / widest) * 100, 2)}%` }}
              />
            </span>
          </span>
          <span className="num-cell overview-row-count">{compact(row.count)}</span>
        </div>
      ))}
    </div>
  );
}

/** One line of the attention block: a count, what it means, and where to act on it. */
function Attention({
  n,
  of,
  label,
  href,
  urgent = false,
}: {
  n: number | string;
  of?: number;
  label: string;
  href: string;
  urgent?: boolean;
}) {
  return (
    <a className={`attention-row${urgent ? " urgent" : ""}`} href={href}>
      <span className="attention-count">
        {typeof n === "number" ? n.toLocaleString() : n}
        {of !== undefined && <span className="attention-of"> of {of}</span>}
      </span>
      <span className="attention-label">{label}</span>
    </a>
  );
}

export function OverviewView() {
  // Each source is fetched independently so one slow scan cannot hold up the page.
  const totals = useApi<Totals>("/api/sessions/totals?limit=40");
  const history = useApi<HistoryStats>("/api/history/stats");
  const hooks = useApi<HookHealth>("/api/hooks?limit=40");
  const skills = useApi<SkillInfo[]>("/api/skills");
  const friction = useApi<FrictionAging>("/api/friction/aging");
  const mcp = useApi<McpUsage>("/api/mcp-usage");
  const instructions = useApi<Instructions>("/api/instructions");
  const delegation = useApi<Delegation>("/api/delegation");

  // A fresh clone lands here, so this page needs a first-run state of its own. Every
  // block hiding itself individually leaves a title, two paragraphs and nothing else,
  // which reads as broken rather than as empty - the one impression the source-missing
  // contract exists to prevent, on the first screen anybody sees.
  const primarySources = [totals, history, skills];
  const stillLoading = primarySources.some((s) => s.loading && !s.data);
  const nothingToShow =
    !stillLoading && primarySources.every((s) => !s.data);

  const hasRankings = Boolean(
    totals.data?.toolCalls.length ||
      totals.data?.skills.length ||
      totals.data?.models.length ||
      history.data?.byProject.length,
  );

  const neverInvoked = skills.data?.filter((s) => s.usageCount === 0).length;
  const cooling = skills.data?.filter(
    (s) => s.staleness === "cold" || s.staleness === "cooling",
  ).length;
  const always = instructions.data?.buckets.find((b) => b.bucket === "always");
  const peakHour = history.data
    ? history.data.byHour.indexOf(Math.max(...history.data.byHour))
    : null;
  const hasAttention = Boolean(
    friction.data?.openCount ||
      neverInvoked ||
      cooling ||
      mcp.data?.decay.stats.configuredNamesNeverCalled ||
      always ||
      hooks.data?.hooks.length,
  );
  const recentDays = history.data?.byDay.slice(0, 30).reverse() ?? [];
  const peakDay = Math.max(...recentDays.map((d) => d.count), 1);

  return (
    <div>
      <h1 className="view-title">
        How You Are <span className="accent">Using Claude</span>
      </h1>
      <p className="view-sub">
        the shape of it in one page - every figure here is owned and explained by a
        pillar, and links to it; nothing on this page is a claim of its own
      </p>

      {nothingToShow && (
        <div className="not-configured">
          <div className="not-configured-head">
            <span className="badge info">nothing recorded yet</span>
            <span className="row-meta">first run</span>
          </div>
          <p className="not-configured-lead">
            This page summarises how you use Claude Code, and it reads what Claude
            Code writes as you work. Nothing has been recorded on this machine yet,
            so there is nothing to summarise - which is a first run, not a fault.
          </p>
          <p className="not-configured-how">
            Use Claude Code once and come back: sessions, prompts and skills appear on
            their own, with no configuration. The optional pillars - a memory vault, a
            friction log, session wraps and a token database - describe one operator's
            own note-taking and stay empty until you point them at yours.
          </p>
          <div className="not-configured-path">
            <span className="row-meta">see every source and what it is missing</span>
            <code>npm run doctor</code>
          </div>
        </div>
      )}

      {/* ---- headline ---------------------------------------------------- */}
      {totals.loading && !totals.data ? (
        <Skeleton kind="tiles" count={4} label="reading sessions..." />
      ) : totals.data ? (
        <>
          <div className="stat-grid">
            <div className="stat-tile bounded">
              <div className="num">{totals.data.sessionsScanned}</div>
              <div className="row-meta">sessions read</div>
            </div>
            <div className="stat-tile bounded">
              <div className="num">{compact(totals.data.tokens.output)}</div>
              <div className="row-meta">output tokens</div>
            </div>
            <div className="stat-tile bounded">
              <div className="num">{compact(totals.data.tokens.cacheRead)}</div>
              <div className="row-meta">cache read</div>
            </div>
            {history.data && (
              <div className="stat-tile">
                <div className="num">{history.data.totalPrompts.toLocaleString()}</div>
                <div className="row-meta">prompts, all time</div>
              </div>
            )}
            {delegation.data && (
              <div className="stat-tile">
                <div className="num">{delegation.data.totals.dispatches}</div>
                <div className="row-meta">handed to subagents</div>
              </div>
            )}
          </div>
          <RailLegend present={["measured", "bounded"]} />
          <p className="row-meta" style={{ marginTop: -4, marginBottom: 20, lineHeight: 1.55 }}>
            The token figures cover the {totals.data.sessionsScanned} most recent
            sessions rather than your whole history, which is why they are marked as
            bounded. Prompts and dispatches are counted across everything on disk.
          </p>
        </>
      ) : null}

      {/* ---- what needs attention ---------------------------------------- */}
      {hasAttention && (
        <>
      <h3>Worth a look</h3>
      <p className="row-meta" style={{ marginTop: -6, marginBottom: 10 }}>
        Only things with an action attached. Each one opens the pillar that explains
        it; none of them is a recommendation to act without reading that first.
      </p>
      <div className="attention-grid">
        {friction.data && friction.data.openCount > 0 && (
          <Attention
            n={friction.data.openCount}
            label={`open friction loops, oldest ${friction.data.oldestOpenDays} days`}
            href="#/friction"
            urgent={friction.data.oldestOpenDays > 92}
          />
        )}
        {neverInvoked !== undefined && skills.data && (
          <Attention
            n={neverInvoked}
            of={skills.data.length}
            label="skills installed and never once invoked"
            href="#/skills"
          />
        )}
        {cooling !== undefined && cooling > 0 && (
          <Attention n={cooling} label="skills cooling or gone cold" href="#/skill-trend" />
        )}
        {mcp.data && mcp.data.decay.stats.configuredNamesNeverCalled > 0 && (
          <Attention
            n={mcp.data.decay.stats.configuredNamesNeverCalled}
            label="MCP servers configured and never called"
            href="#/mcp-usage"
          />
        )}
        {always && instructions.data && (
          <Attention
            n={`${Math.round((instructions.data.alwaysLoaded.percentOfCeilingLargestFile ?? 0))}%`}
            label={`of the instruction ceiling, largest always-loaded file (${compact(always.chars)} chars over ${always.files})`}
            href="#/instructions"
            urgent={(instructions.data.alwaysLoaded.percentOfCeilingLargestFile ?? 0) >= 95}
          />
        )}
        {hooks.data && hooks.data.hooks.length > 0 && (
          <Attention
            n={`${(hooks.data.totalMs / 1000).toFixed(0)}s`}
            label={`of hook time across these sessions, worst is ${hooks.data.hooks[0]!.label}`}
            href="#/hooks"
          />
        )}
      </div>
        </>
      )}

      {/* ---- rhythm ------------------------------------------------------ */}
      {history.data && peakHour !== null && (
        <>
          <h3 style={{ marginTop: 26 }}>When you work</h3>
          <p className="row-meta" style={{ marginTop: -6, marginBottom: 8 }}>
            Prompts by hour of day, busiest at {String(peakHour).padStart(2, "0")}:00.
          </p>
          <div className="hour-chart">
            {history.data.byHour.map((count, hour) => {
              const peak = Math.max(...history.data!.byHour) || 1;
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

          {recentDays.length > 1 && (
            <>
              <p className="row-meta" style={{ marginTop: 14, marginBottom: 8 }}>
                Prompts per day, most recent {recentDays.length} days with activity.
              </p>
              <div className="hour-chart">
                {recentDays.map((day) => (
                  <div className="hour-col" key={day.date} title={`${day.date} - ${day.count} prompts`}>
                    <div className="hour-track">
                      <div
                        className="hour-bar"
                        style={{ height: `${Math.max((day.count / peakDay) * 100, 1)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* ---- rankings ---------------------------------------------------- */}
      {hasRankings && (
        <>
      <h3 style={{ marginTop: 26 }}>What you reach for</h3>
      <p className="row-meta" style={{ marginTop: -6, marginBottom: 10 }}>
        Bounded by the same {totals.data?.sessionsScanned ?? 40} most recent sessions
        as the tiles above. Prompt counts per project cover everything on disk.
      </p>
      <div className="overview-strips">
        <TopFive
          title="Tools"
          rows={totals.data?.toolCalls}
          href="#/sessions"
          unit="calls"
        />
        <TopFive
          title="Skills"
          rows={totals.data?.skills}
          href="#/skill-trend"
          unit="invocations"
        />
        <TopFive
          title="Models"
          rows={totals.data?.models}
          href="#/usage"
          unit="turns"
        />
        <TopFive
          title="MCP servers"
          rows={totals.data?.mcpServers}
          href="#/mcp-usage"
          unit="calls"
        />
        {history.data && (
          <TopFive
            title="Projects"
            rows={history.data.byProject.map((p) => ({
              name: p.projectPath.split("/").filter(Boolean).slice(-2).join("/"),
              count: p.count,
            }))}
            href="#/history"
            unit="prompts"
          />
        )}
        <TopFive
          title="Denied tools"
          rows={totals.data?.toolDenials}
          href="#/sessions"
          unit="refusals"
        />
      </div>
        </>
      )}

      {!nothingToShow && (
      <p className="row-meta" style={{ marginTop: 18, lineHeight: 1.55 }}>
        Blocks appear as their sources answer, so a slow scan never holds up the rest
        of the page. A block that is missing entirely means its source is not on this
        machine; open the pillar itself to see which path it looked for.
      </p>
      )}
    </div>
  );
}
