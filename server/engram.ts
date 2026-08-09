import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import MiniSearch from "minisearch";
import { SourceMissingError } from "./config.js";

export type ThoughtSummary = {
  id: string;
  title: string;
  type: string;
  timestamp: string;
  snippet: string;
  /**
   * The vault's own one-line summary, written by hand when the entry was
   * captured. This is the most readable text an entry has and it costs nothing to
   * surface: no model, no algorithm, just a field that was already there.
   * Empty when the entry has no such field.
   */
  description: string;
};

export type ThoughtFull = ThoughtSummary & {
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
};

type VaultFile = {
  filePath: string;
  typeDir: string;
};

/**
 * Collect all markdown thought files under <vault>/thoughts/<type>/. A vault
 * root that exists but has no thoughts/ dir yet is an empty vault, not a
 * misconfiguration - only a missing root is reported as a missing source.
 */
function listVaultFiles(vaultRoot: string): VaultFile[] {
  const thoughtsDir = path.join(vaultRoot, "thoughts");
  if (!fs.existsSync(thoughtsDir)) return [];
  const out: VaultFile[] = [];
  for (const typeEntry of fs.readdirSync(thoughtsDir, { withFileTypes: true })) {
    if (!typeEntry.isDirectory()) continue;
    const typeDir = path.join(thoughtsDir, typeEntry.name);
    for (const f of fs.readdirSync(typeDir)) {
      if (f.endsWith(".md")) {
        out.push({ filePath: path.join(typeDir, f), typeDir: typeEntry.name });
      }
    }
  }
  return out;
}

