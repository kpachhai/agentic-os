import { describe, expect, it } from "vitest";
import {
  fleschKincaidGrade,
  readabilityStats,
  syllables,
} from "../server/text/readability.js";

describe("syllable counting", () => {
  // Hand-checked against how each word is spoken. Each row names the
  // correction it exercises, so a regression says which rule broke.
  const table: [word: string, count: number, rule: string][] = [
    ["cat", 1, "single vowel group"],
    ["pillar", 2, "two vowel groups"],
    ["readability", 5, "many vowel groups"],
    ["make", 1, "silent trailing e"],
    ["while", 1, "silent trailing e"],
    ["cheese", 1, "silent trailing e over a diphthong"],
    ["the", 1, "floor of 1 once the silent e is removed"],
    ["table", 2, "le ending after a consonant"],
    ["little", 2, "le ending after a consonant"],
    ["candle", 2, "le ending after a consonant"],
    ["people", 2, "le ending after a consonant"],
    ["syllable", 3, "le ending after a consonant"],
    ["whale", 1, "le ending after a vowel is a silent e, not a syllable"],
    ["boat", 1, "diphthong counted once"],
    ["beautiful", 3, "triple vowel run counted once"],
    ["queue", 1, "vowel run plus silent trailing e"],
    ["happy", 2, "y as a vowel"],
    ["well-known", 2, "hyphenated compound summed part by part"],
    ["self-documenting", 5, "hyphenated compound summed part by part"],
    // Hiatus: adjacent vowels in separate syllables. Counting the run once is
    // what made this module report a lower grade than the prose deserves.
    ["idea", 3, "word-final ea after an earlier vowel"],
    ["area", 3, "word-final ea after an earlier vowel"],
    ["sea", 1, "word-final ea with no earlier vowel stays one sound"],
    ["create", 2, "eate ending"],
    ["repeat", 2, "eat without the final e stays one sound"],
    ["reliable", 4, "ia hiatus under a ble ending"],
    ["giant", 2, "ia hiatus"],
    ["million", 3, "io hiatus after a consonant other than t, s, c or x"],
    ["radio", 3, "io hiatus"],
    ["medium", 3, "iu hiatus"],
    ["science", 2, "ie hiatus before n; ci does not palatalise before e"],
    ["client", 2, "ie hiatus before nt"],
    ["diet", 2, "ie hiatus before t"],
    ["field", 1, "ie before ld is one sound"],
    ["friend", 1, "ie before nd is one sound"],
    ["believe", 2, "ie before v is one sound"],
    ["quiet", 2, "ie hiatus after the qu glide"],
    ["cruel", 2, "ue hiatus"],
    ["ruin", 2, "ui hiatus"],
    ["actual", 3, "ua hiatus"],
    ["virtuous", 3, "uo hiatus"],
    ["video", 3, "eo hiatus"],
    ["leopard", 2, "eo before p is one sound"],
    ["nation", 2, "t palatalises the following i"],
    ["vision", 2, "s palatalises the following i"],
    ["anxious", 2, "x palatalises the following i"],
    ["special", 2, "c palatalises the following i before a"],
    ["precious", 2, "c palatalises the following i before o"],
    ["patient", 2, "t palatalises the following i before e"],
    ["being", 2, "word-final ing after a vowel"],
    ["going", 2, "word-final ing after a vowel"],
    ["saying", 2, "word-final ing after a vowel"],
    ["arguing", 3, "word-final ing outranks the gu glide"],
    ["during", 2, "ing after a consonant needs no correction"],
    ["guess", 1, "u after g is a glide, not a syllable"],
    ["guide", 1, "u after g is a glide, not a syllable"],
    ["language", 2, "u after g is a glide, not a syllable"],
    ["jaguar", 2, "u after g is a glide, not a syllable"],
    ["recipe", 3, "listed word whose final e is spoken"],
  ];

  for (const [word, count, rule] of table) {
    it(`counts ${count} in "${word}" (${rule})`, () => {
      expect(syllables(word)).toBe(count);
    });
  }

  it("counts the same word the same way whatever its case", () => {
    // Pinned counts rather than a comparison between two calls: comparing
    // syllables("Readability") with syllables("readability") holds for any
    // implementation that lowercases first, including one that returns 0.
    expect(syllables("Readability")).toBe(5);
    expect(syllables("readability")).toBe(5);
    expect(syllables("TABLE")).toBe(2);
    expect(syllables("Idea")).toBe(3);
  });

  it("returns 0 for a word with no letters, so nothing is guessed", () => {
    expect(syllables("")).toBe(0);
    expect(syllables("   ")).toBe(0);
    expect(syllables("127.0.0.1")).toBe(0);
    expect(syllables("--")).toBe(0);
  });
});

