import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadConfig, SourceMissingError } from "../server/config.js";
import {
  linkResolutions,
  parseFrictionLog,
  readFrictionLog,
} from "../server/friction.js";

const config = loadConfig();
const logPresent = fs.existsSync(config.frictionLogPath);

describe("friction parser (synthetic, all three formats)", () => {
  const sample = [
    "2026-05-03T21:50:00Z | [Friction] | pipe format friction about widget parsing",
    "2026-05-04T10:00:00Z | [Resolution] | fixed widget parsing everywhere | supersedes: 2026-05-03 widget parsing friction",
    "",
    "## 2026-06-07 - some heading",
    "[Notice] section format notice text",
    "continuation line of the notice",
    "",
    "| Date | Type | Scope | Note |",
    "|------|------|-------|------|",
    "| 2026-06-04 | Friction | some-skill | table format friction note |",
  ].join("\n");

  it("parses all three formats without dropping entries", () => {
    const entries = parseFrictionLog(sample);
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.format)).toEqual([
      "pipe",
      "pipe",
      "section",
      "table",
    ]);
  });

  it("extracts supersedes and merges section continuations", () => {
    const entries = parseFrictionLog(sample);
    expect(entries[1]!.supersedes).toBe(
      "2026-05-03 widget parsing friction",
    );
    expect(entries[2]!.text).toContain("continuation line");
  });

  it("links Resolution to Friction via supersedes date token (rule 1)", () => {
    const entries = parseFrictionLog(sample);
    linkResolutions(entries, 14);
    expect(entries[0]!.status).toBe("resolved");
    expect(entries[0]!.resolvedBy?.text).toContain("fixed widget parsing");
    expect(entries[1]!.resolves?.text).toContain("pipe format friction");
  });

  it("falls back to nearest-following Resolution within the window (rule 2)", () => {
    const entries = parseFrictionLog(
      [
        "2026-01-01T00:00:00Z | [Friction] | alpha beta gamma",
        "2026-01-05T00:00:00Z | [Resolution] | totally unrelated wording",
      ].join("\n"),
    );
    linkResolutions(entries, 14);
    expect(entries[0]!.status).toBe("resolved");
  });

  it("leaves a Friction open when no Resolution is in the window", () => {
    const entries = parseFrictionLog(
      [
        "2026-01-01T00:00:00Z | [Friction] | alpha beta gamma",
        "2026-03-05T00:00:00Z | [Resolution] | far away resolution",
      ].join("\n"),
    );
    linkResolutions(entries, 14);
    expect(entries[0]!.status).toBe("open");
  });

  it("matches the closest preceding Friction even when the file is out of order", () => {
    // The log's three formats interleave, so a February entry can sit above a
    // January one. The Resolution must close the February friction (nearest in
    // time), not whichever line happens to come last in the file.
    const entries = parseFrictionLog(
      [
        "2026-02-10T00:00:00Z | [Friction] | widget parsing breaks on nested arrays",
        "",
        "## 2026-01-05 - older section",
        "[Friction] widget parsing breaks on nested arrays",
        "",
        "2026-02-20T00:00:00Z | [Resolution] | rewrote it | supersedes: widget parsing nested arrays",
      ].join("\n"),
    );
    linkResolutions(entries, 14);
    expect(entries[0]!.date).toContain("2026-02-10");
    expect(entries[0]!.status).toBe("resolved");
    expect(entries[1]!.date).toBe("2026-01-05");
    expect(entries[1]!.status).toBe("open");
  });

  it("never crashes on unknown formats or malformed lines", () => {
    const entries = parseFrictionLog(
      "random prose\n| bad | row |\n2026-13-99 nonsense | [Wat] | x\n",
    );
    expect(entries).toEqual([]);
  });
});

// Smoke against the REAL friction log (gate check 6).
describe.skipIf(!logPresent)("friction log (real data)", () => {
  it("returns >= 1 Friction AND >= 1 Resolution", () => {
    const all = readFrictionLog(config.frictionLogPath, 14);
    expect(all.filter((e) => e.type === "Friction").length).toBeGreaterThanOrEqual(1);
    expect(all.filter((e) => e.type === "Resolution").length).toBeGreaterThanOrEqual(1);
  });

  it("parses at least as many entries as [Friction] lines in the file", () => {
    const rawText = fs.readFileSync(config.frictionLogPath, "utf8");
    const frictionLines = (rawText.match(/\[Friction\]/g) ?? []).length;
    const all = readFrictionLog(config.frictionLogPath, 14);
    expect(all.length).toBeGreaterThanOrEqual(frictionLines);
  });

  it("represents all three source formats present in the file", () => {
    const formats = new Set(
      readFrictionLog(config.frictionLogPath, 14).map((e) => e.format),
    );
    expect(formats.has("pipe")).toBe(true);
    expect(formats.has("section")).toBe(true);
    expect(formats.has("table")).toBe(true);
  });

  it("links at least one Friction -> Resolution pair", () => {
    const resolved = readFrictionLog(config.frictionLogPath, 14, {
      type: "Friction",
      status: "resolved",
    });
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved[0]!.resolvedBy).toBeTruthy();
  });

  it("status=open returns only unmatched Frictions", () => {
    const open = readFrictionLog(config.frictionLogPath, 14, { status: "open" });
    for (const e of open) {
      expect(e.type).toBe("Friction");
      expect(e.status).toBe("open");
      expect(e.resolvedBy).toBeNull();
    }
  });
});

it("reports an absent log as a missing source, not an empty timeline", () => {
  expect(() => readFrictionLog("/no/such/friction-log.md", 14)).toThrow(
    SourceMissingError,
  );
});
