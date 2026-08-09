import { useMemo, useState } from "react";

/**
 * Re-ordering for the tables that already carry ranked data.
 *
 * Several pillars compute more than one ranking and can only show one, because the
 * order is fixed at the server: hooks are sorted by total cost while p95 and worst
 * run sit unused in adjacent columns, and subagent types are sorted by dispatches
 * while the tokens their work produced are right there. Sorting is the whole fix -
 * no new server work, no new figures.
 *
 * Two rules this deliberately keeps:
 *
 * Sorting changes the order and nothing else. A column's value is whatever the
 * payload said it was, and no total, share or rank is recomputed from the visible
 * order, so a re-sorted table cannot say something the unsorted one did not.
 *
 * The server's own order stays reachable. It is the default and it is not merely
 * the first column ascending - a pillar's default order is usually a claim in its
 * own right, so a third click returns to it rather than cycling between the two
 * directions forever.
 */

export type SortDirection = "asc" | "desc";

export type SortState = { key: string; direction: SortDirection } | null;

/** How a column's value is obtained, so a column can sort on something it renders. */
export type SortAccessor<Row> = (row: Row) => number | string | null | undefined;

/**
 * Order rows by one accessor.
 *
 * Exported apart from the hook so the ordering rules - which are the part that can
 * be wrong - are testable without a renderer.
 */
export function sortRows<Row>(
  rows: Row[],
  accessor: SortAccessor<Row>,
  direction: SortDirection,
): Row[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = accessor(left);
    const b = accessor(right);
    const aMissing = a === null || a === undefined || a === "";
    const bMissing = b === null || b === undefined || b === "";
    if (aMissing && bMissing) return 0;
    // Missing always sorts last, in both directions: absent is not smaller than
    // present, and letting it lead a descending sort would put "not recorded"
    // exactly where the reader looks for the largest figure.
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
    return String(a).localeCompare(String(b)) * factor;
  });
}

/** desc -> asc -> back to the pillar's own order. */
export function nextSort(current: SortState, key: string): SortState {
  if (!current || current.key !== key) return { key, direction: "desc" };
  if (current.direction === "desc") return { key, direction: "asc" };
  return null;
}

export function useSorted<Row>(
  rows: Row[],
  accessors: Record<string, SortAccessor<Row>>,
  sort: SortState,
): Row[] {
  return useMemo(() => {
    if (!sort) return rows;
    const accessor = accessors[sort.key];
    if (!accessor) return rows;
    return sortRows(rows, accessor, sort.direction);
    // `accessors` is rebuilt per render by callers that define it inline, so it is
    // deliberately not a dependency; the sort key identifies the column instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort?.key, sort?.direction]);
}

/** Track which column is active, cycling desc -> asc -> back to the server's order. */
export function useSortState(): [SortState, (key: string) => void] {
  const [sort, setSort] = useState<SortState>(null);
  const toggle = (key: string): void => {
    setSort((current) => nextSort(current, key));
  };
  return [sort, toggle];
}

/**
 * A clickable column heading.
 *
 * It is a real button inside the `th` rather than a click handler on the cell, so
 * it is reachable by keyboard and announced as something that can be activated.
 * `aria-sort` carries the state to a screen reader, which the arrow alone does not.
 */
export function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  numeric = false,
  title,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  numeric?: boolean;
  title?: string;
}) {
  const active = sort?.key === sortKey;
  const ariaSort = active
    ? sort!.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th className={numeric ? "num-cell" : undefined} aria-sort={ariaSort}>
      <button
        type="button"
        className={`sort-header${active ? " active" : ""}`}
        onClick={() => onSort(sortKey)}
        title={title ?? `sort by ${label}`}
      >
        {label}
        <span className="sort-arrow" aria-hidden="true">
          {active ? (sort!.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** Says which order is in force, including that the default is the pillar's own. */
export function SortNote({
  sort,
  defaultOrder,
}: {
  sort: SortState;
  defaultOrder: string;
}) {
  return (
    <p className="row-meta" style={{ marginTop: 8, lineHeight: 1.55 }}>
      {sort
        ? `Sorted by ${sort.key}, ${sort.direction === "asc" ? "smallest" : "largest"} first. Click again to reverse, once more to return to the default order.`
        : `Default order: ${defaultOrder}. Column headings re-sort; the figures themselves do not change.`}
    </p>
  );
}
