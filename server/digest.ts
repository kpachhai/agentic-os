import { createHash } from "node:crypto";
import type { DigestDefaults } from "./config.js";
import { readabilityStats } from "./text/readability.js";
import { splitSentences, stripMarkdownSyntax } from "./text/sentences.js";
import { extractKeywords, rankSentences } from "./text/textrank.js";

/**
 * Where a line of digest text came from. Rendered on every line, because the one
 * thing a reader must never be unable to work out is whether they are looking at
 * their own words or a machine's paraphrase of them.
 *
 *  - "verbatim"   a field the operator wrote, reproduced exactly
 *  - "selected"   one of their own sentences, chosen by ranking; links to its source
 *  - "paraphrase" written by a local model from one source record
 */
export type Provenance = "verbatim" | "selected" | "paraphrase";

export type DigestLine = {
  text: string;
  provenance: Provenance;
  /** Index into the source sentences for a selected line; null otherwise. */
  sourceIndex: number | null;
  /** The exact source text a selected or paraphrased line was derived from. */
  sourceText: string | null;
};

export type Digest = {
  lines: DigestLine[];
  keywords: string[];
  /**
   * Flesch-Kincaid grade of the digest text. Exposed rather than kept internal so
   * the acceptance gate can assert a ceiling: a mechanical threshold can fail,
   * where "reads well" cannot.
   */
  grade: number;
  sentenceCount: number;
  /** Tiers that actually contributed, so the UI can say what it is showing. */
  tiers: Array<"structural" | "extractive" | "abstractive">;
};

/** How many sentences an extractive digest selects. */
const DIGEST_SENTENCES = 3;

/**
 * A source record reduced to what the digest engine needs.
 *
 * `verbatimSummary` is the operator's own one-line summary when the record has
 * one: a vault entry's description, a wrap's frontmatter description. It is the
 * best text available and needs no processing at all, which is why it is a
 * separate field rather than something to be discovered in the body.
 */
export type DigestSource = {
  verbatimSummary?: string;
  body: string;
};

/**
 * Build the always-available part of a digest: the operator's own summary if there
 * is one, then their own most central sentences.
 *
 * Nothing here can invent text. Extractive selection returns existing sentences,
 * so every line is traceable to an offset in the source, which is what makes the
 * provenance claim above honest rather than decorative.
 */
export function buildDigest(source: DigestSource): Digest {
  const lines: DigestLine[] = [];
  const tiers: Digest["tiers"] = [];

  const summary = source.verbatimSummary?.trim();
  if (summary) {
    lines.push({
      text: summary,
      provenance: "verbatim",
      sourceIndex: null,
      sourceText: summary,
    });
    tiers.push("structural");
  }

  const stripped = stripMarkdownSyntax(source.body);
  const sentences = splitSentences(stripped);

  // Selecting from a document that is already one or two sentences long produces
  // the document back, which is noise next to a summary that is already present.
  if (sentences.length > DIGEST_SENTENCES) {
    for (const ranked of rankSentences(source.body, DIGEST_SENTENCES)) {
      lines.push({
        text: ranked.sentence,
        provenance: "selected",
        sourceIndex: ranked.sourceIndex,
        sourceText: ranked.sentence,
      });
    }
    tiers.push("extractive");
  } else if (!summary && sentences.length > 0) {
    // Short and with no summary of its own: the body IS the digest, verbatim.
    for (const [index, sentence] of sentences.entries()) {
      lines.push({
        text: sentence,
        provenance: "verbatim",
        sourceIndex: index,
        sourceText: sentence,
      });
    }
    tiers.push("structural");
  }

  const digestText = lines.map((line) => line.text).join(" ");
  return {
    lines,
    keywords: extractKeywords(source.body, 6),
    grade: readabilityStats(digestText).grade,
    sentenceCount: sentences.length,
    tiers,
  };
}

// ---- Optional local model ----

export type LocalModelState =
  | { state: "ready"; url: string; model: string | null; detail: string }
  | { state: "loading"; url: string; detail: string }
  | { state: "absent"; probed: string[]; detail: string };

/**
 * Loopback endpoints worth probing, in order.
 *
 * All three expose an OpenAI-compatible chat endpoint, so one request shape works
 * against whichever is running. The configured URL is tried first; the other two
 * are the default ports of the common runners, so an operator who already has one
 * running gets the feature with no configuration.
 *
 * Every candidate must be loopback. A remote address here would turn a local
 * paraphrase into shipping the operator's notes to somebody else's server, which
 * is the one thing this tool must never do.
 */
function candidateUrls(digest: DigestDefaults): string[] {
  const candidates = [
    digest.localModelUrl,
    "http://127.0.0.1:11434",
    "http://127.0.0.1:1234",
  ];
  return [...new Set(candidates.filter(isLoopbackUrl))];
}

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}

/** Short timeout: a runner that is not listening must not stall a page. */
const PROBE_TIMEOUT_MS = 1200;

async function probeOne(base: string): Promise<LocalModelState | null> {
  // Three states matter, not two. A runner that is up but still loading its model
  // is neither ready nor absent, and telling the operator "no model found" while
  // it warms up would send them chasing a problem about to resolve itself.
  //
  // "Loading" is only trusted from a /health endpoint that looks like a model
  // runner's. Any HTTP service can answer 503.
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (health.status === 503 && (await looksLikeLoadingBody(health))) {
      return { state: "loading", url: base, detail: "model is still loading" };
    }
  } catch {
    // No /health here. Not conclusive; the model list below is the real test.
  }

  // Readiness requires a NAMED MODEL, not merely a reachable port. Ports get
  // reused: the llama.cpp default of 8080 is also where any number of dev servers
  // listen, and one of those answering /health with a 200 was enough to make this
  // report a model that did not exist. The paraphrase then failed at the point of
  // use with an HTTP 426, which is the wrong place to discover it. So a candidate
  // counts as ready only when it lists at least one model it can serve.
  const model = await firstModelName(base);
  if (model) return { state: "ready", url: base, model, detail: `serving ${model}` };
  return null;
}

