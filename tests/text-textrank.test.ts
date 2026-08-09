import { describe, expect, it } from "vitest";
import {
  splitSentences,
  stripMarkdownSyntax,
} from "../server/text/sentences.js";
import {
  extractKeywords,
  rankSentences,
  rankSentencesWithDiagnostics,
  RANKING_SENTENCE_CEILING,
} from "../server/text/textrank.js";

// Every fixture in this file is written by hand. Nothing here comes from the
// operator's memory vault, friction log or session wraps: this repo is meant to
// be published, so captured personal text must never land in a test.

/** A document whose second sentence is the hub every other sentence touches. */
const HUB_DOCUMENT = [
  "The gate script wipes node_modules before it starts.",
  "The gate script builds the server, runs the test suite, and boots the server once.",
  "The test suite runs under vitest.",
  "The server boots on loopback and refuses anything else.",
  "Rain fell steadily on the roof all afternoon.",
].join(" ");

const MULTI_TOPIC_DOCUMENT = [
  "The launcher spawns a skill headlessly and streams its output back.",
  "Each launch narrows the configured allowlist instead of replacing it.",
  "A narrowed working directory has to stay inside the configured directory.",
  "The launcher clamps a requested timeout to the configured ceiling.",
  "A client therefore cannot grant itself what the operator withheld.",
  "Wildflowers opened along the fence line sometime last week.",
].join(" ");

/**
 * Term frequencies here are chosen so the whole keyword ordering is worked out
 * by hand below rather than copied from a run: "ceiling" appears four times,
 * "launcher" three, and "clamps", "configured" and "requested" twice each.
 */
const KEYWORD_DOCUMENT = [
  "The launcher clamps a requested timeout to the configured ceiling.",
  "The launcher clamps a requested budget to the configured ceiling.",
  "A ceiling is a ceiling, and the launcher never raises one.",
  "Wildflowers opened along the fence line last week.",
].join(" ");

/**
 * Multi-paragraph synthetic prose, five sentences per paragraph. Subjects are
 * capitalised because the sentence splitter deliberately refuses to break
 * before a lowercase word; a lowercase subject would collapse each paragraph
 * into one long sentence and make the timing assertion below meaningless.
 */
function syntheticDocument(paragraphCount: number): string {
  const subjects = [
    "The launcher",
    "The gate script",
    "The vault reader",
    "The friction timeline",
    "The token chart",
  ];
  const verbs = ["reads", "validates", "streams", "clamps", "records"];
  const objects = [
    "a bounded working directory before it spawns anything at all",
    "the configured allowlist and the one narrow override that came with it",
    "a source-missing error naming the exact path that was absent",
    "the wrap history in reverse order so the newest entry lands first",
    "every token total it found in the read-only usage database",
  ];
  const paragraphs: string[] = [];
  for (let paragraph = 0; paragraph < paragraphCount; paragraph++) {
    const sentences: string[] = [];
    for (let sentence = 0; sentence < 5; sentence++) {
      const step = paragraph * 5 + sentence;
      const subject = subjects[step % subjects.length]!;
      const verb = verbs[(step + paragraph) % verbs.length]!;
      const object = objects[(step + 2 * paragraph) % objects.length]!;
      sentences.push(`${subject} ${verb} ${object}.`);
    }
    paragraphs.push(sentences.join(" "));
  }
  return paragraphs.join("\n\n");
}

/**
 * Deterministic pseudo-random numbers. A fixed seed is what makes a generated
 * document that breaks an invariant reproducible; with Math.random the failure
 * would disappear on the next run.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const GENERATED_VOCABULARY = [
  "launcher", "gate", "vault", "friction", "token", "wrap", "loopback",
  "allowlist", "timeout", "budget", "score", "index", "source", "reader",
  "policy", "record", "handler", "route", "ceiling", "transcript",
];

/**
 * A short document of generated prose wrapped in whichever markdown shapes the
 * seed picks: headings, bullets, fenced code, tables and quotes. The markdown
 * matters as much as the prose, because `sourceIndex` is an index into the
 * stripped and split text, so a stripping rule that drops or merges a line moves
 * every index after it.
 */
