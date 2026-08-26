import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROOT, loadConfig } from "../server/config.js";

/**
 * The three lists that are supposed to say the same thing, checked mechanically.
 *
 * `scripts/gate.mjs` and `scripts/doctor.mjs` are dependency-free by design, so
 * neither can import server/config.ts and each carries its own copy of the source
 * paths. Both files say so in a comment and both ask a human to keep them in
 * step; that convention held for the sixteen paths the gate carries and had
 * already failed for one the doctor carries, which is the exact shape of a rule
 * with no enforcement point. The same goes for the pillar routes, which are named
 * in the app, in the render smoke, and again in the gate's absent-route map.
 *
 * The extraction is by text on purpose. gate.mjs runs its own `main()` at import
 * time, so importing it would run the acceptance check; and the point of pinning
 * these is that they stay readable as plain Node. Every extraction below asserts
 * it actually found something before comparing, because two empty lists match and
 * a silent comparison of nothing is the failure this file exists to prevent.
 */

function read(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), "utf8");
}

/** Text from `marker` to the bracket that closes the one it opens. */
function sliceBalanced(source: string, marker: string, open: string, close: string): string {
  const from = source.indexOf(marker);
  if (from < 0) return "";
  // Scan past the marker, not from its start: one of these markers is a type
  // annotation that carries a bracket of its own, and matching that one returns
  // an empty list rather than the declaration.
  const start = source.indexOf(open, from + marker.length);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return "";
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** A config path that cannot exist, so only the defaults are compared. */
const NO_CONFIG = path.join(os.tmpdir(), "agentic-os-no-such-config-file.json");

describe("the source paths duplicated across the two dependency-free scripts", () => {
  it("gives gate.mjs the same defaults the server resolves", () => {
    const source = read("scripts/gate.mjs");
    const expandHomeFn = sliceBalanced(source, "function expandHome(", "{", "}");
    const loadFn = sliceBalanced(source, "function loadGateConfig(", "{", "}");
    // Extraction failure must be loud. Renaming either function would otherwise
    // leave this comparing an empty object against a full one, or worse, nothing
    // against nothing.
    expect(expandHomeFn, "expandHome() not found in scripts/gate.mjs").not.toBe("");
    expect(loadFn, "loadGateConfig() not found in scripts/gate.mjs").not.toBe("");

    const evaluate = new Function(
      "fs",
      "os",
      "path",
      "ROOT",
      "process",
      `${expandHomeFn}\n${loadFn}\nreturn loadGateConfig();`,
    ) as (
      fsArg: typeof fs,
      osArg: typeof os,
      pathArg: typeof path,
      root: string,
      processArg: { env: Record<string, string> },
    ) => Record<string, unknown>;
    const gate = evaluate(fs, os, path, APP_ROOT, { env: { CONFIG_PATH: NO_CONFIG } });
    const server = loadConfig(NO_CONFIG) as unknown as Record<string, unknown>;

    const shared = Object.keys(gate).filter((key) => key in server);
    expect(shared.length, "gate.mjs declared no key the server also has").toBeGreaterThan(0);
    for (const key of shared) {
      expect(gate[key], `${key} differs between scripts/gate.mjs and server/config.ts`).toEqual(
        server[key],
      );
    }
  });

  it("gives doctor.mjs the same defaults the server resolves", () => {
    const source = read("scripts/doctor.mjs");
    const literal = sliceBalanced(source, "const SOURCES = ", "[", "]");
    expect(literal, "SOURCES not found in scripts/doctor.mjs").not.toBe("");

    const rows = (
      new Function(`${literal};\nreturn SOURCES;`) as () => Array<{
        key: string;
        fallback: string | string[];
      }>
    )();
    const server = loadConfig(NO_CONFIG) as unknown as Record<string, unknown>;

    const shared = rows.filter((row) => row.key in server);
    expect(shared.length, "doctor.mjs declared no key the server also has").toBeGreaterThan(0);
    for (const row of shared) {
      const expanded = Array.isArray(row.fallback)
        ? row.fallback.map(expandHome)
        : expandHome(row.fallback);
      expect(
        expanded,
        `${row.key} differs between scripts/doctor.mjs and server/config.ts`,
      ).toEqual(server[row.key]);
    }
  });
});

describe("the pillar routes named in three places", () => {
  it("names the same set in the app, the render smoke and the gate", () => {
    const appBlock = sliceBalanced(read("src/App.tsx"), "const ROUTES: Route[] = ", "[", "]");
    const smokeBlock = sliceBalanced(read("scripts/ui-smoke.mjs"), "const ROUTES = ", "[", "]");
    const gateBlock = sliceBalanced(read("scripts/gate.mjs"), "const absentRoutes = ", "[", "]");
    for (const [name, block] of [
      ["src/App.tsx ROUTES", appBlock],
      ["scripts/ui-smoke.mjs ROUTES", smokeBlock],
      ["scripts/gate.mjs absentRoutes", gateBlock],
    ] as const) {
      expect(block, `${name} not found`).not.toBe("");
    }

    const app = new Set([...appBlock.matchAll(/path:\s*"(\/[^"]+)"/g)].map((m) => `#${m[1]}`));
    const smoke = new Set([...smokeBlock.matchAll(/hash:\s*"(#\/[^"]+)"/g)].map((m) => m[1]!));
    const gate = new Set([...gateBlock.matchAll(/"(#\/[^"]+)"/g)].map((m) => m[1]!));

    // The corpus, before the comparison. Three empty sets are equal, and a
    // regex that stopped matching would report that as agreement.
    expect(app.size, "no routes extracted from src/App.tsx").toBeGreaterThan(0);
    expect(smoke.size, "no routes extracted from scripts/ui-smoke.mjs").toBeGreaterThan(0);
    expect(gate.size, "no routes extracted from scripts/gate.mjs").toBeGreaterThan(0);

    // A route the smoke walks but the gate has no absent-source entry for is
    // asked for real data on a machine that has none, and fails with a selector
    // timeout instead of rendering the first-run panel it was meant to prove.
    expect([...smoke].sort()).toEqual([...app].sort());
    expect([...gate].sort()).toEqual([...app].sort());
  });
});
