import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP_ROOT,
  loadConfig,
  SourceMissingError,
  type AppConfig,
} from "./config.js";
import {
  createIndexHandle,
  indexStats,
  searchIndex,
  syncIndex,
} from "./index-store.js";
import {
  configuredMcpNames,
  effectiveSettings,
  installedPlugins,
  mcpServers,
} from "./config-surface.js";
import { byModel, byProject, summary, trends } from "./cta.js";
import {
  buildDigest,
  paraphrase,
  probeLocalModel,
  withParaphrase,
  type Digest,
} from "./digest.js";
import { getThought, listThoughts, listThoughtTypes } from "./engram.js";
import { frictionAging, readFrictionLog } from "./friction.js";
import { diskReport } from "./disk.js";
import { frictionGapReport } from "./friction-gap.js";
import { outcomeForSession, outcomesReport } from "./outcomes.js";
import { triggerCoverage } from "./trigger-coverage.js";
import { diffFileVersions, fileHistoryIndex, readFileVersion } from "./file-history.js";
import { joinConfigured, mcpUsage } from "./mcp-usage.js";
import { delegationReport } from "./delegation.js";
import { instructionBudget } from "./instruction-budget.js";
import { deletionShortlist, skillActivity } from "./skill-trend.js";
import { memoryGraph } from "./graph.js";
import { historyStats, listPrompts } from "./history.js";
import { hookHealth } from "./hooks.js";
import { captureHookCommand, readPacing } from "./pacing.js";
import {
  usageBlocks,
  usageTotals,
  pricedModels,
  pricingFreshness,
  type BlockInput,
} from "./pricing.js";
import { readWorkflowScript, workflowInventory } from "./workflows.js";
import { LaunchManager } from "./launcher.js";
import { listLiveSessions } from "./live.js";
import { diffRuns } from "./diff.js";
import { getSession, listSessions, sessionTotals } from "./sessions.js";
import { listSkills } from "./skills.js";
import { readSkillUsage } from "./skill-usage.js";
import { indexSourcePaths, sourceStatuses } from "./sources.js";
import { listAbandonedTasks, listSessionTasks } from "./tasks.js";
import { getWrap, listWraps } from "./wraps.js";

/** Reported by /api/health. package.json is the single source of the version. */
export const APP_VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"),
  ) as { version: string }
).version;

// Localhost binding IS the security boundary. There is no auth on these
// routes, and /api/launch can start an agent with Edit, Write, and Bash, so
// widening this constant would expose remote code execution to the network.
// Never make it configurable.
export const BIND_HOST = "127.0.0.1";

/** Loopback hosts/origins on any port (Vite dev proxy included). */
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Build the Hono app: the five pillar route groups, the launch endpoints,
 * and the static UI. Exported so tests can exercise routes without binding
 * a socket.
 */
