import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../server/config.js";
import { loadConfig } from "../server/config.js";
import { indexSourcePaths, sourceStatuses } from "../server/sources.js";
import { workflowInventory } from "../server/workflows.js";

/**
 * `sourceStatuses` backs `/api/sources`, which the shell reads to dim pillars and
 * to pick a landing route. Nothing pinned it: the roster, the field each pillar is
 * probed at, and the difference between "absent", "wrong kind" and "unreadable"
 * were all free to move without a test going red, and a pillar quietly dropped
 * from the roster would only show up as a nav item that stopped appearing.
 *
 * These are characterization tests. They record what the probe does today,
 * including where it disagrees with the pillar it describes; they do not assert
 * what it ought to do.
 *
 * Every path is synthetic and under a temp root, so the answers do not depend on
 * what this machine happens to have in ~/.claude.
 */
let root = "";

/**
 * A config whose every probed path is a distinct, non-existent sentinel under the
 * temp root. Each test creates only the paths it is about, so "absent" is the
 * default state rather than something each test has to arrange. The sentinel is
 * named after the field, which is what lets the mapping test below prove that a
 * given pillar is probed at a given config field.
 */
function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const absent = (field: string): string => path.join(root, "absent", field);
  return {
    ...loadConfig(),
    transcriptsDir: absent("transcriptsDir"),
    engramVaultPath: absent("engramVaultPath"),
    wrapsDir: absent("wrapsDir"),
    frictionLogPath: absent("frictionLogPath"),
    liveSessionsDir: absent("liveSessionsDir"),
    tasksDir: absent("tasksDir"),
    claudeSettingsPath: absent("claudeSettingsPath"),
    historyPath: absent("historyPath"),
    pacingLogPath: absent("pacingLogPath"),
    fileHistoryDir: absent("fileHistoryDir"),
    claudeMdPath: absent("claudeMdPath"),
    usageDataDir: absent("usageDataDir"),
    claudeHome: absent("claudeHome"),
    ctaDbPath: absent("ctaDbPath"),
    skillRoots: [absent("skillRoots")],
    ...overrides,
  };
}

