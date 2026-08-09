import fs from "node:fs";
import path from "node:path";
import { expandHome, SourceMissingError } from "./config.js";

/**
 * What instruction text is already in the window before the operator types.
 *
 * Every always-loaded instruction file is paid for on every single turn of every
 * single session, and nothing on screen says how much it costs. Claude Code will
 * warn once a memory file gets large, which means there is a line worth watching;
 * this turns that standing invisible cost into a figure that can be watched.
 *
 * The whole correctness question in this module is WHAT COUNTS. Four distinctions
 * carry it, and getting any of them wrong produces a confidently wrong number:
 *
 * 1. A skill does NOT auto-load its body. Only its identity - the name and the
 *    description from its frontmatter - is surfaced so the model can decide
 *    whether to reach for it. On a real machine the bodies are more than forty
 *    times the identity text, so counting them would not be a rounding error; it
 *    would be the wrong answer by an order of magnitude.
 * 2. An instruction file inside the working directory's own subtree only loads
 *    once that subtree is entered. It is a real cost, but a conditional one, so it
 *    is counted and labelled separately rather than folded into the standing total.
 * 3. The same file can be reachable by two routes - the global instruction path is
 *    also `<home>/.claude/CLAUDE.md`, which the walk up the directory tree passes
 *    through - and counting it twice would double the headline number. Sources are
 *    de-duplicated by resolved path for exactly that reason.
 * 4. An instruction file can pull another file in with an `@path` line, and that
 *    file then loads on the same terms as the one that imported it. Those are
 *    followed and counted, because an always-loaded file missing from a total
 *    labelled "loaded in full on every session" is the one error this pillar
 *    cannot afford. An import that is deliberately not followed is reported as a
 *    count with its reason rather than dropped.
 *
 * A second rule runs through the whole module: a partial figure has to say it is
 * partial. Anywhere a file, a skill or a directory is passed over, the return
 * value carries a count of how many and why, and anywhere a bound cut a walk
 * short it carries a flag saying the number below it is a floor. A total that
 * reads complete while being partial is worse than no total.
 *
 * Nothing here reads a file's content into its return value. Paths, buckets and
 * counts only: an instruction file is the operator's own writing, and a budget
 * report has no need of the text to do its job.
 */

/**
 * Characters per token, for turning a character count into a token estimate.
 *
 * Four is the customary rule of thumb for English prose and it is an
 * approximation, not a measurement: real tokenisation depends on the tokeniser
 * and on the text, and instruction files are markdown full of punctuation and code
 * fences, which tokenise worse than prose. Every token figure in this module is
 * therefore an estimate derived from this one constant, and the character counts
 * beside them are the exact numbers. No tokeniser is bundled, so pretending to
 * more precision than this would be pretending.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * The size at which an instruction file is treated as too large.
 *
 * Claude Code raises its own "this file is large" warning once a memory file
 * passes forty thousand characters, and the operator keeps a soft cap at the same
 * number for that reason. The tool can raise its threshold for a bigger context
 * window, so holding the line at the lower figure errs toward warning early. It is
 * a convention either way, not a measurement of anything.
 */
export const SOFT_CEILING_CHARS = 40_000;

/**
 * Where to start warning, ahead of the ceiling.
 *
 * Two thousand characters of headroom is the operator's own earlier line, picked so
 * a file gets flagged while there is still room to trim it rather than at the
 * moment the tool itself complains. Also a convention.
 */
export const WARNING_CHARS = 38_000;

/**
 * How a source reaches the model.
 *
 * - `always`: loaded in full on every session that starts in this project.
 * - `conditional`: loaded in full, but only once its subtree is entered.
 * - `identity-only`: the body never loads; a name and a description are surfaced
 *   so the model can decide whether to ask for the rest.
 * - `unverified`: believed to be surfaced but not established from the files on
 *   disk. Kept out of every total on purpose - a number nobody can check does not
 *   belong inside one that can be.
 */
export type BudgetBucket = "always" | "conditional" | "identity-only" | "unverified";

export type InstructionKind =
  | "global-instructions"
  | "project-instructions"
  | "nested-project-instructions"
  | "imported-instructions"
  | "skill-identity"
  | "agent-identity";

export type CeilingStatus = "ok" | "warning" | "over";

export type InstructionSource = {
  /** What to call this row: a file's name, or a skill's or agent's own name. */
  label: string;
  path: string;
  kind: InstructionKind;
  bucket: BudgetBucket;
  /**
   * Characters, counted the way the tool that warns about size counts them: the
   * length of the decoded text, not bytes on disk. The two differ for any file
   * containing non-ASCII punctuation, and the character count is the one a token
   * estimate can be divided out of.
   */
  chars: number;
  estimatedTokens: number;
  /**
   * Ceiling comparison, for whole-file sources only; null for an identity row.
   *
   * The ceiling is a per-file convention. A single skill's description sitting
   * under it means nothing, so reporting a status there would invite the reader to
   * add up figures that were never meant to be added.
   */
  ceilingStatus: CeilingStatus | null;
};

/** Which side of the convention a single instruction file falls on. */
export function ceilingStatus(chars: number): CeilingStatus {
  if (chars >= SOFT_CEILING_CHARS) return "over";
  if (chars >= WARNING_CHARS) return "warning";
  return "ok";
}

function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

export type BucketTotal = {
  bucket: BudgetBucket;
  label: string;
  files: number;
  chars: number;
  estimatedTokens: number;
};

const BUCKET_LABELS: Record<BudgetBucket, string> = {
  always: "Loaded in full on every session",
  conditional: "Loaded in full once its subtree is entered",
  "identity-only": "Name and description only; body never auto-loads",
  unverified: "Surfacing not established from the files; excluded from totals",
};