/** Filename shape: <YYYYMMDDHHMMSS>-<slug>-<hash>.md; timestamp fallback source. */
function timestampFromFilename(fileName: string): string | null {
  const m = fileName.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** Slug between the timestamp prefix and the trailing hash segment. */
function slugFromFilename(fileName: string): string {
  const stem = fileName.replace(/\.md$/, "");
  const parts = stem.split("-");
  // drop leading 14-digit timestamp and trailing hex hash when present
  if (parts.length > 2 && /^\d{14}$/.test(parts[0] ?? "")) parts.shift();
  if (parts.length > 1 && /^[0-9a-f]{8,}$/.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  return parts.join(" ").trim();
}

/**
 * Thoughts have NO title field; derive from the first non-empty body line
 * (preferred, richer) with the filename slug as fallback.
 */
function deriveTitle(body: string, fileName: string): string {
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine) {
    const clean = firstLine.replace(/^#+\s*/, "").trim();
    return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
  }
  const slug = slugFromFilename(fileName);
  return slug || fileName;
}

function parseThought(vf: VaultFile): ThoughtFull | null {
  try {
    const rawText = fs.readFileSync(vf.filePath, "utf8");
    const { data, content } = matter(rawText);
    const fm = data as Record<string, unknown>;
    const fileName = path.basename(vf.filePath);
    const body = content.trim();
    const timestamp =
      typeof fm.created_at === "string"
        ? fm.created_at
        : (timestampFromFilename(fileName) ?? "");
    return {
      id: typeof fm.id === "string" ? fm.id : fileName,
      title: deriveTitle(body, fileName),
      type: typeof fm.prefix === "string" ? fm.prefix : vf.typeDir,
      timestamp,
      snippet: body.slice(0, 200),
      description: typeof fm.description === "string" ? fm.description : "",
      frontmatter: fm,
      body,
      path: vf.filePath,
    };
  } catch (err) {
    // Malformed frontmatter or unreadable file: skip + log, never crash.
    console.warn(`engram: skipping unparseable thought ${vf.filePath}:`, err);
    return null;
  }
}

export type ListOptions = {
  q?: string;
  type?: string;
  limit?: number;
  offset?: number;
};

function loadAll(vaultRoot: string): ThoughtFull[] {
  if (!fs.existsSync(vaultRoot)) {
    throw new SourceMissingError("engram vault", vaultRoot);
  }
  return listVaultFiles(vaultRoot)
    .map(parseThought)
    .filter((t): t is ThoughtFull => t !== null)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

function toSummary(thought: ThoughtFull): ThoughtSummary {
  return {
    id: thought.id,
    title: thought.title,
    type: thought.type,
    timestamp: thought.timestamp,
    snippet: thought.snippet,
    description: thought.description,
  };
}

/**
 * Rank thoughts against a query.
 *
 * Substring matching used to do this, which meant a search only ever found the
 * exact characters typed: a singular query missed a plural entry, a typo found
 * nothing, and a hit in a passing mention of a word ranked the same as one in the
 * title. Ranked search fixes all three. Title and description are boosted above
 * the body because they are where an entry says what it is about, and prefix
 * matching makes a partial word useful while the entry is still being typed.
 *
 * The corpus is small enough that indexing per request costs milliseconds, so
 * there is no stale-index problem to manage: an entry edited on disk is searchable
 * on the next request.
 */
function searchThoughts(thoughts: ThoughtFull[], query: string): ThoughtFull[] {
  const index = new MiniSearch<ThoughtFull>({
    fields: ["title", "description", "body"],
    storeFields: ["id"],
    idField: "id",
    searchOptions: {
      boost: { title: 3, description: 2 },
      prefix: true,
      // Edit distance scaled to the term's own length, so a short word is matched
      // strictly and only a longer one tolerates a slip. A flat distance would
      // make three-letter queries match almost anything.
      fuzzy: 0.2,
      // Every term must match. The default is to match any of them, which makes a
      // query worse the more precise you try to be: "zzz-no-such-term" splits on
      // the hyphens and its common fragments match most of the vault, so a query
      // for something absent returns nearly everything instead of nothing.
      // Requiring all terms keeps the obvious contract - more words, fewer
      // results - and lets a query that genuinely matches nothing say so.
      combineWith: "AND",
    },
  });
  index.addAll(thoughts);

  const byId = new Map(thoughts.map((thought) => [thought.id, thought]));
  const ranked: ThoughtFull[] = [];
  for (const result of index.search(query)) {
    const thought = byId.get(String(result.id));
    if (thought) ranked.push(thought);
  }
  return ranked;
}

/**
 * List thought summaries. Newest first when browsing; by relevance when a query
 * is given, because ordering search results by date buries the best match.
 */
export function listThoughts(
  vaultRoot: string,
  opts: ListOptions = {},
): ThoughtSummary[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  let all = loadAll(vaultRoot);

  if (opts.type) {
    const t = opts.type.toLowerCase();
    all = all.filter((th) => th.type.toLowerCase() === t);
  }
  if (opts.q && opts.q.trim()) {
    all = searchThoughts(all, opts.q.trim());
  }

  return all.slice(offset, offset + limit).map(toSummary);
}

/** Fetch one thought by frontmatter id. Returns null when absent (-> 404). */
export function getThought(vaultRoot: string, id: string): ThoughtFull | null {
  return loadAll(vaultRoot).find((t) => t.id === id) ?? null;
}

/**
 * Every thought in full, newest first, in one pass.
 *
 * Exists because reading the vault entry by entry is quadratic: each `getThought`
 * re-reads every file in the vault, by design, so that an edit on disk is always
 * visible. That is the right trade for a single lookup serving one request, and
 * the wrong one for a caller that wants all of them - at five hundred entries it
 * turned a no-op index sync into fifteen seconds of re-reading. A caller that
 * needs the whole vault should ask for it once.
 */
export function allThoughts(vaultRoot: string): ThoughtFull[] {
  return loadAll(vaultRoot);
}

/** Distinct thought types present in the vault (for the UI filter). */
export function listThoughtTypes(vaultRoot: string): string[] {
  return [...new Set(loadAll(vaultRoot).map((t) => t.type))].sort();
}
