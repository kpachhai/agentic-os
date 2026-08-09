import { describe, expect, it } from "vitest";
import { splitSentences, stripMarkdownSyntax } from "../server/text/sentences.js";

/** All fixtures here are written for the test; none come from real notes. */

/** The splitter this module exists to replace: any run up to a terminator. */
const NAIVE_SPLITTER_RE = /[^.!?]+[.!?]+/g;

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The no-text-lost property: splitting only ever removes whitespace, so the
 * pieces rejoined must equal the input once whitespace is normalised on both
 * sides. A splitter that drops a terminator, a bracket or a whole clause looks
 * fine in a count assertion and fails here.
 */
function expectNoTextLost(input: string): void {
  expect(normaliseWhitespace(splitSentences(input).join(" "))).toBe(
    normaliseWhitespace(input),
  );
}

/**
 * Five sentences carrying a markdown filename, a JSON filename, a loopback IP
 * address, a dotted version, a decimal and a domain - every dotted token shape
 * this corpus is full of, in one string.
 */
const DOTTED_TOKEN_CORPUS = [
  "Read CLAUDE.md before editing config.json.",
  "The server binds 127.0.0.1 only.",
  "Node v24.2.0 is required.",
  "Boot takes 6.2 seconds.",
  "Never fetch from example.com!",
].join(" ");

describe("splitSentences: dotted tokens", () => {
  it("splits the dotted-token corpus into 5 sentences, where the naive splitter finds 14", () => {
    // 14 vs 5 is the whole reason this module exists. The naive count is
    // asserted alongside ours so the gap stays visible instead of becoming a
    // number in a comment that nobody can check.
    expect(DOTTED_TOKEN_CORPUS.match(NAIVE_SPLITTER_RE)).toHaveLength(14);

    const sentences = splitSentences(DOTTED_TOKEN_CORPUS);
    expect(sentences).toHaveLength(5);
    expect(sentences[0]).toBe("Read CLAUDE.md before editing config.json.");
    expect(sentences[1]).toBe("The server binds 127.0.0.1 only.");
    expect(sentences[2]).toBe("Node v24.2.0 is required.");
    expect(sentences[3]).toBe("Boot takes 6.2 seconds.");
    expect(sentences[4]).toBe("Never fetch from example.com!");
  });

  it("keeps multi-dot filenames and prices whole", () => {
    expect(splitSentences("The types live in index.d.ts and nowhere else.")).toEqual([
      "The types live in index.d.ts and nowhere else.",
    ]);
    expect(splitSentences("A run costs $0.05 at 6.2 tokens per second.")).toEqual([
      "A run costs $0.05 at 6.2 tokens per second.",
    ]);
    expect(splitSentences("Pinned to 1.24.1 for now.")).toEqual([
      "Pinned to 1.24.1 for now.",
    ]);
  });

  it("still splits when a dotted token ends the sentence", () => {
    expect(
      splitSentences("Everything is in config.json. Nothing is hardcoded."),
    ).toEqual(["Everything is in config.json.", "Nothing is hardcoded."]);
  });
});

