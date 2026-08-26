import { describe, expect, it } from "vitest";
import {
  BLOCK_MS,
  CACHE_READ_MULTIPLIER,
  costOf,
  isUnbilled,
  PRICING_AS_OF,
  PRICING_SHELF_LIFE_DAYS,
  pricedModels,
  pricingFreshness,
  rateFor,
  totalCost,
  usageBlocks,
  usageTotals,
} from "../server/pricing.js";

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

describe("vendored rates", () => {
  it("carries a verification date, because the table goes stale silently", () => {
    // Every figure derived from this table is only as good as this date, so it
    // ships alongside the numbers rather than living in a comment.
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(`${PRICING_AS_OF}T00:00:00Z`))).toBe(false);
  });

  it("refuses a verification date in the future", () => {
    // Staleness is a matter of degree and stays advisory; a date later than today
    // is not. It is well-formed and impossible, which means the constant was
    // mistyped - and a mistyped date makes every age computed from it wrong in
    // the direction that says the table is fresh.
    expect(pricingFreshness().fromFuture).toBe(false);
  });

  it("measures the table's age against an injected clock, on both sides of the shelf life", () => {
    // Dated against a fixed clock rather than today's, so this asserts the
    // arithmetic instead of reddening on a morning nobody touched the code.
    const dayAfter = (days: number): Date =>
      new Date(Date.parse(`${PRICING_AS_OF}T00:00:00Z`) + days * 86_400_000);

    const fresh = pricingFreshness(dayAfter(PRICING_SHELF_LIFE_DAYS));
    expect(fresh.ageDays).toBe(PRICING_SHELF_LIFE_DAYS);
    expect(fresh.stale).toBe(false);

    const expired = pricingFreshness(dayAfter(PRICING_SHELF_LIFE_DAYS + 1));
    expect(expired.ageDays).toBe(PRICING_SHELF_LIFE_DAYS + 1);
    expect(expired.stale).toBe(true);

    // The same-day case, so an age of zero is reported as zero rather than as
    // something falsy that a caller reads as "unknown".
    expect(pricingFreshness(dayAfter(0)).ageDays).toBe(0);
    expect(pricingFreshness(dayAfter(-1)).fromFuture).toBe(true);
  });

  it("prices the current model families", () => {
    expect(rateFor("claude-opus-5")).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 25,
    });
    expect(rateFor("claude-haiku-4-5")).toEqual({
      inputPerMillion: 1,
      outputPerMillion: 5,
    });
    expect(pricedModels().length).toBeGreaterThan(5);
  });

  it("refuses to guess a rate from a model-name prefix", () => {
    // A family guess would price an unknown model at a neighbour's rate and
    // present the result as confidently as a real one.
    expect(rateFor("claude-opus-9")).toBeNull();
    expect(rateFor("claude-opus")).toBeNull();
    expect(rateFor("")).toBeNull();
  });

  it("prices a dated snapshot as its alias", () => {
    // Real transcripts name Haiku by its snapshot. Missing this left an entire
    // five-hour window reporting no cost over two records.
    expect(rateFor("claude-haiku-4-5-20251001")).toEqual(rateFor("claude-haiku-4-5"));
  });

  it("does not mistake a version segment for a date", () => {
    // The suffix rule must require exactly eight digits, or trimming would eat the
    // minor version and price Opus 4.8 as some other model entirely.
    expect(rateFor("claude-opus-4-8")).not.toBeNull();
    expect(rateFor("claude-opus-4-8")).toEqual(rateFor("claude-opus-5"));
    expect(rateFor("claude-sonnet-4-6")).not.toEqual(rateFor("claude-sonnet-4"));
    // Four digits is not a date either; a made-up suffix stays unknown.
    expect(rateFor("claude-haiku-4-5-2025")).toBeNull();
  });
});

