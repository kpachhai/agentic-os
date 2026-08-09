import fs from "node:fs";

/**
 * How a skill's usage record was matched to the skill on disk. Reported per skill
 * so a reader can tell a certain link from a plausible one, rather than being
 * shown a count and left to trust it.
 */
export type UsageMatch = "exact" | "name" | "none";

export type SkillUsage = {
  usageCount: number;
  /** Epoch milliseconds, as recorded. */
  lastUsedAt: number;
  match: UsageMatch;
};

/** One raw entry as Claude Code records it. */
type RawUsage = { usageCount?: unknown; lastUsedAt?: unknown };

export type UsageIndex = {
  /** Keyed exactly as recorded, e.g. "add-feature" or "some-plugin:some-skill". */
  byKey: Map<string, { usageCount: number; lastUsedAt: number }>;
  /**
   * Usage keys that matched no skill in the inventory. Not a fault: built-in
   * skills and plain slash commands are recorded here too and never appear in a
   * directory scan. Reported so a shrinking match rate is visible rather than
   * looking like disuse.
   */
  unmatchedKeys: string[];
};

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Read the per-skill usage counters Claude Code maintains.
 *
 * Read fresh on every call rather than cached: Claude Code rewrites this file
 * constantly, and a cached copy would report a skill as cold minutes after it ran.
 *
 * A missing file is not an error. Usage is an enrichment on top of the inventory,
 * so its absence must leave the skills pillar working; only a missing skill root
 * makes that pillar report a missing source.
 *
 * The file also holds an account object and per-project history. Nothing here
 * reads beyond the usage map, and nothing from it is ever returned wholesale.
 */
export function readSkillUsage(claudeConfigPath: string): UsageIndex | null {
  if (!fs.existsSync(claudeConfigPath)) return null;

  let parsed: { skillUsage?: Record<string, RawUsage> };
  try {
    parsed = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8")) as {
      skillUsage?: Record<string, RawUsage>;
    };
  } catch (err) {
    // A torn read is expected: the file is rewritten while it is being read. This
    // costs one request its usage overlay, never the inventory.
    console.warn(`skill-usage: cannot parse ${claudeConfigPath}:`, err);
    return null;
  }

  const byKey = new Map<string, { usageCount: number; lastUsedAt: number }>();
  for (const [key, raw] of Object.entries(parsed.skillUsage ?? {})) {
    if (typeof raw !== "object" || raw === null) continue;
    byKey.set(key, {
      usageCount: toCount(raw.usageCount),
      lastUsedAt: toCount(raw.lastUsedAt),
    });
  }
  return { byKey, unmatchedKeys: [] };
}

/**
 * Resolve usage for one skill.
 *
 * Two forms appear in the recorded keys for the same skill: the namespaced
 * command a plugin skill is invoked by, and its bare name. So an exact match on
 * the command is tried first, and only then the bare name.
 *
 * The bare-name fallback is deliberately restricted to names that are unique
 * across the inventory. Two plugins can ship a skill of the same name, and
 * crediting one recorded count to both would silently double it - a wrong number
 * presented with the same confidence as a right one.
 */
export function resolveUsage(
  index: UsageIndex,
  slashCommand: string,
  bareName: string,
  uniqueBareNames: Set<string>,
): SkillUsage | null {
  const commandKey = slashCommand.replace(/^\//, "");

  const exact = index.byKey.get(commandKey);
  if (exact) return { ...exact, match: "exact" };

  if (uniqueBareNames.has(bareName)) {
    const byName = index.byKey.get(bareName);
    if (byName) return { ...byName, match: "name" };
  }
  return null;
}

/**
 * Bare names that identify exactly one skill in the inventory, which is the
 * precondition for trusting the bare-name fallback above.
 */
export function uniqueBareNames(
  skills: Array<{ slashCommand: string }>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const bare = skill.slashCommand.replace(/^\//, "").split(":").pop() ?? "";
    if (bare) counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  const unique = new Set<string>();
  for (const [name, count] of counts) if (count === 1) unique.add(name);
  return unique;
}

/**
 * How long ago a skill was last used, as a coarse state.
 *
 * "never" is the interesting one: a skill installed and never invoked is either a
 * gap in habit or a skill that should be dropped, and the inventory alone cannot
 * tell the operator which skills those are.
 */
export type SkillStaleness = "never" | "active" | "cooling" | "cold";

const ACTIVE_DAYS = 30;
const COOLING_DAYS = 90;

export function staleness(usage: SkillUsage | null, now: number): SkillStaleness {
  if (!usage || usage.usageCount === 0 || usage.lastUsedAt === 0) return "never";
  const ageDays = (now - usage.lastUsedAt) / (24 * 60 * 60 * 1000);
  if (ageDays <= ACTIVE_DAYS) return "active";
  if (ageDays <= COOLING_DAYS) return "cooling";
  return "cold";
}
