/**
 * Sentence segmentation and markdown stripping for developer prose.
 *
 * The obvious splitter - a run of non-terminators followed by one or more of
 * `.` `!` `?` - is wrong for this corpus. These notes are saturated with
 * filenames, dotted version numbers, IP addresses and prices, so on a
 * five-sentence sample mentioning CLAUDE.md, config.json, 127.0.0.1 and
 * v24.2.0 that splitter yields fourteen fragments instead of five. Every
 * ranking, scoring and summarising step downstream reads whatever this module
 * returns, so a bad split here is not a cosmetic problem: it silently corrupts
 * results that still look plausible.
 *
 * The fix that does most of the work is one rule: a terminator only ends a
 * sentence when whitespace follows it. Every token in the list above keeps a
 * non-space character right after its dot, so all of them survive intact
 * without needing a pattern of their own. Abbreviations and ellipses are the
 * cases that rule cannot catch, and they get explicit handling below.
 *
 * Both functions are pure and synchronous: no I/O, no state, no dependencies.
 */

/** Sentence-ending punctuation. */
const TERMINATOR_CHARS = new Set([".", "!", "?"]);

/**
 * Punctuation allowed between the terminator and the following space, so that
 * `He said "done." Then left.` is two sentences rather than one.
 */
const CLOSING_CHARS = new Set([
  '"',
  "'",
  "”", // right double quotation mark
  "’", // right single quotation mark
  ")",
  "]",
  "}",
  "»", // right-pointing double angle quotation mark
]);

/**
 * Punctuation allowed to sit in front of the capital that opens the next
 * sentence, so a quoted or parenthesised sentence still starts a new one.
 */
const OPENING_CHARS = new Set([
  '"',
  "'",
  "“", // left double quotation mark
  "‘", // left single quotation mark
  "(",
  "[",
  "{",
  "«", // left-pointing double angle quotation mark
]);

/**
 * Abbreviations whose trailing period is not a sentence end. Stored lowercased
 * and with the period so the lookup is one exact match against the token that
 * precedes the terminator. "al." covers "et al." - only the final token is
 * checked, so the multi-word form needs no special case.
 *
 * A fixed list has a known failure: a sentence that genuinely ends in "etc."
 * runs into the next one. That is the cheaper of the two errors. A merged pair
 * still reads as the author's own words, while splitting inside "e.g." emits a
 * fragment that is not a sentence at all and pollutes every ranking that sees
 * it.
 */
const ABBREVIATIONS = new Set([
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "fig.",
  "approx.",
  "cf.",
  "al.",
  // Multi-dot forms need no handling of their own. Their inner dots are each
  // followed by a letter, so the whitespace rule already keeps them out of the
  // boundary test, and the backward token scan below walks over dots as well as
  // letters, so "p.m." is recovered whole rather than as its final "m".
  "a.m.",
  "p.m.",
  "u.k.",
  "u.s.",
  "ph.d.",
  // Company suffixes. "Owned by Example Inc. Nobody else has a stake." is one
  // sentence plus one fragment without these.
  "inc.",
  "ltd.",
  "co.",
  "corp.",
  // Street, as in "Turn onto Elm St. Then park."
  "st.",
]);

/**
 * Abbreviations spelled the same as an ordinary English word, so the period
 * only fails to end a sentence when a number follows it: "Check ticket No. 42"
 * is one sentence, while "The answer is no. Then we shipped it." is two. Listing
 * these unconditionally above would merge the second shape, which is the
 * commoner one in prose.
 */
const NUMBER_LABEL_ABBREVIATIONS = new Set(["no.", "nos."]);

/**
 * A blank line ends a sentence even with no terminator in sight. Headings,
 * bullets and table rows in these notes frequently carry no final period, and
 * `stripMarkdownSyntax` relies on this to keep a heading off the front of the
 * paragraph beneath it. Every character consumed here is whitespace, which is
 * what keeps the no-text-lost property true.
 */
const PARAGRAPH_BREAK_RE = /\n(?:[ \t]*\n)+/;

/** A capital letter or a digit, including non-ASCII capitals. */
const SENTENCE_OPENER_RE = /[\p{Lu}\p{Nd}]/u;

