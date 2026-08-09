/**
 * Vendored model pricing, so token counts can be read as money without this tool
 * ever making a network call.
 *
 * THE PATTERN, AND WHY: prices are embedded here and refreshed by a deliberate
 * commit, never fetched at runtime. A dashboard that phones a pricing API to
 * render a cost figure has quietly become a tool that talks to the internet, and
 * this one's whole claim is that it does not. The cost of the pattern is that the
 * table goes stale silently, so every figure derived from it is labelled with the
 * date below and the UI says so.
 *
 * VERIFY BEFORE EDITING. These are published list prices, not guesses, and a
 * wrong number here produces confident wrong money. Re-check against Anthropic's
 * pricing documentation and update `PRICING_AS_OF` in the same commit.
 *
 * Unknown model: cost is null rather than zero. A model missing from this table
 * must read as "not priced", never as "free" - a silent zero would understate a
 * total and there would be nothing on screen to say so.
 */

/** Date the rates below were last verified against published pricing. */
export const PRICING_AS_OF = "2026-06-24";

export type ModelRate = {
  /** US dollars per million input tokens. */
  inputPerMillion: number;
  /** US dollars per million output tokens. */
  outputPerMillion: number;
  /** Note carried into the UI, e.g. an introductory rate with an end date. */
  note?: string;
};

/**
 * Cache multipliers, applied to the model's own input rate.
 *
 * A cache read costs about a tenth of base input. A cache write costs more than
 * base input, and how much more depends on the entry's lifetime: the longer TTL
 * doubles the write. Reads dominate any real workload, which is why a session
 * with billions of cache-read tokens can still be inexpensive.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/**
 * Rates by model id. Keys are the exact ids that appear in transcript records,
 * so a lookup is a plain map hit rather than a guess at a family.
 */
const RATES: Record<string, ModelRate> = {
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-mythos-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    note: "introductory rate of $2 / $10 applies through 2026-08-31",
  },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type CostBreakdown = {
  model: string;
  /** Null when the model is not in the table; never zero. */
  totalUsd: number | null;
  inputUsd: number | null;
  outputUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  priced: boolean;
  note: string | null;
};

/**
 * Resolve a model id to a rate.
 *
 * Exact match only. A prefix or family guess would price an unknown model at a
 * neighbour's rate and present the result with the same confidence as a real
 * figure, which is worse than declining to price it.
 */
/**
 * Some transcripts name a model by its dated snapshot rather than its alias -
 * `claude-haiku-4-5-20251001` for what this table keys as `claude-haiku-4-5`.
 * A snapshot is the same model at the same price, so the suffix is dropped before
 * lookup. Requiring exactly eight digits keeps it from touching a version segment:
 * `claude-opus-4-8` must survive intact.
 */
const DATED_SNAPSHOT_SUFFIX = /-\d{8}$/;

export function rateFor(model: string): ModelRate | null {
  return RATES[model] ?? RATES[model.replace(DATED_SNAPSHOT_SUFFIX, "")] ?? null;
}

/**
 * Pseudo-models that appear in transcripts but are never billed.
 *
 * Claude Code records `<synthetic>` on messages it generated locally rather than
 * requesting from a model. It is not an unknown model whose price this table is
 * missing, so treating it as unpriced would blank a real cost figure for a whole
 * window over tokens nobody was charged for - which is what happened before this
 * existed. Zero-cost is the accurate answer, not a workaround.
 */
const UNBILLED_MODELS = new Set(["<synthetic>"]);

export function isUnbilled(model: string): boolean {
  return UNBILLED_MODELS.has(model);
}

/** Every model this table can price, for the UI to show what it covers. */
export function pricedModels(): string[] {
  return Object.keys(RATES).sort();
}

/**
 * Cost of one model's token counts.
 *
 * Cache writes are charged at the 5-minute multiplier. Transcripts record a
 * combined cache-creation figure without splitting the two lifetimes reliably, so
 * the cheaper of the two is used and the result is a lower bound rather than a
 * number pretending to precision it does not have.
 */
export function costOf(model: string, tokens: TokenCounts): CostBreakdown {
  if (isUnbilled(model)) {
    return {
      model,
      totalUsd: 0,
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWriteUsd: 0,
      priced: true,
      note: "locally generated, never billed",
    };
  }
  const rate = rateFor(model);
  if (!rate) {
    return {
      model,
      totalUsd: null,
      inputUsd: null,
      outputUsd: null,
      cacheReadUsd: null,
      cacheWriteUsd: null,
      priced: false,
      note: `no vendored rate for ${model}; not priced`,
    };
  }

  const perToken = rate.inputPerMillion / 1_000_000;
  const inputUsd = tokens.input * perToken;
  const outputUsd = (tokens.output * rate.outputPerMillion) / 1_000_000;
  const cacheReadUsd = tokens.cacheRead * perToken * CACHE_READ_MULTIPLIER;
  const cacheWriteUsd =
    tokens.cacheCreation * perToken * CACHE_WRITE_5M_MULTIPLIER;

  return {
    model,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    priced: true,
    note: rate.note ?? null,
  };
}

export type TotalCost = {
  totalUsd: number;
  /** Models encountered that this table cannot price. */
  unpricedModels: string[];
  /** Tokens belonging to those models, so the gap has a size. */
  unpricedTokens: number;
  perModel: CostBreakdown[];
  asOf: string;
};

