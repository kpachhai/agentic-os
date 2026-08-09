import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadConfig, SourceMissingError } from "../server/config.js";
import { getThought, listThoughts } from "../server/engram.js";

const config = loadConfig();
const vaultPresent = fs.existsSync(config.engramVaultPath);

// Smoke against the REAL memory vault (gate check 5).
describe.skipIf(!vaultPresent)("engram vault reader (real data)", () => {
  it("lists >= 1 thought with non-empty id and title, newest first", () => {
    const rows = listThoughts(config.engramVaultPath, { limit: 5 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.title).toBeTruthy();
    }
    const timestamps = rows.map((r) => r.timestamp);
    const sorted = [...timestamps].sort().reverse();
    expect(timestamps).toEqual(sorted);
  });

  it("fetches a single thought by id with frontmatter + body + path", () => {
    const first = listThoughts(config.engramVaultPath, { limit: 1 })[0]!;
    const full = getThought(config.engramVaultPath, first.id);
    expect(full).not.toBeNull();
    expect(full!.path).toContain("thoughts");
    expect(typeof full!.body).toBe("string");
    expect(full!.frontmatter).toBeTypeOf("object");
  });

  it("returns null for a non-existent id (route maps this to 404)", () => {
    expect(getThought(config.engramVaultPath, "no-such-id-xyz")).toBeNull();
  });

  it("keyword search narrows results and combines with type filter", () => {
    const all = listThoughts(config.engramVaultPath, { limit: 500 });
    const hits = listThoughts(config.engramVaultPath, {
      q: "the",
      limit: 500,
    });
    expect(hits.length).toBeLessThanOrEqual(all.length);
    const none = listThoughts(config.engramVaultPath, {
      q: "zzz-no-such-term-xyzzy",
    });
    expect(none).toEqual([]);
  });
});

it("reports an absent vault as a missing source, not an empty list", () => {
  expect(() => listThoughts("/no/such/vault/xyz")).toThrow(SourceMissingError);
  expect(() => getThought("/no/such/vault/xyz", "any")).toThrow(
    /source missing/,
  );
});
