import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { SourceMissingError } from "./config.js";

export type WrapSummary = {
  id: string;
  date: string;
  title: string;
  description: string;
  path: string;
};

export type WrapFull = WrapSummary & {
  frontmatter: Record<string, unknown>;
  body: string;
  sections: Partial<Record<"shipped" | "learned" | "friction" | "parked", string>>;
};

/** Filename shape: session_wrap_YYYY_MM_DD_<slug>.md */
const WRAP_RE = /^session_wrap_(\d{4})_(\d{2})_(\d{2})_(.+)\.md$/;

function requireWrapsDir(wrapsDir: string): void {
  if (!fs.existsSync(wrapsDir)) {
    throw new SourceMissingError("wraps dir", wrapsDir);
  }
}

function listWrapFiles(wrapsDir: string): string[] {
  return fs
    .readdirSync(wrapsDir)
    .filter((f) => WRAP_RE.test(f))
    .map((f) => path.join(wrapsDir, f));
}

/** Title from the body heading "# Session Wrap: <date> - <title>", slug fallback. */
function deriveTitle(body: string, slug: string): string {
  const heading = body.match(/^#\s+Session Wrap:\s*(.+)$/m);
  if (heading) {
    const h = heading[1]!.trim();
    // strip the leading date portion when present: "2026-06-05 - Title"
    const dashSplit = h.match(/^\d{4}-\d{2}-\d{2}\s*[-–—]\s*(.+)$/);
    return dashSplit ? dashSplit[1]!.trim() : h;
  }
  return slug.replace(/_/g, " ");
}

/**
 * Best-effort split of the wrap body into Shipped / Learned / Friction /
 * PARKED sections. Wrap headings vary (## headings or **bold** markers), and
 * the files are hand-written, so the split is best-effort by design: showing
 * an unsplit body beats dropping a wrap that used an unanticipated heading.
 */
function splitSections(body: string): WrapFull["sections"] {
  const sections: WrapFull["sections"] = {};
  const keys = ["shipped", "learned", "friction", "parked"] as const;
  // Match "## Shipped", "**Shipped ...:**" or "Shipped:" style markers.
  const markerRe =
    /^(?:#{1,4}\s*|\*\*)\s*(shipped|learned|friction|parked)\b[^\n]*$/gim;
  const hits: { key: (typeof keys)[number]; index: number }[] = [];
  for (const m of body.matchAll(markerRe)) {
    hits.push({
      key: m[1]!.toLowerCase() as (typeof keys)[number],
      index: m.index!,
    });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i]!.index;
    const end = i + 1 < hits.length ? hits[i + 1]!.index : body.length;
    // First marker of each kind wins; later duplicates are ignored.
    if (!(hits[i]!.key in sections)) {
      sections[hits[i]!.key] = body.slice(start, end).trim();
    }
  }
  return sections;
}

function parseWrap(filePath: string): WrapFull | null {
  try {
    const fileName = path.basename(filePath);
    const m = fileName.match(WRAP_RE)!;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const slug = m[4]!;
    const { data, content } = matter(fs.readFileSync(filePath, "utf8"));
    const fm = data as Record<string, unknown>;
    const body = content.trim();
    return {
      id: fileName.replace(/\.md$/, ""),
      date,
      title: deriveTitle(body, slug),
      description: typeof fm.description === "string" ? fm.description : "",
      path: filePath,
      frontmatter: fm,
      body,
      sections: splitSections(body),
    };
  } catch (err) {
    console.warn(`wraps: skipping unparseable wrap ${filePath}:`, err);
    return null;
  }
}

/** List wrap summaries, newest first (date, then filename for stability). */
export function listWraps(wrapsDir: string): WrapSummary[] {
  requireWrapsDir(wrapsDir);
  return listWrapFiles(wrapsDir)
    .map(parseWrap)
    .filter((w): w is WrapFull => w !== null)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1))
    .map(({ id, date, title, description, path: p }) => ({
      id,
      date,
      title,
      description,
      path: p,
    }));
}

/** Fetch one wrap by filename stem. Returns null when absent (-> 404). */
export function getWrap(wrapsDir: string, id: string): WrapFull | null {
  requireWrapsDir(wrapsDir);
  // id is a filename stem; reject any path separators outright.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  const filePath = path.join(wrapsDir, `${id}.md`);
  if (!fs.existsSync(filePath) || !WRAP_RE.test(path.basename(filePath))) {
    return null;
  }
  return parseWrap(filePath);
}