/** A digit, including non-ASCII digits. */
const DIGIT_RE = /\p{Nd}/u;

/** Only dots, three or more of them: a continuation marker, not a terminator. */
const ELLIPSIS_RE = /^\.{3,}$/;

/**
 * Split prose into sentences, preserving source order.
 *
 * Returns trimmed, non-empty sentences. No non-whitespace character is ever
 * dropped or reordered, so the concatenation of the result equals the input
 * once whitespace is normalised on both sides; `tests/text-sentences.test.ts`
 * asserts that property directly.
 *
 * Known limits, both deliberate: a sentence that starts with a lowercase word
 * (`Run the gate. npm run gate is the check.`) is not split, because requiring
 * a capital or digit is what keeps abbreviations and filenames whole; and a
 * sentence genuinely ending in a listed abbreviation merges with its successor.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const block of normaliseLineEndings(text).split(PARAGRAPH_BREAK_RE)) {
    for (const piece of splitBlock(block)) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) sentences.push(trimmed);
    }
  }
  return sentences;
}

/** Split one blank-line-free block at its internal sentence boundaries. */
function splitBlock(block: string): string[] {
  const pieces: string[] = [];
  let sentenceStart = 0;
  let cursor = 0;

  while (cursor < block.length) {
    if (!TERMINATOR_CHARS.has(block[cursor]!)) {
      cursor++;
      continue;
    }
    // Consume the whole run so "?!" and "..." are judged as single units.
    let runEnd = cursor;
    while (runEnd < block.length && TERMINATOR_CHARS.has(block[runEnd]!)) runEnd++;

    const boundary = findBoundary(block, cursor, runEnd);
    if (boundary === null) {
      cursor = runEnd;
      continue;
    }
    pieces.push(block.slice(sentenceStart, boundary.sentenceEnd));
    sentenceStart = boundary.nextStart;
    cursor = boundary.nextStart;
  }

  if (sentenceStart < block.length) pieces.push(block.slice(sentenceStart));
  return pieces;
}

type Boundary = {
  /** Index just past the terminator and any closing punctuation. */
  sentenceEnd: number;
  /** Index of the first character of the next sentence. */
  nextStart: number;
};

/**
 * Decide whether the terminator run at `[runStart, runEnd)` ends a sentence.
 * Returns null when it does not, which leaves the run inside the current
 * sentence.
 */
function findBoundary(block: string, runStart: number, runEnd: number): Boundary | null {
  const run = block.slice(runStart, runEnd);
  if (ELLIPSIS_RE.test(run)) return null;

  let sentenceEnd = runEnd;
  while (sentenceEnd < block.length && CLOSING_CHARS.has(block[sentenceEnd]!)) {
    sentenceEnd++;
  }
  // Nothing follows: the block already ends here, so there is nothing to cut.
  if (sentenceEnd >= block.length) return null;
  // No space after the terminator means it sits inside a token - a filename,
  // a version, an IP address, a decimal or a domain.
  if (!isWhitespace(block[sentenceEnd]!)) return null;

  let nextStart = sentenceEnd;
  while (nextStart < block.length && isWhitespace(block[nextStart]!)) nextStart++;
  if (nextStart >= block.length) return null;
  if (!opensSentence(block, nextStart)) return null;
  if (isAbbreviation(block, runStart, run, nextStart)) return null;

  return { sentenceEnd, nextStart };
}

/** True when the text at `position` looks like the start of a new sentence. */
function opensSentence(block: string, position: number): boolean {
  const char = block[skipOpeningChars(block, position)];
  return char !== undefined && SENTENCE_OPENER_RE.test(char);
}

/** True when a number follows at `position`, ignoring quotes and brackets. */
function opensWithNumber(block: string, position: number): boolean {
  const char = block[skipOpeningChars(block, position)];
  return char !== undefined && DIGIT_RE.test(char);
}

/**
 * Index of the first character at or after `position` that is not opening
 * punctuation, so a quoted or parenthesised follower is judged on its first
 * real character.
 */
function skipOpeningChars(block: string, position: number): number {
  let index = position;
  while (index < block.length && OPENING_CHARS.has(block[index]!)) index++;
  return index;
}

