import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, SourceMissingError } from "../server/config.js";
import {
  LaunchManager,
  narrowBudget,
  narrowCwd,
  narrowTimeout,
  type LaunchRecord,
} from "../server/launcher.js";
import { listSkills, type SkillInfo } from "../server/skills.js";

const config = loadConfig();
const rootsPresent = config.skillRoots.some((r) => fs.existsSync(r));

// Smoke against the real skill roots on this machine (gate check 7).
describe.skipIf(!rootsPresent)("skill inventory (real roots)", () => {
  // One scan for the whole block. Each call walks every skill root, which
  // takes seconds against a real machine's plugin tree - scanning once per
  // assertion is what pushed this suite past the default timeout.
  let skills: SkillInfo[];
  beforeAll(() => {
    skills = listSkills(config.skillRoots);
  }, 60000);

  it("returns >= 10 skills, each with non-empty name + description", () => {
    expect(skills.length).toBeGreaterThanOrEqual(10);
    for (const s of skills) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.slashCommand).toBeTruthy();
      expect(s.path).toBeTruthy();
    }
  });

  it("de-dupes by slashCommand (no duplicate keys survive)", () => {
    const keys = skills.map((s) => s.slashCommand);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("classifies sources into global / plugin:* with no plugin special-cased", () => {
    const sources = new Set(skills.map((s) => s.source));
    expect(sources.has("global")).toBe(true);
    expect([...sources].some((s) => s.startsWith("plugin:"))).toBe(true);
    // every source is one of the two shapes - no bespoke per-plugin label
    for (const s of sources) {
      expect(s === "global" || s.startsWith("plugin:")).toBe(true);
    }
  });

  it("gives every skill a launchable leading-slash command", () => {
    for (const s of skills) {
      expect(s.slashCommand.startsWith("/")).toBe(true);
    }
  });

  it(
    "q filter narrows by name/description",
    () => {
      const hits = listSkills(config.skillRoots, "review");
      expect(hits.length).toBeLessThanOrEqual(skills.length);
    },
    60000,
  );
});

it("reports absent skill roots as a missing source, not an empty list", () => {
  expect(() => listSkills(["/no/such/skills/root"])).toThrow(
    SourceMissingError,
  );
});