describe("costOf", () => {
  it("charges output at its own higher rate", () => {
    const cost = costOf("claude-opus-5", { ...NO_TOKENS, output: 1_000_000 });
    expect(cost.outputUsd).toBeCloseTo(25, 6);
    expect(cost.totalUsd).toBeCloseTo(25, 6);
  });

  it("charges a cache read at a fraction of base input", () => {
    // This is why a session with billions of cache-read tokens can still be cheap,
    // and the single most load-bearing multiplier in the file.
    const cost = costOf("claude-opus-5", { ...NO_TOKENS, cacheRead: 1_000_000 });
    expect(cost.cacheReadUsd).toBeCloseTo(5 * CACHE_READ_MULTIPLIER, 6);
  });

  it("charges a cache write above base input", () => {
    const cost = costOf("claude-opus-5", { ...NO_TOKENS, cacheCreation: 1_000_000 });
    expect(cost.cacheWriteUsd!).toBeGreaterThan(5);
  });

  it("reports an unknown model as not priced rather than free", () => {
    // A silent zero would understate a total with nothing on screen to say so.
    const cost = costOf("some-future-model", { ...NO_TOKENS, output: 1_000_000 });
    expect(cost.priced).toBe(false);
    expect(cost.totalUsd).toBeNull();
    expect(cost.note).toContain("not priced");
  });

  it("treats a locally generated pseudo-model as unbilled, not unknown", () => {
    // Regression: <synthetic> appears in real transcripts and is never charged.
    // Treating it as an unknown model blanked the cost of a whole five-hour
    // window over tokens nobody paid for.
    expect(isUnbilled("<synthetic>")).toBe(true);
    const cost = costOf("<synthetic>", { ...NO_TOKENS, output: 5_000_000 });
    expect(cost.priced).toBe(true);
    expect(cost.totalUsd).toBe(0);
  });

  it("surfaces an introductory-rate caveat instead of hiding it", () => {
    expect(costOf("claude-sonnet-5", NO_TOKENS).note).toMatch(/introductory/i);
  });
});

describe("totalCost", () => {
  it("keeps the unpriced remainder visible beside the total", () => {
    const cost = totalCost(
      new Map([
        ["claude-opus-5", { ...NO_TOKENS, output: 1_000_000 }],
        ["mystery-model", { ...NO_TOKENS, output: 2_000_000 }],
      ]),
    );
    expect(cost.totalUsd).toBeCloseTo(25, 6);
    expect(cost.unpricedModels).toEqual(["mystery-model"]);
    // The gap has a size, so a reader can judge how incomplete the total is.
    expect(cost.unpricedTokens).toBe(2_000_000);
  });

  it("does not let an unbilled pseudo-model count as an unpriced gap", () => {
    const cost = totalCost(
      new Map([
        ["claude-opus-5", { ...NO_TOKENS, output: 1_000_000 }],
        ["<synthetic>", { ...NO_TOKENS, output: 9_000_000 }],
      ]),
    );
    expect(cost.unpricedModels).toEqual([]);
    expect(cost.totalUsd).toBeCloseTo(25, 6);
  });
});