/**
 * True when the word ending at this period is a known abbreviation. The token
 * is read backwards over letters, digits and dots so that "e.g" is recovered
 * whole rather than just its final "g".
 *
 * `nextStart` is where the following sentence would begin; it decides the
 * number-label forms, which are abbreviations only when a number follows.
 */
function isAbbreviation(
  block: string,
  runStart: number,
  run: string,
  nextStart: number,
): boolean {
  if (run !== ".") return false;
  let tokenStart = runStart;
  while (tokenStart > 0 && isAbbreviationChar(block[tokenStart - 1]!)) tokenStart--;
  const token = block.slice(tokenStart, runStart + 1).toLowerCase();
  if (ABBREVIATIONS.has(token)) return true;
  return NUMBER_LABEL_ABBREVIATIONS.has(token) && opensWithNumber(block, nextStart);
}

function isAbbreviationChar(char: string): boolean {
  return char === "." || /[\p{L}\p{Nd}]/u.test(char);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/** Collapse CRLF and lone CR so line handling has one case to consider. */
function normaliseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** An opening or closing code fence, returned as the marker run itself. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** ATX heading; the text is optional so a bare "###" line is still a heading. */
const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/;

/** Closing hashes of a closed ATX heading ("## Title ##"). */
const HEADING_TRAILING_HASHES_RE = /[ \t]+#+[ \t]*$/;

/** Thematic break: three or more -, * or _ on a line of their own. */
const THEMATIC_BREAK_RE =
  /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * A line of nothing but `=`, or nothing but `-`. Under a title that is the
 * underline of a setext heading, and both characters need matching: left in the
 * text the underline glues the title to the paragraph below it and the run of
 * `=` ends up inside a sentence. Replacing the line with a blank line supplies
 * the boundary instead, and the title above needs no handling of its own because
 * an ordinary text line already comes out stripped and emitted correctly.
 *
 * No title is required above the line, because the same blank line is the right
 * answer wherever such a line appears: a run of `=` on its own is a divider, not
 * prose. That also makes the overlap with THEMATIC_BREAK_RE deliberate rather
 * than a conflict to resolve, since a dash underline and a dash rule cannot be
 * told apart and want the same output.
 */
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

/**
 * Delimiter row under a table header: one dash run per column, with optional
 * alignment colons. At least one pipe is required as well (checked by the
 * caller), which is what keeps a bare "---" beneath a paragraph a setext
 * underline instead of the opening of a table.
 */
const TABLE_DELIMITER_ROW_RE =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** One or more blockquote markers at the head of a line. */
const BLOCKQUOTE_RE = /^ {0,3}(?:>[ \t]?)+/;

/** Bullet marker. The trailing space is what makes it a marker. */
const BULLET_MARKER_RE = /^[ \t]*[-*+][ \t]+/;

/**
 * Ordered-list marker, capturing the number so a caller can judge whether the
 * line is really a list item. The trailing space is what makes it a marker,
 * which is also why "1.5 seconds elapsed" at line start is not one.
 */
const ORDERED_MARKER_RE = /^[ \t]*(\d{1,9})[.)][ \t]+/;

/** Task-list checkbox, which follows the bullet marker. */
const TASK_CHECKBOX_RE = /^\[[ xX]\][ \t]+/;

const IMAGE_RE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const INLINE_LINK_RE = /\[([^\]\n]*)\]\([^)\n]*\)/g;
const REFERENCE_LINK_RE = /\[([^\]\n]*)\]\[[^\]\n]*\]/g;
const CODE_SPAN_RE = /(`{1,2})([^`\n]*?)\1/g;
const BOLD_ITALIC_RE = /\*\*\*([^\s*][^*\n]*?)\*\*\*/g;
const BOLD_RE = /\*\*([^\s*][^*\n]*?)\*\*/g;
const ITALIC_RE = /\*([^\s*][^*\n]*?)\*/g;

/**
 * Underscore emphasis needs a boundary on both sides. Without it `some_var_name`
 * loses its middle underscores, and identifiers are everywhere in these notes.
 * The trailing boundary is a lookahead so it stays available to the next match.
 */