export type AlwaysLoadedTotal = {
  files: number;
  chars: number;
  estimatedTokens: number;
  /**
   * The single biggest always-loaded file, which is what the ceiling is actually
   * about. `chars` above is the sum, and the sum has no ceiling to be measured
   * against - see `ceilingAppliesTo`.
   */
  largestFileChars: number;
  largestFilePath: string | null;
  /** Characters left on the largest file before it reaches the ceiling. */
  headroomOnLargestFile: number;
  /** Share of the ceiling used by the largest file, as a percentage. */
  percentOfCeilingLargestFile: number;
  /** Files between the warning line and the ceiling. */
  filesAtWarning: number;
  /** Files at or past the ceiling. */
  filesOverCeiling: number;
  /** The worst per-file status, NOT a comparison of the sum to the ceiling. */
  worstFileStatus: CeilingStatus;
  ceilingChars: number;
  warningChars: number;
  ceilingAppliesTo: string;
};

export type SkillBodiesExcluded = {
  files: number;
  /** Whole-file characters across those skills, frontmatter included. */
  chars: number;
  estimatedTokens: number;
  /** Identity characters actually counted, for the comparison below. */
  identityChars: number;
  /**
   * How many times larger the bodies are than the identity text. Null when there
   * are no skills, since a ratio over zero would be an invented number.
   */
  overstatementFactor: number | null;
};

/**
 * How many of something were passed over, and why.
 *
 * Every walk in this module reports one of these lists. A reason with a count of
 * zero is left out, so an empty list means nothing was passed over.
 */
export type SkipCount = { reason: string; count: number };

/** What the skill walk found, and what it could not count. */
export type SkillEnumerationReport = {
  /** Skills whose identity is in the identity-only bucket. */
  counted: number;
  /** Directories opened, after expanding any plugin store into its installs. */
  dirsScanned: number;
  /** Identity files and directories passed over, grouped by why. */
  skipped: SkipCount[];
  /**
   * True when a skills walk stopped at its depth bound, which makes `counted` a
   * floor rather than a count.
   */
  depthTruncated: boolean;
};

/** What the agent walk found, and what it could not count. */
export type AgentEnumerationReport = {
  counted: number;
  /** Agent files passed over, grouped by why. */
  skipped: SkipCount[];
};

/**
 * What the walk below the working directory covered.
 *
 * Both bounds turn the conditional bucket into a floor, and a reader cannot tell
 * a complete count from a truncated one unless the payload says which it is.
 */
export type NestedWalkReport = {
  maxDepth: number;
  dirLimit: number;
  dirsVisited: number;
  /** Subdirectories never opened because the depth bound was reached. */
  skippedByDepth: number;
  /** Subdirectories never opened because the directory budget ran out. */
  skippedByDirLimit: number;
  /**
   * Directories that could not be read at all, so anything under them is unseen.
   * Distinct from the two bounds: nothing chose to stop here, permission did.
   */
  unreadableDirs: number;
  /**
   * True when a bound cut the walk short OR a directory could not be read, so the
   * conditional bucket is a floor rather than a count.
   */
  truncated: boolean;
};

/** What the `@path` import walk followed, and what it refused to. */
export type ImportReport = {
  /** Import references found in counted instruction files. */
  seen: number;
  /** Imported files added to the bucket of the file that imported them. */
  counted: number;
  /** References not counted, grouped by why. */
  skipped: SkipCount[];
  maxHops: number;
  maxFiles: number;
  /** True when a bound stopped the walk, so the import figure is a floor. */
  truncated: boolean;
};

export type InstructionBudgetResult = {
  sources: InstructionSource[];
  buckets: BucketTotal[];
  alwaysLoaded: AlwaysLoadedTotal;
  skillBodiesExcluded: SkillBodiesExcluded;
  skillEnumeration: SkillEnumerationReport;
  agentEnumeration: AgentEnumerationReport;
  nestedWalk: NestedWalkReport;
  imports: ImportReport;
  /** Optional inputs that were absent, named so their absence is visible. */
  missingSources: string[];
  charsPerToken: number;
  note: string;
};

export type InstructionBudgetOptions = {
  /** The global instruction file, loaded in full by every session. */
  globalInstructionPath: string;
  /** The working directory whose project instructions apply. */
  projectDir: string;
  /** Directories holding skills, whose frontmatter identity is surfaced. */
  skillRoots?: string[];
  /**
   * Agent definitions. Reported separately: see the `unverified` bucket.
   */
  agentsDir?: string;
  /** How deep to look for nested project instructions. */
  maxNestedDepth?: number;
};

/**
 * Instruction files a single directory can contribute.
 *
 * All three load in full when the directory is in scope. The `.local` variant is
 * the per-developer override that is not checked in, and the copy under `.claude/`
 * is the alternative location for the same project-level file; both are read the
 * same way as the plain one, so leaving either out would undercount.
 */
const MEMORY_FILENAMES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  path.join(".claude", "CLAUDE.md"),
];

/** Directories that never hold instruction files worth counting. */
const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
]);

/**
 * Read a file's text, or null when it is not a readable file.
 *
 * Text rather than a size stat because bytes and characters diverge on any file
 * with non-ASCII punctuation, and characters are the unit both the size
 * convention and the token estimate are expressed in. Callers keep the length and
 * the import lines; no text reaches the return value of this module.
 */
function readTextFile(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(`instruction-budget: cannot read ${filePath}:`, err);
    return null;
  }
}

/** True when the path is a file, following a symlink to decide. */
function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** True when the path is a directory, following a symlink to decide. */
function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function bump(counts: Map<string, number>, reason: string, by = 1): void {
  if (by <= 0) return;
  counts.set(reason, (counts.get(reason) ?? 0) + by);
}

/** Turn a reason tally into a stable list, biggest first, zeroes left out. */
function skipCounts(counts: Map<string, number>): SkipCount[] {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** What a backslash escape inside a double-quoted YAML scalar stands for. */
const DOUBLE_QUOTED_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  "0": "\0",
  '"': '"',
  "'": "'",
  "\\": "\\",
  "/": "/",
};

