import { describe, expect, it } from "vitest";
import { count, day, shortProject, span, summarize } from "../src/delegation-report.js";
import type { DelegatedWork, SubagentDelegation } from "../src/delegation-types.js";

/**
 * The four formatters lifted out of DelegationView.tsx, which had no test of any
 * kind: the suite covers server/delegation.ts and never renders the view, so every
 * one of these could have changed silently.
 *
 * These are characterization tests. They record what the functions do TODAY,
 * including the rounding and the boundaries, so the extraction that moved them and
 * any later change to the view cannot alter a rendered figure without going red.
 * Where current behaviour looks arguable it is pinned as-is and said so, not fixed.
 */

describe("count", () => {
  it("groups thousands in en-US regardless of the host locale", () => {
    expect(count(1_234_567)).toBe("1,234,567");
    expect(count(1000)).toBe("1,000");
    expect(count(999)).toBe("999");
    expect(count(0)).toBe("0");
  });

  it("passes a fractional value through with en-US grouping", () => {
    // Nothing rounds first. Every caller happens to pass an integer today, so this
    // records what would happen rather than endorsing it.
    expect(count(1234.5)).toBe("1,234.5");
  });

  it("keeps a negative sign", () => {
    expect(count(-4200)).toBe("-4,200");
  });
});

describe("span", () => {
  it("reports minutes below one hour, rounded", () => {
    expect(span(0)).toBe("0m");
    expect(span(60_000)).toBe("1m");
    expect(span(90_000)).toBe("2m"); // 1.5m rounds up, not down
    expect(span(3_599_999)).toBe("60m"); // just under the hour still reads in minutes
  });

  it("switches to hours at exactly one hour", () => {
    expect(span(3_600_000)).toBe("1.0h");
    expect(span(5_400_000)).toBe("1.5h");
  });

  it("switches to days at exactly 48 hours", () => {
    expect(span(47 * 3_600_000)).toBe("47.0h");
    expect(span(48 * 3_600_000)).toBe("2.0d");
    expect(span(72 * 3_600_000)).toBe("3.0d");
  });

  it("gives one decimal place in both the hour and the day band", () => {
    expect(span(1_000 * 60 * 100)).toBe("1.7h");
    expect(span(3_600_000 * 60)).toBe("2.5d");
  });
});

describe("day", () => {
  it("states an absence rather than rendering an empty cell", () => {
    expect(day(null)).toBe("no date");
  });

  it("takes the date half of an ISO timestamp", () => {
    expect(day("2026-08-29T14:12:00Z")).toBe("2026-08-29");
    expect(day("2026-08-29")).toBe("2026-08-29");
  });

  it("slices the first ten characters without validating them", () => {
    // A plain slice, not a parse. Pinned because a caller passing something that is
    // not an ISO string gets a silently wrong label rather than an error.
    expect(day("not-a-date-at-all")).toBe("not-a-date");
    expect(day("")).toBe("");
  });
});

describe("shortProject", () => {
  it("returns one and two token labels whole", () => {
    expect(shortProject("engram")).toBe("engram");
    expect(shortProject("kpachhai-engram")).toBe("kpachhai-engram");
  });

  it("keeps only the last two tokens of a longer label", () => {
    expect(shortProject("Users-someone-repos-github-com-owner-engram")).toBe("...owner-engram");
  });

  it("strips a single leading slash before splitting", () => {
    expect(shortProject("/Users-someone-repos-engram")).toBe("...repos-engram");
  });

  it("drops empty tokens from repeated separators", () => {
    // filter(Boolean) means "a--b" is two tokens, not three, so a doubled separator
    // does not push a real token out of the visible tail.
    expect(shortProject("a--b")).toBe("a-b");
    expect(shortProject("w--x--y--z")).toBe("...y-z");
  });

  it("returns the original label when nothing survives the split", () => {
    expect(shortProject("")).toBe("");
    expect(shortProject("/")).toBe("/");
    expect(shortProject("---")).toBe("---");
  });
});

