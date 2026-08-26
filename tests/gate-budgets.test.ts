import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROOT } from "../server/config.js";

/**
 * The gate's wall-clock budgets, held to the property that makes them a gate.
 *
 * `npm run gate` used to read `os.loadavg()` once at process start and pick a
 * narrow or a wide budget per step from it. The reading was taken before npm ci,
 * the typecheck, the build and the whole suite - the four heaviest things on the
 * box while the gate runs - so it described a machine that no longer existed by
 * the time any budget was applied. The result was that one tree passed on a
 * machine that happened to be busy at second zero and failed on an idle one: four
 * separate reports on one unchanged tree disagreed, all of them honest. A budget
 * derived from ambient load is a coin flip, not a check.
 *
 * Two rules put that beyond reach, and this file is their enforcement point. The
 * budgets are literals in a file that imports nothing, so they cannot vary with
 * the machine; and every machine reading left in the gate scripts is confined to
 * the one helper whose job is to print a diagnostic, so a reading can inform a
 * failure message and can never move a verdict.
 *
 * Read by text rather than imported, like tests/script-config-parity.test.ts:
 * scripts/gate.mjs runs its own main() at import time, so importing it would run
 * the acceptance check. Every extraction below asserts it found something before
 * it compares, because a rule applied to nothing passes.
 */

const BUDGETS_FILE = "scripts/gate-budgets.mjs";

/**
 * Every script that runs work under one of those budgets.
 *
 * An explicit list rather than a glob over scripts/: a glob promises coverage it
 * cannot have, and a file that stopped matching it would take its rules with it
 * silently. A new script that takes a budget is added here by hand.
 */
const CONSUMERS = ["scripts/gate.mjs", "scripts/ui-smoke.mjs"];

/**
 * The readings that describe the machine rather than the code. Confining these
 * is what the second rule enforces; the list is the property, not a list of the
 * specific calls that once caused trouble, so a new one is caught the same way.
 */
const MACHINE_READING =
  /\b(?:os\.)?(loadavg|cpus|freemem|totalmem|uptime|availableParallelism)\s*\(/g;

/** The one helper allowed to make those readings, because it returns a string. */
const DIAGNOSTIC_HELPER = "function loadNote(";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

/**
 * The source with comments and string contents blanked out, offsets preserved.
 *
 * These rules are about code, and the prose gets in the way of both directions:
 * scripts/gate-budgets.mjs names `os.loadavg()` while explaining the defect it
 * exists to prevent, which a text scan reads as the defect itself; and gate.mjs
 * builds loopback URLs whose `//` would end a line-comment scan early, hiding
 * whatever follows on that line. Blanking rather than deleting keeps every
 * offset, so a finding still reports the line it is really on.
 *
 * A `${...}` inside a template literal stays code, because that is what it is:
 * blanking it would hide a reading that a message happens to be built around.
 *
 * Known limit: a regular-expression literal is scanned as code, so one containing
 * `//` or a lone quote would confuse this. Neither script has one.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < out.length; at++) {
      if (out[at] !== "\n") out[at] = " ";
    }
  };
  // One frame per template literal currently open. The number is the brace depth
  // inside its `${ }`, or -1 while we are in the literal's text.
  const frames: number[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (frames.length > 0 && frames[frames.length - 1] === -1) {
      if (char === "\\") {
        blank(index, index + 2);
        index += 2;
      } else if (char === "`") {
        frames.pop();
        index++;
      } else if (source.startsWith("${", index)) {
        frames[frames.length - 1] = 0;
        index += 2;
      } else {
        blank(index, index + 1);
        index++;
      }
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const to = end < 0 ? source.length : end;
      blank(index, to);
      index = to;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const to = end < 0 ? source.length : end + 2;
      blank(index, to);
      index = to;
      continue;
    }
    if (char === '"' || char === "'") {
      let at = index + 1;
      while (at < source.length && source[at] !== char) at += source[at] === "\\" ? 2 : 1;
      blank(index + 1, at);
      index = Math.min(at + 1, source.length);
      continue;
    }
    if (char === "`") {
      frames.push(-1);
      index++;
      continue;
    }
    if (frames.length > 0) {
      const depth = frames[frames.length - 1] ?? 0;
      if (char === "{") frames[frames.length - 1] = depth + 1;
      else if (char === "}") frames[frames.length - 1] = depth === 0 ? -1 : depth - 1;
    }
    index++;
  }
  return out.join("");
}

/** Span of the `{...}` body opened after `marker`, or null when it is absent. */
function bodySpan(source: string, marker: string): { start: number; end: number } | null {
  const from = source.indexOf(marker);
  if (from < 0) return null;
  const open = source.indexOf("{", from + marker.length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return { start: open, end: index };
    }
  }
  return null;
}

