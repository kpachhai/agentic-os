import { describe, expect, it } from "vitest";
import { nextSort, sortRows, type SortState } from "../src/sortable.js";

type Row = { name: string; tokens: number | null };

const ROWS: Row[] = [
  { name: "beta", tokens: 50 },
  { name: "alpha", tokens: 900 },
  { name: "gamma", tokens: null },
  { name: "delta", tokens: 7 },
];

describe("sortRows", () => {
  it("orders numerically in both directions", () => {
    const desc = sortRows(ROWS, (r) => r.tokens, "desc").map((r) => r.name);
    const asc = sortRows(ROWS, (r) => r.tokens, "asc").map((r) => r.name);
    expect(desc.slice(0, 3)).toEqual(["alpha", "beta", "delta"]);
    expect(asc.slice(0, 3)).toEqual(["delta", "beta", "alpha"]);
  });

  it("sorts a missing value last in BOTH directions", () => {
    // Absent is not smaller than present. Letting null lead a descending sort would
    // put "not recorded" exactly where the reader looks for the largest figure.
    expect(sortRows(ROWS, (r) => r.tokens, "desc").at(-1)!.name).toBe("gamma");
    expect(sortRows(ROWS, (r) => r.tokens, "asc").at(-1)!.name).toBe("gamma");
  });

  it("does not mutate the array it was given", () => {
    const original = [...ROWS];
    sortRows(ROWS, (r) => r.tokens, "desc");
    expect(ROWS).toEqual(original);
  });

  it("changes order without changing any value", () => {
    const sorted = sortRows(ROWS, (r) => r.tokens, "desc");
    expect([...sorted].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...ROWS].sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it("compares strings as text rather than by code unit accident", () => {
    const rows = [{ name: "Zebra", tokens: 1 }, { name: "apple", tokens: 2 }];
    expect(sortRows(rows, (r) => r.name, "asc").map((r) => r.name)).toEqual([
      "apple",
      "Zebra",
    ]);
  });
});

describe("nextSort", () => {
  it("cycles descending, ascending, then back to the pillar's own order", () => {
    let state: SortState = null;
    state = nextSort(state, "tokens");
    expect(state).toEqual({ key: "tokens", direction: "desc" });
    state = nextSort(state, "tokens");
    expect(state).toEqual({ key: "tokens", direction: "asc" });
    // Null is the server's order, which is a claim in its own right and has to stay
    // reachable rather than being lost after the first click.
    expect(nextSort(state, "tokens")).toBeNull();
  });

  it("starts a different column at descending rather than inheriting a direction", () => {
    const state: SortState = { key: "tokens", direction: "asc" };
    expect(nextSort(state, "runs")).toEqual({ key: "runs", direction: "desc" });
  });
});