describe("splitSentences: abbreviations", () => {
  it("does not split after a known abbreviation followed by a capital", () => {
    const cases = [
      "Use a reader e.g. The vault reader for this.",
      "Prefer the gate i.e. The mechanical check.",
      "Add hooks, scripts, etc. Then run it.",
      "Vitest vs. Playwright is not the question.",
      "Ask Mr. Smith and Dr. Jones about it.",
      "See Fig. 4 for the layout.",
      "It takes approx. 6 seconds per record.",
      "Compare cf. Section 2 of the notes.",
      "Attributed to Chen et al. Later work disagrees.",
    ];
    for (const input of cases) {
      expect(splitSentences(input)).toEqual([input]);
    }
  });

  it("splits after an ordinary word that merely looks abbreviated", () => {
    expect(splitSentences("Check the docs. Then ship it.")).toEqual([
      "Check the docs.",
      "Then ship it.",
    ]);
  });

  it("keeps multi-dot abbreviations whole", () => {
    // A form like "p.m." has to survive as one token: split at its last dot it
    // emits "Tuesday, right after the gate run." as a standalone "sentence",
    // which is the fragment this module promises never to produce.
    const cases = [
      "The review is at 5 p.m. Tuesday, right after the gate run.",
      "Deploy at 9 a.m. Monday if the suite is green.",
      "The box lives in the U.K. London specifically.",
      "The mirror is in the U.S. Traffic still crosses the ocean.",
      "She has a Ph.D. Nobody disputes it.",
    ];
    for (const input of cases) {
      expect(splitSentences(input)).toEqual([input]);
    }
  });

  it("keeps single-dot abbreviations common in notes whole", () => {
    const cases = [
      "Owned by Example Inc. Nobody else has a stake.",
      "Owned by Example Ltd. Nobody else has a stake.",
      "Owned by Example Corp. Nobody else has a stake.",
      "Owned by Example Co. Nobody else has a stake.",
      "Turn onto Elm St. Then park.",
      "Ask Prof. Adeyemi and Mrs. Ito about it.",
      "Ask Ms. Okonkwo about it.",
    ];
    for (const input of cases) {
      expect(splitSentences(input)).toEqual([input]);
    }
  });

  it("treats No. as a number label only when a number follows it", () => {
    expect(splitSentences("Check ticket No. 42 before shipping.")).toEqual([
      "Check ticket No. 42 before shipping.",
    ]);
    // "no" is an ordinary English word far more often than it is a label, so a
    // capital after it still ends the sentence. Listing "no." unconditionally
    // would merge this pair, which is the commoner shape of the two.
    expect(splitSentences("The answer is no. Then we shipped it.")).toEqual([
      "The answer is no.",
      "Then we shipped it.",
    ]);
  });

  it("splits when a number-shaped token that is not an abbreviation ends the sentence", () => {
    // The backward token scan takes digits too, so "1st." is read whole and is
    // not mistaken for the "st." abbreviation.
    expect(splitSentences("Ship it on the 1st. Then take the week off.")).toEqual([
      "Ship it on the 1st.",
      "Then take the week off.",
    ]);
  });
});

describe("splitSentences: punctuation shapes", () => {
  it("splits when a closing quote sits between the terminator and the space", () => {
    expect(splitSentences('He said "done." Then left.')).toEqual([
      'He said "done."',
      "Then left.",
    ]);
  });

  it("splits when a closing bracket sits between the terminator and the space", () => {
    expect(splitSentences("It shipped (barely.) Nobody noticed.")).toEqual([
      "It shipped (barely.)",
      "Nobody noticed.",
    ]);
  });

  it("starts a new sentence that opens with a quote or bracket", () => {
    expect(splitSentences('The gate went green. "Finally," she said.')).toEqual([
      "The gate went green.",
      '"Finally," she said.',
    ]);
  });

  it("treats an ellipsis as a continuation, not a boundary", () => {
    // The dots are one token, so they are never broken apart, and the run is
    // not read as a terminator either - trailing off mid-thought is the usual
    // meaning in these notes.
    expect(splitSentences("Waiting on the probe... Then it answered.")).toEqual([
      "Waiting on the probe... Then it answered.",
    ]);
  });

  it("splits on a doubled terminator", () => {
    expect(splitSentences("Never widen the bind! Ever.")).toEqual([
      "Never widen the bind!",
      "Ever.",
    ]);
    expect(splitSentences("Did it pass?! The gate says yes.")).toEqual([
      "Did it pass?!",
      "The gate says yes.",
    ]);
  });

  it("splits on a digit that opens the next sentence", () => {
    expect(splitSentences("The suite grew. 13 checks run now.")).toEqual([
      "The suite grew.",
      "13 checks run now.",
    ]);
  });
});

describe("splitSentences: boundaries and blank input", () => {
  it("splits across a single newline when a sentence ended there", () => {
    expect(splitSentences("First line ends here.\nSecond line starts.")).toEqual([
      "First line ends here.",
      "Second line starts.",
    ]);
  });

  it("splits on a blank line even with no terminator", () => {
    expect(splitSentences("A heading with no period\n\nThe paragraph under it")).toEqual([
      "A heading with no period",
      "The paragraph under it",
    ]);
  });

  it("returns [] for empty and whitespace-only input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
    expect(splitSentences("\n\n\t \n")).toEqual([]);
  });

  it("emits a trailing sentence that has no terminator", () => {
    expect(splitSentences("It passed. Now the last thought")).toEqual([
      "It passed.",
      "Now the last thought",
    ]);
  });
});

