import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { apiGet } from "./api";
import { Skeleton } from "./PillarState";
import { LiveStrip } from "./LiveStrip";
import { Palette, usePaletteShortcut } from "./Palette";

// Each pillar view is a separate chunk, fetched the first time its route is
// opened. Bundling all of them together meant every visit downloaded the chart
// library that only the token-trends view uses, which by itself was most of
// the payload. Views export by name, so each import is mapped to the default
// export React.lazy expects.
const SearchView = lazy(() =>
  import("./views/SearchView").then((m) => ({ default: m.SearchView })),
);
const OverviewView = lazy(() =>
  import("./views/OverviewView").then((m) => ({ default: m.OverviewView })),
);
const FileHistoryView = lazy(() =>
  import("./views/FileHistoryView").then((m) => ({ default: m.FileHistoryView })),
);
const McpUsageView = lazy(() =>
  import("./views/McpUsageView").then((m) => ({ default: m.McpUsageView })),
);
const DelegationView = lazy(() =>
  import("./views/DelegationView").then((m) => ({ default: m.DelegationView })),
);
const InstructionsView = lazy(() =>
  import("./views/InstructionsView").then((m) => ({ default: m.InstructionsView })),
);
const SkillTrendView = lazy(() =>
  import("./views/SkillTrendView").then((m) => ({ default: m.SkillTrendView })),
);
const HistoryView = lazy(() =>
  import("./views/HistoryView").then((m) => ({ default: m.HistoryView })),
);
const GraphView = lazy(() =>
  import("./views/GraphView").then((m) => ({ default: m.GraphView })),
);
const UsageView = lazy(() =>
  import("./views/UsageView").then((m) => ({ default: m.UsageView })),
);
const WorkflowsView = lazy(() =>
  import("./views/WorkflowsView").then((m) => ({ default: m.WorkflowsView })),
);
const SessionsView = lazy(() =>
  import("./views/SessionsView").then((m) => ({ default: m.SessionsView })),
);
const EngramView = lazy(() =>
  import("./views/EngramView").then((m) => ({ default: m.EngramView })),
);
const FrictionView = lazy(() =>
  import("./views/FrictionView").then((m) => ({ default: m.FrictionView })),
);
const SkillsView = lazy(() =>
  import("./views/SkillsView").then((m) => ({ default: m.SkillsView })),
);
const HooksView = lazy(() =>
  import("./views/HooksView").then((m) => ({ default: m.HooksView })),
);
const TasksView = lazy(() =>
  import("./views/TasksView").then((m) => ({ default: m.TasksView })),
);
const ConfigView = lazy(() =>
  import("./views/ConfigView").then((m) => ({ default: m.ConfigView })),
);
const CtaView = lazy(() =>
  import("./views/CtaView").then((m) => ({ default: m.CtaView })),
);
const WrapsView = lazy(() =>
  import("./views/WrapsView").then((m) => ({ default: m.WrapsView })),
);

type Route = {
  path: string;
  label: string;
  component: ComponentType;
  /** Key in the /api/sources response that decides whether this pillar has data. */
  sourceKey: string;
};

/**
 * One route per pillar, universal sources first.
 *
 * The order is the point: the pillars that work for anyone who clones this lead,
 * and the ones describing one operator's own note-taking follow. A stranger's
 * first screen is then something with data in it.
 */
