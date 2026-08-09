import fs from "node:fs";
import { SourceMissingError } from "./config.js";

export const FRICTION_TYPES = [
  "Friction",
  "Resolution",
  "Notice",
  "Lesson",
  "Pattern",
  "Decision",
] as const;

export type FrictionType = (typeof FRICTION_TYPES)[number];

export type FrictionEntry = {
  date: string;
  type: FrictionType;
  text: string;
  supersedes: string | null;
  format: "pipe" | "section" | "table";
  raw: string;
  /** Friction entries only: open until a Resolution matches. */
  status?: "open" | "resolved";
  /** Friction entries only: the Resolution that closed it, when matched. */
  resolvedBy?: { date: string; text: string } | null;
  /** Resolution entries only: the Friction it closed, when matched. */
  resolves?: { date: string; text: string } | null;
  /**
   * Friction entries only. Days the entry has been open, or took to close.
   *
   * The status field says whether a loop closed; this says how long it stayed
   * open, which is the part that applies pressure. A log where every entry is
   * eventually resolved still says nothing about whether resolutions arrive in a
   * day or a quarter.
   */
  ageDays?: number;
  /**
   * Coarse band for an open entry, so a list can be sorted by urgency without the
   * reader doing arithmetic on dates.
   */
  ageBand?: "today" | "week" | "month" | "quarter" | "stale";
};

/** Day boundaries for the age bands above. */
const AGE_BANDS: Array<{ band: NonNullable<FrictionEntry["ageBand"]>; maxDays: number }> = [
  { band: "today", maxDays: 1 },
  { band: "week", maxDays: 7 },
  { band: "month", maxDays: 31 },
  { band: "quarter", maxDays: 92 },
];

function bandFor(ageDays: number): NonNullable<FrictionEntry["ageBand"]> {
  for (const { band, maxDays } of AGE_BANDS) {
    if (ageDays <= maxDays) return band;
  }
  return "stale";
}

/**
 * Annotate Friction entries with how long they have been open, or took to close.
 *
 * Measured against the resolution for a closed entry and against now for an open
 * one, so the two numbers mean different things and the status field is what
 * distinguishes them. An unparseable date yields no age rather than a zero: zero
 * would read as "opened today", which is the opposite of what a missing date means.
 */
export function annotateAges(entries: FrictionEntry[], now = Date.now()): void {
  for (const entry of entries) {
    if (entry.type !== "Friction") continue;
    const openedAt = Date.parse(entry.date);
    if (Number.isNaN(openedAt)) continue;

    const closedAt = entry.resolvedBy ? Date.parse(entry.resolvedBy.date) : Number.NaN;
    const until = Number.isNaN(closedAt) ? now : closedAt;
    const ageDays = Math.max(Math.floor((until - openedAt) / 86_400_000), 0);

    entry.ageDays = ageDays;
    if (entry.status === "open") entry.ageBand = bandFor(ageDays);
  }
}

export type FrictionAging = {
  openCount: number;
  resolvedCount: number;
  /** Open entries by band, oldest band first, so pressure is visible. */
  openByBand: Array<{ band: string; count: number }>;
  /** Longest-open unresolved entry's age, the headline number. */
  oldestOpenDays: number;
  /** Median days to close, over entries that did close. */
  medianDaysToResolve: number;
  /**
   * Share of Friction entries that ever closed, 0-1.
   *
   * The operator's own framing: friction captured without resolution is a
   * knowledge base, not a world model. This is that ratio.
   */
  resolutionRate: number;
};

/** Aggregate aging figures over a parsed, linked, annotated log. */
export function frictionAging(entries: FrictionEntry[]): FrictionAging {
  const frictions = entries.filter((entry) => entry.type === "Friction");
  const open = frictions.filter((entry) => entry.status === "open");
  const resolved = frictions.filter((entry) => entry.status === "resolved");

  const byBand = new Map<string, number>();
  let oldestOpenDays = 0;
  for (const entry of open) {
    if (entry.ageBand) byBand.set(entry.ageBand, (byBand.get(entry.ageBand) ?? 0) + 1);
    if (entry.ageDays !== undefined) {
      oldestOpenDays = Math.max(oldestOpenDays, entry.ageDays);
    }
  }

  const closeDurations = resolved
    .map((entry) => entry.ageDays)
    .filter((days): days is number => days !== undefined)
    .sort((a, b) => a - b);

  // Band order is fixed rather than sorted by count, so the list always reads
  // oldest-first and a growing tail is visible at a glance.
  const bandOrder = ["stale", "quarter", "month", "week", "today"];

  return {
    openCount: open.length,
    resolvedCount: resolved.length,
    openByBand: bandOrder
      .filter((band) => byBand.has(band))
      .map((band) => ({ band, count: byBand.get(band)! })),
    oldestOpenDays,
    medianDaysToResolve:
      closeDurations.length > 0
        ? closeDurations[Math.floor(closeDurations.length / 2)]!
        : 0,
    resolutionRate: frictions.length > 0 ? resolved.length / frictions.length : 0,
  };
}