describe("usageBlocks", () => {
  const tokens = { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 };

  it("groups five hours of activity into one window", () => {
    const base = Date.parse("2026-07-01T00:00:00.000Z");
    const blocks = usageBlocks([
      { timestamp: new Date(base).toISOString(), sessionId: "a", model: "claude-opus-5", tokens },
      { timestamp: new Date(base + 60_000).toISOString(), sessionId: "b", model: "claude-opus-5", tokens },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.sessions).toBe(2);
    expect(blocks[0]!.turns).toBe(2);
    expect(blocks[0]!.tokens.output).toBe(40);
  });

  it("splits activity that crosses a window boundary", () => {
    const base = Date.parse("2026-07-01T00:00:00.000Z");
    const blocks = usageBlocks([
      { timestamp: new Date(base).toISOString(), sessionId: "a", model: "claude-opus-5", tokens },
      { timestamp: new Date(base + BLOCK_MS + 1000).toISOString(), sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("aligns windows to the epoch, not to the first record", () => {
    // Aligning to the data would make a window's identity depend on the query, so
    // two overlapping views would disagree about which block a turn belongs to.
    const odd = "2026-07-01T03:47:11.000Z";
    const [block] = usageBlocks([
      { timestamp: odd, sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    expect(Date.parse(block!.startedAt) % BLOCK_MS).toBe(0);
    expect(Date.parse(block!.startedAt)).toBeLessThanOrEqual(Date.parse(odd));
  });

  it("reports no cost for a window containing a genuinely unpriced model", () => {
    const [block] = usageBlocks([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
      { timestamp: "2026-07-01T00:01:00.000Z", sessionId: "a", model: "mystery", tokens },
    ]);
    // Partial money is worse than none: a figure on screen must not be quietly
    // missing a model's contribution.
    expect(block!.costUsd).toBeNull();
  });

  it("skips an unparseable timestamp rather than bucketing it at the epoch", () => {
    const blocks = usageBlocks([
      { timestamp: "not a date", sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    expect(blocks).toEqual([]);
  });

  it("returns newest window first", () => {
    const blocks = usageBlocks([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
      { timestamp: "2026-07-02T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    expect(blocks[0]!.startedAt > blocks[1]!.startedAt).toBe(true);
  });
});

/**
 * The corpus-wide figures the blocks payload used to compute per block and throw
 * away. The point of them is the two questions a block's single scalar cannot
 * answer: which model the money goes to, and what caching costs against what it
 * saves.
 */
describe("usageTotals", () => {
  const tokens = { input: 1000, output: 2000, cacheRead: 30000, cacheCreation: 4000 };

  it("adds a model's turns together rather than reporting the last one", () => {
    const one = usageTotals([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    const two = usageTotals([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
      { timestamp: "2026-07-01T01:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    expect(two.perModel).toHaveLength(1);
    expect(two.totalUsd).toBeCloseTo(one.totalUsd * 2, 8);
  });

  it("splits cost by token kind, so caching can be weighed", () => {
    const totals = usageTotals([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    const row = totals.perModel[0]!;
    // Every kind is priced separately or the question "is my caching saving money"
    // has no answer on screen.
    for (const part of [row.inputUsd, row.outputUsd, row.cacheReadUsd, row.cacheWriteUsd]) {
      expect(part).not.toBeNull();
    }
    expect(row.totalUsd).toBeCloseTo(
      row.inputUsd! + row.outputUsd! + row.cacheReadUsd! + row.cacheWriteUsd!,
      8,
    );
  });

  it("ranks models by spend", () => {
    const totals = usageTotals([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-haiku-4-5", tokens },
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
    ]);
    expect(totals.perModel.map((row) => row.model)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
    ]);
  });

  it("keeps an unpriced model's tokens visible beside the total", () => {
    // Unlike a block, which reports null cost outright, this reports what it could
    // price and gives the gap a size - so the shortfall is on screen rather than
    // collapsing the whole answer.
    const totals = usageTotals([
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "claude-opus-5", tokens },
      { timestamp: "2026-07-01T00:00:00.000Z", sessionId: "a", model: "not-a-real-model", tokens },
    ]);
    expect(totals.unpricedModels).toEqual(["not-a-real-model"]);
    expect(totals.unpricedTokens).toBe(37000);
    expect(totals.totalUsd).toBeGreaterThan(0);
    expect(totals.perModel.find((r) => r.model === "not-a-real-model")!.totalUsd).toBeNull();
  });

  it("reports no models at all for an empty read", () => {
    const totals = usageTotals([]);
    expect(totals.perModel).toEqual([]);
    expect(totals.totalUsd).toBe(0);
    expect(totals.unpricedTokens).toBe(0);
  });
});