describe("splitSentences: no text is lost", () => {
  it("preserves every non-whitespace character across a range of inputs", () => {
    const inputs = [
      DOTTED_TOKEN_CORPUS,
      'He said "done." Then left. It shipped (barely.) Nobody noticed.',
      "Add hooks, scripts, etc. Then run it. Vitest vs. Playwright is moot.",
      "Waiting on the probe... Then it answered.",
      "One paragraph here.\n\nAnother paragraph there.\n\n\nA third one.",
      "Windows lines.\r\nStill split.\r\nAnd again.",
      "  leading and trailing whitespace survives normalisation  ",
      "no terminator at all",
      "",
      "   ",
      "Check ticket No. 42 before shipping. The review is at 5 p.m. Tuesday.",
      "2026. That was the year the gate went green.",
      stripMarkdownSyntax(MARKDOWN_FIXTURE),
      stripMarkdownSyntax(MARKDOWN_STRUCTURE_FIXTURE),
    ];
    for (const input of inputs) {
      expectNoTextLost(input);
    }
  });
});

const MARKDOWN_FIXTURE = [
  "# Sample Notes",
  "The heading above must not glue onto this sentence.",
  "",
  "## Setup ##",
  "Run the installer. It writes **no** files outside the *scratch* directory.",
  "",
  "```ts",
  'const poison = "this line is not prose at all";',
  "console.log(poison);",
  "```",
  "",
  "Prose resumes after the block.",
  "",
  "- First bullet with no period",
  "- Second bullet with `inline_code` kept",
  "1. Numbered item one",
  "2) Numbered item two",
  "",
  "> A quoted remark about some_var_name staying intact.",
  "",
  "See the [project README](https://example.com/readme) for more.",
  "",
  "![a diagram](https://example.com/diagram.png)",
  "",
  "---",
  "",
  "- [ ] An unchecked task",
  "- [x] A checked task",
].join("\n");

/**
 * A six-row lookup table: the shape that used to reach the splitter intact,
 * collapse into one pseudo-sentence full of pipe characters, and then outrank
 * real prose because its rows share vocabulary by construction.
 */
const TABLE_FIXTURE = [
  "| Setting | What it controls |",
  "| --- | --- |",
  "| port | The port the server listens on |",
  "| vaultPath | Where the memory vault is read from |",
  "| logPath | Where the friction log is read from |",
  "| wrapPath | Where the session wraps are read from |",
].join("\n");

/**
 * The block-level constructs the first fixture leaves out: a table, both setext
 * heading underlines, a heading inside a blockquote, and a prose line that opens
 * with a year rather than with a list marker.
 */
const MARKDOWN_STRUCTURE_FIXTURE = [
  "Setext Title",
  "============",
  "The paragraph under the setext title.",
  "",
  "A Dashed Title",
  "--------------",
  "The paragraph under the dashed title.",
  "",
  "> ## Quoted heading",
  "> The server binds loopback only.",
  "",
  TABLE_FIXTURE,
  "",
  "2026. That was the year the gate went green.",
].join("\n");