/**
 * The budget table, evaluated out of its own source.
 *
 * `new Function` refuses an import statement outright, so a budgets file that
 * grew a dependency fails here rather than being grepped for one.
 */
function loadBudgets(): Record<string, number> {
  const source = read(BUDGETS_FILE);
  const body = `${source.replace(/\bexport\s+const\b/g, "const")}\nreturn HANG_GUARD_MS;`;
  try {
    return (new Function(body) as () => Record<string, number>)();
  } catch (err) {
    // Raised bare, the syntax error names neither the file nor the rule, and the
    // runner's guess about CommonJS packaging sends the reader somewhere else.
    throw new Error(
      `${BUDGETS_FILE} must stay a standalone table of literals - it imports ` +
        `nothing so a budget cannot vary with the machine: ${String(err)}`,
    );
  }
}

describe("the gate's wall-clock budgets", () => {
  it("states every one as a machine-independent literal", () => {
    const budgets = loadBudgets();
    const names = Object.keys(budgets);
    // A budget table with no entries would satisfy every assertion below by
    // having nothing to check, which is the shape of a green that means nothing.
    expect(names.length, `${BUDGETS_FILE} exported no budget`).toBeGreaterThan(0);

    for (const name of names) {
      const value = budgets[name];
      expect(
        typeof value === "number" && Number.isInteger(value) && value > 0,
        `${BUDGETS_FILE}: ${name} is ${String(value)}, not a positive whole number of milliseconds`,
      ).toBe(true);
    }

    // `new Function` already rejects an import. These are the ways a value could
    // still come from the machine or the environment without one.
    const code = blankNonCode(read(BUDGETS_FILE));
    const escapes = [...code.matchAll(/\bprocess\.env\b|\brequire\s*\(|\bos\.[a-z]/g)].map(
      (match) => match[0],
    );
    expect(
      escapes,
      `${BUDGETS_FILE} must hold plain literals: a budget that can read the machine can vary with it`,
    ).toEqual([]);
  });

  it("confines every machine reading in the gate scripts to the diagnostic helper", () => {
    expect(CONSUMERS.length, "no gate scripts were listed to check").toBeGreaterThan(0);

    let readingsSeen = 0;
    const escaped: string[] = [];
    for (const relativePath of CONSUMERS) {
      const source = read(relativePath);
      expect(source.length, `${relativePath} is empty`).toBeGreaterThan(0);
      const code = blankNonCode(source);
      const span = bodySpan(code, DIAGNOSTIC_HELPER);

      for (const match of code.matchAll(MACHINE_READING)) {
        readingsSeen++;
        const at = match.index ?? 0;
        if (span && at > span.start && at < span.end) continue;
        const line = code.slice(0, at).split("\n").length;
        escaped.push(`${relativePath}:${line} ${match[0]}`);
      }
    }

    // The rule is about where readings live, so a corpus with no readings in it
    // proves nothing - and that is exactly what a renamed helper or a moved file
    // would look like.
    expect(
      readingsSeen,
      `no machine reading found in ${CONSUMERS.join(", ")}; this rule examined nothing`,
    ).toBeGreaterThan(0);
    expect(
      escaped,
      `a machine reading outside ${DIAGNOSTIC_HELPER}...) can reach a verdict, and the ` +
        `gate must give one tree one answer whatever the box is doing. If it is for a ` +
        `message, move it inside that helper; if it is choosing a timeout, take a ` +
        `literal from ${BUDGETS_FILE} instead`,
    ).toEqual([]);
  });

  it("gives every budget a consumer", () => {
    const names = Object.keys(loadBudgets());
    expect(names.length, `${BUDGETS_FILE} exported no budget`).toBeGreaterThan(0);
    const sources = CONSUMERS.map((relativePath) => blankNonCode(read(relativePath)));
    expect(sources.length, "no gate scripts were listed to check").toBeGreaterThan(0);

    const unused = names.filter(
      (name) => !sources.some((source) => source.includes(`HANG_GUARD_MS.${name}`)),
    );
    expect(
      unused,
      `declared in ${BUDGETS_FILE} and read by nothing, so it is a number that cannot ` +
        `rot loudly. Point a gate script at it, or delete it`,
    ).toEqual([]);
  });
});