/**
 * Decode the escapes a double-quoted YAML scalar carries.
 *
 * The decoded string is what reaches the window, so it is what has to be measured.
 * A description writing an inner quote as `\"` pays for one character there rather
 * than two, and real descriptions on this machine contain enough of them to shift
 * a row by tens of characters. An escape this does not recognise is left as
 * written, because dropping a backslash on a guess would undercount instead.
 */
function decodeDoubleQuoted(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += char;
      continue;
    }
    const simple = DOUBLE_QUOTED_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      i += 1;
      continue;
    }
    // A numeric escape stands for one character; anything else stays as written.
    const width = next === "u" ? 4 : next === "x" ? 2 : 0;
    const digits = width > 0 ? value.slice(i + 2, i + 2 + width) : "";
    if (width > 0 && new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
      out += String.fromCodePoint(Number.parseInt(digits, 16));
      i += 1 + width;
      continue;
    }
    out += char + next;
    i += 1;
  }
  return out;
}

/**
 * Strip a matching pair of surrounding quotes from a frontmatter value, and
 * decode whatever the quoting escaped.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (first === '"' && trimmed.endsWith('"') && trimmed.length > 1) {
    return decodeDoubleQuoted(trimmed.slice(1, -1));
  }
  // A single-quoted scalar has exactly one escape: a doubled quote is one quote.
  if (first === "'" && trimmed.endsWith("'") && trimmed.length > 1) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * A YAML block-scalar header: `|` or `>`, with an optional explicit indentation
 * digit and an optional chomping indicator.
 */
const BLOCK_SCALAR_HEADER = /^([|>])([0-9]*)([-+]?)$/;

/** A line that starts a new frontmatter key rather than continuing a value. */
const KEY_LINE = /^\s*[A-Za-z0-9_.-]+\s*:/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * YAML's folded style: a single line break between two lines becomes a space, a
 * blank line stays a break, and a line indented past the block keeps its break.
 */
function foldLines(lines: string[]): string {
  let out = "";
  let afterText = false;
  for (const line of lines) {
    if (line === "") {
      out += "\n";
      afterText = false;
      continue;
    }
    if (afterText) out += line.startsWith(" ") ? `\n${line}` : ` ${line}`;
    else out += line;
    afterText = true;
  }
  return out;
}

/**
 * Read one frontmatter value, which may run past the line its key is on.
 *
 * Both of YAML's multi-line forms are handled, and handling them is the point of
 * this function. A description written as a block scalar (`description: >-` or
 * `description: |`) has nothing after the colon but the indicator itself, so
 * taking the rest of that one line yields two stray characters where a paragraph
 * belongs - a row that still reads as counted while nearly all of its text has
 * vanished. Chomping indicators are parsed off the header and then ignored,
 * because the value is trimmed before it is measured and the chomping modes
 * differ only in trailing newlines.
 *
 * Returns the index of the first line after the value, so the caller resumes
 * past a block body rather than reading it as more keys.
 */
function readFrontmatterValue(
  lines: string[],
  index: number,
  key: string,
): { value: string; next: number } {
  const line = lines[index] ?? "";
  const afterKey = line.slice(key.length + 1);
  const header = BLOCK_SCALAR_HEADER.exec(afterKey.trim());

  if (!header) {
    // A plain value can also be continued on the following indented lines, and
    // YAML folds that continuation into the same value. A line that looks like a
    // new key ends it; that heuristic is what lets this reader tolerate the
    // unquoted colons real definitions contain, which a strict parser rejects.
    const parts = [afterKey.trim()];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? "";
      if (next.trim() === "") break;
      if (indentOf(next) === 0) break;
      if (KEY_LINE.test(next)) break;
      // A comment is not part of the value. YAML drops it, so folding it in would
      // charge a definition for text that never reaches the model.
      if (next.trim().startsWith("#")) break;
      parts.push(next.trim());
    }
    return { value: unquote(parts.join(" ")), next: cursor };
  }

  const style = header[1];
  const explicitIndent = header[2] ? Number(header[2]) : null;
  const body: string[] = [];
  let cursor = index + 1;
  for (; cursor < lines.length; cursor += 1) {
    const next = lines[cursor] ?? "";
    if (next.trim() === "") {
      body.push("");
      continue;
    }
    // A line back at column zero is the next key, or the closing fence.
    if (indentOf(next) === 0) break;
    body.push(next);
  }
  const textLines = body.filter((entry) => entry !== "");
  const baseIndent =
    explicitIndent ??
    textLines.reduce(
      (least, entry) => Math.min(least, indentOf(entry)),
      Number.MAX_SAFE_INTEGER,
    );
  const stripped = body.map((entry) =>
    entry === "" ? "" : entry.slice(Math.min(baseIndent, indentOf(entry))),
  );
  const value = style === "|" ? stripped.join("\n") : foldLines(stripped);
  return { value: value.trim(), next: cursor };
}

/**
 * The identity a file's frontmatter declares, or null when it declares none.
 *
 * Only `name` and `description` are read; that pair is the whole of what gets
 * surfaced, so the count has to reflect it rather than the file it came from.
 *
 * Read key by key rather than parsed as YAML, and that is deliberate. Real agent
 * definitions on this machine put an unquoted colon inside the description ("Modes
 * - review: ..."), which a strict YAML parser rejects outright. Rejecting the file
 * would drop the agent from a count whose whole job is to say how many there are,
 * so the two fields are lifted off their own keys instead - including the
 * multi-line forms, which are the norm in real skill frontmatter and cost the
 * same in the window as an inline value.
 */
function parseFrontmatterIdentity(
  raw: string,
): { name: string; description: string } | null {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  // Only the frontmatter block is scanned. A body heading that happens to start
  // with "name:" is not frontmatter and must not be read as it.
  let end = lines.length;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }

  let name = "";
  let description = "";
  let cursor = 1;
  while (cursor < end) {
    const line = lines[cursor] ?? "";
    if (!name && line.startsWith("name:")) {
      const read = readFrontmatterValue(lines.slice(0, end), cursor, "name");
      name = read.value;
      cursor = read.next;
      continue;
    }
    if (!description && line.startsWith("description:")) {
      const read = readFrontmatterValue(lines.slice(0, end), cursor, "description");
      description = read.value;
      cursor = read.next;
      continue;
    }
    cursor += 1;
  }
  if (!name && !description) return null;
  return { name, description };
}