const UNDERSCORE_BOLD_RE = /(^|[\s([{"'])__([^\s_][^\n]*?)__(?=[\s)\]}"'.,;:!?]|$)/g;
const UNDERSCORE_ITALIC_RE = /(^|[\s([{"'])_([^\s_][^\n]*?)_(?=[\s)\]}"'.,;:!?]|$)/g;

/**
 * Strip markdown syntax down to the prose inside it, keeping link text and
 * inline-code text and dropping fenced code blocks and tables whole.
 *
 * Fenced blocks go because their content is not prose: it distorts readability
 * scores and, once ranked, surfaces a line of code as if the author had written
 * it as a sentence. Tables go for the same reason and one more. A cell is a
 * field value rather than a sentence, so counting it as one drags
 * words-per-sentence away from the surrounding prose; and the rows of a table
 * share vocabulary by construction, which is exactly the shape a centrality
 * ranker rewards, so keeping cell text hands the summariser a self-reinforcing
 * cluster of field values that outranks real sentences. Left in place entirely,
 * a table is worse still: it carries no terminator, so the whole thing collapses
 * into one pseudo-sentence full of pipe characters and gets selected as a
 * summary line. The cost of dropping tables is real and accepted: a table whose
 * cells hold whole prose sentences loses that prose.
 *
 * Blank lines are inserted where a heading, a bullet or a removed block ended,
 * because those are sentence boundaries that carry no terminator - a heading
 * glued to the paragraph under it produces one sentence that neither of them
 * actually says.
 *
 * The output is still markdown-shaped text, ready for `splitSentences`.
 */
export function stripMarkdownSyntax(text: string): string {
  const lines = normaliseLineEndings(text).split("\n");
  const outputLines: string[] = [];
  let openFence: string | null = null;
  // Whether the previous lines were a run of numbered items; see
  // isOrderedListItem for why a numbered line needs that context.
  let inOrderedRun = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = line.match(FENCE_RE)?.[1] ?? null;

    if (openFence !== null) {
      // A fence closes on the same character, repeated at least as many times.
      if (fence !== null && fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    if (fence !== null) {
      openFence = fence;
      outputLines.push("");
      inOrderedRun = false;
      continue;
    }

    // Blockquote markers come off before every block-level test below, because a
    // heading, a rule, a table or a list inside a quote is still that construct.
    // Testing for a heading first instead left "> ## Rule" as ordinary text and
    // put its hash marks inside a sentence. The fence test above deliberately
    // stays on the raw line: a fence opened inside a quote is not recognised,
    // which is a limit rather than a fix, because stripping the markers first
    // would also let a quoted fence line inside a real code block close it early.
    const body = stripBlockquoteMarkers(line);

    const tableEnd = tableEndIndex(lines, index);
    if (tableEnd !== null) {
      outputLines.push("");
      inOrderedRun = false;
      index = tableEnd;
      continue;
    }
    if (SETEXT_UNDERLINE_RE.test(body) || THEMATIC_BREAK_RE.test(body)) {
      // A rule and a heading underline are both dividers rather than sentences;
      // left in place they become "---" and "===" inside the prose.
      outputLines.push("");
      inOrderedRun = false;
      continue;
    }

    const heading = body.match(HEADING_RE);
    if (heading !== null) {
      const headingText = (heading[1] ?? "").replace(HEADING_TRAILING_HASHES_RE, "");
      outputLines.push(stripInline(headingText));
      outputLines.push("");
      inOrderedRun = false;
      continue;
    }

    const ordered = body.match(ORDERED_MARKER_RE);
    if (ordered !== null && isOrderedListItem(lines, index, Number(ordered[1]), inOrderedRun)) {
      inOrderedRun = true;
      pushListItem(outputLines, body.slice(ordered[0].length));
      continue;
    }
    const bullet = body.match(BULLET_MARKER_RE);
    if (bullet !== null) {
      inOrderedRun = false;
      pushListItem(outputLines, body.slice(bullet[0].length));
      continue;
    }

    // A left-aligned line of anything else ends a run of numbered items. Blank
    // lines and indented continuation lines do not, because a list with blank
    // lines between its items is still one list and a wrapped item carries no
    // marker of its own.
    if (body.trim().length > 0 && !/^[ \t]/.test(body)) inOrderedRun = false;
    outputLines.push(stripInline(body));
  }

  // An unterminated fence swallows the rest of the input, which is the safe
  // reading: the author opened a code block and never closed it.
  return outputLines.join("\n");
}

/**
 * Emit one list item. The blank line in front of it is the boundary:
 * consecutive items are separate statements and rarely end in a period, so
 * without it two of them merge into a sentence neither one says.
 */
function pushListItem(outputLines: string[], itemBody: string): void {
  outputLines.push("");
  outputLines.push(stripInline(itemBody.replace(TASK_CHECKBOX_RE, "")));
}

function stripBlockquoteMarkers(line: string): string {
  return line.replace(BLOCKQUOTE_RE, "");
}

/** The line at `index` with its blockquote markers removed, or null past the end. */
function bodyAt(lines: readonly string[], index: number): string | null {
  const line = lines[index];
  return line === undefined ? null : stripBlockquoteMarkers(line);
}

/**
 * Decide whether a numbered line is a list item or prose that merely opens with
 * a number. The distinction matters because removing the marker from prose
 * deletes text outright: "2026. That was the year the gate went green." came
 * back as "That was the year the gate went green." with the year gone, and
 * "42. Answers everything." lost its "42.".
 *
 * A marker is only removed when the line reads as part of a list: it is the
 * number a list starts on, it continues a run of items already accepted, or
 * another numbered item follows it. Everything else keeps its text, which is the
 * reading that can never delete a number the author wrote as prose.
 *
 * Two consequences of that choice, both accepted. A lone numbered line keeps its
 * number and therefore splits into a short "42." plus the rest, which is a
 * defensible reading of a line that starts with a standalone figure. And a
 * numbered line directly beneath a numbered list is read as that list's next
 * item - the same reading a markdown renderer gives it - so a paragraph opening
 * with a year in that position does lose the year.
 */
function isOrderedListItem(
  lines: readonly string[],
  index: number,
  markerNumber: number,
  inOrderedRun: boolean,
): boolean {
  if (markerNumber <= 1) return true;
  if (inOrderedRun) return true;
  return orderedSiblingFollows(lines, index);
}

/** True when another numbered item follows the line at `index`. */
function orderedSiblingFollows(lines: readonly string[], index: number): boolean {
  const next = bodyAt(lines, index + 1);
  if (next === null) return false;
  if (ORDERED_MARKER_RE.test(next)) return true;
  // A list with blank lines between its items puts exactly one blank line before
  // the sibling, so look one line past a single blank. Two blank lines mean a
  // new block rather than a sibling.
  if (next.trim().length > 0) return false;
  const afterBlank = bodyAt(lines, index + 2);
  return afterBlank !== null && ORDERED_MARKER_RE.test(afterBlank);
}

/**
 * Last line index of the markdown table starting at `start`, or null when no
 * table starts there.
 *
 * A row full of pipes is not proof of a table on its own: prose in these notes
 * contains pipes, from shell pipelines to "one | the other". A table is only
 * recognised when the delimiter row sits directly under the header, which is
 * what markdown itself requires, and it then runs for as long as the following
 * lines still carry a pipe.
 */
function tableEndIndex(lines: readonly string[], start: number): number | null {
  const header = bodyAt(lines, start);
  if (header === null || !header.includes("|")) return null;
  const delimiter = bodyAt(lines, start + 1);
  if (delimiter === null) return null;
  if (!delimiter.includes("|") || !TABLE_DELIMITER_ROW_RE.test(delimiter)) return null;

  let end = start + 1;
  for (;;) {
    const next = bodyAt(lines, end + 1);
    if (next === null || !next.includes("|")) return end;
    end++;
  }
}

/** Remove inline markdown markers from a single line, keeping the text. */
function stripInline(line: string): string {
  return line
    .replace(IMAGE_RE, "")
    .replace(INLINE_LINK_RE, "$1")
    .replace(REFERENCE_LINK_RE, "$1")
    .replace(CODE_SPAN_RE, "$2")
    .replace(BOLD_ITALIC_RE, "$1")
    .replace(BOLD_RE, "$1")
    .replace(ITALIC_RE, "$1")
    .replace(UNDERSCORE_BOLD_RE, "$1$2")
    .replace(UNDERSCORE_ITALIC_RE, "$1$2");
}
