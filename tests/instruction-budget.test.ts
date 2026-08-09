import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceMissingError } from "../server/config.js";
import {
  CHARS_PER_TOKEN,
  SOFT_CEILING_CHARS,
  WARNING_CHARS,
  ceilingStatus,
  identityChars,
  instructionBudget,
} from "../server/instruction-budget.js";

/**
 * Every fixture here is hand-written to the shape the real files use. Nothing is
 * copied from the operator's own instruction files, skills, or agents.
 */
let root = "";
let globalPath = "";
let projectDir = "";
let skillsRoot = "";
let agentsDir = "";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeSkill(name: string, description: string, bodyChars: number): void {
  writeFile(
    path.join(skillsRoot, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${"b".repeat(bodyChars)}\n`,
  );
}

function writeAgent(name: string, description: string): void {
  writeFile(
    path.join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmodel: inherit\n---\n\nAgent body text that is not identity.\n`,
  );
}

/**
 * Wrap one line of text into an indented YAML block-scalar body.
 *
 * The wrapping is done here rather than typed into the fixture so that the block
 * form and the inline form provably carry the same words: a folded block rejoins
 * its lines with single spaces, which is exactly what splitting on spaces undoes.
 */
function blockBody(text: string, width = 70, indent = "  "): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line) => indent + line).join("\n");
}