/**
 * Total cost across several models, keeping the unpriced remainder visible.
 *
 * The unpriced part is reported alongside the total rather than folded into it. A
 * single number that silently omitted an unknown model would be an understatement
 * the reader could not detect.
 */
export function totalCost(byModel: Map<string, TokenCounts>): TotalCost {
  let totalUsd = 0;
  const unpricedModels: string[] = [];
  let unpricedTokens = 0;
  const perModel: CostBreakdown[] = [];

  for (const [model, tokens] of byModel) {
    const breakdown = costOf(model, tokens);
    perModel.push(breakdown);
    if (breakdown.totalUsd === null) {
      unpricedModels.push(model);
      unpricedTokens +=
        tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
      continue;
    }
    totalUsd += breakdown.totalUsd;
  }

  return {
    totalUsd,
    unpricedModels: unpricedModels.sort(),
    unpricedTokens,
    perModel: perModel.sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1)),
    asOf: PRICING_AS_OF,
  };
}

// ---- Five-hour usage blocks ----

/**
 * Length of the window this tool groups usage into.
 *
 * Five hours is not arbitrary: it is the window a Claude subscription's own
 * limits are expressed in, which makes it the only unit that answers "am I
 * pacing?". Grouping by calendar day cannot: a day's total says nothing about
 * whether one afternoon burned a window's worth of headroom.
 */
export const BLOCK_MS = 5 * 60 * 60 * 1000;

export type UsageBlock = {
  /** Block start, aligned to the epoch so blocks are stable across reads. */
  startedAt: string;
  endedAt: string;
  tokens: TokenCounts;
  /** Distinct sessions with activity in this window. */
  sessions: number;
  turns: number;
  costUsd: number | null;
  models: string[];
};

export type BlockInput = {
  timestamp: string;
  sessionId: string;
  model: string;
  tokens: TokenCounts;
};

/**
 * Group per-turn usage into fixed five-hour blocks.
 *
 * Blocks are aligned to the epoch rather than to the first record, so the same
 * turn always lands in the same block no matter what range was read. Aligning to
 * the data would make a block's identity depend on the query, and two views of
 * overlapping ranges would disagree about which window a turn belonged to.
 */
export function usageBlocks(entries: BlockInput[]): UsageBlock[] {
  const blocks = new Map<
    number,
    {
      tokens: TokenCounts;
      sessions: Set<string>;
      turns: number;
      byModel: Map<string, TokenCounts>;
    }
  >();

  for (const entry of entries) {
    const at = Date.parse(entry.timestamp);
    if (Number.isNaN(at)) continue;
    const key = Math.floor(at / BLOCK_MS) * BLOCK_MS;

    let block = blocks.get(key);
    if (!block) {
      block = {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        sessions: new Set(),
        turns: 0,
        byModel: new Map(),
      };
      blocks.set(key, block);
    }

    block.tokens.input += entry.tokens.input;
    block.tokens.output += entry.tokens.output;
    block.tokens.cacheRead += entry.tokens.cacheRead;
    block.tokens.cacheCreation += entry.tokens.cacheCreation;
    block.sessions.add(entry.sessionId);
    block.turns++;

    const model = block.byModel.get(entry.model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    model.input += entry.tokens.input;
    model.output += entry.tokens.output;
    model.cacheRead += entry.tokens.cacheRead;
    model.cacheCreation += entry.tokens.cacheCreation;
    block.byModel.set(entry.model, model);
  }

  return [...blocks.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, block]) => {
      const cost = totalCost(block.byModel);
      return {
        startedAt: new Date(key).toISOString(),
        endedAt: new Date(key + BLOCK_MS).toISOString(),
        tokens: block.tokens,
        sessions: block.sessions.size,
        turns: block.turns,
        // A block containing any unpriced model reports no cost rather than a
        // partial one, so a figure on screen is never quietly incomplete.
        costUsd: cost.unpricedModels.length > 0 ? null : cost.totalUsd,
        models: [...block.byModel.keys()].sort(),
      };
    });
}

/**
 * Cost across every turn the caller read, per model and per token kind.
 *
 * `totalCost` already computed all of this and `usageBlocks` already called it,
 * once per block, and kept a single scalar from each. So the answers to "which
 * model is the money going to" and "is my caching saving anything" were being
 * computed and thrown away on every request, and the pricing blind spot was
 * asserted to exist without ever being given a size.
 *
 * Corpus-wide rather than per block on purpose. A block is five hours because that
 * is the window a subscription's limits are expressed in, which is the right frame
 * for "am I near a limit" and the wrong one for "what does this model cost me":
 * per-model spend in a five-hour slice is mostly a statement about which hour it
 * was. The blocks keep their own scalar cost, unchanged.
 *
 * Note what is deliberately different from a block's `costUsd`. A block reports
 * null when it contains any unpriced model, because a block's cost is a figure a
 * reader compares against other blocks and a partial one would be an
 * understatement they could not see. Here the total sits beside the unpriced model
 * list and token count, so the gap is on screen with its size rather than
 * collapsing the whole answer - the pillar can then say "this much, plus n tokens
 * of models the table cannot price".
 */
export function usageTotals(entries: BlockInput[]): TotalCost {
  const byModel = new Map<string, TokenCounts>();
  for (const entry of entries) {
    const running = byModel.get(entry.model) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    running.input += entry.tokens.input;
    running.output += entry.tokens.output;
    running.cacheRead += entry.tokens.cacheRead;
    running.cacheCreation += entry.tokens.cacheCreation;
    byModel.set(entry.model, running);
  }
  return totalCost(byModel);
}
