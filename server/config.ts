import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LaunchDefaults = {
  cwd: string;
  allowedTools: string;
  permissionMode: string;
  maxBudgetUsd: number | null;
  timeoutSeconds: number;
};

/**
 * Plain-language digest settings. The digest engine degrades in tiers: reading
 * fields that already exist on disk, then extractive selection of the operator's
 * own sentences, and only then a local model. `localModelUrl` points at a model
 * runner already listening on loopback (llama-server, Ollama and LM Studio all
 * expose an OpenAI-compatible chat endpoint); nothing is installed or downloaded
 * on the operator's behalf, and an absent runner degrades like any missing
 * source. Talking to loopback is not an outbound call, which is why this does
 * not breach the zero-network rule.
 */
export type DigestDefaults = {
  localModelUrl: string;
  model: string | null;
  /**
   * Readability ceiling for text the local model WRITES, and only for that.
   *
   * A mechanical grade threshold is checkable where "reads well" is not, which is
   * why it exists. But it applies to paraphrase output alone: the lower tiers
   * reproduce or select the operator's own sentences, so holding those to a grade
   * would demand rewriting the very words the tier exists to preserve. Real
   * measurement of the point: an actual session wrap digests to grade 14 because
   * the wrap itself is written that way, and selecting from it cannot move the
   * number. So the grade is reported for information at those tiers and asserted
   * only against a paraphrase.
   */
  maxGrade: number;
};

export type AppConfig = {
  port: number;
  engramVaultPath: string;
  frictionLogPath: string;
  skillRoots: string[];
  ctaDbPath: string;
  wrapsDir: string;
  frictionResolveWindowDays: number;
  claudeBinary: string;
  launchDefaults: LaunchDefaults;
  smokeCommand: string;
  /**
   * Surfaces every Claude Code install has, as opposed to the paths above that
   * describe one operator's own note-taking layout. A fork with no config.json
   * still gets working pillars from these, which is why their defaults are
   * derived rather than placeholders.
   */
  transcriptsDir: string;
  liveSessionsDir: string;
  tasksDir: string;
  claudeConfigPath: string;
  claudeSettingsPath: string;
  pluginsDir: string;
  historyPath: string;
  workflowsDir: string;
  /**
   * Where a statusline capture hook appends rate-limit samples. Absent until the
   * operator installs that hook; this tool only ever reads it.
   */
  pacingLogPath: string;
  /** Claude Code's own versioned copies of files it edited. */
  fileHistoryDir: string;
  /** Where agent definitions live; their identity text loads with every session. */
  agentsDir: string;
  /** The global instruction file, which loads in full on every session. */
  claudeMdPath: string;
  /**
   * Where the derived index is written. It is a disposable cache and never a
   * source of truth: deleting it must lose nothing, it rebuilds from the files
   * it summarizes, and every answer it gives must be reproducible by reading
   * those files directly. It lives under the install, never inside a data
   * source, because this tool never writes to the operator's own data.
   */
  indexPath: string;
  digest: DigestDefaults;
};

/** Expand a leading ~ to $HOME. All config paths use ~ syntax for portability. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const HOME = os.homedir();

/**
 * The app's own repo root (this file lives in <root>/server). Everything that
 * must resolve against the install rather than the shell's working directory
 * uses this: the launch-cwd fallback, the static UI root, the version string.
 * Starting the server from an arbitrary directory then cannot change where
 * launches run or which files get served.
 */
export const APP_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Thrown when a configured data source does not exist on disk. Every pillar
 * signals a missing source this way and the route layer maps it to HTTP 503,
 * so a mistyped path surfaces as a named, visible failure instead of an empty
 * list that reads like "you have no data".
 */
export class SourceMissingError extends Error {
  constructor(
    readonly pillar: string,
    readonly sourcePath: string,
  ) {
    super(`${pillar} source missing: ${sourcePath}`);
    this.name = "SourceMissingError";
  }
}