function generatedDocument(rand: () => number): string {
  const sentence = (): string => {
    const words: string[] = [];
    const length = 3 + Math.floor(rand() * 10);
    for (let word = 0; word < length; word++) {
      words.push(
        GENERATED_VOCABULARY[Math.floor(rand() * GENERATED_VOCABULARY.length)]!,
      );
    }
    return `The ${words.join(" ")}.`;
  };

  const lines: string[] = [];
  const blockCount = 1 + Math.floor(rand() * 5);
  for (let block = 0; block < blockCount; block++) {
    const shape = Math.floor(rand() * 6);
    if (shape === 0) lines.push(`## ${sentence()}`);
    else if (shape === 1) lines.push(`- ${sentence()}`, `- ${sentence()}`);
    else if (shape === 2) lines.push("```ts", "const value = 1;", "```");
    else if (shape === 3) lines.push("| head | other |", "| --- | --- |", "| cell |");
    else if (shape === 4) lines.push(`> ${sentence()}`);
    else lines.push(`${sentence()} ${sentence()}`);
    lines.push("");
  }
  return lines.join("\n");
}

describe("rankSentences", () => {
  it("returns the selected sentences in source order, not score order", () => {
    const selected = rankSentences(MULTI_TOPIC_DOCUMENT, 3);
    expect(selected).toHaveLength(3);

    const indexes = selected.map((row) => row.sourceIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));

    // Ordering by position only means something if score order would differ,
    // so assert the returned scores are not already descending.
    const scores = selected.map((row) => row.score);
    expect(scores).not.toEqual([...scores].sort((a, b) => b - a));

    // Ordering by position must not change which sentences won: the selection
    // is still the three highest scorers of the document.
    const everySentence = rankSentences(MULTI_TOPIC_DOCUMENT, 100);
    const highestThree = [...everySentence]
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map((row) => row.sourceIndex)
      .sort((a, b) => a - b);
    expect(indexes).toEqual(highestThree);
  });

  it("reports sourceIndex as the position in the split, stripped source", () => {
    const markdown = [
      "# Launch guarding",
      "",
      "Every **override** may only narrow the configured default.",
      "A `narrowCwd` value stays inside the configured working directory.",
      "A requested timeout is clamped to the configured ceiling.",
      "",
      "- The allowlist is intersected, never replaced.",
    ].join("\n");
    const sentences = splitSentences(stripMarkdownSyntax(markdown));
    // Guard against the fixture quietly collapsing to one sentence, which would
    // make the index assertions below pass without proving anything.
    expect(sentences.length).toBeGreaterThan(3);

    const ranked = rankSentences(markdown, 3);
    expect(ranked).toHaveLength(3);
    for (const row of ranked) {
      expect(row.sourceIndex).toBeGreaterThanOrEqual(0);
      expect(row.sourceIndex).toBeLessThan(sentences.length);
      // The text is the split sentence at that index, character for character.
      // Markdown syntax is gone because the split ran on stripped text, but no
      // wording is rewritten.
      expect(row.sentence).toBe(sentences[row.sourceIndex]);
      expect(row.sentence).not.toContain("**");
      expect(row.sentence).not.toContain("`");
    }
  });

  it("keeps the original wording, casing and punctuation of each sentence", () => {
    const sentences = splitSentences(stripMarkdownSyntax(HUB_DOCUMENT));
    for (const row of rankSentences(HUB_DOCUMENT, 5)) {
      expect(row.sentence).toBe(sentences[row.sourceIndex]);
      expect(row.sentence).toMatch(/^[A-Z]/);
    }
  });

  it("picks the sentence the rest of the document converges on", () => {
    const sentences = splitSentences(stripMarkdownSyntax(HUB_DOCUMENT));
    const hubIndex = sentences.findIndex((sentence) =>
      sentence.includes("builds the server"),
    );
    expect(hubIndex).toBeGreaterThanOrEqual(0);

    const single = rankSentences(HUB_DOCUMENT, 1);
    expect(single).toHaveLength(1);
    expect(single[0]!.sourceIndex).toBe(hubIndex);

    // The off-topic sentence shares no content words, so it scores lowest.
    const allRanked = rankSentences(HUB_DOCUMENT, sentences.length);
    const lowest = allRanked.reduce((worst, row) =>
      row.score < worst.score ? row : worst,
    );
    expect(lowest.sentence).toContain("Rain fell");
  });

  it("returns [] for empty or whitespace-only text", () => {
    expect(rankSentences("", 5)).toEqual([]);
    expect(rankSentences("   \n\n  ", 5)).toEqual([]);
  });

  it("returns the one sentence of a single-sentence document", () => {
    const text = "The database is opened read-only and never written to.";
    const ranked = rankSentences(text, 3);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.sourceIndex).toBe(0);
    expect(ranked[0]!.sentence).toBe(text);
    expect(Number.isFinite(ranked[0]!.score)).toBe(true);
  });

  it("returns [] when maxSentences is zero or negative", () => {
    expect(rankSentences(MULTI_TOPIC_DOCUMENT, 0)).toEqual([]);
    expect(rankSentences(MULTI_TOPIC_DOCUMENT, -3)).toEqual([]);
  });

  it("returns every sentence in source order when maxSentences overshoots", () => {
    const sentences = splitSentences(stripMarkdownSyntax(MULTI_TOPIC_DOCUMENT));
    const ranked = rankSentences(MULTI_TOPIC_DOCUMENT, sentences.length + 50);
    expect(ranked.map((row) => row.sentence)).toEqual(sentences);
    expect(ranked.map((row) => row.sourceIndex)).toEqual(
      sentences.map((_sentence, index) => index),
    );
  });

  it("treats Infinity as no limit rather than as no result", () => {
    // Infinity is the obvious way to ask for the whole document, and an empty
    // answer to that question is indistinguishable from "this text has no prose
    // in it", which is a different and much more alarming claim.
    const sentences = splitSentences(stripMarkdownSyntax(MULTI_TOPIC_DOCUMENT));
    const unlimited = rankSentences(MULTI_TOPIC_DOCUMENT, Infinity);
    expect(unlimited.map((row) => row.sentence)).toEqual(sentences);
    expect(unlimited).toEqual(rankSentences(MULTI_TOPIC_DOCUMENT, 1e9));
  });

  it("returns [] for a limit that is not a number at all", () => {
    // NaN is not a count of sentences, so it selects none. Unlike Infinity there
    // is no reading of it that means "all of them".
    expect(rankSentences(MULTI_TOPIC_DOCUMENT, NaN)).toEqual([]);
    expect(rankSentences(MULTI_TOPIC_DOCUMENT, -Infinity)).toEqual([]);
  });

  it("settles the scores instead of stopping at the iteration cap", () => {
    // Five sentences on one subject is the ordinary case, not a pathological
    // graph, and it needs about 80 rounds to bring every score under the 1e-6
    // threshold. The iteration count is asserted as well as the flag: if it ever
    // drops to something a smaller cap would allow, this fixture has stopped
    // proving that the cap clears a realistic worst case.
    const report = rankSentencesWithDiagnostics(HUB_DOCUMENT, 3);
    expect(report.converged).toBe(true);
    expect(report.iterations).toBeGreaterThan(60);
    expect(report.sentenceCount).toBe(
      splitSentences(stripMarkdownSyntax(HUB_DOCUMENT)).length,
    );
    expect(report.sentences).toHaveLength(3);
  });

  it("reports no iterations and no scores for a degenerate input", () => {
    const empty = rankSentencesWithDiagnostics("   \n\n ", 5);
    expect(empty.sentences).toEqual([]);
    expect(empty.sentenceCount).toBe(0);
    expect(empty.iterations).toBe(0);

    // A real document with a limit of zero scores nothing either, but the
    // sentence count still reports what was there to score.
    const unscored = rankSentencesWithDiagnostics(MULTI_TOPIC_DOCUMENT, 0);
    expect(unscored.sentences).toEqual([]);
    expect(unscored.iterations).toBe(0);
    expect(unscored.sentenceCount).toBeGreaterThan(1);
  });

  it("keeps sourceIndex honest and the scores settled across generated markdown", () => {
    const rand = seededRandom(20260726);
    let checkedRows = 0;
    let maxIterations = 0;
    for (let document = 0; document < 400; document++) {
      const text = generatedDocument(rand);
      const sentences = splitSentences(stripMarkdownSyntax(text));
      const limit = 1 + Math.floor(rand() * 12);
      const report = rankSentencesWithDiagnostics(text, limit);

      expect(report.converged).toBe(true);
      maxIterations = Math.max(maxIterations, report.iterations);
      expect(report.sentenceCount).toBe(sentences.length);
      expect(report.sentences).toHaveLength(Math.min(limit, sentences.length));

      let previousIndex = -1;
      for (const row of report.sentences) {
        // The selected line is the source sentence at that index, character for
        // character; indexes ascend and never repeat.
        expect(row.sentence).toBe(sentences[row.sourceIndex]);
        expect(row.sourceIndex).toBeGreaterThan(previousIndex);
        previousIndex = row.sourceIndex;
        expect(Number.isFinite(row.score)).toBe(true);
        checkedRows++;
      }
    }
    // Guard the corpus itself: a generator that produced only empty documents
    // would satisfy every assertion above without exercising anything.
    expect(checkedRows).toBeGreaterThan(400);
    expect(maxIterations).toBeGreaterThan(1);
  });

  it("ranks a few thousand words fast enough for a request handler", () => {
    const document = syntheticDocument(50);
    const wordCount = document.split(/\s+/).filter(Boolean).length;
    const sentenceCount = splitSentences(stripMarkdownSyntax(document)).length;
    // Pin the shape of the input as well as the time. Without this, a splitter
    // change that merged paragraphs into single sentences would shrink the work
    // by a factor of five and the timing bound would pass on a much easier job.
    expect(wordCount).toBeGreaterThan(3000);
    expect(sentenceCount).toBeGreaterThan(200);

    // One warm-up pass so the measurement is not dominated by first-call JIT.
    rankSentences(document, 5);
    const startedAt = performance.now();
    const ranked = rankSentences(document, 5);
    const elapsedMs = performance.now() - startedAt;

    expect(ranked).toHaveLength(5);
    // Measures around 20 ms on an idle development machine, and was observed at
    // 426 ms inside the acceptance gate, which runs this immediately after a
    // dependency reinstall, a build and a typecheck have saturated the machine.
    // The bound is therefore set for regression detection rather than for
    // benchmarking: the regression it guards against, per-edge work reintroduced
    // on every iteration, costs two orders of magnitude, not a factor of three.
    // A tighter bound does not catch more bugs; it only fails on a busy box, and
    // a gate that cries wolf gets ignored, which is worse than no bound at all.
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("ranks a document at the recommended ceiling in well under a second", () => {
    // The module documents a ceiling in sentences instead of capping the input,
    // so the number has to be defended by a measurement rather than by prose:
    // an input of exactly that size stays inside a request handler's budget.
    // The fixture puts five sentences in a paragraph, so a ceiling that is not a
    // multiple of five fails the count assertion below rather than quietly
    // measuring a different size than the one being documented.
    const document = syntheticDocument(RANKING_SENTENCE_CEILING / 5);
    const sentenceCount = splitSentences(stripMarkdownSyntax(document)).length;
    expect(sentenceCount).toBe(RANKING_SENTENCE_CEILING);

    rankSentences(document, 5);
    const startedAt = performance.now();
    const ranked = rankSentences(document, 5);
    const elapsedMs = performance.now() - startedAt;

    expect(ranked).toHaveLength(5);
    // Measures around 70 ms on an idle development machine for this fixture, and
    // roughly 200 ms for a 500-sentence document whose sentences share more
    // vocabulary than these do. Same reasoning as the smaller timing case above:
    // the bound exists to catch an algorithmic regression, so it is set well clear
    // of the load the acceptance gate itself puts on the machine.
    expect(elapsedMs).toBeLessThan(6000);
  });
});