function statusFor(config: AppConfig, key: string) {
  const found = sourceStatuses(config).find((s) => s.key === key);
  expect(found, `no status reported for pillar ${key}`).toBeTruthy();
  return found!;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-sources-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("indexSourcePaths", () => {
  it("names the four sources the derived index reads, in this order", () => {
    // Three callers depend on this list agreeing with itself: the "search" probe,
    // the guard on the search routes, and the gate's first-run decision. Order is
    // pinned because the joined form is what the 503 body and the probe's `path`
    // field show the operator.
    const config = baseConfig();
    expect(indexSourcePaths(config)).toEqual([
      config.transcriptsDir,
      config.engramVaultPath,
      config.wrapsDir,
      config.frictionLogPath,
    ]);
  });
});

describe("sourceStatuses roster", () => {
  it("reports one status per pillar, keyed and ordered as it is today", () => {
    // A dropped key is a pillar the nav can no longer light up; a reordered one
    // changes which pillar a fresh clone lands on. Both are silent today.
    expect(sourceStatuses(baseConfig()).map((s) => s.key)).toEqual([
      "search",
      "sessions",
      "hooks",
      "live",
      "tasks",
      "skills",
      "config",
      "history",
      "workflows",
      "pacing",
      "blocks",
      "fileHistory",
      "mcpUsage",
      "delegation",
      "instructions",
      "skillTrend",
      "usageData",
      "disk",
      "engram",
      "graph",
      "friction",
      "wraps",
      "cta",
    ]);
  });

  it("marks exactly the four operator-specific pillars as personal", () => {
    // The tier is what lets a fresh clone be honest about what a stranger is
    // missing by definition. Promoting a universal pillar to personal would
    // excuse a real misconfiguration as "not your setup".
    const statuses = sourceStatuses(baseConfig());
    expect(statuses.filter((s) => s.tier === "personal").map((s) => s.key)).toEqual([
      "engram",
      "friction",
      "wraps",
      "cta",
    ]);
    expect(statuses.every((s) => s.tier === "personal" || s.tier === "universal")).toBe(true);
  });

  it("probes each pillar at the config field it uses today", () => {
    // The sentinel paths are named after their config field, so the reported
    // `path` names the field. This is the table that makes the transcriptsDir
    // fan-out visible: eight pillars are answered by the same directory, and two
    // of them (workflows, blocks) have a dedicated config field that is never
    // probed.
    const config = baseConfig();
    const field = (name: string): string => path.join(root, "absent", name);
    const reported = Object.fromEntries(sourceStatuses(config).map((s) => [s.key, s.path]));
    expect(reported).toEqual({
      search: indexSourcePaths(config).join(", "),
      sessions: field("transcriptsDir"),
      hooks: field("transcriptsDir"),
      live: field("liveSessionsDir"),
      tasks: field("tasksDir"),
      skills: field("skillRoots"),
      config: field("claudeSettingsPath"),
      history: field("historyPath"),
      workflows: field("transcriptsDir"),
      pacing: field("pacingLogPath"),
      blocks: field("transcriptsDir"),
      fileHistory: field("fileHistoryDir"),
      mcpUsage: field("transcriptsDir"),
      delegation: field("transcriptsDir"),
      instructions: field("claudeMdPath"),
      skillTrend: field("transcriptsDir"),
      usageData: field("usageDataDir"),
      disk: field("claudeHome"),
      engram: field("engramVaultPath"),
      graph: field("transcriptsDir"),
      friction: field("frictionLogPath"),
      wraps: field("wrapsDir"),
      cta: field("ctaDbPath"),
    });
  });

  it("reports every pillar absent with no problem when nothing exists", () => {
    // An absent source is not a configuration error, so `problem` stays null and
    // only `present` carries the news. This is the state of a fresh clone.
    const statuses = sourceStatuses(baseConfig());
    expect(statuses.every((s) => s.present === false)).toBe(true);
    expect(statuses.every((s) => s.problem === null)).toBe(true);
  });
});

describe("single-path probes check the kind of what they find", () => {
  it("reports a present directory for a dir probe", () => {
    const transcriptsDir = path.join(root, "projects");
    fs.mkdirSync(transcriptsDir, { recursive: true });
    expect(statusFor(baseConfig({ transcriptsDir }), "sessions")).toMatchObject({
      present: true,
      problem: null,
      path: transcriptsDir,
    });
  });

  it("reports a present file for a file probe", () => {
    const frictionLogPath = path.join(root, "friction-log.md");
    writeFile(frictionLogPath, "| date | entry |\n");
    expect(statusFor(baseConfig({ frictionLogPath }), "friction")).toMatchObject({
      present: true,
      problem: null,
      tier: "personal",
    });
  });

  it("names a file found where a directory was configured", () => {
    // The message is the whole point of the check: a bare existence test would
    // call this present and the pillar would then fail at read time with an
    // ENOTDIR that names nothing.
    const transcriptsDir = path.join(root, "projects");
    writeFile(transcriptsDir, "not a directory\n");
    expect(statusFor(baseConfig({ transcriptsDir }), "sessions")).toMatchObject({
      present: false,
      problem: "exists but is a file, not a directory",
    });
  });

  it("names a directory found where a file was configured", () => {
    const claudeMdPath = path.join(root, "CLAUDE.md");
    fs.mkdirSync(claudeMdPath, { recursive: true });
    expect(statusFor(baseConfig({ claudeMdPath }), "instructions")).toMatchObject({
      present: false,
      problem: "exists but is a directory, not a file",
    });
  });

  it("follows a symlink to a directory and calls it present", () => {
    // existsSync and statSync both resolve the link, so the probe describes the
    // target's kind, not the link's. A move to lstat would flip this.
    const realDir = path.join(root, "real-projects");
    const link = path.join(root, "projects-link");
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, link);
    expect(statusFor(baseConfig({ transcriptsDir: link }), "sessions")).toMatchObject({
      present: true,
      problem: null,
    });
  });

  it("reads a dangling symlink as plain absence, not as a problem", () => {
    // existsSync resolves the link, finds nothing, and returns false, so the
    // broken-link case never reaches the kind check and gets no message. The
    // operator sees "not configured" for a path that is in fact misconfigured.
    const link = path.join(root, "projects-link");
    fs.symlinkSync(path.join(root, "nowhere"), link);
    expect(fs.existsSync(link)).toBe(false);
    expect(statusFor(baseConfig({ transcriptsDir: link }), "sessions")).toMatchObject({
      present: false,
      problem: null,
    });
  });
});