describe("stripMarkdownSyntax", () => {
  const stripped = stripMarkdownSyntax(MARKDOWN_FIXTURE);
  const sentences = splitSentences(stripped);

  it("removes fenced code blocks entirely", () => {
    expect(stripped).not.toContain("this line is not prose at all");
    expect(stripped).not.toContain("console.log");
    expect(stripped).not.toContain("```");
    expect(sentences).toContain("Prose resumes after the block.");
  });

  it("does not glue a heading onto the sentence that follows it", () => {
    expect(sentences).toContain("Sample Notes");
    expect(sentences).toContain("The heading above must not glue onto this sentence.");
    expect(stripped).not.toContain("Sample Notes The heading");
  });

  it("removes heading markers including closed-ATX trailing hashes", () => {
    expect(sentences).toContain("Setup");
    expect(stripped).not.toContain("#");
  });

  it("removes bullet and numbered-list markers and keeps items apart", () => {
    expect(sentences).toContain("First bullet with no period");
    expect(sentences).toContain("Second bullet with inline_code kept");
    expect(sentences).toContain("Numbered item one");
    expect(sentences).toContain("Numbered item two");
  });

  it("removes blockquote markers and leaves identifiers with underscores alone", () => {
    expect(sentences).toContain("A quoted remark about some_var_name staying intact.");
  });

  it("removes emphasis and bold markers but keeps their text", () => {
    expect(sentences).toContain(
      "It writes no files outside the scratch directory.",
    );
    expect(stripped).not.toContain("**");
    expect(stripped).not.toContain("*");
  });

  it("keeps link text and drops the URL, and drops images whole", () => {
    expect(sentences).toContain("See the project README for more.");
    expect(stripped).not.toContain("example.com");
    expect(stripped).not.toContain("a diagram");
  });

  it("drops thematic breaks and task-list checkboxes", () => {
    expect(sentences).not.toContain("---");
    expect(sentences).toContain("An unchecked task");
    expect(sentences).toContain("A checked task");
    expect(stripped).not.toContain("[ ]");
    expect(stripped).not.toContain("[x]");
  });

  it("drops an unterminated fence through to the end of the input", () => {
    const unterminated = [
      "Prose before the fence.",
      "```",
      "still inside the block",
    ].join("\n");
    expect(splitSentences(stripMarkdownSyntax(unterminated))).toEqual([
      "Prose before the fence.",
    ]);
  });

  it("leaves plain prose untouched", () => {
    const prose = "Nothing to strip here. The bind stays on 127.0.0.1.";
    expect(splitSentences(stripMarkdownSyntax(prose))).toEqual([
      "Nothing to strip here.",
      "The bind stays on 127.0.0.1.",
    ]);
  });

  it("returns nothing splittable for empty input", () => {
    expect(splitSentences(stripMarkdownSyntax(""))).toEqual([]);
    expect(splitSentences(stripMarkdownSyntax("   \n\n  "))).toEqual([]);
  });
});

describe("stripMarkdownSyntax: tables", () => {
  it("drops a table whole, cell text included", () => {
    const stripped = stripMarkdownSyntax(TABLE_FIXTURE);
    expect(stripped).not.toContain("|");
    expect(splitSentences(stripped)).toEqual([]);
    // Dropping the cell text is the accepted cost of dropping the structure: a
    // cell is a field value, not a sentence, and a table of prose sentences
    // therefore loses that prose.
    expect(stripped).not.toContain("vaultPath");
  });

  it("leaves the prose around a table exactly as it would be without it", () => {
    const prose = [
      "The reader opens every source read-only.",
      "",
      "Nothing is written back to the operator's disk.",
    ].join("\n");
    // Identical sentence lists mean the table cannot move any count or score
    // downstream: readability and sentence ranking both read this output.
    expect(splitSentences(stripMarkdownSyntax(`${prose}\n\n${TABLE_FIXTURE}\n`))).toEqual(
      splitSentences(stripMarkdownSyntax(prose)),
    );
  });

  it("resumes prose on the first line after the table", () => {
    const document = `${TABLE_FIXTURE}\nProse resumes on the very next line.`;
    expect(splitSentences(stripMarkdownSyntax(document))).toEqual([
      "Prose resumes on the very next line.",
    ]);
  });

  it("recognises a table with no outer pipes and one inside a blockquote", () => {
    const bare = ["Setting | Meaning", "--- | ---", "port | The listening port"].join("\n");
    expect(splitSentences(stripMarkdownSyntax(bare))).toEqual([]);

    const quoted = TABLE_FIXTURE.split("\n")
      .map((row) => `> ${row}`)
      .join("\n");
    expect(splitSentences(stripMarkdownSyntax(quoted))).toEqual([]);
  });

  it("keeps prose that merely contains a pipe", () => {
    // A pipe is ordinary in these notes, so the delimiter row underneath is what
    // makes a table a table. Without it nothing may be dropped.
    const pipes = [
      "Run the gate | tee gate.log when you want a transcript.",
      "Pick one | the other, never both.",
    ].join("\n");
    expect(splitSentences(stripMarkdownSyntax(pipes))).toEqual([
      "Run the gate | tee gate.log when you want a transcript.",
      "Pick one | the other, never both.",
    ]);
  });

  it("does not read a piped line above a dashed rule as a table", () => {
    // The rule carries no pipe, so it is a heading underline or a thematic
    // break, and the line above it is prose that must survive.
    const stripped = stripMarkdownSyntax("Use the a | b form.\n---\nThe next paragraph.");
    expect(splitSentences(stripped)).toEqual(["Use the a | b form.", "The next paragraph."]);
  });
});

