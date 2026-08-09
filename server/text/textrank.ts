import { splitSentences, stripMarkdownSyntax } from "./sentences.js";

/**
 * A sentence lifted verbatim out of the source text, plus where it came from.
 *
 * This summarizer is extractive: it only ever selects sentences that the author
 * actually wrote, and never paraphrases. That restriction is the reason its
 * output can be trusted without review - a selected line cannot say something
 * the source did not say. `sourceIndex` is what lets a caller prove that, by
 * pointing a reader back at the origin of every line it shows.
 */
export type RankedSentence = {
  sentence: string;
  sourceIndex: number;
  score: number;
};

/**
 * English function words that appear in almost every sentence. They inflate
 * similarity between sentences that share nothing topical, so they are dropped
 * before scoring. Inlined rather than pulled from a package: the list is short,
 * it never needs updating, and a dependency for it would not earn its keep.
 */
const STOPWORDS = new Set([
  "a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "been",
  "but", "by", "can", "do", "for", "from", "had", "has", "have", "if", "in",
  "into", "is", "it", "its", "more", "most", "no", "not", "of", "on", "or",
  "other", "so", "some", "such", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "was", "we", "were", "what",
  "when", "which", "will", "with", "would", "you", "your",
]);

/**
 * Words and numbers, with internal hyphens kept so a compound such as
 * "memory-vault" stays a single token instead of splitting into two weaker
 * halves. Unicode-aware so accented words get scored rather than discarded.
 */
const WORD_PATTERN = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;

/** PageRank's standard damping factor: the odds of following an edge. */
const DAMPING = 0.85;

/**
 * Iteration bounds. The threshold is what is meant to stop the loop and the cap
 * is only a backstop, so the two have to be chosen together. Each round moves
 * the scores by at most `DAMPING` times the movement of the round before it, so
 * from a uniform start the largest per-round change needs at most about
 * log(CONVERGENCE_THRESHOLD / 2) / log(DAMPING) rounds - roughly 90 at these
 * values - to fall under the threshold on any graph. Measured behavior is far
 * below that bound: across 400 generated five-sentence documents plus four
 * adversarial fixtures (heavy overlap, all-unrelated, near-identical, cyclic
 * chain) the worst case was 28 rounds and none hit the cap. The cap sits above
 * the analytic bound rather than the measured one, so it stays correct if the
 * damping or the threshold is ever retuned.
 *
 * The threshold is an absolute movement rather than a relative one, so it is a
 * stricter test on a short document, where each score is a large share of the
 * total, than on a long one, where the baseline score is 1/n to begin with. That
 * asymmetry is deliberate: it is what lets a thousand-sentence document settle
 * in a handful of rounds, and selection reads only the order of the scores, so
 * precision beyond the order buys nothing.
 *
 * If the cap is reached anyway, the last iterate is returned as it stands and
 * `converged` on the returned diagnostics is false. The scores are still finite
 * and still ordered, they are simply not settled to the threshold, and a caller
 * that cares can see that it happened.
 */
const MAX_ITERATIONS = 120;
const CONVERGENCE_THRESHOLD = 1e-6;

/**
 * Lowercase, punctuation-free tokens. Lowercasing and punctuation stripping
 * happen here and nowhere else, so scoring works on normalised text while every
 * returned sentence stays exactly as the author wrote it.
 */
