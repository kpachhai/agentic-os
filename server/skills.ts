import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { SourceMissingError } from "./config.js";
import {
  readSkillUsage,
  resolveUsage,
  staleness,
  uniqueBareNames,
  type SkillStaleness,
  type UsageMatch,
} from "./skill-usage.js";

export type SkillSource = "global" | `plugin:${string}`;

export type SkillInfo = {
  name: string;
  description: string;
  source: SkillSource;
  slashCommand: string;
  path: string;
  /**
   * Times invoked, per Claude Code's own counters. Null when no usage source was
   * available, which is different from zero: zero means installed and never used,
   * null means nobody was counting.
   */
  usageCount: number | null;
  /** Epoch milliseconds of the last invocation, or null. */
  lastUsedAt: number | null;
  /** How the usage record was matched, so a reader can weigh the number. */
  usageMatch: UsageMatch;
  /**
   * Coarse recency. "never" is the one worth acting on: a catalog cannot tell you
   * which skills you have installed and never once reached for.
   */
  staleness: SkillStaleness | null;
};

/**
 * Claude Code's record of which plugins are installed and where each one
 * lives. The plugin store keeps every version ever downloaded under cache/
 * and a full second copy of each marketplace repo under marketplaces/, so the
 * directory layout alone cannot tell a live install from history. This
 * manifest is the only thing that can.
 */
const INSTALLED_PLUGINS = "installed_plugins.json";

/** Only the fields this tool reads; the file carries more. */
type InstalledPlugins = {
  plugins?: Record<string, Array<{ installPath?: string }>>;
};

/** A directory to scan, already resolved to the source it stands for. */
type ScanRoot = { dir: string; source: SkillSource; plugin: string | null };

/**
 * Recursively find SKILL.md files under a root (bounded depth for safety).
 *
 * Two rules here are load-bearing, and getting either wrong changes the catalog's
 * count rather than merely its ordering.
 *
 * Symlinked directories are followed. Installing a skill by linking it out of
 * another checkout is ordinary practice, and a directory entry's own type is
 * `symlink` rather than `directory`, so testing the entry meant every linked skill
 * was invisible to this catalog while Claude Code surfaced it. The type is taken
 * from a stat that follows the link instead, and `visited` holds resolved paths so
 * a link pointing at an ancestor cannot loop.
 *
 * A directory that has its own SKILL.md is not descended into. Skills keep variant
 * copies in subdirectories, and continuing past the identity file turned one
 * installed skill into three, each named for a directory nobody can invoke.
 */
function findSkillFiles(root: string, depth = 8, visited?: Set<string>): string[] {
  if (depth < 0) return [];
  const seen = visited ?? new Set<string>();
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // A broken link or an unreadable root contributes nothing, which is the same
    // answer as an absent one.
    return [];
  }
  if (seen.has(realRoot)) return [];
  seen.add(realRoot);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  // The identity file at this level is the whole answer for this directory.
  const own = entries.find((entry) => entry.name === "SKILL.md");
  if (own) {
    const ownPath = path.join(root, "SKILL.md");
    return isFileFollowingLinks(ownPath) ? [ownPath] : [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const entryPath = path.join(root, entry.name);
    if (isDirectoryFollowingLinks(entryPath)) {
      out.push(...findSkillFiles(entryPath, depth - 1, seen));
    }
  }
  return out;
}

/** Type checks that follow a symlink, so a linked skill counts as what it points at. */
function isDirectoryFollowingLinks(candidate: string): boolean {
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory();
}

function isFileFollowingLinks(candidate: string): boolean {
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

/** User-authored skills outrank plugin-supplied ones of the same command. */
function precedence(source: SkillSource): number {
  return source === "global" ? 0 : 1;
}

// Every distinct problem is still reported - just once per process rather than
// on every request. The inventory is re-scanned per call, and repeating the
// same lines each time buries anything worth reading.
const warnedOnce = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message);
}

/**
 * Tell Claude Code's plugin store apart from a plain directory of skills.
 * Recognised by structure rather than by name, so a fork can point skillRoots
 * anywhere without this hard-coding where the store lives.
 */
function isPluginStore(root: string): boolean {
  return (
    fs.existsSync(path.join(root, INSTALLED_PLUGINS)) ||
    fs.existsSync(path.join(root, "cache")) ||
    fs.existsSync(path.join(root, "marketplaces"))
  );
}

/**
 * Expand a plugin store into one scan root per installed plugin, taking each
 * directory from the manifest instead of walking the store.
 *
 * Walking it is what the operator sees as breakage: superseded cache versions
 * and marketplace clones hold the same SKILL.md files as the live install, so
 * a walk collects several copies of every skill and has nothing but path
 * ordering to choose between them. That picks a stale copy about as often as
 * the real one, files it under a namespace taken from the marketplace repo
 * rather than the plugin, and reports each rejected copy - a wall of warnings
 * describing a choice that should never have been made.
 */