describe("stripMarkdownSyntax: setext headings and quoted headings", () => {
  it("does not glue a setext heading onto the paragraph beneath it", () => {
    for (const underline of ["===", "---", "=", "==============", "-----"]) {
      const stripped = stripMarkdownSyntax(
        `Sample Title\n${underline}\nThe paragraph under it.`,
      );
      expect(splitSentences(stripped)).toEqual([
        "Sample Title",
        "The paragraph under it.",
      ]);
      expect(stripped).not.toContain(underline);
    }
  });

  it("recognises a heading inside a blockquote", () => {
    const stripped = stripMarkdownSyntax("> ## Rule\n> The server binds loopback only.");
    expect(stripped).not.toContain("#");
    expect(splitSentences(stripped)).toEqual([
      "Rule",
      "The server binds loopback only.",
    ]);
  });

  it("strips every block-level construct in the structure fixture", () => {
    const stripped = stripMarkdownSyntax(MARKDOWN_STRUCTURE_FIXTURE);
    expect(stripped).not.toContain("|");
    expect(stripped).not.toContain("#");
    expect(stripped).not.toContain("=");
    expect(splitSentences(stripped)).toEqual([
      "Setext Title",
      "The paragraph under the setext title.",
      "A Dashed Title",
      "The paragraph under the dashed title.",
      "Quoted heading",
      "The server binds loopback only.",
      "2026.",
      "That was the year the gate went green.",
    ]);
  });
});

describe("stripMarkdownSyntax: numbered lines", () => {
  it("keeps a number that opens a prose line", () => {
    // Removing the marker here deleted the author's own text: the year and the
    // figure were gone from the output entirely.
    for (const line of [
      "2026. That was the year the gate went green.",
      "42. Answers everything.",
      "13. Checks run in the gate today.",
    ]) {
      expect(normaliseWhitespace(stripMarkdownSyntax(line))).toBe(line);
    }
  });

  it("reads a lone numbered line as prose, splitting rather than deleting", () => {
    // The accepted consequence of never deleting a number: a standalone figure
    // becomes its own short sentence instead of vanishing.
    expect(splitSentences(stripMarkdownSyntax("42. Answers everything."))).toEqual([
      "42.",
      "Answers everything.",
    ]);
  });

  it("still strips markers from a real numbered list", () => {
    const tight = ["1. First step", "2) Second step", "3. Third step"].join("\n");
    expect(splitSentences(stripMarkdownSyntax(tight))).toEqual([
      "First step",
      "Second step",
      "Third step",
    ]);

    // A list with blank lines between its items is still one list, so its later
    // items must not fall back to being read as prose.
    const loose = ["1. First step", "", "2. Second step", "", "3. Third step"].join("\n");
    expect(splitSentences(stripMarkdownSyntax(loose))).toEqual([
      "First step",
      "Second step",
      "Third step",
    ]);

    // A list that starts above 1 is still a list when a sibling follows it.
    const restarted = ["7. Seventh step", "8. Eighth step"].join("\n");
    expect(splitSentences(stripMarkdownSyntax(restarted))).toEqual([
      "Seventh step",
      "Eighth step",
    ]);

    // A wrapped item carries no marker of its own, so the item after it still
    // continues the list.
    const wrapped = ["1. First step", "   wrapped onto a second line", "2. Second step"].join(
      "\n",
    );
    // Normalised, because a sentence keeps the newline it was wrapped on.
    expect(splitSentences(stripMarkdownSyntax(wrapped)).map(normaliseWhitespace)).toEqual([
      "First step wrapped onto a second line",
      "Second step",
    ]);
  });
});
