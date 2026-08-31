import type { SubagentDelegation } from "./delegation-types";

/**
 * The pure core of the delegation view: formatting, with no React and no IO.
 *
 * Extracted from DelegationView.tsx, which had grown to a thousand lines with these
 * four helpers buried at the top. They are the only part of that file that can be
 * called without rendering anything, so they are the only part that was ever
 * testable - and until this module existed, nothing tested them.
 *
 * Every function here is total: same input, same output, no clock, no locale beyond
 * the explicit "en-US", no filesystem. That is the property that makes the tests
 * next door meaningful rather than decorative.
 */

/** A whole number with thousands separators, pinned to en-US so it never follows the host locale. */
export const count = (value: number): string => value.toLocaleString("en-US");

/** A duration, at whatever unit keeps it readable. Never a wait, always a span. */
export function span(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** The date half of an ISO timestamp, or a stated absence rather than an empty cell. */
export const day = (iso: string | null): string => (iso === null ? "no date" : iso.slice(0, 10));

/**
 * The tail of an encoded project directory.
 *
 * The corpus addresses a project by a directory name whose path separators were
 * already flattened to hyphens, so the whole thing is one token and the usual path
 * shortener cannot split it. The leading segments are the reader's home directory
 * and repeat on every row, so only the tail is shown as the label and the value the
 * corpus actually uses stays in the title.
 */
export function shortProject(label: string): string {
  const tokens = label.replace(/^\//, "").split("-").filter(Boolean);
  if (tokens.length === 0) return label;
  if (tokens.length <= 2) return tokens.join("-");
  return `...${tokens.slice(-2).join("-")}`;
}

/**
 * The seven figures the view derives from the specialist rows.
 *
 * The totals the server sends carry no denominator for their delegated figures and
 * the rows do, so these are summed from the rows rather than reported: every
 * specialist the delegated scan found becomes a row, so the sum covers the same
 * corpus the totals were built from. Kept as a visible sum for that reason.
 */
export type DelegationSummary = {
  recordsWithUsage: number;
  transcriptsWithoutSpan: number;
  promptCharsMissing: number;
  /** Rows that dispatched but have nothing attributed on disk. */
  dispatchedWithNothingBack: number;
  /** Rows with work attributed but no dispatch recorded. */
  workWithoutADispatch: number;
  /**
   * Largest dispatch count, floored at 1.
   *
   * These two are bar denominators, so the floor is load-bearing rather than
   * defensive: an all-zero corpus would otherwise divide by zero.
   */
  mostDispatches: number;
  /** Largest attributed-record count, floored at 1, for the same reason. */
  mostRecords: number;
};

export function summarize(rows: readonly SubagentDelegation[]): DelegationSummary {
  return {
    recordsWithUsage: rows.reduce((sum, row) => sum + (row.delegatedWork?.recordsWithUsage ?? 0), 0),
    transcriptsWithoutSpan: rows.reduce(
      (sum, row) => sum + (row.delegatedWork?.transcriptsWithoutSpan ?? 0),
      0,
    ),
    promptCharsMissing: rows.reduce((sum, row) => sum + row.promptCharsMissing, 0),
    dispatchedWithNothingBack: rows.filter(
      (row) => row.dispatches > 0 && row.delegatedWork === null,
    ).length,
    workWithoutADispatch: rows.filter((row) => row.dispatches === 0 && row.delegatedWork !== null)
      .length,
    mostDispatches: rows.reduce((max, row) => Math.max(max, row.dispatches), 1),
    mostRecords: rows.reduce((max, row) => Math.max(max, row.delegatedWork?.records ?? 0), 1),
  };
}
