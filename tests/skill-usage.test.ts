import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSkillUsage,
  resolveUsage,
  staleness,
  uniqueBareNames,
} from "../server/skill-usage.js";

let dir = "";
const DAY = 24 * 60 * 60 * 1000;

function writeConfig(body: unknown): string {
  const filePath = path.join(dir, "claude.json");
  fs.writeFileSync(filePath, JSON.stringify(body), "utf8");
  return filePath;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-usage-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readSkillUsage", () => {
  it("reads the recorded counters", () => {
    const filePath = writeConfig({
      skillUsage: {
        "add-feature": { usageCount: 3, lastUsedAt: 1784992756080 },
        "some-plugin:some-skill": { usageCount: 1, lastUsedAt: 1781217203542 },
      },
    });
    const index = readSkillUsage(filePath)!;
    expect(index.byKey.get("add-feature")).toEqual({
      usageCount: 3,
      lastUsedAt: 1784992756080,
    });
    expect(index.byKey.size).toBe(2);
  });

  it("returns null for an absent file rather than throwing", () => {
    // Usage is an enrichment. Its absence must leave the skills pillar working;
    // only a missing skill root makes that pillar report a missing source.
    expect(readSkillUsage(path.join(dir, "nope.json"))).toBeNull();
  });

  it("returns null for a torn read rather than failing the pillar", () => {
    // The real file is rewritten constantly, so catching a half-written copy is
    // expected traffic, not an exceptional case.
    const filePath = path.join(dir, "torn.json");
    fs.writeFileSync(filePath, '{"skillUsage": {"a": {"usageCo', "utf8");
    expect(readSkillUsage(filePath)).toBeNull();
  });

  it("ignores entries whose counters are not usable numbers", () => {
    const filePath = writeConfig({
      skillUsage: {
        good: { usageCount: 2, lastUsedAt: 1700000000000 },
        weird: { usageCount: "many", lastUsedAt: null },
        negative: { usageCount: -5, lastUsedAt: -1 },
      },
    });
    const index = readSkillUsage(filePath)!;
    expect(index.byKey.get("good")!.usageCount).toBe(2);
    expect(index.byKey.get("weird")).toEqual({ usageCount: 0, lastUsedAt: 0 });
    expect(index.byKey.get("negative")).toEqual({ usageCount: 0, lastUsedAt: 0 });
  });

  it("reads no further than the usage map", () => {
    // The real file also holds an account object and per-project history.
    const filePath = writeConfig({
      oauthAccount: { emailAddress: "someone@example.test" },
      projects: { "/tmp/x": { history: ["a prompt"] } },
      skillUsage: { only: { usageCount: 1, lastUsedAt: 1 } },
    });
    const index = readSkillUsage(filePath)!;
    expect([...index.byKey.keys()]).toEqual(["only"]);
  });
});

describe("resolveUsage", () => {
  const inventory = [
    { slashCommand: "/superpowers:brainstorming" },
    { slashCommand: "/session-wrap" },
    { slashCommand: "/plugin-a:review" },
    { slashCommand: "/plugin-b:review" },
  ];
  const unique = uniqueBareNames(inventory);

  it("prefers an exact match on the namespaced command", () => {
    const index = readSkillUsage(
      writeConfig({
        skillUsage: {
          "superpowers:brainstorming": { usageCount: 35, lastUsedAt: 1785000000000 },
          brainstorming: { usageCount: 2, lastUsedAt: 1772287978042 },
        },
      }),
    )!;
    // Both spellings exist for this skill on a real machine. The namespaced one
    // is the command actually invoked, so it wins and the count is 35, not 2.
    const usage = resolveUsage(index, "/superpowers:brainstorming", "brainstorming", unique);
    expect(usage).toEqual({ usageCount: 35, lastUsedAt: 1785000000000, match: "exact" });
  });

  it("falls back to the bare name when only that spelling was recorded", () => {
    const index = readSkillUsage(
      writeConfig({ skillUsage: { brainstorming: { usageCount: 2, lastUsedAt: 500 } } }),
    )!;
    const usage = resolveUsage(index, "/superpowers:brainstorming", "brainstorming", unique);
    expect(usage).toEqual({ usageCount: 2, lastUsedAt: 500, match: "name" });
  });

  it("refuses the bare-name fallback when two plugins share a skill name", () => {
    // Crediting one recorded count to both would silently double it, and a wrong
    // number is presented with exactly the same confidence as a right one.
    const index = readSkillUsage(
      writeConfig({ skillUsage: { review: { usageCount: 9, lastUsedAt: 500 } } }),
    )!;
    expect(resolveUsage(index, "/plugin-a:review", "review", unique)).toBeNull();
    expect(resolveUsage(index, "/plugin-b:review", "review", unique)).toBeNull();
  });

  it("returns null when nothing was recorded for the skill", () => {
    const index = readSkillUsage(writeConfig({ skillUsage: {} }))!;
    expect(resolveUsage(index, "/session-wrap", "session-wrap", unique)).toBeNull();
  });
});

describe("uniqueBareNames", () => {
  it("keeps only names identifying exactly one skill", () => {
    const unique = uniqueBareNames([
      { slashCommand: "/a:review" },
      { slashCommand: "/b:review" },
      { slashCommand: "/solo" },
      { slashCommand: "/c:only-here" },
    ]);
    expect(unique.has("review")).toBe(false);
    expect(unique.has("solo")).toBe(true);
    expect(unique.has("only-here")).toBe(true);
  });
});

describe("staleness", () => {
  const now = 1785000000000;

  it("calls a skill that was never invoked never, not cold", () => {
    // The distinction matters: cold means it fell out of use, never means it was
    // installed and not once reached for. Only one of those is a habit gap.
    expect(staleness(null, now)).toBe("never");
    expect(staleness({ usageCount: 0, lastUsedAt: 0, match: "none" }, now)).toBe("never");
    expect(staleness({ usageCount: 3, lastUsedAt: 0, match: "exact" }, now)).toBe("never");
  });

  it("bands by how long ago it last ran", () => {
    expect(staleness({ usageCount: 1, lastUsedAt: now - 2 * DAY, match: "exact" }, now)).toBe("active");
    expect(staleness({ usageCount: 1, lastUsedAt: now - 30 * DAY, match: "exact" }, now)).toBe("active");
    expect(staleness({ usageCount: 1, lastUsedAt: now - 45 * DAY, match: "exact" }, now)).toBe("cooling");
    expect(staleness({ usageCount: 1, lastUsedAt: now - 200 * DAY, match: "exact" }, now)).toBe("cold");
  });
});