export function createApp(config: AppConfig) {
  const app = new Hono();
  const launches = new LaunchManager(config);

  // The browser is the untrusted path onto localhost: a malicious page can
  // fire cross-site POSTs (text/plain form CSRF) or DNS-rebind onto this
  // port, and /api/launch spawns a child process. Reject any request whose
  // Host is not loopback (rebinding) or whose Origin is off-machine (CSRF).
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!LOOPBACK_HOST_RE.test(host)) {
      return c.json({ error: "forbidden host" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin && !LOOPBACK_ORIGIN_RE.test(origin)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    await next();
  });

  // A configured source that is not on disk is a config problem, not an empty
  // dataset: report it as such on every pillar rather than returning [] that
  // reads like "you have no data". The UI surfaces the message verbatim.
  app.onError((err, c) => {
    if (err instanceof SourceMissingError) {
      return c.json(
        { error: "source missing", pillar: err.pillar, path: err.sourcePath },
        503,
      );
    }
    console.error("unhandled error:", err);
    return c.json({ error: String(err) }, 500);
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: APP_VERSION, host: BIND_HOST }),
  );

  // Which sources exist on this machine. The shell reads this to dim the pillars
  // that have nothing to show and to land on one that does, so a fresh clone
  // opens on real data instead of on a pillar the operator has not configured.
  app.get("/api/sources", (c) => c.json(sourceStatuses(config)));

  // ---- Skill inventory + one-click headless launch ----
  app.get("/api/skills", (c) =>
    c.json(
      listSkills(
        config.skillRoots,
        c.req.query("q") || undefined,
        config.claudeConfigPath,
      ),
    ),
  );

  app.post("/api/launch", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      if (body.smoke === true) {
        // Hermetic wiring smoke (gate check 8): no LLM run, no cost.
        const record = launches.launchSmoke();
        return c.json({ launchId: record.launchId });
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return c.json({ error: "prompt (non-empty string) is required" }, 400);
      }
      const record = launches.launch({
        prompt: body.prompt,
        model: typeof body.model === "string" ? body.model : undefined,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        allowedTools:
          typeof body.allowedTools === "string" ? body.allowedTools : undefined,
        maxBudgetUsd:
          typeof body.maxBudgetUsd === "number" ? body.maxBudgetUsd : undefined,
        timeoutSeconds:
          typeof body.timeoutSeconds === "number" ? body.timeoutSeconds : undefined,
      });
      return c.json({ launchId: record.launchId });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get("/api/launch/:id", (c) => {
    const record = launches.get(c.req.param("id"));
    if (!record) return c.json({ error: "launch not found" }, 404);
    return c.json(record);
  });

  app.post("/api/launch/:id/cancel", (c) => {
    const id = c.req.param("id");
    if (!launches.get(id)) return c.json({ error: "launch not found" }, 404);
    if (!launches.kill(id, "cancelled")) {
      return c.json({ error: "launch is not running" }, 409);
    }
    return c.json({ ok: true });
  });

  // SSE: replay buffered events, then stream live ones until the child exits.
  app.get("/api/launch/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!launches.get(id)) return c.json({ error: "launch not found" }, 404);

    return streamSSE(c, async (stream) => {
      // Live events land in `queued` from the moment of subscription, so the
      // buffer replay below can await without dropping anything that arrives
      // mid-replay. `wake` lets an arriving event interrupt the idle wait.
      const queued: object[] = [];
      const finalRecords: object[] = [];
      const aborted: true[] = [];
      let wake: (() => void) | null = null;
      const nudge = () => {
        wake?.();
        wake = null;
      };

      const sub = launches.subscribe(id, {
        onEvent: (event) => {
          queued.push(event);
          nudge();
        },
        onDone: (record) => {
          finalRecords.push(record);
          nudge();
        },
      });
      if (!sub) return;
      stream.onAbort(() => {
        aborted.push(true);
        nudge();
      });

      const write = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });

      try {
        for (const event of sub.buffered) await write("progress", event);
        while (aborted.length === 0) {
          while (queued.length) await write("progress", queued.shift()!);
          // `sub.finished` covers the run that ended before this subscription:
          // its `done` event fired before anyone was listening.
          const final = finalRecords[0] ?? (sub.finished ? launches.get(id) : null);
          if (final) {
            await write("done", final);
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        sub.unsubscribe();
      }
    });
  });

  // ---- Sessions: read straight from Claude Code's own transcripts ----
  // Universal by design: every Claude Code install writes these, so this pillar
  // works on a fresh clone with no configuration and no third-party plugin.
  app.get("/api/sessions", (c) => {
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    return c.json(
      listSessions(config.transcriptsDir, {
        q: c.req.query("q") || undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        offset: offsetRaw ? Number(offsetRaw) : undefined,
      }),
    );
  });

  app.get("/api/sessions/totals", (c) => {
    const limitRaw = c.req.query("limit");
    return c.json(
      sessionTotals(config.transcriptsDir, limitRaw ? Number(limitRaw) : undefined),
    );
  });

  // The project directory and session id are path segments the client supplies,
  // so the reader validates them and refuses anything that is not a plain
  // segment; a null return is a 404 rather than a read outside the tree.
  app.get("/api/sessions/:projectDir/:sessionId", (c) => {
    const detail = getSession(
      config.transcriptsDir,
      c.req.param("projectDir"),
      c.req.param("sessionId"),
    );
    if (!detail) return c.json({ error: "session not found" }, 404);
    return c.json(detail);
  });

  // ---- Hook health, derived from records already in the transcripts ----
  // No collector, no listener, no settings change: a hook that has grown slow
  // taxes every turn, and until now the only way to notice was to feel it.
  // Two runs of the same task, aligned. Both sides are addressed the way the
  // detail route addresses one, because a session id alone is not enough to find
  // a transcript.
  app.get("/api/sessions/diff", (c) => {
    const aProject = c.req.query("aProject") ?? "";
    const aSession = c.req.query("aSession") ?? "";
    const bProject = c.req.query("bProject") ?? "";
    const bSession = c.req.query("bSession") ?? "";
    if (!aProject || !aSession || !bProject || !bSession) {
      return c.json({ error: "aProject, aSession, bProject and bSession are required" }, 400);
    }
    const a = getSession(config.transcriptsDir, aProject, aSession);
    const b = getSession(config.transcriptsDir, bProject, bSession);
    // A missing transcript is a bad reference rather than a missing source: the
    // tree is present, this pair is not in it.
    if (!a) return c.json({ error: `no such session: ${aProject}/${aSession}` }, 404);
    if (!b) return c.json({ error: `no such session: ${bProject}/${bSession}` }, 404);
    return c.json(diffRuns(a, b));
  });

  app.get("/api/hooks", (c) => {
    const limitRaw = c.req.query("limit");
    return c.json(
      hookHealth(config.transcriptsDir, limitRaw ? Number(limitRaw) : undefined),
    );
  });

  // ---- Live sessions: which repos have a Claude open right now ----
  app.get("/api/live", (c) => c.json(listLiveSessions(config.liveSessionsDir)));

  // ---- Task boards, including work left behind by sessions that ended ----
  app.get("/api/tasks", (c) => {
    const abandonedOnly = c.req.query("abandoned") === "true";
    return c.json(
      abandonedOnly
        ? listAbandonedTasks(config.tasksDir, config.liveSessionsDir)
        : listSessionTasks(config.tasksDir, config.liveSessionsDir),
    );
  });

  // ---- Token-usage trends (SQLite, read-only) ----
  app.get("/api/cta/trends", (c) => c.json(trends(config.ctaDbPath)));
  app.get("/api/cta/by-model", (c) => c.json(byModel(config.ctaDbPath)));
  app.get("/api/cta/by-project", (c) => c.json(byProject(config.ctaDbPath)));
  app.get("/api/cta/summary", (c) => c.json(summary(config.ctaDbPath)));

  // ---- Session-wrap history ----
  app.get("/api/wraps", (c) => c.json(listWraps(config.wrapsDir)));

  app.get("/api/wraps/:id", (c) => {
    const wrap = getWrap(config.wrapsDir, c.req.param("id"));
    if (!wrap) return c.json({ error: "wrap not found" }, 404);
    return c.json(wrap);
  });

  // ---- Friction-log timeline ----
  app.get("/api/friction", (c) => {
    const type = c.req.query("type") || undefined;
    const statusRaw = c.req.query("status");
    const status =
      statusRaw === "open" || statusRaw === "resolved" ? statusRaw : undefined;
    return c.json(
      readFrictionLog(config.frictionLogPath, config.frictionResolveWindowDays, {
        type,
        status,
      }),
    );
  });

  // Aging is deliberately its own route rather than a field on the timeline: it
  // must be computed over the whole log, and the timeline is filtered. Folding it
  // in would make the headline numbers change as the reader narrows the view,
  // which is the one thing a pressure gauge must not do.
  app.get("/api/friction/aging", (c) => {
    const entries = readFrictionLog(
      config.frictionLogPath,
      config.frictionResolveWindowDays,
    );
    return c.json(frictionAging(entries));
  });

  // The gap between what the operator captured and what the analysis found is a
  // comparison, so it needs both sources and reports 503 naming whichever is
  // absent. It is its own route rather than a field on the timeline for the same
  // reason aging is: it is computed over the whole log, not the filtered view.
  app.get("/api/friction/gap", (c) =>
    c.json(
      frictionGapReport(
        config.usageDataDir,
        config.transcriptsDir,
        config.frictionLogPath,
        config.frictionResolveWindowDays,
      ),
    ),
  );

  // Which standing rules have had their trigger occur at all. Occurrence only:
  // the route reports no adherence figure, because violation detection over
  // transcripts was measured at nine hits and nine false positives.
  app.get("/api/instructions/triggers", (c) => {
    const daysRaw = c.req.query("days");
    const days = daysRaw ? Number(daysRaw) : undefined;
    return c.json(
      triggerCoverage(config.transcriptsDir, {
        windowDays: Number.isFinite(days) ? days : undefined,
      }),
    );
  });

  // What the install is keeping, by category. Byte counts are measured rather
  // than derived, and the retention setting rides along because it is what says
  // whether the transcript tree is bounded at all.
  app.get("/api/disk", (c) =>
    c.json(diskReport(config.claudeHome, config.claudeSettingsPath)),
  );

  // ---- Outcomes: whether the work went anywhere ----
  // Every other pillar measures activity. This one reports a model's reading of
  // how sessions turned out, over whichever sessions were judged the last time
  // /insights ran, which is why coverage travels with every answer.
  app.get("/api/outcomes", (c) =>
    c.json(outcomesReport(config.usageDataDir, config.transcriptsDir)),
  );

  app.get("/api/outcomes/:sessionId", (c) => {
    const found = outcomeForSession(
      config.usageDataDir,
      config.transcriptsDir,
      c.req.param("sessionId"),
    );
    // A session nobody judged is absence, not an error: the store covers a
    // fraction of the corpus by design.
    return found ? c.json(found) : c.json({ judged: false }, 200);
  });

  // ---- Memory browser (the markdown vault is the source of truth) ----
  app.get("/api/engram/thoughts", (c) => {
    const q = c.req.query("q") || undefined;
    const type = c.req.query("type") || undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const offset = c.req.query("offset")
      ? Number(c.req.query("offset"))
      : undefined;
    return c.json(
      listThoughts(config.engramVaultPath, { q, type, limit, offset }),
    );
  });

  app.get("/api/engram/types", (c) =>
    c.json(listThoughtTypes(config.engramVaultPath)),
  );

  app.get("/api/engram/thoughts/:id", (c) => {
    const thought = getThought(config.engramVaultPath, c.req.param("id"));
    if (!thought) {
      return c.json({ error: "thought not found" }, 404);
    }
    return c.json(thought);
  });

  // ---- Prompt history: what has actually been asked for ----
  app.get("/api/history", (c) => {
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    return c.json(
      listPrompts(config.historyPath, {
        q: c.req.query("q") || undefined,
        project: c.req.query("project") || undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        offset: offsetRaw ? Number(offsetRaw) : undefined,
      }),
    );
  });

  // Counts and shapes only; no prompt text is returned by this route.
  app.get("/api/history/stats", (c) => c.json(historyStats(config.historyPath)));

  // ---- Memory link graph, and the faults in it ----
  app.get("/api/graph", (c) => c.json(memoryGraph(config.transcriptsDir)));

  // ---- Orchestration scripts Claude wrote on this machine ----
  app.get("/api/workflows", (c) =>
    c.json(workflowInventory(config.transcriptsDir, config.workflowsDir)),
  );

  // The path must be one the inventory produced; anything else is a 404 rather
  // than an arbitrary file read.
  app.get("/api/workflows/source", (c) => {
    const scriptPath = c.req.query("path") ?? "";
    const found = readWorkflowScript(config.transcriptsDir, config.workflowsDir, scriptPath);
    if (!found) return c.json({ error: "no such workflow script" }, 404);
    return c.json(found);
  });


  // ---- Claude Code's own versioned copies of files it edited ----
  // git shows what survived; this shows every intermediate version, including ones
  // later reverted, which never reached a commit and are otherwise unrecoverable.
  app.get("/api/file-history", (c) =>
    c.json(fileHistoryIndex(config.fileHistoryDir, config.transcriptsDir)),
  );

  // Version text is served one named entry at a time, never in bulk by the index:
  // these are verbatim file contents, including any config file Claude ever edited.
  app.get("/api/file-history/version", (c) => {
    const sessionId = c.req.query("sessionId") ?? "";
    const hash = c.req.query("hash") ?? "";
    const version = Number(c.req.query("version"));
    const found = readFileVersion(
      config.fileHistoryDir,
      config.transcriptsDir,
      sessionId,
      hash,
      version,
    );
    if (!found) return c.json({ error: "no such stored version" }, 404);
    return c.json(found);
  });

  app.get("/api/file-history/diff", (c) => {
    const hash = c.req.query("hash") ?? "";
    const found = diffFileVersions(
      config.fileHistoryDir,
      config.transcriptsDir,
      {
        sessionId: c.req.query("fromSession") ?? "",
        hash,
        version: Number(c.req.query("fromVersion")),
      },
      {
        sessionId: c.req.query("toSession") ?? c.req.query("fromSession") ?? "",
        hash,
        version: Number(c.req.query("toVersion")),
      },
    );
    if (!found) return c.json({ error: "no such pair of stored versions" }, 404);
    return c.json(found);
  });

  // ---- Which MCP servers are used, against which are merely configured ----
  app.get("/api/mcp-usage", (c) => {
    const usage = mcpUsage(config.transcriptsDir);
    // Every source that can be shown to configure a server, not just the top-level
    // block: reading that alone left most real traffic unexplained, which made the
    // never-called list honest and useless at the same time. Origins travel with the
    // names so the view can say which claim each one supports.
    let configured: ReturnType<typeof configuredMcpNames> | null = null;
    try {
      configured = configuredMcpNames(config.claudeConfigPath, config.pluginsDir);
    } catch (err) {
      if (!(err instanceof SourceMissingError)) throw err;
    }
    return c.json({
      usage,
      decay: joinConfigured(usage, (configured?.names ?? []).map((entry) => entry.name)),
      configuredNames: configured,
    });
  });

  // ---- What work was handed to subagents, and what came back ----
  app.get("/api/delegation", (c) => c.json(delegationReport(config.transcriptsDir)));

  // ---- What instruction text loads before the operator types a word ----
  app.get("/api/instructions", (c) => {
    const projectDir = c.req.query("projectDir") || config.launchDefaults.cwd;
    return c.json(
      instructionBudget({
        globalInstructionPath: config.claudeMdPath,
        projectDir,
        skillRoots: config.skillRoots,
        agentsDir: config.agentsDir,
      }),
    );
  });

  // ---- When skills were actually used, and which look safe to delete ----
  app.get("/api/skill-trend", (c) => {
    const activity = skillActivity(config.transcriptsDir);
    const usage = readSkillUsage(config.claudeConfigPath);
    const counters = usage
      ? [...usage.byKey].map(([name, entry]) => ({
          name,
          usageCount: entry.usageCount,
          lastUsedAt: entry.lastUsedAt,
        }))
      : [];
    return c.json({
      activity,
      shortlist: deletionShortlist(activity, counters, Date.now()),
      // An absent or unparseable counter file and a counter that recorded nothing both
      // yield an empty list, and only the second is a measurement. Saying which it was
      // is the difference between "no skill has been invoked" and "we could not look".
      counterSource: {
        readable: usage !== null,
        path: config.claudeConfigPath,
        skillsRecorded: counters.length,
      },
    });
  });

  // ---- Rate-limit pacing, from an operator-installed capture hook ----
  app.get("/api/pacing", (c) => c.json(readPacing(config.pacingLogPath)));

  // Returned as text to run, never executed: installing it edits the operator's
  // Claude Code settings, which this tool does not do on their behalf.
  app.get("/api/pacing/setup", (c) =>
    c.json(captureHookCommand(config.pacingLogPath)),
  );

  // ---- Five-hour usage blocks, priced from a vendored table ----
  app.get("/api/blocks", (c) => {
    const limitRaw = c.req.query("limit");
    const entries: BlockInput[] = [];
    for (const session of listSessions(config.transcriptsDir, {
      limit: limitRaw ? Number(limitRaw) : 40,
    })) {
      // A session's per-model split is known but its per-turn timestamps are not
      // carried on the summary, so the session's start anchors its usage. Blocks
      // are five hours wide, so this is accurate for all but the rare session
      // that straddles a boundary.
      for (const model of session.models) {
        entries.push({
          timestamp: session.startedAt,
          sessionId: session.sessionId,
          model: model.name,
          tokens: session.tokens,
        });
      }
    }
    return c.json({
      blocks: usageBlocks(entries),
      // Per-model and per-token-kind cost over everything read, which totalCost
      // was already computing per block and the payload was discarding.
      totals: usageTotals(entries),
      // The age travels with the date because the date alone does not answer the
      // question a reader has: a table refreshed only by a deliberate commit is
      // as good as how long ago that commit was.
      pricing: { ...pricingFreshness(), models: pricedModels() },
      note:
        "Five hours is the window a subscription's own limits are expressed in, " +
        "which is why usage is grouped this way rather than by calendar day. " +
        "Costs come from a pricing table vendored into this repo and refreshed by " +
        "a deliberate commit; a model missing from it reports no cost rather than zero.",
    });
  });

  // ---- Derived index: full-corpus search across every pillar ----
  // The index is a disposable cache. It is opened lazily so a machine that never
  // searches never creates one, and a sync is explicit rather than automatic
  // because a first build reads every transcript on disk.
  // The handle reopens itself if the cache file is deleted underneath it, which
  // is what makes "you may delete this at any time" true while the server runs.
  const index = createIndexHandle(config.indexPath);

  // The index outlives its sources, which is what makes this guard necessary
  // rather than tidy: with every source moved away, the cache went on answering
  // 200 with real excerpts and a document count for files that were not there,
  // while every other pillar on the same machine correctly said 503. A stale hit
  // presented as current is the one failure worse than an empty answer. Any one
  // source is enough, so a machine that has transcripts but no vault still
  // searches.
  const requireIndexSource = (): void => {
    const paths = indexSourcePaths(config);
    if (paths.some((sourcePath) => fs.existsSync(sourcePath))) return;
    throw new SourceMissingError("search index", paths.join(", "));
  };

  app.get("/api/index/stats", (c) => {
    requireIndexSource();
    return c.json(index.run((db) => indexStats(db, config.indexPath)));
  });

  app.post("/api/index/sync", (c) => {
    requireIndexSource();
    return c.json(index.run((db) => syncIndex(db, config)));
  });

  app.get("/api/search", (c) => {
    requireIndexSource();
    const query = c.req.query("q") ?? "";
    if (!query.trim()) return c.json({ query, hits: [], note: "empty query" });
    const kindRaw = c.req.query("kind");
    const kind =
      kindRaw === "session" || kindRaw === "thought" || kindRaw === "friction" || kindRaw === "wrap"
        ? kindRaw
        : undefined;
    const limitRaw = c.req.query("limit");
    const hits = index.run((db) =>
      searchIndex(db, query, { kind, limit: limitRaw ? Number(limitRaw) : undefined }),
    );
    return c.json({
      query,
      hits,
      stats: index.run((db) => indexStats(db, config.indexPath)),
    });
  });

  // ---- Config surface: what is actually in effect ----
  // Every field in these responses is chosen by an allowlist in
  // server/config-surface.ts rather than filtered out of a parsed config, because
  // the files behind them hold live credentials in several different shapes.
  app.get("/api/config/settings", (c) =>
    c.json(
      effectiveSettings(
        config.claudeSettingsPath,
        c.req.query("projectDir") || undefined,
      ),
    ),
  );

  app.get("/api/config/mcp", (c) => c.json(mcpServers(config.claudeConfigPath)));

  app.get("/api/config/plugins", (c) =>
    c.json(installedPlugins(config.pluginsDir, config.claudeConfigPath)),
  );

  // ---- Plain-language digests ----
  // Two tiers always work and need nothing installed: the operator's own summary
  // field, then their own most central sentences selected by ranking. A local
  // model, if one happens to be listening on loopback, can add a paraphrase on
  // request. Every line carries where it came from.

  /**
   * Resolve a digestible record to its own summary and body.
   *
   * Only these kinds are addressable, deliberately. Accepting arbitrary text would
   * turn this into a general-purpose proxy to the operator's local model, which is
   * a capability nothing here needs.
   */
  const digestSource = (
    kind: string,
    id: string,
  ): { verbatimSummary?: string; body: string; label: string } | null => {
    if (kind === "thought") {
      const thought = getThought(config.engramVaultPath, id);
      if (!thought) return null;
      return {
        verbatimSummary: thought.description,
        body: thought.body,
        label: thought.title,
      };
    }
    if (kind === "wrap") {
      const wrap = getWrap(config.wrapsDir, id);
      if (!wrap) return null;
      return {
        verbatimSummary: wrap.description,
        body: wrap.body,
        label: wrap.title,
      };
    }
    return null;
  };

  /** Whether a local model runner is listening, and what it is serving. */
  app.get("/api/digest/model", async (c) =>
    c.json(await probeLocalModel(config.digest)),
  );

  app.get("/api/digest/:kind/:id", (c) => {
    const kind = c.req.param("kind");
    const source = digestSource(kind, c.req.param("id"));
    if (!source) return c.json({ error: "no such record to digest" }, 404);
    return c.json({ label: source.label, ...buildDigest(source) });
  });

  app.post("/api/digest/:kind/:id/paraphrase", async (c) => {
    const source = digestSource(c.req.param("kind"), c.req.param("id"));
    if (!source) return c.json({ error: "no such record to digest" }, 404);

    const state = await probeLocalModel(config.digest);
    if (state.state !== "ready") {
      // Same shape as any other missing source, so an absent model runner reads
      // the same way an absent data source does rather than as a failure.
      return c.json(
        {
          error: "source missing",
          pillar: "local model",
          path: state.state === "absent" ? state.probed.join(", ") : state.url,
          detail: state.detail,
        },
        503,
      );
    }

    // The model is handed the already-structured digest, never the raw body: one
    // record, one sentence, no counting and no classification.
    const digest: Digest = buildDigest(source);
    const record = digest.lines.map((line) => line.text).join(" ");
    if (!record.trim()) {
      return c.json({ error: "nothing to paraphrase in this record" }, 400);
    }
    try {
      const result = await paraphrase(state, record);
      return c.json({
        label: source.label,
        ...withParaphrase(digest, result, record),
        model: result.model,
      });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  // An unmatched /api path is a client bug; say so instead of falling through
  // to the SPA below, which would answer a bad API call with 200 and HTML.
  app.all("/api/*", (c) => c.json({ error: "unknown API route" }, 404));

  // Static SPA (production): Hono serves the Vite build output. Rooted at the
  // install, not the shell's cwd, so `tsx server/index.ts` serves the same
  // files from any directory.
  app.use("/*", serveStatic({ root: path.join(APP_ROOT, "dist") }));
  app.get("*", (c) => {
    // SPA fallback: any non-API path serves index.html.
    const indexPath = path.join(APP_ROOT, "dist", "index.html");
    if (fs.existsSync(indexPath)) {
      return c.html(fs.readFileSync(indexPath, "utf8"));
    }
    return c.text("dist/index.html missing - run npm run build first", 404);
  });

  return app;
}

function main() {
  const config = loadConfig();
  const app = createApp(config);

  const server = serve(
    { fetch: app.fetch, hostname: BIND_HOST, port: config.port },
    (info) => {
      console.log(`agentic-os listening on http://${info.address}:${info.port}`);
    },
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Fail fast and loud: never hop to another port. The operator has a
      // bookmark and a config pointing at this one; silently moving would
      // leave them staring at a stale tab wondering why nothing updates.
      console.error(
        `Port ${config.port} is already in use. Set PORT=<n> to use another port.`,
      );
      process.exit(1);
    }
    throw err;
  });
}

// Only start a real server when run directly (not when imported by tests).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