// A plugin store holds every version ever downloaded plus a clone of each
// marketplace repo, so the same SKILL.md exists several times over. Only the
// copy the installed-plugins manifest names is live. Built synthetically: the
// real store on any given machine may or may not have a superseded version
// lying around, and a test must not depend on that.
describe("plugin store resolves through the installed-plugins manifest", () => {
  let store: string;
  const skillFile = (dir: string, name: string, body: string) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(
      path.join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${body}\n---\n`,
    );
  };

  beforeAll(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-skills-"));
    const live = path.join(store, "cache", "some-market", "demo-plugin", "2.0.0");
    const stale = path.join(store, "cache", "some-market", "demo-plugin", "1.0.0");
    // Lexicographically first, so path-ordered scanning picks it over the live
    // copy - the failure this guards against.
    skillFile(path.join(stale, "skills"), "widget", "stale copy");
    skillFile(path.join(live, "skills"), "widget", "live copy");
    // The marketplace clone carries the same file a third time.
    skillFile(
      path.join(store, "marketplaces", "some-market", "demo-plugin", "skills"),
      "widget",
      "clone copy",
    );
    // Not under skills/, so not launchable as a command.
    skillFile(path.join(live, "template"), "scaffold", "not a real skill");

    fs.writeFileSync(
      path.join(store, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo-plugin@some-market": [{ installPath: live, version: "2.0.0" }],
          // A stale manifest entry must not take the scan down with it.
          "gone-plugin@some-market": [
            { installPath: path.join(store, "cache", "some-market", "gone", "1.0.0") },
          ],
        },
      }),
    );
  });

  afterAll(() => fs.rmSync(store, { recursive: true, force: true }));

  it("serves the installed version, not a superseded or cloned copy", () => {
    const skills = listSkills([store]);
    const widgets = skills.filter((s) => s.name === "widget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.description).toBe("live copy");
    expect(widgets[0]!.path).toContain(`${path.sep}2.0.0${path.sep}`);
  });

  it("namespaces the command by plugin, not by marketplace", () => {
    const skills = listSkills([store]);
    expect(skills.map((s) => s.slashCommand)).toContain("/demo-plugin:widget");
    expect(skills.every((s) => !s.slashCommand.startsWith("/some-market:"))).toBe(
      true,
    );
  });

  it("ignores SKILL.md files outside a plugin's skills/ directory", () => {
    expect(listSkills([store]).some((s) => s.name === "scaffold")).toBe(false);
  });

  it("crashes on an unreadable manifest rather than reporting no plugins", () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-broken-"));
    try {
      fs.writeFileSync(path.join(broken, "installed_plugins.json"), "{not json");
      expect(() => listSkills([broken])).toThrow(/cannot read/);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });
});

// Launcher wiring via the hermetic smoke command (gate check 8).
// Asserts spawn -> stream -> exit-capture plumbing, NOT a real LLM skill run.
describe("launcher wiring (hermetic smoke command)", () => {
  it("runs the smoke command to a terminal status with exitCode + events", async () => {
    const mgr = new LaunchManager(config);
    const record = mgr.launchSmoke();
    expect(record.launchId).toBeTruthy();
    expect(record.status).toBe("running");

    const done = await new Promise<LaunchRecord>((resolve) => {
      mgr.subscribe(record.launchId, { onEvent: () => {}, onDone: resolve });
    });
    expect(["done", "error", "timed_out"]).toContain(done.status);
    expect(done.exitCode).not.toBeNull();
    expect(done.events.length).toBeGreaterThanOrEqual(1);
  }, 65000);

  it("rejects an empty prompt and a cwd that does not exist", () => {
    const mgr = new LaunchManager(config);
    expect(() => mgr.launch({ prompt: "  " })).toThrow(/non-empty/);
    expect(() =>
      mgr.launch({ prompt: "/x", cwd: "no-such-subdir-xyz" }),
    ).toThrow(/not a directory/);
  });

  it("rejects a cwd outside the configured one (cannot widen)", () => {
    const mgr = new LaunchManager(config);
    expect(() => mgr.launch({ prompt: "/x", cwd: "/" })).toThrow(
      /must be inside/,
    );
    expect(() => mgr.launch({ prompt: "/x", cwd: "../.." })).toThrow(
      /must be inside/,
    );
  });

  it("builds claude argv without --max-turns (absent on CLI 2.1.202)", () => {
    // echo stands in for the claude binary: this asserts argv construction
    // only, without triggering a real (billable) claude -p run.
    const mgr = new LaunchManager({ ...config, claudeBinary: "echo" });
    const record = mgr.launch({ prompt: "/noop", timeoutSeconds: 5 });
    expect(record.argv).toContain("--output-format");
    expect(record.argv).toContain("stream-json");
    expect(record.argv).toContain("--permission-mode");
    expect(record.argv).toContain("--allowedTools");
    expect(record.argv).toContain("--add-dir");
    expect(record.argv).not.toContain("--max-turns");
  });
});

describe("launch lifecycle (hermetic commands, no LLM run)", () => {
  /** Resolve when the given launch reaches a terminal status. */
  function whenDone(mgr: LaunchManager, launchId: string) {
    return new Promise<LaunchRecord>((resolve) => {
      mgr.subscribe(launchId, { onEvent: () => {}, onDone: resolve });
    });
  }

  it("cancels a running launch and records it as cancelled", async () => {
    const mgr = new LaunchManager({ ...config, smokeCommand: "sleep 30" });
    const record = mgr.launchSmoke();
    expect(record.status).toBe("running");

    expect(mgr.kill(record.launchId, "cancelled")).toBe(true);
    const done = await whenDone(mgr, record.launchId);
    expect(done.status).toBe("cancelled");
    // a second cancel has nothing to stop
    expect(mgr.kill(record.launchId, "cancelled")).toBe(false);
  }, 20000);

  it("tells a late subscriber the run already finished", async () => {
    const mgr = new LaunchManager({ ...config, smokeCommand: "true" });
    const record = mgr.launchSmoke();
    await whenDone(mgr, record.launchId);

    // Subscribing after the fact must report `finished` rather than leaving
    // the subscriber waiting for a `done` event that already fired.
    const late = mgr.subscribe(record.launchId, {
      onEvent: () => {},
      onDone: () => {},
    });
    expect(late).not.toBeNull();
    expect(late!.finished).toBe(true);
    expect(late!.buffered.length).toBeGreaterThanOrEqual(1);
    late!.unsubscribe();
  }, 20000);

  it("drops the oldest finished records instead of growing forever", async () => {
    // A binary that cannot be spawned reaches a terminal record through the
    // same path as a real one, without paying process-startup cost 55 times.
    const mgr = new LaunchManager({
      ...config,
      smokeCommand: "definitely-not-a-real-binary-xyz",
    });
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const rec = mgr.launchSmoke();
      ids.push(rec.launchId);
      await whenDone(mgr, rec.launchId);
    }
    expect(mgr.get(ids[0]!)).toBeNull();
    expect(mgr.get(ids[ids.length - 1]!)).not.toBeNull();
  }, 30000);

  it("returns null when subscribing to an unknown launch", () => {
    const mgr = new LaunchManager(config);
    expect(
      mgr.subscribe("no-such-id", { onEvent: () => {}, onDone: () => {} }),
    ).toBeNull();
  });
});

describe("per-launch overrides narrow, never widen", () => {
  it("clamps the timeout to the configured ceiling", () => {
    expect(narrowTimeout(600, undefined)).toBe(600);
    expect(narrowTimeout(600, 30)).toBe(30);
    expect(narrowTimeout(600, 99999)).toBe(600);
    expect(() => narrowTimeout(600, 0)).toThrow(/positive/);
    expect(() => narrowTimeout(600, -5)).toThrow(/positive/);
  });

  it("clamps the budget, and lets a request add a cap where none was set", () => {
    expect(narrowBudget(5, undefined)).toBe(5);
    expect(narrowBudget(5, 1)).toBe(1);
    expect(narrowBudget(5, 100)).toBe(5);
    expect(narrowBudget(null, undefined)).toBeNull();
    expect(narrowBudget(null, 2)).toBe(2);
    expect(() => narrowBudget(5, -1)).toThrow(/positive/);
  });

  it("keeps a requested cwd inside the configured one", () => {
    expect(narrowCwd("/base/dir", undefined)).toBe("/base/dir");
    expect(narrowCwd("/base/dir", "sub")).toBe("/base/dir/sub");
    expect(narrowCwd("/base/dir", "/base/dir/sub")).toBe("/base/dir/sub");
    expect(() => narrowCwd("/base/dir", "/etc")).toThrow(/must be inside/);
    expect(() => narrowCwd("/base/dir", "../sibling")).toThrow(/must be inside/);
    // a traversal that lands back inside is still inside
    expect(narrowCwd("/base/dir", "sub/../other")).toBe("/base/dir/other");
  });
});

describe("what counts as one installed skill", () => {
  let root = "";
  let linkTarget = "";

  const writeSkill = (dir: string, name: string, description: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n`,
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-skillscan-"));
    linkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-skilllink-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(linkTarget, { recursive: true, force: true });
  });

  it("finds a skill installed by linking it out of another checkout", () => {
    // Linking a skill directory out of its own repo is ordinary practice, and a
    // directory entry's own type is symlink rather than directory - testing the
    // entry hid every linked skill from this catalog while Claude Code surfaced it.
    writeSkill(path.join(linkTarget, "linked-skill"), "linked-skill", "lives elsewhere");
    fs.symlinkSync(path.join(linkTarget, "linked-skill"), path.join(root, "linked-skill"));

    const skills = listSkills([root]);
    expect(skills.map((s) => s.name)).toContain("linked-skill");
  });

  it("counts a skill that keeps variant copies inside itself as one skill", () => {
    // Continuing past a directory's own identity file turned one installed skill
    // into three, each named for a directory nobody can invoke.
    writeSkill(path.join(root, "harness"), "harness", "the real one");
    writeSkill(path.join(root, "harness", "variants", "alt"), "harness-alt", "a variant");
    writeSkill(path.join(root, "harness", "variants", "other"), "harness-other", "a variant");

    const skills = listSkills([root]);
    expect(skills.map((s) => s.name)).toEqual(["harness"]);
  });

  it("survives a broken link and a link pointing back up the tree", () => {
    writeSkill(path.join(root, "real-skill"), "real-skill", "present");
    fs.symlinkSync(path.join(linkTarget, "not-there"), path.join(root, "dangling"));
    // A link to an ancestor would recurse forever without the resolved-path guard.
    fs.symlinkSync(root, path.join(root, "loop"));

    const skills = listSkills([root]);
    expect(skills.map((s) => s.name)).toEqual(["real-skill"]);
  });
});