// Defaults derive from $HOME when config.json is absent. The engram vault and
// wraps dir are machine-specific (they name a repo layout this tool cannot
// guess); their defaults point at plausible locations and the gate reports the
// pillar as SKIPPED (source missing) if they do not exist.
// scripts/gate.mjs duplicates these source paths for its precondition probe -
// it is dependency-free and cannot import this module. Update both together.
function defaults(): AppConfig {
  return {
    port: 4317,
    engramVaultPath: path.join(HOME, "engram-vault"),
    frictionLogPath: path.join(HOME, ".claude", "friction-log.md"),
    skillRoots: [
      path.join(HOME, ".claude", "skills"),
      path.join(HOME, ".claude", "plugins"),
    ],
    ctaDbPath: path.join(
      HOME,
      ".claude",
      "plugins",
      "data",
      "claude-token-analyzer-claude-token-analyzer",
      "token-analyzer.db",
    ),
    wrapsDir: path.join(HOME, ".claude", "memory"),
    frictionResolveWindowDays: 14,
    claudeBinary: "claude",
    launchDefaults: {
      // With no config.json, launches default to the app's own repo dir -
      // never $HOME or /. An agent with Edit and Write rooted at $HOME could
      // touch anything the operator owns, so the fallback has to be a bounded
      // directory. A fork points this at its own project dir in config.json.
      cwd: APP_ROOT,
      allowedTools:
        "Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch,TodoWrite,Task",
      permissionMode: "acceptEdits",
      maxBudgetUsd: null,
      timeoutSeconds: 600,
    },
    smokeCommand: "claude --version",
    transcriptsDir: path.join(HOME, ".claude", "projects"),
    liveSessionsDir: path.join(HOME, ".claude", "sessions"),
    tasksDir: path.join(HOME, ".claude", "tasks"),
    claudeConfigPath: path.join(HOME, ".claude.json"),
    claudeSettingsPath: path.join(HOME, ".claude", "settings.json"),
    pluginsDir: path.join(HOME, ".claude", "plugins"),
    historyPath: path.join(HOME, ".claude", "history.jsonl"),
    workflowsDir: path.join(HOME, ".claude", "workflows"),
    pacingLogPath: path.join(HOME, ".claude", "pacing-log.jsonl"),
    fileHistoryDir: path.join(HOME, ".claude", "file-history"),
    agentsDir: path.join(HOME, ".claude", "agents"),
    claudeMdPath: path.join(HOME, ".claude", "CLAUDE.md"),
    // Under the install, and gitignored: a cache the operator can delete at any
    // time without losing anything.
    indexPath: path.join(APP_ROOT, ".cache", "index.db"),
    digest: {
      // llama-server's default port. Ollama (11434) and LM Studio (1234) are
      // probed as fallbacks by the digest engine, so this is a starting point
      // rather than a requirement.
      localModelUrl: "http://127.0.0.1:8080",
      model: null,
      maxGrade: 12,
    },
  };
}

/**
 * Load config.json (path overridable via CONFIG_PATH), merge over defaults,
 * expand ~ in every path field. Fail fast on unreadable/invalid JSON - a
 * silently-wrong config is worse than a crash for a single-operator tool.
 */
export function loadConfig(configPath?: string): AppConfig {
  const file =
    configPath ??
    process.env.CONFIG_PATH ??
    path.join(process.cwd(), "config.json");

  const base = defaults();
  let raw: Partial<AppConfig> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    raw = JSON.parse(text) as Partial<AppConfig>;
  }

  const merged: AppConfig = {
    ...base,
    ...raw,
    launchDefaults: { ...base.launchDefaults, ...(raw.launchDefaults ?? {}) },
    digest: { ...base.digest, ...(raw.digest ?? {}) },
  };

  merged.port = Number(process.env.PORT ?? merged.port);
  if (!Number.isInteger(merged.port) || merged.port < 0 || merged.port > 65535) {
    throw new Error(`Invalid port: ${merged.port}`);
  }

  merged.engramVaultPath = expandHome(merged.engramVaultPath);
  merged.frictionLogPath = expandHome(merged.frictionLogPath);
  merged.skillRoots = merged.skillRoots.map(expandHome);
  merged.ctaDbPath = expandHome(merged.ctaDbPath);
  merged.wrapsDir = expandHome(merged.wrapsDir);
  merged.launchDefaults.cwd = expandHome(merged.launchDefaults.cwd);
  merged.transcriptsDir = expandHome(merged.transcriptsDir);
  merged.liveSessionsDir = expandHome(merged.liveSessionsDir);
  merged.tasksDir = expandHome(merged.tasksDir);
  merged.claudeConfigPath = expandHome(merged.claudeConfigPath);
  merged.claudeSettingsPath = expandHome(merged.claudeSettingsPath);
  merged.pluginsDir = expandHome(merged.pluginsDir);
  merged.historyPath = expandHome(merged.historyPath);
  merged.workflowsDir = expandHome(merged.workflowsDir);
  merged.pacingLogPath = expandHome(merged.pacingLogPath);
  merged.fileHistoryDir = expandHome(merged.fileHistoryDir);
  merged.agentsDir = expandHome(merged.agentsDir);
  merged.claudeMdPath = expandHome(merged.claudeMdPath);
  merged.indexPath = expandHome(merged.indexPath);

  if (!Number.isFinite(merged.digest.maxGrade) || merged.digest.maxGrade <= 0) {
    throw new Error(`Invalid digest.maxGrade: ${merged.digest.maxGrade}`);
  }

  return merged;
}