/**
 * `summarize` is the seven figures the view derives from the specialist rows.
 * Written before the view was switched over to it, so these pin the behaviour of
 * the original inline reduces rather than of whatever the extraction produced.
 */
function row(over: Partial<SubagentDelegation> = {}): SubagentDelegation {
  return {
    subagentType: "coder",
    dispatches: 0,
    projects: [],
    sessions: 0,
    firstDispatchAt: null,
    lastDispatchAt: null,
    modelOverrides: 0,
    modelsRequested: [],
    backgroundDispatches: 0,
    inlineDispatches: 0,
    launchModeUnknownDispatches: 0,
    worktreeIsolatedDispatches: 0,
    medianPromptChars: null,
    promptCharsMissing: 0,
    delegatedWork: null,
    ...over,
  };
}

const EMPTY_WORK: DelegatedWork = {
  transcripts: 0,
  owningSessions: 0,
  records: 0,
  toolCalls: 0,
  outputTokens: 0,
  recordsWithUsage: 0,
  firstRecordAt: null,
  lastRecordAt: null,
  wallClockMs: 0,
  transcriptsWithoutSpan: 0,
};

function work(over: Partial<DelegatedWork> = {}): DelegatedWork {
  return { ...EMPTY_WORK, ...over };
}

describe("summarize", () => {
  it("floors both bar denominators at 1 on an empty corpus", () => {
    // Load-bearing, not defensive: these divide bar widths, so a zero would be a
    // division by zero rather than an empty chart.
    const s = summarize([]);
    expect(s.mostDispatches).toBe(1);
    expect(s.mostRecords).toBe(1);
  });

  it("returns zero for every sum and count on an empty corpus", () => {
    const s = summarize([]);
    expect(s.recordsWithUsage).toBe(0);
    expect(s.transcriptsWithoutSpan).toBe(0);
    expect(s.promptCharsMissing).toBe(0);
    expect(s.dispatchedWithNothingBack).toBe(0);
    expect(s.workWithoutADispatch).toBe(0);
  });

  it("keeps the floor when every real value is below it", () => {
    const s = summarize([row({ dispatches: 0, delegatedWork: work({ records: 0 }) })]);
    expect(s.mostDispatches).toBe(1);
    expect(s.mostRecords).toBe(1);
  });

  it("treats a null delegatedWork as zero rather than skipping the row", () => {
    const s = summarize([
      row({ delegatedWork: null, promptCharsMissing: 5 }),
      row({ delegatedWork: work({ recordsWithUsage: 3, transcriptsWithoutSpan: 2, records: 9 }) }),
    ]);
    expect(s.recordsWithUsage).toBe(3);
    expect(s.transcriptsWithoutSpan).toBe(2);
    expect(s.promptCharsMissing).toBe(5); // read off the row, not off delegatedWork
    expect(s.mostRecords).toBe(9);
  });

  it("counts a dispatch with nothing attributed back", () => {
    const s = summarize([
      row({ dispatches: 4, delegatedWork: null }),
      row({ dispatches: 0, delegatedWork: null }), // neither dispatched nor attributed
      row({ dispatches: 2, delegatedWork: work() }),
    ]);
    expect(s.dispatchedWithNothingBack).toBe(1);
  });

  it("counts attributed work with no dispatch recorded", () => {
    const s = summarize([
      row({ dispatches: 0, delegatedWork: work() }),
      row({ dispatches: 1, delegatedWork: work() }),
      row({ dispatches: 0, delegatedWork: null }),
    ]);
    expect(s.workWithoutADispatch).toBe(1);
  });

  it("takes the maximum, not the sum, for the two denominators", () => {
    const s = summarize([
      row({ dispatches: 3, delegatedWork: work({ records: 10 }) }),
      row({ dispatches: 7, delegatedWork: work({ records: 4 }) }),
    ]);
    expect(s.mostDispatches).toBe(7);
    expect(s.mostRecords).toBe(10);
  });
});