function frontmatterIdentity(
  filePath: string,
): { name: string; description: string } | null {
  const raw = readTextFile(filePath);
  if (raw === null) return null;
  return parseFrontmatterIdentity(raw);
}

/**
 * Characters of surfaced identity for one name and description.
 *
 * The two fields, and nothing else. Whatever separator or bullet the surrounding
 * list adds costs a few more characters per entry that this does not try to guess;
 * naming the rule is worth more than a fabricated allowance for formatting.
 */
export function identityChars(name: string, description: string): number {
  return name.length + description.length;
}

/**
 * Every directory whose instructions apply, outermost first.
 *
 * The chain runs from the filesystem root down to the working directory, because
 * an instruction file in any ancestor of the working directory loads in full too -
 * a CLAUDE.md sitting one level above a repo is as always-loaded as the repo's own.
 * Outermost first so that when the same file is reachable twice, the row that
 * survives de-duplication is the one from the broader scope.
 */
function ancestorChain(projectDir: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(projectDir);
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse();
}

/**
 * How many subdirectories the nested search will visit before it stops.
 *
 * A project directory is normally a repo and nowhere near this. The cap is here
 * because the working directory is configurable: pointed at a home directory it
 * would otherwise crawl everything the operator owns to find a handful of files.
 * Stopping loudly at a bound beats an unbounded walk.
 */
const MAX_NESTED_DIRS = 2000;

type NestedWalkState = {
  /** Directories left in the budget. */
  left: number;
  /** Directories actually opened. */
  visited: number;
  /** Directories never opened because the depth bound was reached. */
  skippedByDepth: number;
  /** Directories never opened because the budget ran out. */
  skippedByDirLimit: number;
  /** Directories that could not be read, so their subtree was never seen. */
  unreadableDirs: number;
};

/**
 * Subdirectories of a root, bounded in depth and in count, excluding the root.
 *
 * Symlinked directories are not followed. `readdirSync` reports a symlink as a
 * symlink rather than as the directory it points at, so this is the default rather
 * than a check, and it is what keeps a link back up the tree from looping.
 *
 * Both bounds count what they cut off. Whatever the walk does not reach is a
 * nested instruction file the conditional bucket does not include, and the caller
 * has to be able to say so rather than print a total that looks complete.
 */
function walkDirectories(
  root: string,
  depth: number,
  state: NestedWalkState,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // A directory the process cannot read may hold an instruction file, so the
    // conditional bucket becomes a floor exactly as it does past either bound.
    // Returning an empty list without saying so let `truncated` claim a complete
    // count over a subtree that was never opened.
    state.unreadableDirs += 1;
    console.warn(`instruction-budget: skipping unreadable ${root}:`, err);
    return [];
  }
  const children = entries
    .filter((entry) => entry.isDirectory())
    // Hidden directories are skipped as a class, and the one that can hold an
    // instruction file is picked up by name from its parent instead.
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => !SKIPPED_DIR_NAMES.has(entry.name))
    .map((entry) => path.join(root, entry.name));

  if (depth <= 0) {
    // Counted rather than assumed: a tree that simply ends at the bound has
    // nothing left to visit, and reporting that as truncation would cry wolf.
    state.skippedByDepth += children.length;
    return [];
  }

  const out: string[] = [];
  for (let i = 0; i < children.length; i += 1) {
    if (state.left <= 0) {
      state.skippedByDirLimit += children.length - i;
      return out;
    }
    const child = children[i] as string;
    state.left -= 1;
    state.visited += 1;
    out.push(child, ...walkDirectories(child, depth - 1, state));
  }
  return out;
}

function nestedDirectories(
  root: string,
  depth: number,
): { dirs: string[]; report: NestedWalkReport } {
  const state: NestedWalkState = {
    left: MAX_NESTED_DIRS,
    visited: 0,
    skippedByDepth: 0,
    skippedByDirLimit: 0,
    unreadableDirs: 0,
  };
  const dirs = walkDirectories(root, depth, state);
  const truncated =
    state.skippedByDepth > 0 ||
    state.skippedByDirLimit > 0 ||
    state.unreadableDirs > 0;
  if (truncated) {
    // Loud rather than silent: past either bound the conditional bucket is a
    // floor rather than a count, and a reader has to know which of the two it is.
    // The report field carries the same fact to an API consumer, which stderr
    // cannot reach.
    console.warn(
      `instruction-budget: nested walk under ${root} stopped early ` +
        `(${state.skippedByDepth} directories below the depth bound of ${depth}, ` +
        `${state.skippedByDirLimit} past the ${MAX_NESTED_DIRS}-directory bound); ` +
        `nested instruction files inside them are not counted`,
    );
  }
  return {
    dirs,
    report: {
      maxDepth: depth,
      dirLimit: MAX_NESTED_DIRS,
      dirsVisited: state.visited,
      skippedByDepth: state.skippedByDepth,
      skippedByDirLimit: state.skippedByDirLimit,
      unreadableDirs: state.unreadableDirs,
      truncated,
    },
  };
}

/**
 * Collects sources while refusing to count the same file twice.
 *
 * De-duplication is on the resolved real path, not the string, because the routes
 * to one file genuinely differ: the global instruction file is also reachable as
 * `<home>/.claude/CLAUDE.md` on the walk up the tree, and a symlinked instruction
 * file is reachable under both its names. Either would double the headline figure.
 */
class SourceCollector {
  private readonly seen = new Set<string>();
  readonly sources: InstructionSource[] = [];

  private identity(filePath: string): string {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }

