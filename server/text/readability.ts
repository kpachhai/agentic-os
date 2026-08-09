import { splitSentences, stripMarkdownSyntax } from "./sentences.js";

/**
 * Flesch-Kincaid readability scoring, so that "plain language" is a mechanical
 * check rather than a judgement call. A gate can assert
 * `readabilityStats(digest).grade <= 9` and get the same answer on every
 * machine on every run; asking a model whether prose "reads plainly" gives a
 * different answer each time and cannot fail a build.
 *
 * The caveat below is implemented, not merely documented. Flesch-Kincaid was
 * calibrated on prose meant to be read aloud. Fed text dense with identifiers,
 * paths and URLs it still returns a tidy number that looks like a grade level
 * and is not one. Two concrete distortions:
 *
 *   - A path is a single whitespace-delimited "word" carrying a pile of vowel
 *     groups. `server/text/readability.ts` scores as one eight-syllable word,
 *     so syllables-per-word - the term the formula weights at 11.8 - jumps, and
 *     the reported grade climbs by years on the strength of a file name.
 *   - Code lines rarely end in sentence punctuation, so a run of them collapses
 *     into one enormous "sentence" and words-per-sentence inflates as well.
 *
 * The score would then move with formatting rather than with how hard the prose
 * is to read, while still printing as an authoritative "grade 17.4". So before
 * scoring, markdown syntax is stripped and code-shaped tokens are dropped, and
 * a passage that is nothing but code reports as having no prose at all rather
 * than as unreadable prose.
 *
 * Known biases, both upward. A plural "-es" is counted as a spoken syllable, so
 * "makes" scores 2 where a reader says 1; correcting it needs a sibilant test
 * that is wrong about as often as it is right ("boxes" and "sentences" really do
 * sound the ending; "notes" and "times" do not), so it is left alone. And the
 * hiatus rules below split some vowel pairs a reader merges, so "fruit",
 * "build", "cir-cuit", "an-cient" and "ef-fi-cient" each score one syllable
 * high.
 *
 * The direction of the error matters more than its size, because the two
 * directions fail differently. Undercounting lowers the reported grade, which
 * turns a gate into a rubber stamp: counting vowel groups alone scored "Being
 * quiet is a reliable idea in this area." at grade 4.96 on 13 syllables, where
 * the hand count is 18 and the grade 11.52, so `grade <= 9` passed prose that
 * reads at eleventh-grade level. Overcounting only makes the gate stricter than
 * it was asked to be. Individual words are therefore still allowed to come out
 * short - "cre-at-ed" and "ar-gu-a-ble" do - but the net error across the
 * hand-checked word table in `tests/text-readability.test.ts` is asserted to be
 * zero or positive, never negative.
 */

/**
 * Token shapes that mean "this is code, not prose". Each one is a reason a
 * syllable count would be meaningless: a path is not pronounced word by word,
 * a version string is not a word, an identifier is not English.
 */
const CODE_TOKEN_PATTERNS: readonly RegExp[] = [
  /[/\\]/, // a path or URL: server/text/readability.ts, https://example.test
  /_/, // a snake_case or __dunder__ identifier
  /::/, // a namespace or scope operator
  // An internal dot, which covers file extensions (config.json), member access
  // (fs.existsSync), version strings (18.0.5) and IPv4 literals (127.0.0.1).
  // A period that ends a sentence is not an internal dot, so ordinary words
  // keep their place in the count.
  /[A-Za-z0-9]\.[A-Za-z0-9]/,
  /^v\d+$/i, // a dotless version tag: v2
];