/** An agent whose description is a YAML block scalar rather than an inline value. */
function writeBlockAgent(
  name: string,
  description: string,
  indicator: ">-" | "|",
): void {
  writeFile(
    path.join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${indicator}\n${blockBody(description)}\nmodel: inherit\n---\n\nAgent body text that is not identity.\n`,
  );
}

/** Options pointing at the fixture tree; individual tests narrow them. */
function opts(overrides: Record<string, unknown> = {}) {
  return {
    globalInstructionPath: globalPath,
    projectDir,
    skillRoots: [skillsRoot],
    agentsDir,
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-budget-"));
  globalPath = path.join(root, "home", ".claude", "CLAUDE.md");
  projectDir = path.join(root, "repo");
  skillsRoot = path.join(root, "home", ".claude", "skills");
  agentsDir = path.join(root, "home", ".claude", "agents");
  writeFile(globalPath, "G".repeat(1000));
  writeFile(path.join(projectDir, "CLAUDE.md"), "P".repeat(500));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what counts as auto-loaded", () => {
  it("counts a skill's name and description, never its body", () => {
    // This is the distinction the whole module turns on. A skill's body does not
    // auto-load; only the identity pair is surfaced so the model can decide
    // whether to ask for the rest. On a real machine the bodies are tens of times
    // the identity text, so counting them would not be a small error - it would
    // be the wrong answer by more than an order of magnitude.
    writeSkill("alpha", "Does the alpha thing.", 40_000);
    writeSkill("beta", "Does the beta thing.", 40_000);

    const budget = instructionBudget(opts({ agentsDir: undefined }));
    const identity = budget.buckets.find((b) => b.bucket === "identity-only")!;

    expect(identity.files).toBe(2);
    // name + description for each, and nothing else.
    expect(identity.chars).toBe(
      identityChars("alpha", "Does the alpha thing.") +
        identityChars("beta", "Does the beta thing."),
    );
    expect(identity.chars).toBeLessThan(200);
    // The bodies are reported, and reported as excluded.
    expect(budget.skillBodiesExcluded.files).toBe(2);
    expect(budget.skillBodiesExcluded.chars).toBeGreaterThan(80_000);
    expect(budget.skillBodiesExcluded.overstatementFactor).toBeGreaterThan(100);
    // No total anywhere is anywhere near body size.
    for (const bucket of budget.buckets) {
      expect(bucket.chars).toBeLessThan(10_000);
    }
    expect(budget.alwaysLoaded.chars).toBe(1500);
  });

  it("labels a nested instruction file conditional, separately from the always-loaded ones", () => {
    // A file inside a subtree is a real cost, but only once that subtree is
    // entered. Folding it into the standing total would overstate every session
    // that never touches it.
    writeFile(path.join(projectDir, "packages", "api", "CLAUDE.md"), "N".repeat(2000));

    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(budget.alwaysLoaded.chars).toBe(1500);
    const conditional = budget.buckets.find((b) => b.bucket === "conditional")!;
    expect(conditional.files).toBe(1);
    expect(conditional.chars).toBe(2000);
    expect(
      budget.sources.find((s) => s.kind === "nested-project-instructions")!.label,
    ).toBe(path.join("packages", "api", "CLAUDE.md"));
  });

  it("keeps agent descriptions out of every total", () => {
    // Whether an agent's description is surfaced on every session cannot be
    // established from the files on disk, and a number nobody can check does not
    // belong inside one that can be.
    writeAgent("reviewer", "Reviews code for correctness and security.");
    writeAgent("writer", "Writes documentation.");

    const budget = instructionBudget(opts({ skillRoots: [] }));
    const unverified = budget.buckets.find((b) => b.bucket === "unverified")!;
    expect(unverified.files).toBe(2);
    expect(unverified.chars).toBeGreaterThan(0);
    expect(budget.alwaysLoaded.chars).toBe(1500);
    expect(
      budget.buckets.find((b) => b.bucket === "identity-only")!.chars,
    ).toBe(0);
  });

  it("counts an agent whose description contains an unquoted colon", () => {
    // Real agent definitions write "Modes - review: ..." unquoted, which a strict
    // YAML parser rejects. Dropping the file would zero out part of a count whose
    // whole job is to say how many agents there are.
    writeFile(
      path.join(agentsDir, "modal.md"),
      "---\nname: modal\ndescription: Two modes - review: correctness | debug: root cause\nmodel: opus\n---\n\nBody.\n",
    );
    const budget = instructionBudget(opts({ skillRoots: [] }));
    const unverified = budget.buckets.find((b) => b.bucket === "unverified")!;
    expect(unverified.files).toBe(1);
    expect(unverified.chars).toBe(
      identityChars("modal", "Two modes - review: correctness | debug: root cause"),
    );
  });

  it("counts an ancestor instruction file as always loaded", () => {
    // An instruction file one level above the working directory loads in full too.
    writeFile(path.join(root, "CLAUDE.md"), "A".repeat(300));
    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(budget.alwaysLoaded.chars).toBe(1800);
    expect(budget.alwaysLoaded.files).toBe(3);
  });

  it("counts the private project override, which loads the same way", () => {
    writeFile(path.join(projectDir, "CLAUDE.local.md"), "L".repeat(700));
    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(budget.alwaysLoaded.chars).toBe(2200);
  });

  it("counts a file reachable by two routes only once", () => {
    // The global instruction file is also <home>/.claude/CLAUDE.md, which the walk
    // up the directory tree passes through. Counting it twice would double the
    // headline figure, which is the most damaging arithmetic error available here.
    const budget = instructionBudget({
      globalInstructionPath: globalPath,
      projectDir: path.join(root, "home"),
      skillRoots: [],
    });
    expect(budget.alwaysLoaded.chars).toBe(1000);
    expect(budget.alwaysLoaded.files).toBe(1);
    expect(budget.sources.filter((s) => s.chars === 1000)).toHaveLength(1);
  });
});

describe("token estimate", () => {
  it("derives tokens from the stated characters-per-token assumption", () => {
    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(budget.charsPerToken).toBe(CHARS_PER_TOKEN);
    expect(budget.alwaysLoaded.estimatedTokens).toBe(
      Math.round(budget.alwaysLoaded.chars / CHARS_PER_TOKEN),
    );
    const global = budget.sources.find((s) => s.kind === "global-instructions")!;
    expect(global.estimatedTokens).toBe(Math.round(1000 / CHARS_PER_TOKEN));
  });
});

describe("the size convention", () => {
  it("bands a single file against the warning line and the ceiling", () => {
    expect(ceilingStatus(0)).toBe("ok");
    expect(ceilingStatus(WARNING_CHARS - 1)).toBe("ok");
    expect(ceilingStatus(WARNING_CHARS)).toBe("warning");
    expect(ceilingStatus(SOFT_CEILING_CHARS)).toBe("over");
  });

  it("measures the ceiling per file and never against the sum", () => {
    // Two files comfortably under the ceiling sum past it. Reporting that as over
    // would flag a healthy machine, which is the field-name trap this guards.
    writeFile(globalPath, "G".repeat(35_000));
    writeFile(path.join(projectDir, "CLAUDE.md"), "P".repeat(11_000));

    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(budget.alwaysLoaded.chars).toBe(46_000);
    expect(budget.alwaysLoaded.chars).toBeGreaterThan(SOFT_CEILING_CHARS);
    expect(budget.alwaysLoaded.worstFileStatus).toBe("ok");
    expect(budget.alwaysLoaded.filesOverCeiling).toBe(0);
    expect(budget.alwaysLoaded.largestFileChars).toBe(35_000);
    expect(budget.alwaysLoaded.headroomOnLargestFile).toBe(5000);
    expect(budget.alwaysLoaded.percentOfCeilingLargestFile).toBeCloseTo(87.5, 5);
    expect(budget.alwaysLoaded.ceilingAppliesTo).toMatch(/each instruction file/);
  });

  it("reports a file past the ceiling as over", () => {
    writeFile(globalPath, "G".repeat(SOFT_CEILING_CHARS + 10));
    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(budget.alwaysLoaded.worstFileStatus).toBe("over");
    expect(budget.alwaysLoaded.filesOverCeiling).toBe(1);
    expect(budget.alwaysLoaded.headroomOnLargestFile).toBe(0);
  });

  it("leaves an identity row without a ceiling status", () => {
    // The convention is about whole instruction files. Putting a status on one
    // skill's description would invite adding up figures that do not add up.
    writeSkill("alpha", "Does the alpha thing.", 100);
    const budget = instructionBudget(opts({ agentsDir: undefined }));
    const skill = budget.sources.find((s) => s.kind === "skill-identity")!;
    expect(skill.ceilingStatus).toBeNull();
    expect(
      budget.sources.find((s) => s.kind === "global-instructions")!.ceilingStatus,
    ).toBe("ok");
  });
});

describe("counting", () => {
  it("counts characters of decoded text rather than bytes on disk", () => {
    // A multi-byte character is one character to the tool that warns about size
    // and one character to divide into a token estimate; counting its bytes would
    // overstate the file.
    // An accented letter, which is two bytes and one character.
    writeFile(globalPath, "é".repeat(100));
    expect(fs.statSync(globalPath).size).toBe(200);
    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    expect(
      budget.sources.find((s) => s.kind === "global-instructions")!.chars,
    ).toBe(100);
  });

  it("never returns any instruction text", () => {
    writeFile(globalPath, "SENSITIVE-GLOBAL-INSTRUCTION-TEXT and more");
    writeFile(path.join(projectDir, "CLAUDE.md"), "SENSITIVE-PROJECT-TEXT");
    writeSkill("alpha", "Does the alpha thing.", 200);
    const serialised = JSON.stringify(instructionBudget(opts()));
    expect(serialised).not.toContain("SENSITIVE-GLOBAL-INSTRUCTION-TEXT");
    expect(serialised).not.toContain("SENSITIVE-PROJECT-TEXT");
    expect(serialised).not.toContain("bbbb");
  });

  it("sorts biggest first inside each bucket so the row worth trimming is on top", () => {
    writeFile(path.join(root, "CLAUDE.md"), "A".repeat(9000));
    const budget = instructionBudget(opts({ agentsDir: undefined, skillRoots: [] }));
    const always = budget.sources.filter((s) => s.bucket === "always");
    expect(always.map((s) => s.chars)).toEqual([9000, 1000, 500]);
  });
});

describe("missing sources", () => {
  it("names the paths rather than returning an empty budget", () => {
    // An empty budget would read as "no instructions are loaded", which is false
    // for any real install and a different claim from "nothing was found here".
    fs.rmSync(globalPath);
    fs.rmSync(path.join(projectDir, "CLAUDE.md"));
    expect(() => instructionBudget(opts())).toThrow(SourceMissingError);
    try {
      instructionBudget(opts());
    } catch (err) {
      expect((err as SourceMissingError).sourcePath).toContain(globalPath);
    }
  });

  it("still reports when only the project file exists, and names what is absent", () => {
    fs.rmSync(globalPath);
    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));
    expect(budget.alwaysLoaded.chars).toBe(500);
    expect(budget.missingSources).toContain(globalPath);
  });

  it("names an absent skill root instead of silently reporting no skills", () => {
    const absent = path.join(root, "no-skills-here");
    const budget = instructionBudget(opts({ skillRoots: [absent], agentsDir: undefined }));
    expect(budget.missingSources).toContain(absent);
    expect(budget.skillBodiesExcluded.overstatementFactor).toBeNull();
  });

  it("refuses an empty project directory rather than falling back to the process cwd", () => {
    expect(() => instructionBudget(opts({ projectDir: "  " }))).toThrow(/projectDir/);
  });

  it("names an absent agents directory", () => {
    const absent = path.join(root, "no-agents-here");
    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: absent }));
    expect(budget.missingSources).toContain(absent);
  });

  it("skips a skill whose frontmatter is unusable rather than counting the file", () => {
    // A skill with no description is not surfaced, so it contributes nothing.
    writeFile(path.join(skillsRoot, "broken", "SKILL.md"), "no frontmatter at all\n");
    writeSkill("alpha", "Does the alpha thing.", 100);
    const budget = instructionBudget(opts({ agentsDir: undefined }));
    expect(budget.buckets.find((b) => b.bucket === "identity-only")!.files).toBe(1);
    // ...and says how many files it passed over, so a shrunken count cannot read
    // as a complete one.
    expect(budget.skillEnumeration.counted).toBe(1);
    expect(budget.skillEnumeration.skipped).toEqual([
      { reason: "no-description-in-frontmatter", count: 1 },
    ]);
  });

  it("names an absent root even when another configured root exists", () => {
    // The damaging case is a partial absence: one mistyped root of several drops
    // most of the identity bucket while every figure still reads as a full count.
    writeSkill("alpha", "Does the alpha thing.", 100);
    writeSkill("beta", "Does the beta thing.", 100);
    const absent = path.join(root, "second-root-does-not-exist");

    const budget = instructionBudget(
      opts({ skillRoots: [skillsRoot, absent], agentsDir: undefined }),
    );

    expect(budget.missingSources).toContain(absent);
    // The skills that were found are still counted; the absence is reported
    // beside them rather than instead of them.
    expect(budget.skillEnumeration.counted).toBe(2);
    expect(budget.buckets.find((b) => b.bucket === "identity-only")!.files).toBe(2);
  });

  it("reports an agent file with no frontmatter identity as passed over", () => {
    writeAgent("reviewer", "Reviews code for correctness and security.");
    writeFile(path.join(agentsDir, "notes.md"), "Plain notes, no frontmatter.\n");
    const budget = instructionBudget(opts({ skillRoots: [] }));
    expect(budget.agentEnumeration.counted).toBe(1);
    expect(budget.agentEnumeration.skipped).toEqual([
      { reason: "no-frontmatter-identity", count: 1 },
    ]);
  });
});

describe("which skills are actually surfaced", () => {
  it("counts a skill directory reached through a symlink", () => {
    // A skill kept in another repo and linked into the skills directory is a
    // skill the tool surfaces. A directory entry reports a symlink as a symlink
    // rather than as the directory it points at, so testing the entry drops the
    // whole skill from a count whose job is to say how many there are.
    const external = path.join(root, "elsewhere", "linked-skill");
    writeFile(
      path.join(external, "SKILL.md"),
      `---\nname: linked-skill\ndescription: Lives outside the skills directory.\n---\n\n${"b".repeat(500)}\n`,
    );
    writeSkill("alpha", "Does the alpha thing.", 100);
    fs.symlinkSync(external, path.join(skillsRoot, "linked-skill"), "dir");

    const budget = instructionBudget(opts({ agentsDir: undefined }));

    expect(budget.skillEnumeration.counted).toBe(2);
    expect(budget.sources.map((s) => s.label)).toContain("/linked-skill");
    expect(budget.buckets.find((b) => b.bucket === "identity-only")!.chars).toBe(
      identityChars("alpha", "Does the alpha thing.") +
        identityChars("linked-skill", "Lives outside the skills directory."),
    );
  });

  it("treats an identity file inside a skill's own directory as that skill's material", () => {
    // A variant copy kept beside a skill is not a second installed skill: the
    // tool surfaces the outer one only. Counting the copies adds identity text
    // that never enters the window, which overstates the bucket.
    writeSkill("parent", "The skill that is surfaced.", 200);
    writeFile(
      path.join(skillsRoot, "parent", "variants", "one", "SKILL.md"),
      "---\nname: parent-one\ndescription: A variant copy that is not installed.\n---\n\nbody\n",
    );
    writeFile(
      path.join(skillsRoot, "parent", "variants", "two", "SKILL.md"),
      "---\nname: parent-two\ndescription: Another variant copy that is not installed.\n---\n\nbody\n",
    );

    const budget = instructionBudget(opts({ agentsDir: undefined }));

    expect(budget.skillEnumeration.counted).toBe(1);
    expect(budget.buckets.find((b) => b.bucket === "identity-only")!.chars).toBe(
      identityChars("parent", "The skill that is surfaced."),
    );
    expect(budget.sources.map((s) => s.label)).not.toContain("/parent-one");
    expect(budget.sources.map((s) => s.label)).not.toContain("/parent-two");
  });

  it("finds a plugin's skills through the install manifest, including grouped ones", () => {
    // A plugin store keeps superseded versions and a second copy of each
    // marketplace repo, so the manifest is the only thing that says which copy is
    // live. Within a plugin, skills may sit under a category directory.
    const store = path.join(root, "home", ".claude", "plugins");
    const install = path.join(store, "cache", "market", "demo", "1.0.0");
    writeFile(
      path.join(store, "installed_plugins.json"),
      JSON.stringify({ plugins: { "demo@market": [{ installPath: install }] } }),
    );
    writeFile(
      path.join(install, "skills", "grouped", "inner", "SKILL.md"),
      "---\nname: inner\ndescription: A skill under a category directory.\n---\n\nbody\n",
    );
    // A superseded copy under the store that the manifest does not point at.
    writeFile(
      path.join(store, "cache", "market", "demo", "0.9.0", "skills", "inner", "SKILL.md"),
      "---\nname: inner\ndescription: An older copy that is not installed.\n---\n\nbody\n",
    );

    const budget = instructionBudget(
      opts({ skillRoots: [store], agentsDir: undefined }),
    );

    expect(budget.skillEnumeration.counted).toBe(1);
    expect(budget.sources.map((s) => s.label)).toContain("/demo:inner");
    expect(budget.buckets.find((b) => b.bucket === "identity-only")!.chars).toBe(
      identityChars("inner", "A skill under a category directory."),
    );
  });
});

describe("multi-line frontmatter", () => {
  // One description, three ways of writing it. The words are identical, so the
  // cost in the window is identical, and reading only the line the key sits on
  // reduces a block form to its two-character indicator - a row that still looks
  // counted with nearly all of its text gone.
  const description =
    "Reviews a change for correctness and for security, then reports what it " +
    "found in order of severity. Modes - review: correctness | debug: root " +
    "cause. Never edits the files it is reading.";

  it("counts a folded description at the same size as the same text inline", () => {
    writeAgent("inline-agent", description);
    writeBlockAgent("folded-agent", description, ">-");

    const budget = instructionBudget(opts({ skillRoots: [] }));
    const inline = budget.sources.find((s) => s.label === "inline-agent")!;
    const folded = budget.sources.find((s) => s.label === "folded-agent")!;

    expect(inline.chars).toBe(identityChars("inline-agent", description));
    expect(folded.chars).toBe(identityChars("folded-agent", description));
    expect(folded.chars).toBe(inline.chars);
    expect(budget.buckets.find((b) => b.bucket === "unverified")!.chars).toBe(
      inline.chars + folded.chars,
    );
  });

  it("counts a literal block description at the same size as the same text inline", () => {
    // A literal block joins its lines with newlines instead of spaces, so the
    // separator count - and therefore the size - is the same.
    writeAgent("inline-agent", description);
    writeBlockAgent("literal-agent", description, "|");

    const budget = instructionBudget(opts({ skillRoots: [] }));
    const inline = budget.sources.find((s) => s.label === "inline-agent")!;
    const literal = budget.sources.find((s) => s.label === "literal-agent")!;

    expect(literal.chars).toBe(identityChars("literal-agent", description));
    // Same description, so the same size once the differing names are taken off.
    expect(literal.chars - "literal-agent".length).toBe(
      inline.chars - "inline-agent".length,
    );
    // Far more than the two characters of a block indicator, which is what a
    // line-at-a-time read of the key would have counted.
    expect(literal.chars).toBeGreaterThan(150);
  });

  it("counts a quoted description at its decoded length, not its escaped length", () => {
    // What reaches the window is the decoded string: an inner quote written as \"
    // costs one character there, not two. Measuring the escaped form charges the
    // description for its own punctuation twice.
    const quoted =
      'Trigger when the user says "deck" or "slides".\nBoth spellings count.';
    writeAgent("quoted-agent", quoted);

    const budget = instructionBudget(opts({ skillRoots: [] }));
    const row = budget.sources.find((s) => s.label === "quoted-agent")!;

    expect(row.chars).toBe(identityChars("quoted-agent", quoted));
  });

  it("does not read the key after a block description as part of it", () => {
    // The block body ends where the indentation does. Swallowing the next key
    // would inflate the same figure the block bug deflates.
    writeBlockAgent("folded-agent", description, ">-");
    const budget = instructionBudget(opts({ skillRoots: [] }));
    const folded = budget.sources.find((s) => s.label === "folded-agent")!;
    expect(folded.chars).toBe(identityChars("folded-agent", description));
  });
});

describe("bounds on the nested walk", () => {
  it("reports the depth bound as truncation rather than printing a short count", () => {
    // Past the bound the conditional bucket is a floor, not a count. A consumer
    // rendering "N nested files" cannot tell the two apart unless the payload
    // says which it has.
    const deep = path.join(
      projectDir,
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
    );
    writeFile(path.join(deep, "CLAUDE.md"), "D".repeat(7000));
    writeFile(path.join(projectDir, "near", "CLAUDE.md"), "N".repeat(11));

    const budget = instructionBudget(
      opts({ skillRoots: [], agentsDir: undefined, maxNestedDepth: 8 }),
    );

    expect(budget.nestedWalk.truncated).toBe(true);
    expect(budget.nestedWalk.skippedByDepth).toBeGreaterThan(0);
    expect(budget.nestedWalk.maxDepth).toBe(8);
    // The shallow file is still counted; the deep one is what the flag is about.
    expect(budget.buckets.find((b) => b.bucket === "conditional")!.files).toBe(1);
  });

  it("does not claim truncation when the tree simply ends at the depth bound", () => {
    writeFile(path.join(projectDir, "one", "two", "CLAUDE.md"), "N".repeat(50));
    const budget = instructionBudget(
      opts({ skillRoots: [], agentsDir: undefined, maxNestedDepth: 8 }),
    );
    expect(budget.nestedWalk.truncated).toBe(false);
    expect(budget.nestedWalk.skippedByDepth).toBe(0);
    expect(budget.nestedWalk.skippedByDirLimit).toBe(0);
    expect(budget.nestedWalk.dirsVisited).toBe(2);
  });

  it("does not claim truncation for a tree of exactly the directory bound", () => {
    // Visiting the last directory in the budget is not the same as running out
    // of budget with directories left. Warning at the first is crying wolf.
    const limit = instructionBudget(
      opts({ skillRoots: [], agentsDir: undefined, maxNestedDepth: 1 }),
    ).nestedWalk.dirLimit;
    for (let i = 0; i < limit; i += 1) {
      fs.mkdirSync(path.join(projectDir, `d${i}`));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const budget = instructionBudget(
        opts({ skillRoots: [], agentsDir: undefined, maxNestedDepth: 1 }),
      );
      expect(budget.nestedWalk.dirsVisited).toBe(limit);
      expect(budget.nestedWalk.skippedByDirLimit).toBe(0);
      expect(budget.nestedWalk.truncated).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reports the directory bound as truncation once a directory is left unvisited", () => {
    const limit = instructionBudget(
      opts({ skillRoots: [], agentsDir: undefined, maxNestedDepth: 1 }),
    ).nestedWalk.dirLimit;
    for (let i = 0; i <= limit; i += 1) {
      fs.mkdirSync(path.join(projectDir, `d${i}`));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const budget = instructionBudget(
        opts({ skillRoots: [], agentsDir: undefined, maxNestedDepth: 1 }),
      );
      expect(budget.nestedWalk.skippedByDirLimit).toBe(1);
      expect(budget.nestedWalk.truncated).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("files pulled in by an import line", () => {
  it("counts an imported file in the bucket of the file that imported it", () => {
    // An @path import loads in full on every session, exactly like the file that
    // wrote the line. Leaving it out understates the bucket labelled as such.
    const globalText = `${"G".repeat(500)}\n@./imported.md\n`;
    writeFile(globalPath, globalText);
    writeFile(path.join(path.dirname(globalPath), "imported.md"), "I".repeat(20_000));

    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));

    expect(budget.imports.seen).toBe(1);
    expect(budget.imports.counted).toBe(1);
    expect(budget.imports.skipped).toEqual([]);
    expect(budget.imports.truncated).toBe(false);
    const imported = budget.sources.find((s) => s.kind === "imported-instructions")!;
    expect(imported.chars).toBe(20_000);
    expect(imported.bucket).toBe("always");
    expect(budget.alwaysLoaded.chars).toBe(20_000 + globalText.length + 500);
    expect(budget.note).toMatch(/import/i);
  });

  it("puts an import of a nested file in the conditional bucket, not the standing one", () => {
    writeFile(
      path.join(projectDir, "packages", "api", "CLAUDE.md"),
      "@./shared.md\n",
    );
    writeFile(path.join(projectDir, "packages", "api", "shared.md"), "S".repeat(300));

    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));

    expect(budget.imports.counted).toBe(1);
    expect(budget.alwaysLoaded.chars).toBe(1500);
    expect(budget.buckets.find((b) => b.bucket === "conditional")!.chars).toBe(313);
  });

  it("refuses an import that climbs out of the importing file's directory, and says so", () => {
    writeFile(path.join(root, "outside.md"), "O".repeat(400));
    writeFile(path.join(projectDir, "CLAUDE.md"), "@../outside.md\n");

    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));

    expect(budget.imports.seen).toBe(1);
    expect(budget.imports.counted).toBe(0);
    expect(budget.imports.skipped).toEqual([
      { reason: "outside-importing-directory", count: 1 },
    ]);
    expect(budget.sources.some((s) => s.chars === 400)).toBe(false);
  });

  it("counts an import that names a missing file as a skip rather than a row", () => {
    writeFile(globalPath, "@./not-there.md\n");
    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));
    expect(budget.imports.seen).toBe(1);
    expect(budget.imports.counted).toBe(0);
    expect(budget.imports.skipped).toEqual([
      { reason: "import-target-not-a-readable-file", count: 1 },
    ]);
  });

  it("does not treat the syntax shown inside code as an import", () => {
    // Documentation of the syntax is not a use of it.
    writeFile(
      globalPath,
      "Write it as `@./sample.md`, like this:\n\n```\n@./sample.md\n```\n",
    );
    writeFile(path.join(path.dirname(globalPath), "sample.md"), "S".repeat(900));

    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));

    expect(budget.imports.seen).toBe(0);
    expect(budget.imports.counted).toBe(0);
    expect(budget.sources.some((s) => s.chars === 900)).toBe(false);
  });

  it("stops a chain of imports at the hop bound and reports the stop", () => {
    const dir = path.dirname(globalPath);
    writeFile(globalPath, "@./hop1.md\n");
    for (let hop = 1; hop <= 6; hop += 1) {
      writeFile(path.join(dir, `hop${hop}.md`), `@./hop${hop + 1}.md\n`);
    }
    writeFile(path.join(dir, "hop7.md"), "end\n");

    const budget = instructionBudget(opts({ skillRoots: [], agentsDir: undefined }));

    expect(budget.imports.counted).toBe(budget.imports.maxHops);
    expect(budget.imports.truncated).toBe(true);
    expect(budget.imports.skipped).toEqual([
      { reason: "beyond-import-hop-bound", count: 1 },
    ]);
  });
});

describe("counting only what YAML would keep", () => {
  it("does not charge a definition for an indented comment line", () => {
    // The continuation rule folds indented lines into a plain value, which is right
    // for a wrapped description and wrong for a comment: YAML discards a comment, so
    // charging for one bills the operator for text the model never sees.
    writeFile(
      path.join(agentsDir, "commented-agent.md"),
      "---\nname: commented-agent\ndescription: Short one\n  # a comment line\n---\n\nBody.\n",
    );

    const budget = instructionBudget(opts({ skillRoots: [] }));
    const row = budget.sources.find((s) => s.label === "commented-agent")!;
    expect(row.chars).toBe(identityChars("commented-agent", "Short one"));
  });

  it("still folds a genuine indented continuation into the value", () => {
    // The guard above must not turn off continuation folding, which is the behaviour
    // a wrapped description depends on.
    writeFile(
      path.join(agentsDir, "wrapped-agent.md"),
      "---\nname: wrapped-agent\ndescription: First part\n  second part\n---\n\nBody.\n",
    );

    const budget = instructionBudget(opts({ skillRoots: [] }));
    const row = budget.sources.find((s) => s.label === "wrapped-agent")!;
    expect(row.chars).toBe(identityChars("wrapped-agent", "First part second part"));
  });

  it("calls the conditional bucket a floor when a directory cannot be read", () => {
    // Permission-denied is not one of the two bounds, but it has the same effect on
    // the total, so a report saying the walk finished would be claiming a count it
    // does not have.
    const locked = path.join(projectDir, "locked");
    fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
    writeFile(path.join(locked, "inner", "CLAUDE.md"), "x".repeat(4000));
    fs.chmodSync(locked, 0o000);
    try {
      const budget = instructionBudget(opts({ skillRoots: [] }));
      expect(budget.nestedWalk.unreadableDirs).toBeGreaterThanOrEqual(1);
      expect(budget.nestedWalk.truncated).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