/**
 * Does a 503 body read like a model runner warming up, rather than a generic
 * service being unavailable?
 */
async function looksLikeLoadingBody(res: Response): Promise<boolean> {
  try {
    return /loading/i.test((await res.text()).slice(0, 500));
  } catch {
    return false;
  }
}

/**
 * The first model the endpoint says it can serve, or null.
 *
 * Returns null rather than an empty string for "nothing usable here", so a
 * response with no model list can never be mistaken for a served model with a
 * blank name - which is exactly how a dev server on the same port passed for a
 * model runner.
 */
async function firstModelName(base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data) || body.data.length === 0) return null;
    const first = (body.data[0] as { id?: unknown }).id;
    return typeof first === "string" && first.trim() ? first : null;
  } catch {
    return null;
  }
}

/**
 * Find a local model runner, or report that there is none.
 *
 * Absence is a first-class answer, reported the same way a missing data source is:
 * this tool installs nothing, downloads nothing, and starts nothing on the
 * operator's behalf.
 */
export async function probeLocalModel(
  digest: DigestDefaults,
): Promise<LocalModelState> {
  const probed = candidateUrls(digest);
  for (const base of probed) {
    const found = await probeOne(base);
    if (found) return found;
  }
  return {
    state: "absent",
    probed,
    detail:
      "no local model server is listening; plain-language rewriting is unavailable " +
      "until one is running. Nothing is downloaded or started automatically.",
  };
}

/**
 * The one job the model is trusted with.
 *
 * It receives a single already-paired, already-classified record and returns one
 * sentence. It never sees a list, never counts anything, and never decides a
 * status, because those are exactly the things a small local model gets wrong
 * while looking authoritative: given five friction and resolution lines under a
 * strict schema, a 3B model returned valid JSON whose themes contradicted its own
 * count, and a 1.5B model paired nothing correctly. Grammar constraints guarantee
 * the shape of a reply and say nothing about its truth.
 *
 * So pairing, counting and classification stay in TypeScript, and the model is
 * left with the one task it is genuinely good at: turning one structured record
 * into one plain sentence.
 */
const PARAPHRASE_SYSTEM =
  "You rewrite one record as a single plain-language sentence a non-technical " +
  "reader understands. Reply with that one sentence only. Do not add detail that " +
  "is not in the record, do not count anything, and do not judge whether the " +
  "record is resolved or unresolved.";

const PARAPHRASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentence"],
  properties: { sentence: { type: "string" } },
};

/** Generation is slow on CPU, so the cap is generous but finite. */
const PARAPHRASE_TIMEOUT_MS = 90_000;

export type ParaphraseResult = {
  sentence: string;
  model: string | null;
  /** Content hash of the input, which is also the cache key. */
  hash: string;
};

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Results are cached by a hash of the input text. Regenerating is measured in
 * seconds per record on a CPU-only machine, and the same record produces the same
 * sentence, so recomputing it would be pure latency.
 */
const paraphraseCache = new Map<string, ParaphraseResult>();

export function cachedParaphrase(text: string): ParaphraseResult | null {
  return paraphraseCache.get(contentHash(text)) ?? null;
}

export async function paraphrase(
  state: LocalModelState,
  text: string,
): Promise<ParaphraseResult> {
  if (state.state !== "ready") {
    throw new Error(`local model is not ready: ${state.detail}`);
  }
  const hash = contentHash(text);
  const cached = paraphraseCache.get(hash);
  if (cached) return cached;

  const res = await fetch(`${state.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(PARAPHRASE_TIMEOUT_MS),
    body: JSON.stringify({
      ...(state.model ? { model: state.model } : {}),
      messages: [
        { role: "system", content: PARAPHRASE_SYSTEM },
        { role: "user", content: text },
      ],
      // Schema-constrained decoding. Note that this guarantees the reply parses,
      // not that it is true; the prompt above is what keeps the task narrow
      // enough for truth to follow.
      response_format: {
        type: "json_schema",
        json_schema: { name: "paraphrase", strict: true, schema: PARAPHRASE_SCHEMA },
      },
      temperature: 0.2,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`local model returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("local model reply had no message content");
  }

  let sentence: string;
  try {
    const parsed = JSON.parse(content) as { sentence?: unknown };
    if (typeof parsed.sentence !== "string" || !parsed.sentence.trim()) {
      throw new Error("reply did not carry a sentence");
    }
    sentence = parsed.sentence.trim();
  } catch (err) {
    throw new Error(`local model reply was not the requested shape: ${err}`);
  }

  const result: ParaphraseResult = { sentence, model: state.model, hash };
  paraphraseCache.set(hash, result);
  return result;
}

/**
 * Fold a paraphrase into a digest as an additional line.
 *
 * It is appended rather than substituted: the operator's own words stay on screen
 * next to the rewrite, so the rewrite can be checked against them rather than
 * replacing them.
 */
export function withParaphrase(
  digest: Digest,
  paraphrased: ParaphraseResult,
  sourceText: string,
): Digest {
  return {
    ...digest,
    lines: [
      ...digest.lines,
      {
        text: paraphrased.sentence,
        provenance: "paraphrase",
        sourceIndex: null,
        sourceText,
      },
    ],
    tiers: [...digest.tiers, "abstractive"],
  };
}
