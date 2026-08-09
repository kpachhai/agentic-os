import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listThoughts } from "../server/engram.js";

let vault = "";

/** Synthetic fixtures only; the real vault is the operator's own writing. */
function writeThought(
  typeDir: string,
  fileName: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const dirPath = path.join(vault, "thoughts", typeDir);
  fs.mkdirSync(dirPath, { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  fs.writeFileSync(path.join(dirPath, fileName), `---\n${yaml}\n---\n\n${body}\n`, "utf8");
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-vault-"));
  writeThought(
    "Pattern",
    "20260101120000-loopback-bind-a1b2c3d4.md",
    {
      id: "t-loopback",
      prefix: "Pattern",
      created_at: "2026-01-01T12:00:00Z",
      description: "Bind the control panel to loopback only",
    },
    "The server listens on the loopback interface so nothing off-machine can reach it.",
  );
  writeThought(
    "Lesson",
    "20260102120000-sanitizer-e5f6a7b8.md",
    {
      id: "t-sanitizer",
      prefix: "Lesson",
      created_at: "2026-01-02T12:00:00Z",
      description: "Sanitize rendered markdown before display",
    },
    "Captured notes can embed external text, so rendering runs through a sanitizer.",
  );
  writeThought(
    "Decision",
    "20260103120000-readonly-db-c9d0e1f2.md",
    {
      id: "t-readonly",
      prefix: "Decision",
      created_at: "2026-01-03T12:00:00Z",
      description: "Open the analyzer database read-only",
    },
    "The database is opened read-only because another process checkpoints it.",
  );
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe("engram description field", () => {
  it("surfaces the hand-written description the vault already carries", () => {
    // This is the readable one-line summary the operator wrote at capture time.
    // Reading it needs no model and no algorithm.
    const found = listThoughts(vault).find((t) => t.id === "t-loopback");
    expect(found!.description).toBe("Bind the control panel to loopback only");
  });

  it("reports an empty description rather than inventing one", () => {
    writeThought(
      "Notice",
      "20260104120000-no-description-11223344.md",
      { id: "t-bare", prefix: "Notice", created_at: "2026-01-04T12:00:00Z" },
      "An entry captured without a description field.",
    );
    const found = listThoughts(vault).find((t) => t.id === "t-bare");
    expect(found!.description).toBe("");
    expect(found!.snippet).toContain("captured without a description");
  });
});

describe("engram ranked search", () => {
  it("finds an entry by a prefix of a word", () => {
    // Substring matching could not do this while the word was still being typed.
    const hits = listThoughts(vault, { q: "sanit" });
    expect(hits.map((t) => t.id)).toContain("t-sanitizer");
  });

  it("tolerates a typo in a long enough term", () => {
    const hits = listThoughts(vault, { q: "loopbak" });
    expect(hits.map((t) => t.id)).toContain("t-loopback");
  });

  it("matches on the description as well as the body", () => {
    // "analyzer" appears only in the description of the read-only entry.
    const hits = listThoughts(vault, { q: "analyzer" });
    expect(hits.map((t) => t.id)).toEqual(["t-readonly"]);
  });

  it("ranks a title or description hit above a passing body mention", () => {
    writeThought(
      "Notice",
      "20260105120000-mentions-loopback-55667788.md",
      { id: "t-mention", prefix: "Notice", created_at: "2026-01-05T12:00:00Z" },
      "A long note about unrelated things that happens to mention loopback once.",
    );
    const hits = listThoughts(vault, { q: "loopback" });
    // The entry whose description is about loopback outranks the passing mention.
    expect(hits[0]!.id).toBe("t-loopback");
    expect(hits.map((t) => t.id)).toContain("t-mention");
  });

  it("narrows as terms are added rather than widening", () => {
    const oneTerm = listThoughts(vault, { q: "database" });
    const twoTerms = listThoughts(vault, { q: "database checkpoints" });
    expect(twoTerms.length).toBeLessThanOrEqual(oneTerm.length);
    expect(twoTerms.map((t) => t.id)).toEqual(["t-readonly"]);
  });

  it("returns nothing for a query that genuinely matches nothing", () => {
    // The failure mode this pins: with any-term matching, a hyphenated nonsense
    // query splits into common fragments and matches nearly the whole vault, so
    // "not found" would render as "here is everything".
    expect(listThoughts(vault, { q: "zzz-no-such-term-xyzzy" })).toEqual([]);
    expect(listThoughts(vault, { q: "quantum" })).toEqual([]);
  });

  it("keeps newest-first ordering when browsing without a query", () => {
    const browsed = listThoughts(vault);
    expect(browsed.map((t) => t.id)).toEqual(["t-readonly", "t-sanitizer", "t-loopback"]);
  });

  it("combines a query with the type filter", () => {
    expect(listThoughts(vault, { q: "loopback", type: "Pattern" }).map((t) => t.id)).toEqual([
      "t-loopback",
    ]);
    expect(listThoughts(vault, { q: "loopback", type: "Decision" })).toEqual([]);
  });

  it("treats a whitespace-only query as no query at all", () => {
    expect(listThoughts(vault, { q: "   " })).toHaveLength(3);
  });
});