describe("extractKeywords", () => {
  it("keeps a hyphenated compound as one keyword", () => {
    const text = [
      "The memory-vault reader walks every thought file on disk.",
      "A missing memory-vault answers with a source-missing error.",
      "The memory-vault is never written to by this tool.",
    ].join(" ");
    const keywords = extractKeywords(text, 6);
    expect(keywords).toContain("memory-vault");
    expect(keywords).not.toContain("memory");
    expect(keywords).not.toContain("vault");
  });

  it("returns lowercased, deduplicated keywords, most significant first", () => {
    const text = [
      "Launcher policy narrows every override before a launch starts.",
      "Policy narrows the allowlist, and Policy narrows the timeout too.",
      "A LAUNCH inherits launcher policy and cannot widen policy.",
    ].join(" ");
    const keywords = extractKeywords(text, 8);
    expect(keywords.length).toBeGreaterThan(0);
    for (const keyword of keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
    }
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords[0]).toBe("policy");
    expect(keywords).not.toContain("the");
  });

  it("returns [] for degenerate inputs", () => {
    expect(extractKeywords("", 5)).toEqual([]);
    expect(extractKeywords("   \n  ", 5)).toEqual([]);
    expect(extractKeywords(MULTI_TOPIC_DOCUMENT, 0)).toEqual([]);
    expect(extractKeywords(MULTI_TOPIC_DOCUMENT, -2)).toEqual([]);
    expect(extractKeywords(MULTI_TOPIC_DOCUMENT, NaN)).toEqual([]);
  });

  it("picks the terms tf-idf ranks highest, in that order", () => {
    // Worked out from the four sentences of KEYWORD_DOCUMENT rather than copied
    // from a run. With smoothed idf log((1 + 4) / (1 + df)) + 1, "ceiling"
    // (4 uses across 3 sentences) scores 4.9, "launcher" (3 across 3) 3.7, and
    // "clamps", "configured" and "requested" (2 across 2) tie at 3.0, so the
    // alphabetical tie-break decides the last three places. Every word of the
    // off-topic fourth sentence is used once and lands below all of them.
    expect(extractKeywords(KEYWORD_DOCUMENT, 5)).toEqual([
      "ceiling",
      "launcher",
      "clamps",
      "configured",
      "requested",
    ]);

    const everyKeyword = extractKeywords(KEYWORD_DOCUMENT, Infinity);
    // Infinity means "no limit", the same as any count above the term total.
    expect(everyKeyword).toEqual(extractKeywords(KEYWORD_DOCUMENT, 1e9));
    expect(everyKeyword.slice(0, 5)).toEqual([
      "ceiling",
      "launcher",
      "clamps",
      "configured",
      "requested",
    ]);
    expect(everyKeyword).toContain("wildflowers");
    expect(everyKeyword.indexOf("wildflowers")).toBeGreaterThan(4);
    // Stopwords and bare numbers never make the list at any limit.
    expect(everyKeyword).not.toContain("the");
    expect(everyKeyword).not.toContain("and");
  });
});