  /**
   * Returns true when the file was counted, false when it was already counted
   * under another name. The character count is passed in because the caller has
   * already read the text to look for imports, and reading it twice to measure it
   * would double the work on every file.
   */
  addFile(
    filePath: string,
    kind: InstructionKind,
    bucket: BudgetBucket,
    chars: number,
    label?: string,
  ): boolean {
    const key = this.identity(filePath);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.sources.push({
      label: label ?? path.basename(filePath),
      path: filePath,
      kind,
      bucket,
      chars,
      estimatedTokens: estimateTokens(chars),
      ceilingStatus: ceilingStatus(chars),
    });
    return true;
  }

  addIdentity(
    filePath: string,
    kind: InstructionKind,
    bucket: BudgetBucket,
    label: string,
    chars: number,
  ): void {
    this.sources.push({
      label,
      path: filePath,
      kind,
      bucket,
      chars,
      estimatedTokens: estimateTokens(chars),
      // Deliberately null: see the field's own reasoning.
      ceilingStatus: null,
    });
  }
}

/**
 * How many hops of `@path` imports to follow.
 *
 * An import can import, so the chain needs a bound; five is the documented depth
 * the loader itself stops at. A chain cut off here is reported rather than
 * dropped.
 */
const MAX_IMPORT_HOPS = 5;

/**
 * How many imported files to follow in total.
 *
 * One instruction file listing hundreds of imports is not a shape worth reading
 * to the end, and an unbounded fan-out would make this pillar's cost depend on
 * somebody else's file. Anything past the bound is counted as skipped.
 */
const MAX_IMPORT_FILES = 200;

type ImportWalkState = {
  seen: number;
  counted: number;
  skips: Map<string, number>;
};

/**
 * The `@path` references on a page, in the order they appear.
 *
 * Code is excluded: a fenced block or an inline span showing the syntax is
 * documentation of an import, not one. The token has to look like a path - it
 * contains a separator or ends in an extension - so an address or a package
 * handle written in prose does not become a phantom import.
 */