const ROUTES: Route[] = [
  { path: "/overview", label: "Overview", component: OverviewView, sourceKey: "sessions" },
  { path: "/search", label: "Search Everything", component: SearchView, sourceKey: "search" },
  { path: "/sessions", label: "Sessions", component: SessionsView, sourceKey: "sessions" },
  { path: "/skills", label: "Skills + Launch", component: SkillsView, sourceKey: "skills" },
  { path: "/hooks", label: "Hook Health", component: HooksView, sourceKey: "hooks" },
  { path: "/tasks", label: "Unfinished Work", component: TasksView, sourceKey: "tasks" },
  { path: "/history", label: "What You Asked For", component: HistoryView, sourceKey: "history" },
  { path: "/usage", label: "Usage + Pacing", component: UsageView, sourceKey: "blocks" },
  { path: "/graph", label: "Memory Graph", component: GraphView, sourceKey: "graph" },
  { path: "/workflows", label: "Orchestration", component: WorkflowsView, sourceKey: "workflows" },
  { path: "/file-history", label: "File History", component: FileHistoryView, sourceKey: "fileHistory" },
  { path: "/delegation", label: "Delegation", component: DelegationView, sourceKey: "delegation" },
  { path: "/skill-trend", label: "Skill Decay", component: SkillTrendView, sourceKey: "skillTrend" },
  { path: "/mcp-usage", label: "MCP Usage", component: McpUsageView, sourceKey: "mcpUsage" },
  { path: "/instructions", label: "Instruction Budget", component: InstructionsView, sourceKey: "instructions" },
  { path: "/config", label: "What Is In Effect", component: ConfigView, sourceKey: "config" },
  { path: "/engram", label: "Memory", component: EngramView, sourceKey: "engram" },
  { path: "/friction", label: "Friction Log", component: FrictionView, sourceKey: "friction" },
  { path: "/wraps", label: "Session Wraps", component: WrapsView, sourceKey: "wraps" },
  { path: "/cta", label: "Token Trends", component: CtaView, sourceKey: "cta" },
];

type SourceStatus = {
  key: string;
  label: string;
  tier: "universal" | "personal";
  present: boolean;
  path: string;
  problem: string | null;
};

function currentHash(): string {
  return window.location.hash.replace(/^#/, "");
}

export function App() {
  const [path, setPath] = useState(currentHash());
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePaletteShortcut(() => setPaletteOpen(true));

  useEffect(() => {
    const onHashChange = () => setPath(currentHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    // A failure here must not blank the shell: without availability data every
    // pillar simply renders as though present, and each one still reports its own
    // missing source when opened.
    apiGet<SourceStatus[]>("/api/sources")
      .then(setSources)
      .catch(() => setSources([]));
  }, []);

  const presentKeys = new Set(
    (sources ?? []).filter((s) => s.present).map((s) => s.key),
  );
  const knowsAvailability = sources !== null && sources.length > 0;
  const isAvailable = (route: Route): boolean =>
    !knowsAvailability || presentKeys.has(route.sourceKey);

  // Land on the first pillar that actually has data. Defaulting to a fixed route
  // meant a machine without that one source opened on an empty page and looked
  // broken before the reader had done anything.
  const landing = ROUTES.find(isAvailable) ?? ROUTES[0]!;
  const route = ROUTES.find((r) => r.path === path) ?? landing;
  const View = route.component;

  const missingCount = knowsAvailability
    ? ROUTES.filter((r) => !isAvailable(r)).length
    : 0;

  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav-brand">
          <div className="title">AGENTIC OS</div>
          <div className="sub">meta-stack control panel</div>
        </div>
        {ROUTES.map((r) => {
          const available = isAvailable(r);
          return (
            <a
              key={r.path}
              href={`#${r.path}`}
              className={`nav-item${r.path === route.path ? " active" : ""}${
                available ? "" : " unavailable"
              }`}
              title={available ? undefined : "no source on this machine yet"}
            >
              {r.label}
              {!available && <span className="nav-dot">not set up</span>}
            </a>
          );
        })}
        <div className="nav-foot">
          <button
            className="chip"
            onClick={() => setPaletteOpen(true)}
            style={{ marginBottom: 8, width: "100%" }}
          >
            search everything
          </button>
          127.0.0.1 - local only
          {missingCount > 0 && (
            <>
              <br />
              {missingCount} pillar{missingCount === 1 ? "" : "s"} unconfigured -
              run <code>npm run doctor</code>
            </>
          )}
        </div>
      </nav>
      <main className="main">
        <Palette
          routes={ROUTES.map((r) => ({
            path: r.path,
            label: r.label,
            available: isAvailable(r),
          }))}
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
        />
        <LiveStrip />
        <Suspense fallback={<Skeleton kind="tiles" count={4} label="loading view..." />}>
          <View />
        </Suspense>
      </main>
    </div>
  );
}
