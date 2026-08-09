/**
 * Number formatting shared by every view.
 *
 * These lived as four separate copies of the same function, one per view, and they
 * had drifted: three rendered a thousand with one decimal and the fourth with
 * none, so the same figure read as "12.3k" on one page and "12k" on another. A
 * reader comparing two pillars has no way to tell that apart from the number
 * having actually changed.
 */

/**
 * A large count at whatever unit keeps it short, with one decimal.
 *
 * The threshold is taken on the magnitude so a negative value compacts too; the
 * per-view copies did not, and a negative delta rendered at full width beside
 * compacted positives.
 */
export function compact(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * The same thing one character narrower, for chart tick labels.
 *
 * Deliberately not folded into `compact`. Axis labels are laid out by the chart
 * library against a fixed gutter, and widening every tick by a decimal point is
 * how the axis labels got clipped once before - a regression that only visual
 * verification caught, because nothing about the numbers themselves was wrong.
 * Tick precision is a layout decision; a figure's precision is not.
 */
export function compactAxis(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}