function importTargets(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const scanned = line.replace(/`[^`]*`/g, " ");
    for (const match of scanned.matchAll(/(?:^|\s)@(\S+)/g)) {
      const target = (match[1] ?? "").replace(/[),.;:'"]+$/, "");
      if (!target) continue;
      const looksLikePath = target.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(target);
      if (!looksLikePath) continue;
      out.push(target);
    }
  }
  return out;
}

/**
 * Where an import points, or null when it points somewhere this will not follow.
 *
 * A relative target resolves against the directory of the file that wrote it,
 * which is what the loader does. One case is refused: a relative target that
 * climbs out of the importing file's own directory. Following it would let one
 * instruction file walk this reader anywhere on the disk, and a refusal that is
 * counted is honest where a silent one is not. A target given as an absolute or
 * home-relative path is followed, because it names a location outright rather
 * than climbing to one.
 */
function resolveImport(target: string, importerPath: string): string | null {
  const expanded = expandHome(target);
  if (path.isAbsolute(expanded)) return expanded;
  const base = path.dirname(path.resolve(importerPath));
  const resolved = path.resolve(base, expanded);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/**
 * Follow the imports of one file, adding each imported file to the same bucket.
 *
 * An imported file loads on the terms of the file that imported it: pulled in by
 * an always-loaded file it is always loaded, pulled in by a nested one it is
 * conditional. Every reference that does not become a row is counted with its
 * reason, so `seen` minus `counted` is always accounted for.
 */
function followImports(
  collector: SourceCollector,
  importerPath: string,
  importerText: string,
  bucket: BudgetBucket,
  hopsLeft: number,
  state: ImportWalkState,
): void {
  const targets = importTargets(importerText);
  if (targets.length === 0) return;
  state.seen += targets.length;
  if (hopsLeft <= 0) {
    bump(state.skips, "beyond-import-hop-bound", targets.length);
    return;
  }
  for (const target of targets) {
    if (state.counted >= MAX_IMPORT_FILES) {
      bump(state.skips, "beyond-import-file-bound");
      continue;
    }
    const resolved = resolveImport(target, importerPath);
    if (resolved === null) {
      bump(state.skips, "outside-importing-directory");
      continue;
    }
    const text = readTextFile(resolved);
    if (text === null) {
      // Either the import names a file that is not there, or the line was prose
      // that looked like one. Both are reported the same way, because this cannot
      // tell them apart and guessing would be the silent half of the problem.
      bump(state.skips, "import-target-not-a-readable-file");
      continue;
    }
    if (!collector.addFile(resolved, "imported-instructions", bucket, text.length)) {
      bump(state.skips, "already-counted-under-another-name");
      continue;
    }
    state.counted += 1;
    followImports(collector, resolved, text, bucket, hopsLeft - 1, state);
  }
}

/** Add one whole instruction file and everything it imports. */
function addFileWithImports(
  collector: SourceCollector,
  filePath: string,
  kind: InstructionKind,
  bucket: BudgetBucket,
  imports: ImportWalkState,
  label?: string,
): "counted" | "absent" | "already-counted" {
  const text = readTextFile(filePath);
  if (text === null) return "absent";
  if (!collector.addFile(filePath, kind, bucket, text.length, label)) {
    return "already-counted";
  }
  followImports(collector, filePath, text, bucket, MAX_IMPORT_HOPS, imports);
  return "counted";
}

/**
 * Claude Code's record of which plugins are installed and where each one lives.
 *
 * A plugin store cannot be walked directly. It keeps every version ever
 * downloaded under `cache/` and a second copy of each marketplace repo under
 * `marketplaces/`, so a plain walk finds the same skill several times over with
 * nothing but path order to choose between the copies. This manifest is the only
 * thing on disk that says which copy is the live one.
 */
const INSTALLED_PLUGINS = "installed_plugins.json";

/** Only the fields this module reads; the manifest carries more. */
type InstalledPlugins = {
  plugins?: Record<string, Array<{ installPath?: string }>>;
};

/** A directory to scan, with the namespace its skills are surfaced under. */
type SkillScanDir = { dir: string; plugin: string | null };

/**
 * How deep a skills directory is walked.
 *
 * One level is not enough: a plugin may group its skills into category
 * subdirectories, so the identity file can sit two or three levels down.
 */
const MAX_SKILL_DEPTH = 8;

type SkillWalkState = {
  dirsScanned: number;
  depthStops: number;
  skips: Map<string, number>;
  visited: Set<string>;
};

/**
 * Tell a plugin store apart from a plain directory of skills, by structure rather
 * than by name, so the configured roots can point anywhere.
 */
function isPluginStore(root: string): boolean {
  return (
    fs.existsSync(path.join(root, INSTALLED_PLUGINS)) ||
    fs.existsSync(path.join(root, "cache")) ||
    fs.existsSync(path.join(root, "marketplaces"))
  );
}

/** Expand a plugin store into one scan directory per installed plugin. */
function pluginScanDirs(
  store: string,
  missingSources: string[],
  state: SkillWalkState,
): SkillScanDir[] {
  const manifestPath = path.join(store, INSTALLED_PLUGINS);
  const text = readTextFile(manifestPath);
  if (text === null) {
    // Without the manifest there is no way to tell a live install from a
    // superseded copy, so the plugin half of this count is absent rather than
    // zero, and it names the file that would have answered.
    missingSources.push(manifestPath);
    return [];
  }
  let manifest: InstalledPlugins;
  try {
    manifest = JSON.parse(text) as InstalledPlugins;
  } catch (err) {
    // Degrading here would drop every plugin skill from a total that still reads
    // as complete, which is the failure this module exists to avoid.
    throw new Error(`instruction-budget: cannot parse ${manifestPath}: ${err}`);
  }

  const dirs: SkillScanDir[] = [];
  for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
    // Manifest keys are `<plugin>@<marketplace>`, and the plugin half is the
    // namespace a skill of that plugin is surfaced under.
    const plugin = key.split("@")[0];
    if (!plugin) continue;
    for (const install of installs ?? []) {
      const installPath = install?.installPath;
      if (!installPath) continue;
      if (!isDirectory(installPath)) {
        bump(state.skips, "plugin-install-directory-missing");
        continue;
      }
      // A plugin ships commands, agents and hooks beside its skills; only
      // `skills/` holds identity files that are surfaced as skills.
      const dir = path.join(installPath, "skills");
      if (!isDirectory(dir)) continue;
      dirs.push({ dir, plugin });
    }
  }
  return dirs.sort(
    (a, b) => (a.plugin ?? "").localeCompare(b.plugin ?? "") || a.dir.localeCompare(b.dir),
  );
}

/** Subdirectories of a skills directory, following symlinks to decide. */
function skillChildDirs(dir: string, state: SkillWalkState): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`instruction-budget: cannot list ${dir}:`, err);
    bump(state.skips, "unreadable-skill-directory");
    return [];
  }
  const out: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const child = path.join(dir, entry.name);
    // The type comes from a stat that follows the link, not from the directory
    // entry. A skill kept in another repo and linked into the skills directory is
    // a skill the tool surfaces, and an entry for a symlink reports itself as a
    // symlink rather than as the directory it points at - so testing the entry
    // drops that skill from the count with nothing said.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(child);
    } catch {
      if (entry.isSymbolicLink()) bump(state.skips, "broken-symlink");
      continue;
    }
    if (!stat.isDirectory()) continue;
    out.push(child);
  }
  return out;
}

/**
 * Identity files under one skills directory.
 *
 * A directory that has its own SKILL.md IS one skill, and the walk stops there.
 * Whatever sits below it - a variant copy, a reference, an example - is that
 * skill's own material rather than a second installed skill, and counting those
 * as skills adds identity text the tool never surfaces.
 */
function skillFilesUnder(
  dir: string,
  depth: number,
  state: SkillWalkState,
): string[] {
  const own = path.join(dir, "SKILL.md");
  if (isFile(own)) return [own];

  const children = skillChildDirs(dir, state);
  if (depth <= 0) {
    if (children.length > 0) {
      state.depthStops += children.length;
      bump(state.skips, "skill-directory-below-depth-bound", children.length);
    }
    return [];
  }

  state.dirsScanned += 1;
  const out: string[] = [];
  for (const child of children) {
    let real: string;
    try {
      real = fs.realpathSync(child);
    } catch {
      real = path.resolve(child);
    }
    // A link back up the tree would otherwise walk forever.
    if (state.visited.has(real)) {
      bump(state.skips, "directory-already-visited");
      continue;
    }
    state.visited.add(real);
    out.push(...skillFilesUnder(child, depth - 1, state));
  }
  return out;
}

type SkillIdentityRow = {
  slashCommand: string;
  name: string;
  description: string;
  path: string;
};

/**
 * Every skill whose identity is surfaced, with everything passed over counted.
 *
 * This walk is the module's own rather than the skill catalog's, because a budget
 * makes a stricter claim than a catalog: the number it prints is the whole claim,
 * so a skill missing from it and a skill invented for it are both wrong answers
 * rather than cosmetic ones. Three rules decide the figure - a symlinked skill
 * directory is a skill, an identity file nested inside another skill's directory
 * is not a second skill, and a plugin store is expanded through its manifest
 * rather than walked - and each of them changes the total.
 *
 * A configured root that does not exist is named in `missingSources` before
 * anything else happens. Letting one absent root shrink the bucket while the
 * report still reads complete is the same failure as any other silent drop, and
 * it hides the most likely cause of all: a mistyped path.
 */
function enumerateSkillIdentities(
  skillRoots: string[],
  missingSources: string[],
): { rows: SkillIdentityRow[]; report: SkillEnumerationReport } {
  const state: SkillWalkState = {
    dirsScanned: 0,
    depthStops: 0,
    skips: new Map(),
    visited: new Set(),
  };

  const scanDirs: SkillScanDir[] = [];
  for (const root of skillRoots) {
    if (!isDirectory(root)) {
      missingSources.push(root);
      continue;
    }
    if (isPluginStore(root)) {
      scanDirs.push(...pluginScanDirs(root, missingSources, state));
    } else {
      scanDirs.push({ dir: root, plugin: null });
    }
  }

  const byCommand = new Map<string, SkillIdentityRow>();
  for (const { dir, plugin } of scanDirs) {
    for (const filePath of skillFilesUnder(dir, MAX_SKILL_DEPTH, state).sort()) {
      const identity = frontmatterIdentity(filePath);
      // A skill with no name field is surfaced under its directory's name, which
      // is what the tool does with it too.
      const name = identity?.name.trim() || path.basename(path.dirname(filePath));
      const description = identity?.description.trim() ?? "";
      if (!description) {
        // The description is what gets surfaced, so a skill without one
        // contributes nothing to count. It is still a file that was passed over,
        // and the reader is told how many of those there were.
        bump(state.skips, "no-description-in-frontmatter");
        continue;
      }
      // The leading slash is what the operator types; a plugin's skills are
      // namespaced, so /<plugin>:<name>.
      const bare = name.replace(/^\//, "");
      const slashCommand = plugin === null ? `/${bare}` : `/${plugin}:${bare}`;
      if (byCommand.has(slashCommand)) {
        // Two files claiming one command: only one of them can be reached, so
        // only one is counted. Deterministic order decides which.
        bump(state.skips, "duplicate-slash-command");
        continue;
      }
      byCommand.set(slashCommand, {
        slashCommand,
        name,
        description,
        path: filePath,
      });
    }
  }

  const rows = [...byCommand.values()];
  return {
    rows,
    report: {
      counted: rows.length,
      dirsScanned: state.dirsScanned,
      skipped: skipCounts(state.skips),
      depthTruncated: state.depthStops > 0,
    },
  };
}

/** Skill identity rows, plus the body figure that is being left out. */
function addSkillIdentity(
  collector: SourceCollector,
  rows: SkillIdentityRow[],
): SkillBodiesExcluded {
  let bodyChars = 0;
  let identityTotal = 0;
  for (const skill of rows) {
    const chars = identityChars(skill.name, skill.description);
    identityTotal += chars;
    collector.addIdentity(
      skill.path,
      "skill-identity",
      "identity-only",
      skill.slashCommand,
      chars,
    );
    bodyChars += readTextFile(skill.path)?.length ?? 0;
  }

  return {
    files: rows.length,
    chars: bodyChars,
    estimatedTokens: estimateTokens(bodyChars),
    identityChars: identityTotal,
    overstatementFactor:
      identityTotal > 0
        ? Math.round((bodyChars / identityTotal) * 10) / 10
        : null,
  };
}

/**
 * Agent definitions, in a bucket of their own.
 *
 * An agent file declares a name and a description in the same shape a skill does,
 * and the description exists so something can pick between agents. Whether it is
 * surfaced on every session or only when agent dispatch comes up is not a question
 * the files on disk can answer, and guessing wrong in either direction would
 * corrupt a total that is otherwise checkable. So the figure is reported and kept
 * out of every sum until somebody establishes which it is.
 */
function addAgentIdentity(
  collector: SourceCollector,
  agentsDir: string,
): AgentEnumerationReport {
  const skips = new Map<string, number>();
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir);
  } catch (err) {
    console.warn(`instruction-budget: cannot list ${agentsDir}:`, err);
    bump(skips, "unreadable-agents-directory");
    return { counted: 0, skipped: skipCounts(skips) };
  }
  let counted = 0;
  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const filePath = path.join(agentsDir, entry);
    const identity = frontmatterIdentity(filePath);
    if (!identity) {
      // No frontmatter identity means nothing to surface, but a file passed over
      // is still worth a count: it is the difference between "no agents declare
      // this" and "this reader could not read them".
      bump(skips, "no-frontmatter-identity");
      continue;
    }
    collector.addIdentity(
      filePath,
      "agent-identity",
      "unverified",
      identity.name || path.basename(entry, ".md"),
      identityChars(identity.name, identity.description),
    );
    counted += 1;
  }
  return { counted, skipped: skipCounts(skips) };
}

function bucketTotals(sources: InstructionSource[]): BucketTotal[] {
  const order: BudgetBucket[] = [
    "always",
    "conditional",
    "identity-only",
    "unverified",
  ];
  return order.map((bucket) => {
    const rows = sources.filter((source) => source.bucket === bucket);
    const chars = rows.reduce((sum, source) => sum + source.chars, 0);
    return {
      bucket,
      label: BUCKET_LABELS[bucket],
      files: rows.length,
      chars,
      estimatedTokens: estimateTokens(chars),
    };
  });
}

/**
 * Summarise the always-loaded rows against the size convention.
 *
 * Per file, deliberately. The convention is a per-file one, so comparing the sum
 * of every always-loaded file to it would report a machine as over the line the
 * moment it has two comfortable files - a global instruction file at
 * thirty-five thousand characters and a project one at eleven thousand sum past
 * forty thousand while neither is anywhere near it. The sum is still worth having,
 * because it is what the context actually pays; it just is not the thing the
 * ceiling measures, and the field names have to say so.
 */
function summariseAlwaysLoaded(sources: InstructionSource[]): AlwaysLoadedTotal {
  const rows = sources.filter((source) => source.bucket === "always");
  const chars = rows.reduce((sum, source) => sum + source.chars, 0);
  const largest = rows.reduce<InstructionSource | null>(
    (worst, source) => (worst === null || source.chars > worst.chars ? source : worst),
    null,
  );
  const largestChars = largest?.chars ?? 0;
  const filesOverCeiling = rows.filter(
    (source) => source.ceilingStatus === "over",
  ).length;
  const filesAtWarning = rows.filter(
    (source) => source.ceilingStatus === "warning",
  ).length;

  return {
    files: rows.length,
    chars,
    estimatedTokens: estimateTokens(chars),
    largestFileChars: largestChars,
    largestFilePath: largest?.path ?? null,
    headroomOnLargestFile: Math.max(0, SOFT_CEILING_CHARS - largestChars),
    percentOfCeilingLargestFile:
      Math.round((largestChars / SOFT_CEILING_CHARS) * 1000) / 10,
    filesAtWarning,
    filesOverCeiling,
    worstFileStatus:
      filesOverCeiling > 0 ? "over" : filesAtWarning > 0 ? "warning" : "ok",
    ceilingChars: SOFT_CEILING_CHARS,
    warningChars: WARNING_CHARS,
    ceilingAppliesTo:
      "each instruction file on its own, not the sum of them. Two files well " +
      "under the ceiling can sum past it without either one being too large.",
  };
}

const NOTE =
  "Counts only text that auto-loads. Skill bodies do not: a skill contributes its " +
  "name and description so the model can decide relevance, and the bodies are " +
  "reported separately to show the size of the difference. A file pulled in by an " +
  "@path import line lands in the same bucket as the file that imported it, up to " +
  "a bounded number of hops; every import not followed is counted with its reason " +
  "in the import report, so no always-loaded file goes missing without saying so. " +
  "Agent descriptions sit in their own bucket and are in no total, because whether " +
  "they are surfaced every session cannot be established from the files. " +
  "Organisation-managed policy, glob-gated rule files, and auto-memory are not " +
  "read, so a machine using those carries more than this reports. Identity is " +
  "counted as a name plus a description for every skill found, which is an upper " +
  "bound: an entry surfaced by name alone costs less than that. Where a walk hit a " +
  "bound, the report says so and the figure below it is a floor. Token figures are " +
  "estimates from a fixed characters-per-token assumption, not a tokeniser.";

/**
 * What instruction text is already loaded before the operator types a word.
 *
 * Returns one row per contributing source with its character count, a token
 * estimate, and which bucket it loads in; plus the always-loaded total and how the
 * files behind it stand against the size convention. No file's content appears in
 * the result.
 */
export function instructionBudget(
  opts: InstructionBudgetOptions,
): InstructionBudgetResult {
  // An empty project directory would resolve to whatever directory the process
  // happens to be in, and the walk up the tree from there would report a budget
  // for somewhere nobody asked about. A caller that does not know its project
  // directory should hear about it rather than get a plausible wrong answer.
  if (!opts.projectDir.trim()) {
    throw new Error("instructionBudget: projectDir is required");
  }
  const globalInstructionPath = expandHome(opts.globalInstructionPath);
  const projectDir = expandHome(opts.projectDir);
  const skillRoots = (opts.skillRoots ?? []).map(expandHome);
  const agentsDir = opts.agentsDir ? expandHome(opts.agentsDir) : null;
  const maxNestedDepth = opts.maxNestedDepth ?? 8;

  const collector = new SourceCollector();
  const missingSources: string[] = [];
  const importState: ImportWalkState = { seen: 0, counted: 0, skips: new Map() };

  // First, so it keeps its own label when the walk up the tree reaches the same
  // file by its other name.
  const globalOutcome = addFileWithImports(
    collector,
    globalInstructionPath,
    "global-instructions",
    "always",
    importState,
  );
  if (globalOutcome === "absent") missingSources.push(globalInstructionPath);

  // The working directory and every ancestor of it: all always loaded.
  for (const dir of ancestorChain(projectDir)) {
    for (const name of MEMORY_FILENAMES) {
      addFileWithImports(
        collector,
        path.join(dir, name),
        "project-instructions",
        "always",
        importState,
      );
    }
  }

  // Below the working directory: real cost, but only once that subtree is entered.
  const nested = nestedDirectories(projectDir, maxNestedDepth);
  for (const dir of nested.dirs) {
    for (const name of MEMORY_FILENAMES) {
      addFileWithImports(
        collector,
        path.join(dir, name),
        "nested-project-instructions",
        "conditional",
        importState,
        path.relative(projectDir, path.join(dir, name)),
      );
    }
  }

  // With no instruction file anywhere, this pillar has nothing to report and says
  // so by naming the paths. Returning an empty budget would read as "you have no
  // instructions loaded", which for any real install is a false claim.
  if (!collector.sources.some((source) => source.bucket === "always")) {
    throw new SourceMissingError(
      "instruction budget",
      `${globalInstructionPath}, ${projectDir}`,
    );
  }

  const skills = enumerateSkillIdentities(skillRoots, missingSources);
  const skillBodiesExcluded = addSkillIdentity(collector, skills.rows);

  let agentEnumeration: AgentEnumerationReport = { counted: 0, skipped: [] };
  if (agentsDir) {
    if (fs.existsSync(agentsDir)) {
      agentEnumeration = addAgentIdentity(collector, agentsDir);
    } else {
      missingSources.push(agentsDir);
    }
  }

  // Biggest first within a bucket: the rows worth trimming are the ones on top.
  const bucketRank: Record<BudgetBucket, number> = {
    always: 0,
    conditional: 1,
    "identity-only": 2,
    unverified: 3,
  };
  const sources = [...collector.sources].sort(
    (a, b) => bucketRank[a.bucket] - bucketRank[b.bucket] || b.chars - a.chars,
  );

  const importSkips = skipCounts(importState.skips);
  return {
    sources,
    buckets: bucketTotals(sources),
    alwaysLoaded: summariseAlwaysLoaded(sources),
    skillBodiesExcluded,
    skillEnumeration: skills.report,
    agentEnumeration,
    nestedWalk: nested.report,
    imports: {
      seen: importState.seen,
      counted: importState.counted,
      skipped: importSkips,
      maxHops: MAX_IMPORT_HOPS,
      maxFiles: MAX_IMPORT_FILES,
      truncated: importSkips.some(
        (skip) =>
          skip.reason === "beyond-import-hop-bound" ||
          skip.reason === "beyond-import-file-bound",
      ),
    },
    missingSources,
    charsPerToken: CHARS_PER_TOKEN,
    note: NOTE,
  };
}