function tokenize(text: string): string[] {
  // Apostrophes are removed rather than treated as separators, so "operator's"
  // scores as one token instead of leaving a meaningless trailing "s".
  const normalized = text.toLowerCase().replace(/['‘’]/g, "");
  return normalized.match(WORD_PATTERN) ?? [];
}

/**
 * Content words carry the topic; stopwords, single characters and bare numbers
 * do not. Bare numbers are excluded because dates, counts and version numbers
 * repeat often enough to outrank real subject words while saying nothing about
 * what the text is about.
 */
function isContentWord(token: string): boolean {
  if (token.length < 2) return false;
  if (STOPWORDS.has(token)) return false;
  if (/^\p{N}+$/u.test(token)) return false;
  return true;
}

/** Term counts keyed by term, for one sentence or for a whole document. */
type TermCounts = Map<string, number>;

function countTerms(sentences: string[]): TermCounts[] {
  return sentences.map((sentence) => {
    const counts: TermCounts = new Map();
    for (const token of tokenize(sentence)) {
      if (!isContentWord(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  });
}

/** How many sentences each term appears in, treating a sentence as a document. */
function countDocumentFrequencies(perSentence: TermCounts[]): TermCounts {
  const documentFrequency: TermCounts = new Map();
  for (const counts of perSentence) {
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return documentFrequency;
}

/**
 * Smoothed inverse document frequency, deliberately never zero. Plain
 * log(total / frequency) would weigh a term that appears in every sentence at
 * nothing, which empties the vectors of a short document and leaves the
 * similarity graph with no edges at all - so a two-sentence note about one
 * subject would score as two unrelated sentences.
 */
function inverseDocumentFrequency(
  totalSentences: number,
  documentFrequency: number,
): number {
  return Math.log((1 + totalSentences) / (1 + documentFrequency)) + 1;
}

/**
 * L2-normalized TF-IDF weights per sentence. Normalizing up front means the
 * cosine similarity of two sentences is just the dot product of their vectors,
 * and that long sentences do not outrank short ones on length alone.
 */
function buildTfIdfVectors(perSentence: TermCounts[]): TermCounts[] {
  const documentFrequency = countDocumentFrequencies(perSentence);
  const totalSentences = perSentence.length;
  return perSentence.map((counts) => {
    const weights: TermCounts = new Map();
    let sumOfSquares = 0;
    for (const [term, count] of counts) {
      const weight =
        count *
        inverseDocumentFrequency(
          totalSentences,
          documentFrequency.get(term) ?? 0,
        );
      weights.set(term, weight);
      sumOfSquares += weight * weight;
    }
    if (sumOfSquares === 0) return weights;
    const magnitude = Math.sqrt(sumOfSquares);
    for (const [term, weight] of weights) {
      weights.set(term, weight / magnitude);
    }
    return weights;
  });
}

/**
 * Cosine similarity between every pair of sentences that shares at least one
 * term: `adjacency[i]` maps the other sentence's index to the similarity. The
 * relation is symmetric, so both directions are stored.
 *
 * Only pairs that share a term are visited, by walking an inverted index of
 * term to sentences rather than every pair of sentences. Cost then tracks how
 * often terms actually repeat instead of the square of the sentence count,
 * which is what keeps a long document inside a synchronous request handler.
 */
function buildAdjacency(vectors: TermCounts[]): Map<number, number>[] {
  const sentencesByTerm = new Map<string, number[]>();
  vectors.forEach((vector, sentenceIndex) => {
    for (const term of vector.keys()) {
      const existing = sentencesByTerm.get(term);
      if (existing) existing.push(sentenceIndex);
      else sentencesByTerm.set(term, [sentenceIndex]);
    }
  });

  const adjacency: Map<number, number>[] = vectors.map(() => new Map());
  for (const [term, sentenceIndexes] of sentencesByTerm) {
    for (let first = 0; first < sentenceIndexes.length; first++) {
      const leftIndex = sentenceIndexes[first]!;
      const leftWeight = vectors[leftIndex]!.get(term)!;
      const leftRow = adjacency[leftIndex]!;
      for (let second = first + 1; second < sentenceIndexes.length; second++) {
        const rightIndex = sentenceIndexes[second]!;
        const contribution = leftWeight * vectors[rightIndex]!.get(term)!;
        const rightRow = adjacency[rightIndex]!;
        leftRow.set(rightIndex, (leftRow.get(rightIndex) ?? 0) + contribution);
        rightRow.set(leftIndex, (rightRow.get(leftIndex) ?? 0) + contribution);
      }
    }
  }
  return adjacency;
}

/**
 * The similarity graph in the shape PageRank reads it. For sentence i,
 * `neighborIndexes[i][k]` is a sentence that resembles it and
 * `inboundShares[i][k]` is the fraction of that neighbour's score which flows
 * to i - its similarity divided by the neighbour's total similarity.
 *
 * Dividing once here rather than on every iteration reduces the inner loop to a
 * single multiply per edge, and typed arrays avoid the per-entry allocation that
 * iterating a Map of edges costs. On a document whose sentences nearly all
 * resemble each other, that inner loop runs tens of thousands of times per
 * iteration, so it is the difference between a few milliseconds and tens.
 */
type TransitionGraph = {
  neighborIndexes: Int32Array[];
  inboundShares: Float64Array[];
};

function buildTransitionGraph(adjacency: Map<number, number>[]): TransitionGraph {
  const outgoingTotals = adjacency.map((row) => {
    let total = 0;
    for (const weight of row.values()) total += weight;
    return total;
  });

  const neighborIndexes: Int32Array[] = [];
  const inboundShares: Float64Array[] = [];
  for (const row of adjacency) {
    const indexes = new Int32Array(row.size);
    const shares = new Float64Array(row.size);
    let slot = 0;
    for (const [neighbor, weight] of row) {
      indexes[slot] = neighbor;
      // Any sentence that appears as someone's neighbour has at least that one
      // edge, and every edge weight is a product of positive term weights, so
      // this total is never zero.
      shares[slot] = weight / outgoingTotals[neighbor]!;
      slot++;
    }
    neighborIndexes.push(indexes);
    inboundShares.push(shares);
  }
  return { neighborIndexes, inboundShares };
}

/** Scores plus how the loop that produced them ended. */
type PageRankResult = {
  scores: number[];
  iterations: number;
  converged: boolean;
};

/**
 * Weighted PageRank over the similarity graph. A sentence scores highly when
 * sentences that themselves score highly resemble it, which is how the central
 * topic of a document rises above its asides. A sentence sharing no terms with
 * any other has no inbound edges and simply keeps the baseline score.
 *
 * The iteration count and the convergence flag are returned rather than kept
 * private because "the scores settled" is not observable from the scores
 * themselves: a run stopped early by the cap looks exactly like a converged one.
 */
function pageRank(graph: TransitionGraph): PageRankResult {
  const nodeCount = graph.neighborIndexes.length;
  const baseline = (1 - DAMPING) / nodeCount;
  let scores = new Float64Array(nodeCount).fill(1 / nodeCount);
  let iterations = 0;
  let converged = false;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const next = new Float64Array(nodeCount);
    let largestChange = 0;
    for (let node = 0; node < nodeCount; node++) {
      const neighbors = graph.neighborIndexes[node]!;
      const shares = graph.inboundShares[node]!;
      let inbound = 0;
      for (let edge = 0; edge < neighbors.length; edge++) {
        inbound += shares[edge]! * scores[neighbors[edge]!]!;
      }
      const updated = baseline + DAMPING * inbound;
      next[node] = updated;
      largestChange = Math.max(largestChange, Math.abs(updated - scores[node]!));
    }
    scores = next;
    if (largestChange < CONVERGENCE_THRESHOLD) {
      converged = true;
      break;
    }
  }
  return { scores: [...scores], iterations, converged };
}

/**
 * A ranking plus what the scorer did to produce it.
 *
 * `converged` describes the scores actually returned: false means the iteration
 * cap stopped the loop before the scores settled, so the ordering is a good
 * approximation rather than the fixed point. An empty selection has no unsettled
 * scores in it, so it reports converged with zero iterations.
 *
 * `sentenceCount` is how many sentences the source split into, which is the
 * number `RANKING_SENTENCE_CEILING` is expressed in, so a caller can see after
 * the fact how large an input it handed over.
 */
export type SentenceRanking = {
  sentences: RankedSentence[];
  sentenceCount: number;
  iterations: number;
  converged: boolean;
};

/**
 * Largest input, in sentences, this module is meant to rank in a single call.
 *
 * Exported as a number rather than left as advice in prose so a caller can test
 * an input against it and split the work up, instead of discovering the cost at
 * request time. See `rankSentences` for the measured curve behind the value.
 */
export const RANKING_SENTENCE_CEILING = 500;

/**
 * Select the most central sentences of `text` and return them in the order
 * they appear in the source, not in score order - selected lines only read as a
 * summary when they keep the author's sequence.
 *
 * `sourceIndex` is the position in `splitSentences(stripMarkdownSyntax(text))`,
 * so a caller can always trace a line back to where it came from.
 *
 * Degenerate inputs return an empty array rather than throwing: no text, no
 * sentences, a non-positive limit, or a limit of `NaN` all mean "nothing to
 * summarize". Any limit at or above the sentence count yields every sentence in
 * source order, `Infinity` included, since asking for no limit at all is the
 * same request as asking for more than there is.
 *
 * Cost grows with the number of sentence pairs that share a term, which for
 * ordinary prose means roughly the square of the sentence count once a document
 * is long enough that common words appear throughout. Measured on a development
 * machine: 250 sentences in 25-35 ms, 500 in 110-200 ms, 1,000 in 0.5-1.3 s,
 * 2,000 in 3-6 s. Each range is how much vocabulary the sentences share, with a
 * document whose sentences nearly all resemble one another at the top of it.
 *
 * Nothing here truncates a long input. Ranking the front of a document and
 * returning the result as its summary would break the provenance the whole
 * extractive design exists to provide, and a limit the caller cannot see is
 * worse than one it is told about. Bounding the cost is the caller's job
 * instead: keep a call at or under `RANKING_SENTENCE_CEILING` sentences and
 * summarize anything longer in sections.
 */
export function rankSentences(
  text: string,
  maxSentences: number,
): RankedSentence[] {
  return rankSentencesWithDiagnostics(text, maxSentences).sentences;
}

/**
 * `rankSentences` plus the diagnostics described on `SentenceRanking`, for a
 * caller that needs to show the numbers settled rather than assume it.
 */
export function rankSentencesWithDiagnostics(
  text: string,
  maxSentences: number,
): SentenceRanking {
  const sentences = splitSentences(stripMarkdownSyntax(text));
  // A limit of NaN is not a count of anything, so it selects nothing rather than
  // being rounded into one. Infinity is a count - all of them - and falls
  // through to the clamp below.
  const wantsNothing = Number.isNaN(maxSentences) || maxSentences < 1;
  if (wantsNothing || sentences.length === 0) {
    return {
      sentences: [],
      sentenceCount: sentences.length,
      iterations: 0,
      converged: true,
    };
  }
  const limit = Math.min(Math.floor(maxSentences), sentences.length);

  const vectors = buildTfIdfVectors(countTerms(sentences));
  const ranking = pageRank(buildTransitionGraph(buildAdjacency(vectors)));
  const ranked: RankedSentence[] = sentences.map((sentence, sourceIndex) => ({
    sentence,
    sourceIndex,
    score: ranking.scores[sourceIndex]!,
  }));

  // Sort by score to choose the winners, then restore reading order. Ties break
  // on position so the same input always produces the same summary.
  const selected = ranked
    .sort(
      (left, right) =>
        right.score - left.score || left.sourceIndex - right.sourceIndex,
    )
    .slice(0, limit);
  selected.sort((left, right) => left.sourceIndex - right.sourceIndex);
  return {
    sentences: selected,
    sentenceCount: sentences.length,
    iterations: ranking.iterations,
    converged: ranking.converged,
  };
}

/**
 * The most significant content words in `text`, most significant first,
 * lowercased and deduplicated. Ranked by TF-IDF over the same sentence-as-
 * document model the sentence ranking uses, so a word that recurs throughout
 * beats one that happens to be rare, and hyphenated compounds survive whole.
 *
 * Limits behave as they do in `rankSentences`: nothing for a non-positive limit
 * or for `NaN`, and every keyword found for a limit at or above their count,
 * `Infinity` included.
 */
export function extractKeywords(text: string, maxKeywords: number): string[] {
  if (Number.isNaN(maxKeywords) || maxKeywords < 1) return [];
  const sentences = splitSentences(stripMarkdownSyntax(text));
  if (sentences.length === 0) return [];

  const perSentence = countTerms(sentences);
  const documentFrequency = countDocumentFrequencies(perSentence);
  const totalCounts: TermCounts = new Map();
  for (const counts of perSentence) {
    for (const [term, count] of counts) {
      totalCounts.set(term, (totalCounts.get(term) ?? 0) + count);
    }
  }

  const scored = [...totalCounts].map(([term, count]) => ({
    term,
    score:
      count *
      inverseDocumentFrequency(
        sentences.length,
        documentFrequency.get(term) ?? 0,
      ),
  }));
  // Alphabetical tie-break keeps the keyword list stable across runs.
  scored.sort(
    (left, right) =>
      right.score - left.score || left.term.localeCompare(right.term),
  );
  return scored.slice(0, Math.floor(maxKeywords)).map((entry) => entry.term);
}
