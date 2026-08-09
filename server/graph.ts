import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { SourceMissingError } from "./config.js";

/**
 * The link graph hiding inside a markdown memory vault.
 *
 * Entries reference each other with `[[wiki-style]]` links, which makes the vault
 * a graph rather than a list - but nothing renders it, so the structure exists
 * without being usable. This module extracts it.
 *
 * The useful output is not the graph itself but its faults: links pointing at
 * entries that do not exist, entries nothing links to, and entries that link to
 * nothing. Those are the maintenance queue, and finding them by hand means reading
 * every file.
 */

/**
 * A `[[target]]` reference, optionally aliased as `[[target|shown text]]`.
 *
 * The target pattern is deliberately narrow, because the obvious permissive
 * version is wrong on this corpus in a way that is easy to miss: `[[ ... ]]` is
 * also bash's test syntax, and `[[:space:]]` is a POSIX character class. Both
 * appear thousands of times across notes that quote shell snippets, and a loose
 * pattern reports every one as a link to a note that does not exist - burying the
 * real broken links under noise and inventing a maintenance problem.
 *
 * So a target must begin with a letter or digit and contain only characters a
 * note name would plausibly use. That excludes `[[:space:]]` (leading colon) and
 * `[[ -f "$file" ]]` (leading space, and `$` and `"` are not in the class).
 */
const WIKILINK_RE = /\[\[([A-Za-z0-9][A-Za-z0-9 ._/-]*?)(?:\|[^\]]*)?\]\]/g;

export type GraphNode = {
  id: string;
  /** The link name other entries use, derived from the file, not the id. */
  name: string;
  title: string;
  type: string;
  timestamp: string;
  outbound: string[];
  inbound: string[];
  /** Outbound links naming an entry that is not in the vault. */
  broken: string[];
  /** Nothing links here. */
  orphan: boolean;
  /** This links nowhere. */
  leaf: boolean;
};

export type MemoryGraph = {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string }>;
  brokenLinks: Array<{ from: string; target: string }>;
  orphans: string[];
  leaves: string[];
  stats: {
    entries: number;
    links: number;
    brokenLinks: number;
    orphans: number;
    leaves: number;
    /** Largest number of inbound links on any one entry. */
    mostLinkedCount: number;
    mostLinked: string | null;
  };
};

/**
 * The name other entries use to link to a file.
 *
 * A wikilink names a file, not a frontmatter id, so resolution has to work from
 * the filename. The vault's names carry a timestamp prefix and a hash suffix that
 * no author would type in a link, so both are stripped before matching.
 */
function linkNameFor(filePath: string): string {
  // A wikilink names the note's slug, which is its filename stem. The frontmatter
  // `name` field carries the same slug by convention, so the stem is sufficient
  // and does not require reading the file twice.
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.md$/, "").trim();
}

/** Link targets are matched case- and separator-insensitively. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function extractLinks(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) found.add(target);
  }
  return [...found];
}

/** One memory file, reduced to what the graph needs. */
type MemoryFile = {
  id: string;
  path: string;
  title: string;
  type: string;
  timestamp: string;
  body: string;
};

/**
 * Load the file-based memory notes.
 *
 * These live under each project's own memory directory, one note per file with a
 * `name` and `description` in frontmatter, plus a `MEMORY.md` index. This is the
 * store that uses `[[wikilinks]]`; a markdown vault of captured thoughts is a
 * different store with a different convention, and pointing this at one produces a
 * graph with no edges and every entry reported as an orphan.
 *
 * `MEMORY.md` is read for its links but is not itself a node: it is an index that
 * points at everything, so counting it would make every note look linked and empty
 * the orphan list of the entries worth finding.
 */
