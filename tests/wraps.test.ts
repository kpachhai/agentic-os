import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadConfig, SourceMissingError } from "../server/config.js";
import { getWrap, listWraps } from "../server/wraps.js";

const config = loadConfig();
const wrapsPresent = fs.existsSync(config.wrapsDir);

// Smoke against the REAL memory dir (gate check 10).
describe.skipIf(!wrapsPresent)("session wraps (real data)", () => {
  it("lists >= 10 wraps, each with date + title, newest first", () => {
    const wraps = listWraps(config.wrapsDir);
    expect(wraps.length).toBeGreaterThanOrEqual(10);
    for (const w of wraps) {
      expect(w.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.title).toBeTruthy();
    }
    const dates = wraps.map((w) => w.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("fetches a wrap by id with frontmatter, body, and sections", () => {
    const first = listWraps(config.wrapsDir)[0]!;
    const full = getWrap(config.wrapsDir, first.id);
    expect(full).not.toBeNull();
    expect(full!.body.length).toBeGreaterThan(0);
    expect(full!.frontmatter).toBeTypeOf("object");
    // sections are best-effort; object present even when empty
    expect(full!.sections).toBeTypeOf("object");
  });

  it("returns null for a missing id and rejects path traversal", () => {
    expect(getWrap(config.wrapsDir, "session_wrap_9999_01_01_nope")).toBeNull();
    expect(getWrap(config.wrapsDir, "../MEMORY")).toBeNull();
  });
});

it("reports an absent wraps dir as a missing source, not an empty list", () => {
  expect(() => listWraps("/no/such/wraps/xyz")).toThrow(SourceMissingError);
});