function isCodeToken(token: string): boolean {
  return CODE_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

/**
 * Reduce a raw token to letters, apostrophes and internal hyphens. NFKD
 * decomposition splits an accented letter into a base letter plus a combining
 * mark, so dropping the mark turns "café" into "cafe" instead of "caf".
 * Surrounding punctuation goes, so "readable," and "readable" count alike.
 * Returns "" for a token with no letters at all: a bare number has no
 * knowable syllable count ("1024" is spoken as six syllables, not four
 * digits), so counting it as a word would be a guess dressed up as data.
 */
function normalizeWord(token: string): string {
  const letters = token
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z'-]/g, "");
  const trimmed = letters.replace(/^['-]+/, "").replace(/['-]+$/, "");
  return /[a-z]/.test(trimmed) ? trimmed : "";
}

/**
 * Words whose final "e" is spoken, so the silent-e rule below must leave it
 * alone. Nothing in the spelling separates "re-ci-pe" from "ripe", so the
 * borrowings likely to appear in prose are listed rather than guessed at. The
 * list is short on purpose: a word missing from it loses one syllable, which is
 * the same error plain vowel-group counting already made, not a new one.
 */
const SPOKEN_FINAL_E = new Set([
  "recipe",
  "cafe",
  "apostrophe",
  "catastrophe",
  "epitome",
  "hyperbole",
  "finale",
]);

/**
 * Vowel pairs that are spoken as two syllables - hiatus - rather than as one
 * diphthong. Counting vowel groups alone merges every one of them ("re-li-a-ble"
 * comes out as three syllables, "i-de-a" as two), and each merge lowers the
 * reported grade, which is the direction that makes a readability gate pass text
 * it should fail.
 *
 * None of these pairs splits everywhere, so membership here only makes a pair
 * eligible; `splitsBetween` holds the tests that decide. "ea" is absent because
 * it is one sound far more often than two ("beat", "please", "great"), and its
 * two splitting shapes are tested directly instead.
 */
const HIATUS_PAIRS = new Set([
  "ia",
  "ie",
  "io",
  "iu",
  "ua",
  "ue",
  "ui",
  "uo",
  "eo",
]);

/** True for one letter that can head a syllable; "y" counts, as in "hap-py". */
function isVowelChar(char: string | undefined): boolean {
  return char !== undefined && char.length === 1 && "aeiouy".includes(char);
}

/**
 * True when a vowel appears before `index`. For a pair at the end of a word that
 * means the word has an earlier syllable, which is what separates "i-de-a" from
 * "sea".
 */
function hasVowelBefore(stem: string, index: number): boolean {
  for (let scan = 0; scan < index; scan++) {
    if (isVowelChar(stem[scan])) return true;
  }
  return false;
}

/**
 * "t", "s" and "x" palatalise a following "i", which then shares a single sound
 * with the vowel after it: "na-tion", "ques-tion", "vi-sion", "anx-ious",
 * "pa-tient". "c" does the same before "a" and "o" ("spe-cial", "pre-cious") but
 * not before "e", which is what keeps "sci-ence" at two syllables.
 */
function isPalatalising(before: string | undefined, second: string): boolean {
  if (before === "t" || before === "s" || before === "x") return true;
  return before === "c" && (second === "a" || second === "o");
}

/**
 * "ie" is one sound in "field", "piece", "be-lieve" and "friend", and two in
 * "di-et", "cli-ent", "sci-ence" and "au-di-ence". The letter after the pair is
 * what separates them: the hiatus cases are followed by "t", or by an "n" that
 * does not begin "nd".
 */
function isIeHiatus(stem: string, index: number): boolean {
  const after = stem[index + 2];
  if (after === "t") return true;
  return after === "n" && stem[index + 3] !== "d";
}

/**
 * The two "ea" shapes that are two syllables. A word-final "ea" with an earlier
 * vowel in the word splits ("i-de-a", "ar-e-a", "cor-ne-a"), while the same
 * ending with no earlier vowel does not ("sea", "tea", "plea"). And "-eate"
 * splits ("cre-ate", "per-me-ate"); the final silent "e" is what separates those
 * from "-eat" ("treat", "re-peat", "wheat"), where the pair is one sound. The
 * second test reads `letters` rather than the stem because the silent "e" it
 * depends on has already been removed from the stem.
 */
function isEaHiatus(stem: string, index: number, letters: string): boolean {
  if (index + 2 === stem.length && hasVowelBefore(stem, index)) return true;
  return letters.endsWith("eate") && index + 4 === letters.length;
}

/**
 * True when the adjacent vowels at `stem[index]` and `stem[index + 1]` are
 * spoken as two syllables rather than one. `letters` is the same word before the
 * silent "e" came off, which one of the tests below needs.
 */
function splitsBetween(stem: string, index: number, letters: string): boolean {
  const first = stem[index]!;
  const second = stem[index + 1]!;
  // A word-final "-ing" is always its own syllable, and after a vowel its "i"
  // joins that vowel's group: "be-ing", "go-ing", "say-ing", "ar-gu-ing". Tested
  // before the suppressions below because it outranks them - "ar-gu-ing" splits
  // even though a "u" after "g" normally does not.
  if (second === "i" && stem.endsWith("ing") && index + 1 === stem.length - 3) {
    return true;
  }
  const pair = first + second;
  if (pair === "ea") return isEaHiatus(stem, index, letters);
  if (!HIATUS_PAIRS.has(pair)) return false;
  const before = stem[index - 1];
  // A "u" after "q" or "g" is a glide rather than a syllable of its own:
  // "quick", "qui-et", "guess", "guide", "lan-guage", "jag-uar". Without this
  // test every one of those gains a syllable it does not have.
  if (first === "u" && (before === "q" || before === "g")) return false;
  if (first === "i" && isPalatalising(before, second)) return false;
  // "eo" is two sounds in "vid-e-o" and "ge-ol-o-gy", one in "peo-ple",
  // "leop-ard" and "jeop-ardy"; a following "p" marks the one-sound cases.
  if (pair === "eo" && stem[index + 2] === "p") return false;
  if (pair === "ie" && !isIeHiatus(stem, index)) return false;
  return true;
}

/**
 * The word with a silent trailing "e" removed, which is the form the vowel runs
 * are counted over.
 *
 * A trailing "e" preceded by a consonant and an "l" is spoken as its own syllable
 * ("ta-ble", "lit-tle", "peo-ple"), so that vowel group stays. Every other
 * trailing "e" is silent ("make", "cheese", "while") and comes off before
 * counting. The consonant test is what separates "candle" from "whale": in
 * "whale" a vowel precedes the "le", so the "e" is silent.
 */
function stemOf(letters: string): string {
  if (SPOKEN_FINAL_E.has(letters)) return letters;
  if (/[^aeiouy]le$/.test(letters)) return letters;
  return letters.replace(/e$/, "");
}

/** Syllables in a single hyphen-free, apostrophe-tolerant word part. */
function countPartSyllables(part: string): number {
  const letters = part.replace(/'/g, "");
  if (letters.length === 0) return 0;
  const stem = stemOf(letters);
  // One nucleus per run of adjacent vowels, which is how a diphthong is counted
  // once ("boat" has one, "beautiful" three rather than five), plus one more for
  // every hiatus split inside a run ("i-de-a" has two runs and three nuclei).
  let nuclei = 0;
  for (let index = 0; index < stem.length; index++) {
    if (!isVowelChar(stem[index])) continue;
    if (!isVowelChar(stem[index - 1])) nuclei += 1;
    else if (splitsBetween(stem, index - 1, letters)) nuclei += 1;
  }
  // Floor of 1: a word can lose every vowel to the silent-e rule ("the") and
  // still be spoken.
  return Math.max(1, nuclei);
}

/**
 * Syllables in one word: one per run of adjacent vowels, corrected for a silent
 * trailing "e" and for the hiatus pairs that a vowel run hides. A hyphenated
 * compound is summed part by part, since each part is spoken as its own word
 * ("well-known" is two, not one). Returns 0 for a word with no letters, which is
 * the only case that can score below the floor of 1.
 */
export function syllables(word: string): number {
  const parts = normalizeWord(word)
    .split("-")
    .filter((part) => part.length > 0);
  let total = 0;
  for (const part of parts) {
    total += countPartSyllables(part);
  }
  return total;
}

/** Scoreable words in one sentence: prose only, code tokens discarded. */
function proseWords(sentence: string): string[] {
  const words: string[] = [];
  for (const token of sentence.split(/\s+/)) {
    if (token.length === 0 || isCodeToken(token)) continue;
    const word = normalizeWord(token);
    if (word.length > 0) words.push(word);
  }
  return words;
}

/** Two decimals is more precision than a grade level can carry. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sentence and word counts over the prose in `text`, plus its Flesch-Kincaid
 * grade level.
 *
 * A sentence contributing no prose words is not counted as a sentence. A line
 * of code would otherwise count in the denominator, dragging words-per-sentence
 * down and reporting the surrounding prose as simpler than it is.
 *
 * Emptiness is signalled by `words === 0`, not by `grade === 0`. The formula
 * legitimately returns a negative grade for very short, very simple text
 * ("The cat sat." scores below zero), so a caller checking for "no prose here"
 * has to read the counts.
 */
export function readabilityStats(text: string): {
  grade: number;
  sentences: number;
  words: number;
  syllables: number;
  avgWordsPerSentence: number;
  avgSyllablesPerWord: number;
} {
  let sentenceCount = 0;
  let wordCount = 0;
  let syllableCount = 0;
  for (const sentence of splitSentences(stripMarkdownSyntax(text))) {
    const words = proseWords(sentence);
    if (words.length === 0) continue;
    sentenceCount += 1;
    wordCount += words.length;
    for (const word of words) {
      // syllables(), not countPartSyllables(), so a hyphenated compound is
      // still summed part by part here.
      syllableCount += syllables(word);
    }
  }
  // Guard the division explicitly. NaN or Infinity leaking into a gate
  // assertion would make every comparison false and let the gate pass on
  // garbage, which is the exact failure this module exists to prevent.
  if (sentenceCount === 0 || wordCount === 0) {
    return {
      grade: 0,
      sentences: 0,
      words: 0,
      syllables: 0,
      avgWordsPerSentence: 0,
      avgSyllablesPerWord: 0,
    };
  }
  const wordsPerSentence = wordCount / sentenceCount;
  const syllablesPerWord = syllableCount / wordCount;
  return {
    grade: round2(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59),
    sentences: sentenceCount,
    words: wordCount,
    syllables: syllableCount,
    avgWordsPerSentence: round2(wordsPerSentence),
    avgSyllablesPerWord: round2(syllablesPerWord),
  };
}

/** Flesch-Kincaid grade level of the prose in `text`; 0 when there is none. */
export function fleschKincaidGrade(text: string): number {
  return readabilityStats(text).grade;
}