function loadMemoryFiles(transcriptsDir: string): MemoryFile[] {
  if (!fs.existsSync(transcriptsDir)) {
    throw new SourceMissingError("memory notes", transcriptsDir);
  }

  const files: MemoryFile[] = [];
  for (const projectEntry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const memoryDir = path.join(transcriptsDir, projectEntry.name, "memory");
    if (!fs.existsSync(memoryDir)) continue;

    let names: string[];
    try {
      names = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const name of names) {
      // Session wraps live in the same directory and are a different artifact
      // with their own pillar; including them would mix two stores in one graph.
      if (name.startsWith("session_wrap_")) continue;
      const filePath = path.join(memoryDir, name);
      try {
        const { data, content } = matter(fs.readFileSync(filePath, "utf8"));
        const frontmatter = data as Record<string, unknown>;
        const body = content.trim();
        const declaredName =
          typeof frontmatter.name === "string" ? frontmatter.name : "";
        const description =
          typeof frontmatter.description === "string" ? frontmatter.description : "";
        const metadata = frontmatter.metadata as Record<string, unknown> | undefined;

        files.push({
          id: `${projectEntry.name}/${name.replace(/\.md$/, "")}`,
          path: filePath,
          title: description || declaredName || name.replace(/\.md$/, ""),
          type:
            metadata && typeof metadata.type === "string" ? metadata.type : "memory",
          timestamp: "",
          body,
        });
      } catch (err) {
        console.warn(`graph: skipping unreadable memory note ${filePath}:`, err);
      }
    }
  }
  return files;
}

/**
 * Build the graph.
 *
 * A link to a name that no file carries is reported as broken rather than being
 * dropped. That is the whole point: a silently ignored link is a reference the
 * operator believes exists, and believing a note is connected when it is not is
 * worse than knowing it is orphaned.
 */
export function memoryGraph(transcriptsDir: string): MemoryGraph {
  const thoughts = loadMemoryFiles(transcriptsDir);

  const byName = new Map<string, string>();
  for (const thought of thoughts) {
    byName.set(normalizeName(linkNameFor(thought.path)), thought.id);
  }

  const nodes = new Map<string, GraphNode>();
  for (const thought of thoughts) {
    nodes.set(thought.id, {
      id: thought.id,
      name: linkNameFor(thought.path),
      title: thought.title,
      type: thought.type,
      timestamp: thought.timestamp,
      outbound: [],
      inbound: [],
      broken: [],
      orphan: true,
      leaf: true,
    });
  }

  const edges: Array<{ from: string; to: string }> = [];
  const brokenLinks: Array<{ from: string; target: string }> = [];

  for (const thought of thoughts) {
    const node = nodes.get(thought.id);
    if (!node) continue;

    for (const target of extractLinks(thought.body)) {
      const resolved = byName.get(normalizeName(target));
      // A self-link is not a connection; counting it would make an isolated
      // entry look linked and hide it from the orphan list.
      if (!resolved || resolved === thought.id) {
        if (!resolved) {
          node.broken.push(target);
          brokenLinks.push({ from: thought.id, target });
        }
        continue;
      }
      node.outbound.push(resolved);
      node.leaf = false;
      edges.push({ from: thought.id, to: resolved });

      const targetNode = nodes.get(resolved);
      if (targetNode) {
        targetNode.inbound.push(thought.id);
        targetNode.orphan = false;
      }
    }
  }

  const all = [...nodes.values()];
  const mostLinked = all.reduce<GraphNode | null>(
    (best, node) => (best === null || node.inbound.length > best.inbound.length ? node : best),
    null,
  );

  return {
    nodes: all.sort((a, b) => b.inbound.length - a.inbound.length || a.name.localeCompare(b.name)),
    edges,
    brokenLinks,
    orphans: all.filter((node) => node.orphan).map((node) => node.id),
    leaves: all.filter((node) => node.leaf).map((node) => node.id),
    stats: {
      entries: all.length,
      links: edges.length,
      brokenLinks: brokenLinks.length,
      orphans: all.filter((node) => node.orphan).length,
      leaves: all.filter((node) => node.leaf).length,
      mostLinkedCount: mostLinked?.inbound.length ?? 0,
      mostLinked: mostLinked && mostLinked.inbound.length > 0 ? mostLinked.id : null,
    },
  };
}