function pluginScanRoots(store: string): ScanRoot[] {
  const manifestPath = path.join(store, INSTALLED_PLUGINS);
  if (!fs.existsSync(manifestPath)) {
    warnOnce(
      `no-manifest:${store}`,
      `skills: no ${manifestPath} - reporting no plugin skills from ${store}`,
    );
    return [];
  }

  let manifest: InstalledPlugins;
  try {
    manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as InstalledPlugins;
  } catch (err) {
    // Degrading here would empty the plugin half of the inventory, which reads
    // as "you have no plugins installed" - a different and wrong claim.
    throw new Error(`skills: cannot read ${manifestPath}: ${err}`);
  }

  const roots: ScanRoot[] = [];
  for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
    // Manifest keys are `<plugin>@<marketplace>`. The plugin half is what
    // namespaces the command, so /<plugin>:<skill> is what the operator types.
    const plugin = key.split("@")[0];
    if (!plugin) continue;
    for (const install of installs ?? []) {
      const installPath = install?.installPath;
      if (!installPath) continue;
      if (!fs.existsSync(installPath)) {
        warnOnce(
          `missing-install:${key}:${installPath}`,
          `skills: ${key} is recorded as installed at ${installPath}, which does not exist`,
        );
        continue;
      }
      // A plugin ships commands, agents, and hooks beside its skills; only
      // skills/ holds SKILL.md files that resolve to a slash command. Anything
      // outside it (a template, a spec fixture) is not launchable.
      const dir = path.join(installPath, "skills");
      if (!fs.existsSync(dir)) continue;
      roots.push({ dir, source: `plugin:${plugin}`, plugin });
    }
  }
  return roots;
}

/** Resolve the configured roots into the concrete directories worth scanning. */
function scanRoots(skillRoots: string[]): ScanRoot[] {
  const roots: ScanRoot[] = [];
  for (const root of skillRoots) {
    if (!fs.existsSync(root)) continue;
    if (isPluginStore(root)) roots.push(...pluginScanRoots(root));
    else roots.push({ dir: root, source: "global", plugin: null });
  }
  return roots;
}

/**
 * Scan the configured roots and build the de-duplicated inventory.
 * De-dupe key is the resolved slashCommand, since that is what the operator
 * actually types and therefore what must be unique. A user-authored skill
 * shadows a plugin-supplied copy of the same command. Ties keep the first in
 * deterministic sorted scan order and log the drop, so a silently vanishing
 * skill stays traceable. No plugin is special-cased by name: a fork's own
 * plugins are resolved exactly like everyone else's.
 */
export function listSkills(
  skillRoots: string[],
  q?: string,
  claudeConfigPath?: string,
): SkillInfo[] {
  if (!skillRoots.some((r) => fs.existsSync(r))) {
    throw new SourceMissingError("skill roots", skillRoots.join(", "));
  }
  const byCommand = new Map<string, SkillInfo>();
  const blankUsage = {
    usageCount: null,
    lastUsedAt: null,
    usageMatch: "none" as UsageMatch,
    staleness: null,
  };

  for (const { dir, source, plugin } of scanRoots(skillRoots)) {
    for (const filePath of findSkillFiles(dir).sort()) {
      let name = "";
      let description = "";
      try {
        const { data } = matter(fs.readFileSync(filePath, "utf8"));
        const fm = data as Record<string, unknown>;
        name =
          typeof fm.name === "string" && fm.name.trim()
            ? fm.name.trim()
            : path.basename(path.dirname(filePath));
        description = typeof fm.description === "string" ? fm.description.trim() : "";
      } catch (err) {
        warnOnce(
          `malformed:${filePath}`,
          `skills: skipping malformed frontmatter in ${filePath}: ${err}`,
        );
        continue;
      }
      if (!name || !description) {
        warnOnce(
          `incomplete:${filePath}`,
          `skills: skipping ${filePath} (missing name or description)`,
        );
        continue;
      }

      // Both forms carry the leading slash, because the launcher sends this
      // string to `claude -p` as the prompt and only a leading slash makes it
      // a command rather than a sentence. Plugin skills are namespaced:
      // /<plugin>:<name>.
      const bare = name.replace(/^\//, "");
      const slashCommand = source === "global" ? `/${bare}` : `/${plugin}:${bare}`;

      const existing = byCommand.get(slashCommand);
      if (existing) {
        if (precedence(source) < precedence(existing.source)) {
          warnOnce(
            `shadow:${slashCommand}:${filePath}`,
            `skills: ${slashCommand} from ${existing.path} shadowed by higher-precedence ${filePath}`,
          );
          byCommand.set(slashCommand, {
            name,
            description,
            source,
            slashCommand,
            path: filePath,
            ...blankUsage,
          });
        } else {
          warnOnce(
            `dup:${slashCommand}:${filePath}`,
            `skills: dropped duplicate ${slashCommand} at ${filePath}`,
          );
        }
        continue;
      }
      byCommand.set(slashCommand, {
        name,
        description,
        source,
        slashCommand,
        path: filePath,
        ...blankUsage,
      });
    }
  }

  let out = [...byCommand.values()].sort((a, b) =>
    a.source === b.source
      ? a.name.localeCompare(b.name)
      : precedence(a.source) - precedence(b.source),
  );

  // Usage turns a catalog into a report on habit: which skills are working, which
  // have gone cold, and which have never once been reached for. It is an overlay,
  // so its absence leaves every field above untouched rather than failing the
  // pillar - only a missing skill root does that.
  if (claudeConfigPath) {
    const usageIndex = readSkillUsage(claudeConfigPath);
    if (usageIndex) {
      const unique = uniqueBareNames(out);
      const now = Date.now();
      out = out.map((skill) => {
        const bare = skill.slashCommand.replace(/^\//, "").split(":").pop() ?? "";
        const usage = resolveUsage(usageIndex, skill.slashCommand, bare, unique);
        return {
          ...skill,
          usageCount: usage ? usage.usageCount : 0,
          lastUsedAt: usage ? usage.lastUsedAt : null,
          usageMatch: usage ? usage.match : "none",
          staleness: staleness(usage, now),
        };
      });
    }
  }

  if (q) {
    const needle = q.toLowerCase();
    out = out.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle),
    );
  }
  return out;
}
