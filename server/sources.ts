import fs from "node:fs";
import type { AppConfig } from "./config.js";

/**
 * Whether a source is one every Claude Code install has, or one that describes a
 * particular operator's own note-taking. The distinction is what lets a fresh
 * clone be honest: a stranger is missing the personal ones by definition, and
 * that is not a fault.
 */
export type SourceTier = "universal" | "personal";

export type SourceStatus = {
  /** Route prefix the pillar is served under, used by the UI to match a view. */
  key: string;
  label: string;
  tier: SourceTier;
  present: boolean;
  path: string;
  /** Set when the path exists but is the wrong kind, a common config typo. */
  problem: string | null;
};

type Probe = {
  key: string;
  label: string;
  tier: SourceTier;
  kind: "dir" | "file" | "any-dir";
  paths: string[];
};

function probes(config: AppConfig): Probe[] {
  return [
    // The index spans several pillars, so it is usable as long as at least one of
    // them exists. Transcripts stand in for that here because they are the source
    // every Claude Code install has.
    { key: "search", label: "search index", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "sessions", label: "session transcripts", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "hooks", label: "hook records", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "live", label: "live session registry", tier: "universal", kind: "dir", paths: [config.liveSessionsDir] },
    { key: "tasks", label: "task boards", tier: "universal", kind: "dir", paths: [config.tasksDir] },
    { key: "skills", label: "skill roots", tier: "universal", kind: "any-dir", paths: config.skillRoots },
    { key: "config", label: "Claude Code settings", tier: "universal", kind: "file", paths: [config.claudeSettingsPath] },
    { key: "history", label: "prompt history", tier: "universal", kind: "file", paths: [config.historyPath] },
    { key: "workflows", label: "workflow scripts", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "pacing", label: "rate-limit capture log", tier: "universal", kind: "file", paths: [config.pacingLogPath] },
    { key: "blocks", label: "usage blocks", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "fileHistory", label: "file version history", tier: "universal", kind: "dir", paths: [config.fileHistoryDir] },
    { key: "mcpUsage", label: "MCP call history", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "delegation", label: "subagent dispatches", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "instructions", label: "always-loaded instructions", tier: "universal", kind: "file", paths: [config.claudeMdPath] },
    { key: "skillTrend", label: "skill attribution history", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "engram", label: "memory vault", tier: "personal", kind: "dir", paths: [config.engramVaultPath] },
    { key: "graph", label: "memory link graph", tier: "universal", kind: "dir", paths: [config.transcriptsDir] },
    { key: "friction", label: "friction log", tier: "personal", kind: "file", paths: [config.frictionLogPath] },
    { key: "wraps", label: "session wraps", tier: "personal", kind: "dir", paths: [config.wrapsDir] },
    { key: "cta", label: "token-analyzer database", tier: "personal", kind: "file", paths: [config.ctaDbPath] },
  ];
}

function checkOne(probe: Probe): SourceStatus {
  const primary = probe.paths[0] ?? "";

  if (probe.kind === "any-dir") {
    const found = probe.paths.filter((p) => fs.existsSync(p));
    return {
      key: probe.key,
      label: probe.label,
      tier: probe.tier,
      present: found.length > 0,
      path: probe.paths.join(", "),
      problem: null,
    };
  }

  if (!fs.existsSync(primary)) {
    return { key: probe.key, label: probe.label, tier: probe.tier, present: false, path: primary, problem: null };
  }

  // A path that exists but is the wrong kind passes a bare existence check and
  // then fails at read time. Naming it here turns a confusing runtime failure
  // into a legible configuration message.
  let isDirectory: boolean;
  try {
    isDirectory = fs.statSync(primary).isDirectory();
  } catch (err) {
    return {
      key: probe.key,
      label: probe.label,
      tier: probe.tier,
      present: false,
      path: primary,
      problem: `unreadable: ${(err as NodeJS.ErrnoException).code ?? "unknown"}`,
    };
  }

  const wantDirectory = probe.kind === "dir";
  if (wantDirectory !== isDirectory) {
    return {
      key: probe.key,
      label: probe.label,
      tier: probe.tier,
      present: false,
      path: primary,
      problem: wantDirectory
        ? "exists but is a file, not a directory"
        : "exists but is a directory, not a file",
    };
  }

  return { key: probe.key, label: probe.label, tier: probe.tier, present: true, path: primary, problem: null };
}

/**
 * Which sources this machine has.
 *
 * The navigation uses it to dim the pillars that have nothing to show and to pick
 * a landing route that is not empty. Probing here once beats having the shell
 * call every pillar endpoint just to discover which ones would answer 503.
 */
export function sourceStatuses(config: AppConfig): SourceStatus[] {
  return probes(config).map(checkOne);
}