const TYPE_SET = new Set<string>(FRICTION_TYPES);

function isKnownType(t: string): t is FrictionType {
  return TYPE_SET.has(t);
}

/** Pull a trailing "supersedes: ..." off an entry text (with or without a pipe). */
function splitSupersedes(text: string): { text: string; supersedes: string | null } {
  const m = text.match(/(?:\|\s*)?supersedes:\s*(.+)\s*$/i);
  if (!m) return { text: text.trim(), supersedes: null };
  return {
    text: text.slice(0, m.index).replace(/\|\s*$/, "").trim(),
    supersedes: m[1]!.trim(),
  };
}

/**
 * Parse the friction log's three accreted line formats into one entry shape:
 *  1. pipe-triple:  ISO_TS | [Type] | text [| supersedes: ...]
 *  2. section:      "## YYYY-MM-DD - heading" then "[Type] text" paragraphs
 *  3. table row:    | YYYY-MM-DD | Type | scope | note |
 * Unknown lines never crash the parser; they are skipped (or appended to the
 * preceding section-format entry as paragraph continuation).
 */
export function parseFrictionLog(raw: string): FrictionEntry[] {
  const entries: FrictionEntry[] = [];
  let sectionDate: string | null = null;
  let lastSectionEntry: FrictionEntry | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      lastSectionEntry = null;
      continue;
    }

    // Format 1: pipe-triple with a leading ISO timestamp.
    const pipe = trimmed.match(
      /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*\|\s*\[(\w+)\]\s*\|\s*(.+)$/,
    );
    if (pipe && isKnownType(pipe[2]!)) {
      const { text, supersedes } = splitSupersedes(pipe[3]!);
      entries.push({
        date: pipe[1]!,
        type: pipe[2] as FrictionType,
        text,
        supersedes,
        format: "pipe",
        raw: trimmed,
      });
      lastSectionEntry = null;
      continue;
    }

    // Format 3: markdown table row | date | Type | scope | note |
    if (trimmed.startsWith("|")) {
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const dateCell = cells[0] ?? "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateCell) && cells.length >= 4) {
        const typeCell = cells[1] ?? "";
        if (isKnownType(typeCell)) {
          const scope = cells[2] ?? "";
          const note = cells.slice(3).join(" | ");
          const { text, supersedes } = splitSupersedes(
            scope ? `(${scope}) ${note}` : note,
          );
          entries.push({
            date: dateCell,
            type: typeCell,
            text,
            supersedes,
            format: "table",
            raw: trimmed,
          });
        }
      }
      lastSectionEntry = null;
      continue; // header/separator/unknown table rows are skipped
    }

    // Format 2: "## YYYY-MM-DD - heading" opens a dated section.
    const section = trimmed.match(/^##\s+(\d{4}-\d{2}-\d{2})\b/);
    if (section) {
      sectionDate = section[1]!;
      lastSectionEntry = null;
      continue;
    }

    // "[Type] text" paragraph inside a dated section.
    const para = trimmed.match(/^\[(\w+)\]\s*(.+)$/);
    if (para && isKnownType(para[1]!) && sectionDate) {
      const { text, supersedes } = splitSupersedes(para[2]!);
      const entry: FrictionEntry = {
        date: sectionDate,
        type: para[1] as FrictionType,
        text,
        supersedes,
        format: "section",
        raw: trimmed,
      };
      entries.push(entry);
      lastSectionEntry = entry;
      continue;
    }

    // Paragraph continuation for the preceding section-format entry.
    if (lastSectionEntry && !trimmed.startsWith("#")) {
      const merged = splitSupersedes(`${lastSectionEntry.text} ${trimmed}`);
      lastSectionEntry.text = merged.text;
      if (merged.supersedes) lastSectionEntry.supersedes = merged.supersedes;
      lastSectionEntry.raw += `\n${trimmed}`;
    }
  }

  return entries;
}

const STOPWORDS = new Set([
  "about", "after", "again", "before", "being", "below", "between",
  "cannot", "could", "doing", "during", "each", "every", "first", "should",
  "their", "there", "these", "thing", "those", "through", "under", "until",
  "where", "which", "while", "would",
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !STOPWORDS.has(w)),
  );
}

function dateTokens(text: string): Set<string> {
  return new Set(text.match(/\d{4}-\d{2}-\d{2}/g) ?? []);
}

function quotedPhrases(text: string): string[] {
  return (text.match(/"([^"]{4,})"/g) ?? []).map((s) => s.slice(1, -1));
}