/**
 * The counter is a heuristic and will be wrong about some English words. What it
 * may not be is wrong in the direction that lowers the reported grade, because
 * that turns a readability gate into a rubber stamp: text scores easier than it
 * reads and the assertion passes. Overcounting only makes the gate stricter than
 * asked. So this block checks the shape of the error, not its absence.
 */
describe("syllable bias direction", () => {
  const handCounted: [word: string, count: number][] = [
    // Words the hiatus rules exist for.
    ["being", 2],
    ["quiet", 2],
    ["reliable", 4],
    ["idea", 3],
    ["area", 3],
    ["science", 2],
    ["create", 2],
    ["million", 3],
    ["radio", 3],
    ["ruin", 2],
    ["giant", 2],
    ["cruel", 2],
    ["recipe", 3],
    // Palatalised "i", which must stay merged.
    ["nation", 2],
    ["question", 2],
    ["vision", 2],
    ["decision", 3],
    ["special", 2],
    ["precious", 2],
    ["patient", 2],
    ["initial", 3],
    ["anxious", 2],
    ["efficient", 3],
    ["ancient", 2],
    // "u" after "q" or "g".
    ["guess", 1],
    ["guide", 1],
    ["language", 2],
    ["jaguar", 2],
    ["penguin", 2],
    ["arguing", 3],
    ["argue", 2],
    ["arguable", 4],
    ["vague", 1],
    // "ui", the pair this counter splits most often against a reader.
    ["fruit", 1],
    ["build", 1],
    ["juice", 1],
    ["circuit", 2],
    ["fluid", 2],
    ["genuine", 3],
    // Word-final "-ing".
    ["going", 2],
    ["saying", 2],
    ["seeing", 2],
    ["trying", 2],
    ["during", 2],
    ["missing", 2],
    // "eo".
    ["video", 3],
    ["people", 2],
    ["leopard", 2],
    ["jeopardy", 3],
    ["geology", 4],
    // "ie" on both sides of the split test.
    ["field", 1],
    ["piece", 1],
    ["believe", 2],
    ["friend", 1],
    ["client", 2],
    ["diet", 2],
    ["audience", 3],
    ["society", 4],
    ["variety", 4],
    ["species", 2],
    ["cookies", 2],
    // "ea" on both sides of the split test.
    ["treat", 1],
    ["great", 1],
    ["repeat", 2],
    ["sea", 1],
    ["cornea", 3],
    ["nausea", 3],
    ["created", 3],
    ["ocean", 2],
    ["really", 2],
    // The plural "-es", the module's other known upward bias.
    ["makes", 1],
    ["notes", 1],
    ["times", 1],
    ["boxes", 2],
    ["sentences", 3],
    // Longer words where several rules meet.
    ["actual", 3],
    ["situation", 4],
    ["individual", 5],
    ["evaluation", 5],
    ["material", 4],
    ["medium", 3],
    ["calcium", 3],
    ["influence", 3],
    ["fuel", 2],
    ["duel", 2],
    ["value", 2],
    ["true", 1],
    ["blue", 1],
    ["duo", 2],
    ["virtuous", 3],
    ["readability", 5],
    ["beautiful", 3],
    ["syllable", 3],
    ["self-documenting", 5],
  ];

  /**
   * Words this counter is knowingly short on, with the reason. Naming them makes
   * the next undercount a failure instead of a rounding detail: an unlisted word
   * that scores low fails the test below whatever the net comes to.
   *
   * Both are cases where the spelling clue the rule depends on has been
   * inflected away. "-eate" marks "cre-ate" as hiatus, and "created" no longer
   * carries it; a "u" after "g" is a glide in "argue", and "ar-gu-a-ble" is the
   * exception. Teaching the counter either word is a change to this list too.
   */
  const knownShort = new Set(["created", "arguable"]);

  it("is short only on the words listed as knowingly short", () => {
    const short = handCounted
      .filter(([word, count]) => syllables(word) < count)
      .map(([word]) => word);
    expect(new Set(short)).toEqual(knownShort);
  });

  it("is never wrong by more than one syllable", () => {
    for (const [word, count] of handCounted) {
      const counted = syllables(word);
      expect(
        Math.abs(counted - count),
        `${word}: counted ${counted}, hand count ${count}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("nets a non-negative bias over the whole table", () => {
    // The assertion that actually protects a gate. Individual heuristics are
    // only how it is reached; if a future correction makes the net negative, the
    // reported grade has started running low and the gate has gone permissive.
    const net = handCounted.reduce(
      (sum, [word, count]) => sum + (syllables(word) - count),
      0,
    );
    expect(handCounted.length).toBeGreaterThanOrEqual(30);
    expect(net).toBeGreaterThanOrEqual(0);
  });
});

describe("grade banding", () => {
  const plain =
    "The gate runs a check on every pillar. It fails loud when the data is missing.";
  const convoluted =
    "Notwithstanding the aforementioned architectural considerations, the " +
    "deterministic evaluation of documentation readability necessitates a " +
    "comprehensive understanding of the underlying morphological " +
    "approximations, particularly whenever the surrounding explanatory " +
    "material has been generated automatically.";

  it("scores short plain sentences in a low grade band", () => {
    const stats = readabilityStats(plain);
    expect(stats.sentences).toBe(2);
    expect(stats.words).toBe(16);
    expect(stats.grade).toBeGreaterThan(0);
    expect(stats.grade).toBeLessThan(6);
  });

  it("scores a deliberately convoluted sentence far higher", () => {
    const stats = readabilityStats(convoluted);
    expect(stats.sentences).toBe(1);
    expect(stats.avgWordsPerSentence).toBeGreaterThan(25);
    expect(stats.avgSyllablesPerWord).toBeGreaterThan(2.5);
    expect(stats.grade).toBeGreaterThan(20);
    expect(stats.grade).toBeGreaterThan(fleschKincaidGrade(plain) + 10);
  });

  it("scores prose full of hiatus words at the grade it reads at", () => {
    // Nine words, hand-counted at 18 syllables: Be-ing qui-et is a re-li-a-ble
    // i-de-a in this ar-e-a. Merging each of those vowel runs into one syllable
    // gave 13 and grade 4.96, so `grade <= 9` passed eleventh-grade prose - the
    // one failure a readability gate exists to prevent.
    const stats = readabilityStats("Being quiet is a reliable idea in this area.");
    expect(stats.sentences).toBe(1);
    expect(stats.words).toBe(9);
    expect(stats.syllables).toBe(18);
    expect(stats.avgSyllablesPerWord).toBe(2);
    expect(stats.grade).toBeCloseTo(11.52, 2);
    expect(stats.grade).toBeGreaterThan(9);
  });

  it("exposes counts that reproduce the reported grade", () => {
    const stats = readabilityStats(plain);
    expect(stats.syllables).toBe(21);
    const recomputed =
      0.39 * (stats.words / stats.sentences) +
      11.8 * (stats.syllables / stats.words) -
      15.59;
    expect(stats.grade).toBeCloseTo(recomputed, 2);
  });

  it("returns pinned grades for pinned prose", () => {
    // Real values rather than a comparison with readabilityStats().grade, which
    // holds for any pair of implementations of the two functions - including a
    // pair that both return 0.
    expect(fleschKincaidGrade("The cat sat on the mat.")).toBe(-1.45);
    expect(fleschKincaidGrade(plain)).toBe(3.02);
    expect(fleschKincaidGrade(convoluted)).toBeGreaterThan(20);
    expect(fleschKincaidGrade("")).toBe(0);
  });

  it("reports a negative grade for text simpler than first grade", () => {
    // Documented behaviour worth pinning: emptiness is signalled by words === 0,
    // not by a grade of 0, because a real grade can be below zero.
    const stats = readabilityStats("The cat sat on the mat.");
    expect(stats.words).toBe(6);
    expect(stats.grade).toBeLessThan(0);
  });
});

describe("code-token stripping", () => {
  /**
   * Scores the way Flesch-Kincaid does when nothing is stripped: every
   * whitespace-delimited token counts as a word. Kept in the test rather than
   * in the module because it is the wrong answer - it exists only to show how
   * far wrong an unstripped score lands.
   */
  function naiveGrade(text: string): number {
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const totalSyllables = tokens.reduce(
      (sum, token) => sum + Math.max(1, syllables(token)),
      0,
    );
    return (
      0.39 * tokens.length + 11.8 * (totalSyllables / tokens.length) - 15.59
    );
  }

  const pathDense =
    "Read the digest notes in workspace/digests/session-notes.md and compare " +
    "the launch_defaults ceiling against 127.0.0.1 before you ship.";

  it("drops paths, identifiers and IP literals from the word count", () => {
    const stats = readabilityStats(pathDense);
    // 16 whitespace-delimited tokens, 3 of them code-shaped.
    expect(stats.words).toBe(13);
    expect(stats.sentences).toBe(1);
  });

  it("scores path-dense text far lower than an unstripped count would", () => {
    const stats = readabilityStats(pathDense);
    // The three dropped tokens add syllables to a naive count. Left in, they
    // move the score more than five grade levels on prose that has not changed.
    expect(naiveGrade(pathDense)).toBeGreaterThan(stats.grade + 5);
  });

  it("still strips code tokens from the prose around a dropped table", () => {
    // A table is removed before scoring, so it changes what reaches the token
    // filter. Checked here because a table that leaked its rows through, or that
    // swallowed the paragraph under it, would both show up as a word count that
    // no longer matches the same paragraph on its own.
    const paragraph = "The launcher reads config.json before it starts.";
    const withTable = [
      "| Source | Path |",
      "| --- | --- |",
      "| One | server/skills.ts |",
      "",
      paragraph,
    ].join("\n");
    const stats = readabilityStats(withTable);
    // Six prose words: config.json is code-shaped and dropped.
    expect(stats.words).toBe(6);
    expect(stats.sentences).toBe(1);
    expect(stats).toEqual(readabilityStats(paragraph));
  });

  it("ignores markdown syntax and the code it wraps", () => {
    const withMarkdown = "- Check the `config.example.json` file for the value.";
    const withoutMarkdown = "Check the file for the value.";
    expect(readabilityStats(withMarkdown).words).toBe(
      readabilityStats(withoutMarkdown).words,
    );
    expect(readabilityStats(withMarkdown).grade).toBe(
      readabilityStats(withoutMarkdown).grade,
    );
  });

  it("reports text that is only code as having no prose", () => {
    const stats = readabilityStats(
      "server/text/readability.ts config.example.json narrowCwd::launchDefaults",
    );
    expect(stats.words).toBe(0);
    expect(stats.sentences).toBe(0);
    expect(stats.grade).toBe(0);
  });
});

describe("empty input", () => {
  const zeroed = {
    grade: 0,
    sentences: 0,
    words: 0,
    syllables: 0,
    avgWordsPerSentence: 0,
    avgSyllablesPerWord: 0,
  };

  for (const input of ["", "   ", "\n\n\t", "### \n\n---\n"]) {
    it(`returns zeroed stats with no NaN for ${JSON.stringify(input)}`, () => {
      const stats = readabilityStats(input);
      expect(stats).toEqual(zeroed);
      // A NaN here would make every gate comparison false, which reads as a
      // pass. Assert finiteness field by field rather than trusting toEqual.
      for (const [field, value] of Object.entries(stats)) {
        expect(Number.isNaN(value), `${field} is NaN`).toBe(false);
        expect(Number.isFinite(value), `${field} is not finite`).toBe(true);
      }
      expect(fleschKincaidGrade(input)).toBe(0);
    });
  }
});

describe("degenerate input", () => {
  const inputs: [label: string, text: string][] = [
    ["a bare terminator", "."],
    ["a run of terminators", "!!!"],
    ["an ellipsis", "..."],
    ["a bare number", "1024"],
    ["an IP literal", "127.0.0.1"],
    ["a dash pair", "--"],
    ["a lone hyphen", "-"],
    ["only apostrophes", "'''"],
    ["a zero-width space", "​"],
    ["a word split by a zero-width space", "Alpha​beta gamma."],
    ["an unterminated backtick fence", "```\nnever closed\nstill open\n"],
    ["an unterminated tilde fence", "~~~\ncode\n"],
    ["a table with no body", "| a | b |\n| --- | --- |"],
    ["a setext heading", "Title\n=====\n"],
    ["an empty heading and a rule", "# \n\n---\n"],
    ["abbreviations only", "e.g. i.e. etc."],
    ["a numbered list", "1. one\n2. two\n"],
    ["one letter", "a"],
    ["a 200k-character single word", "a".repeat(200_000)],
    ["a 200k-character vowel churn", "iaou".repeat(50_000)],
  ];

  for (const [label, text] of inputs) {
    it(`returns finite fields for ${label}`, () => {
      const stats = readabilityStats(text);
      for (const [field, value] of Object.entries(stats)) {
        expect(Number.isFinite(value), `${field} is ${value}`).toBe(true);
      }
      // Counts are counts: a negative or fractional one would mean the scan
      // lost its place. The grade itself is allowed to be negative.
      for (const count of [stats.sentences, stats.words, stats.syllables]) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
      expect(Number.isFinite(fleschKincaidGrade(text))).toBe(true);
    });
  }

  it("never reports fewer syllables than words", () => {
    // Every scored word contributes at least one syllable, so this ratio can
    // never fall below 1. Below it, the grade has been computed from a count
    // that cannot describe speech.
    for (const [, text] of inputs) {
      const stats = readabilityStats(text);
      if (stats.words === 0) continue;
      expect(stats.syllables).toBeGreaterThanOrEqual(stats.words);
    }
  });
});