describe("any-dir probes test existence over a set", () => {
  it("calls the search index present when any one of its four sources exists", () => {
    // Requiring all four would take search away from a machine that has
    // transcripts but no memory vault. The one that exists here is a file, which
    // is deliberate: the set mixes files and directories.
    const frictionLogPath = path.join(root, "friction-log.md");
    writeFile(frictionLogPath, "| date | entry |\n");
    expect(statusFor(baseConfig({ frictionLogPath }), "search").present).toBe(true);
  });

  it("reports the whole set as a comma-joined path, not the one that matched", () => {
    const frictionLogPath = path.join(root, "friction-log.md");
    writeFile(frictionLogPath, "| date | entry |\n");
    const config = baseConfig({ frictionLogPath });
    expect(statusFor(config, "search").path).toBe(indexSourcePaths(config).join(", "));
    expect(statusFor(config, "search").path).toContain(", ");
  });

  it("never reports a problem for an any-dir probe, whatever it finds", () => {
    // The kind check is skipped entirely for this shape, so a file configured as
    // a skill root reads as a healthy source. That matches listSkills, which
    // guards on existence over the roots and nothing more, so the probe and the
    // pillar agree - they are wrong together or right together.
    const fileAsRoot = path.join(root, "skills-but-a-file");
    writeFile(fileAsRoot, "not a skill root\n");
    expect(statusFor(baseConfig({ skillRoots: [fileAsRoot] }), "skills")).toMatchObject({
      present: true,
      problem: null,
    });
  });

  it("reports an empty skill-root list as absent with an empty path string", () => {
    // Nothing to join, so the operator is told a source is missing without being
    // told which one. There is no `problem` message for this either.
    expect(statusFor(baseConfig({ skillRoots: [] }), "skills")).toMatchObject({
      present: false,
      path: "",
      problem: null,
    });
  });
});

describe("a path that exists but cannot be stat'd", () => {
  // Reachable through the filesystem only as a race - existsSync returns false
  // for the same errors statSync throws, so a permission-denied or looping path
  // is reported as absent long before this branch is consulted. The stat is
  // therefore forced, which is the only way to pin the message this branch emits
  // and the fact that it reports the pillar as absent rather than as present.
  function withStatFailure<T>(target: string, err: Error, run: () => T): T {
    const realStatSync = fs.statSync;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((
      statPath: fs.PathLike,
      options?: fs.StatSyncOptions,
    ) => {
      if (String(statPath) === target) throw err;
      return realStatSync(statPath, options);
    }) as typeof fs.statSync);
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  }

  it("reports the errno code in the problem message", () => {
    const transcriptsDir = path.join(root, "projects");
    fs.mkdirSync(transcriptsDir, { recursive: true });
    const denied = new Error("permission denied") as NodeJS.ErrnoException;
    denied.code = "EACCES";

    const status = withStatFailure(transcriptsDir, denied, () =>
      statusFor(baseConfig({ transcriptsDir }), "sessions"),
    );
    expect(status).toMatchObject({
      present: false,
      problem: "unreadable: EACCES",
      path: transcriptsDir,
    });
  });

  it("falls back to 'unknown' when the thrown error carries no code", () => {
    const transcriptsDir = path.join(root, "projects");
    fs.mkdirSync(transcriptsDir, { recursive: true });

    const status = withStatFailure(transcriptsDir, new Error("no code on this one"), () =>
      statusFor(baseConfig({ transcriptsDir }), "sessions"),
    );
    // The thrown message is dropped; only the absent code is reported, so the
    // operator gets "unreadable: unknown" and no way to tell what happened.
    expect(status.problem).toBe("unreadable: unknown");
  });
});

describe("where the probe and the pillar it describes disagree", () => {
  it("calls workflows absent while the workflows pillar still answers", () => {
    // The probe checks transcriptsDir alone. workflowInventory needs only ONE of
    // transcriptsDir and workflowsDir, and reads saved scripts out of
    // workflowsDir - a field no probe looks at. So an operator with a populated
    // ~/.claude/workflows and no ~/.claude/projects is told the pillar has no
    // source while the route serves their scripts.
    //
    // Pinned as-is. If the probe is ever taught about workflowsDir, this test is
    // the one that should go red and force the change to be deliberate.
    const workflowsDir = path.join(root, "workflows");
    const transcriptsDir = path.join(root, "absent", "transcriptsDir");
    writeFile(
      path.join(workflowsDir, "known.js"),
      "export const meta = { name: 'known', description: 'a saved workflow' }\nawait agent('do a thing')\n",
    );

    const status = statusFor(baseConfig({ workflowsDir, transcriptsDir }), "workflows");
    expect(status.present).toBe(false);
    expect(status.path).toBe(transcriptsDir);

    const inventory = workflowInventory(transcriptsDir, workflowsDir);
    expect(inventory.scripts.map((s) => s.name)).toContain("known");
  });
});