function entryMs(e: FrictionEntry): number {
  const ms = Date.parse(e.date);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Deterministic Friction <-> Resolution matching. Deterministic, not fuzzy or
 * model-assisted, so the same log always yields the same timeline:
 *  Rule 1 (supersedes token match): R.supersedes shares with F.text a
 *    YYYY-MM-DD date token (F's own date counts), a quoted phrase, or >= 3
 *    content words (length >= 5, lowercased, stopwords removed). Among
 *    qualifying candidates the closest preceding unmatched Friction wins.
 *  Rule 2 (nearest-following fallback): each remaining Friction matches the
 *    earliest unmatched Resolution within `windowDays` after it.
 * False positives are acceptable in v1; the rule is deterministic.
 */
export function linkResolutions(
  entries: FrictionEntry[],
  windowDays: number,
): void {
  // Walk both lists oldest-first, with file order as the tiebreaker. The log's
  // three formats interleave, so file order is not chronological order; without
  // this sort "closest preceding" and "earliest following" below would silently
  // mean "last in the file" and "first in the file" instead.
  const byTime = (
    a: { e: FrictionEntry; i: number },
    b: { e: FrictionEntry; i: number },
  ) => entryMs(a.e) - entryMs(b.e) || a.i - b.i;
  const frictions = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "Friction")
    .sort(byTime);
  const resolutions = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "Resolution")
    .sort(byTime);

  const matchedFrictions = new Set<number>();
  const matchedResolutions = new Set<number>();

  // Rule 1: supersedes token match.
  for (const { e: res, i: ri } of resolutions) {
    if (!res.supersedes) continue;
    const supDates = dateTokens(res.supersedes);
    const supWords = contentWords(res.supersedes);
    const supQuotes = quotedPhrases(res.supersedes);

    let best: { fi: number } | null = null;
    for (const { e: fr, i: fi } of frictions) {
      if (matchedFrictions.has(fi)) continue;
      // "preceding": earlier in time, or same timestamp but earlier in file.
      const precedes =
        entryMs(fr) < entryMs(res) ||
        (entryMs(fr) === entryMs(res) && fi < ri);
      if (!precedes) continue;

      const frDates = new Set([...dateTokens(fr.text), ...dateTokens(fr.date)]);
      const dateHit = [...supDates].some((d) => frDates.has(d));
      const quoteHit = supQuotes.some((qp) => fr.text.includes(qp));
      const frWords = contentWords(fr.text);
      let shared = 0;
      for (const w of supWords) if (frWords.has(w)) shared++;
      const wordHit = shared >= 3;

      if (dateHit || quoteHit || wordHit) {
        best = { fi }; // candidates arrive oldest-first; the last one wins
      }
    }
    if (best) {
      matchedFrictions.add(best.fi);
      matchedResolutions.add(ri);
      const fr = entries[best.fi]!;
      fr.status = "resolved";
      fr.resolvedBy = { date: res.date, text: res.text };
      res.resolves = { date: fr.date, text: fr.text };
    }
  }

  // Rule 2: nearest-following Resolution within the window.
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  for (const { e: fr, i: fi } of frictions) {
    if (matchedFrictions.has(fi)) continue;
    for (const { e: res, i: ri } of resolutions) {
      if (matchedResolutions.has(ri)) continue;
      const follows =
        entryMs(res) > entryMs(fr) ||
        (entryMs(res) === entryMs(fr) && ri > fi);
      if (!follows) continue;
      if (entryMs(res) - entryMs(fr) > windowMs) continue;
      matchedFrictions.add(fi);
      matchedResolutions.add(ri);
      fr.status = "resolved";
      fr.resolvedBy = { date: res.date, text: res.text };
      res.resolves = { date: fr.date, text: fr.text };
      break;
    }
    if (!matchedFrictions.has(fi)) {
      fr.status = "open";
      fr.resolvedBy = null;
    }
  }
}

export type FrictionQuery = {
  type?: string;
  status?: "open" | "resolved";
};

/** Read + parse + link the real friction log; newest first. */
export function readFrictionLog(
  logPath: string,
  windowDays: number,
  query: FrictionQuery = {},
): FrictionEntry[] {
  if (!fs.existsSync(logPath)) {
    throw new SourceMissingError("friction log", logPath);
  }
  const raw = fs.readFileSync(logPath, "utf8");
  const entries = parseFrictionLog(raw);
  linkResolutions(entries, windowDays);
  annotateAges(entries);

  let out = entries;
  if (query.type) {
    out = out.filter((e) => e.type.toLowerCase() === query.type!.toLowerCase());
  }
  if (query.status) {
    out = out.filter((e) => e.type === "Friction" && e.status === query.status);
  }
  // Reverse-chronological, file order as tiebreaker (stable sort).
  return [...out].sort((a, b) => entryMs(b) - entryMs(a));
}
