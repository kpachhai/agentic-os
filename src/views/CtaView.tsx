import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "../api";
import { compact, compactAxis } from "../format";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type CtaDay = {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionCount: number;
};

type CtaModelRow = {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
};

type CtaProjectRow = {
  projectPath: string;
  costUsd: number;
  sessionCount: number;
};

type CtaSummary = {
  totalCostUsd: number;
  totalSessions: number;
  meanCacheHitRate: number | null;
  subagentShare: number;
  compressionEvents: number;
};

/**
 * The categorical series, read from the stylesheet so the palette lives in one
 * place. recharts writes these into SVG attributes, which do not accept a
 * custom property, so they are resolved once rather than referenced per mark.
 */
const SERIES = [1, 2, 3, 4].map(
  (slot) =>
    getComputedStyle(document.documentElement)
      .getPropertyValue(`--series-${slot}`)
      .trim() || "#217bf4",
);

/** A fill is the same hue at reduced opacity; the stroke stays full strength. */
const fillOf = (hex: string): string => `${hex}55`;

/**
 * Category labels are truncated from the LEFT.
 *
 * These are encoded project directories, whose distinguishing part is the tail. A
 * fixed axis width silently clipped the head, which turns one project's name into
 * something that reads as another's; dropping the head deliberately and marking it
 * says which end was lost. The full name stays in the tooltip.
 */
const AXIS_LABEL_MAX = 26;
const axisLabel = (value: string): string =>
  value.length <= AXIS_LABEL_MAX ? value : `...${value.slice(-(AXIS_LABEL_MAX - 3))}`;

const AXIS = { stroke: "var(--chart-axis)", fontSize: 11 };
const GRID = "var(--chart-grid)";
const TOOLTIP_STYLE = {
  backgroundColor: "var(--surface-mid)",
  border: "1px solid var(--steel-border)",
  borderRadius: 0,
  color: "var(--text)",
  fontSize: 12,
};

function shortProject(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** Compact large token counts so Y-axis ticks (millions) do not overflow. */
export function CtaView() {
  const [days, setDays] = useState<CtaDay[] | null>(null);
  const [models, setModels] = useState<CtaModelRow[]>([]);
  const [projects, setProjects] = useState<CtaProjectRow[]>([]);
  const [sum, setSum] = useState<CtaSummary | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    Promise.all([
      apiGet<CtaDay[]>("/api/cta/trends"),
      apiGet<CtaModelRow[]>("/api/cta/by-model"),
      apiGet<CtaProjectRow[]>("/api/cta/by-project"),
      apiGet<CtaSummary>("/api/cta/summary"),
    ])
      .then(([d, m, p, s]) => {
        setDays(d);
        setModels(m);
        setProjects(p.slice(0, 12));
        setSum(s);
        setError(null);
      })
      .catch(setError);
  }, []);

  return (
    <div>
      {/* Ember discipline: this view's single ember accent is the cost area
          chart (the most important element), so the title stays plain. */}
      <h1 className="view-title">Token Trends</h1>
      <p className="view-sub">token-analyzer.db, opened read-only - zero writes</p>

      {error != null && <FailureState error={error} />}
      {days === null && !error && <Skeleton kind="tiles" count={4} label="querying CTA database..." />}

      {sum && (
        <>
        <div className="stat-grid">
          <div className="stat-tile derived">
            <div className="num">${sum.totalCostUsd.toFixed(0)}</div>
            <div className="label">total cost</div>
          </div>
          <div className="stat-tile">
            <div className="num">{sum.totalSessions}</div>
            <div className="label">sessions</div>
          </div>
          <div className="stat-tile derived">
            <div className="num">
              {sum.meanCacheHitRate === null
                ? "n/a"
                : `${(sum.meanCacheHitRate * 100).toFixed(1)}%`}
            </div>
            <div className="label">mean cache hit rate</div>
          </div>
          <div className="stat-tile derived">
            <div className="num">{(sum.subagentShare * 100).toFixed(1)}%</div>
            <div className="label">subagent share</div>
          </div>
          <div className="stat-tile">
            <div className="num">{sum.compressionEvents}</div>
            <div className="label">compression events</div>
          </div>
        </div>
        <RailLegend present={["measured", "derived"]} />
        </>
      )}

      {days && days.length > 0 && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Cost per day (USD)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={days}>
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={AXIS} minTickGap={40} />
                <YAxis tick={AXIS} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Area
                  type="monotone"
                  dataKey="costUsd"
                  name="cost USD"
                  stroke={SERIES[0]}
                  fill={fillOf(SERIES[0]!)}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Tokens per day (stacked by type)</h3>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={days} stackOffset="none">
                <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={AXIS} minTickGap={40} />
                <YAxis tick={AXIS} width={52} tickFormatter={compact} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v) => compact(Number(v))}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area stackId="t" type="monotone" dataKey="cacheReadTokens" name="cache read" stroke={SERIES[0]} fill={fillOf(SERIES[0]!)} />
                <Area stackId="t" type="monotone" dataKey="cacheCreationTokens" name="cache creation" stroke={SERIES[1]} fill={fillOf(SERIES[1]!)} />
                <Area stackId="t" type="monotone" dataKey="inputTokens" name="input" stroke={SERIES[2]} fill={fillOf(SERIES[2]!)} />
                <Area stackId="t" type="monotone" dataKey="outputTokens" name="output" stroke={SERIES[3]} fill={fillOf(SERIES[3]!)} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Cost by model</h3>
              <ResponsiveContainer width="100%" height={Math.max(160, models.length * 34)}>
                <BarChart data={models} layout="vertical">
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                  <XAxis type="number" tick={AXIS} tickFormatter={(v: number) => `$${compactAxis(v)}`} />
                  <YAxis type="category" dataKey="model" tick={AXIS} width={170} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="costUsd" name="cost USD" fill={SERIES[0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Cost by project (top 12)</h3>
              <ResponsiveContainer width="100%" height={Math.max(160, projects.length * 34)}>
                <BarChart
                  data={projects.map((p) => ({ ...p, name: shortProject(p.projectPath) }))}
                  layout="vertical"
                >
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                  <XAxis type="number" tick={AXIS} tickFormatter={(v: number) => `$${compactAxis(v)}`} />
                  <YAxis type="category" dataKey="name" tick={AXIS} width={190} tickFormatter={axisLabel} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="costUsd" name="cost USD" fill={SERIES[1]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      {days !== null && days.length === 0 && (
        <div className="empty-state">no sessions found in the CTA database</div>
      )}
    </div>
  );
}
