import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";
import { readabilityStats } from "./text/readability.js";

/**
 * Inventory of the orchestration scripts Claude has written on this machine.
 *
 * When a workflow runs, the script that drives it is generated and saved to disk.
 * That script is code the operator did not write and has probably never read, yet
 * it decided how many agents ran, what each was asked, and what was done with the
 * results. This repo's own rules name that category explicitly: code shipped or
 * run that no human fully understands. Surfacing the scripts is the cheapest
 * possible answer - it cannot force comprehension, but it can stop the artifacts
 * being invisible.
 *
 * Two locations, and the distinction matters. A saved workflow is a named,
 * reusable definition the operator chose to keep. A generated script is the
 * one-off a single run produced, stored under that session's directory.
 */

export type WorkflowKind = "saved" | "generated";

export type WorkflowScript = {
  /** File stem, which is the handle the operator sees. */
  name: string;
  kind: WorkflowKind;
  path: string;
  sizeBytes: number;
  lines: number;
  modifiedAt: string;
  /** Session that generated it, for the generated kind. */
  sessionId: string | null;
  /** Encoded project directory, for the generated kind. */
  projectDir: string | null;
  /** `name` from the script's own meta block, when it declares one. */
  declaredName: string | null;
  declaredDescription: string | null;
  /** Phase titles the script declares, which outline what it does. */
  phases: string[];
  /** How many agents it can spawn, counted from its own call sites. */
  agentCallSites: number;
  /** Whether it fans out, which is what makes agent count hard to predict. */
  usesParallel: boolean;
  usesPipeline: boolean;
  /** Whether it runs agents in isolated worktrees, meaning it writes files. */
  usesWorktrees: boolean;
  /** Reading grade of the declared description, if there is one. */
  descriptionGrade: number | null;
  reviewed: boolean;
};

/**
 * Pull the `meta` block's simple fields without executing the script.
 *
 * Regex rather than parsing, deliberately. These files are generated JavaScript
 * of arbitrary shape, and the only safe way to learn about a script you have not
 * read is to read it as text. Nothing here imports, evaluates, or runs it.
 */
function extractMeta(source: string): {
  name: string | null;
  description: string | null;
  phases: string[];
} {
  const name = source.match(/\bname:\s*(['"])([^'"]+)\1/)?.[2] ?? null;
  const description =
    source.match(/\bdescription:\s*(['"])([^'"]+)\1/)?.[2] ?? null;

  const phases: string[] = [];
  // Phase titles appear both in the meta block and in phase() calls; the set is
  // what outlines the script, so both spellings feed it.
  for (const match of source.matchAll(/\btitle:\s*(['"])([^'"]+)\1/g)) {
    if (match[2]) phases.push(match[2]);
  }
  for (const match of source.matchAll(/\bphase\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    if (match[2] && !phases.includes(match[2])) phases.push(match[2]);
  }
  return { name, description, phases };
}

function countOccurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function describeScript(
  filePath: string,
  kind: WorkflowKind,
  sessionId: string | null,
  projectDir: string | null,
): WorkflowScript | null {
  let stat: fs.Stats;
  let source: string;
  try {
    stat = fs.statSync(filePath);
    source = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(`workflows: skipping unreadable script ${filePath}:`, err);
    return null;
  }

  const meta = extractMeta(source);
  const description = meta.description;

  return {
    name: path.basename(filePath, ".js"),
    kind,
    path: filePath,
    sizeBytes: stat.size,
    lines: source.split("\n").length,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    sessionId,
    projectDir,
    declaredName: meta.name,
    declaredDescription: description,
    phases: meta.phases,
    agentCallSites: countOccurrences(source, /\bagent\s*\(/g),
    usesParallel: /\bparallel\s*\(/.test(source),
    usesPipeline: /\bpipeline\s*\(/.test(source),
    usesWorktrees: /isolation\s*:\s*(['"])worktree\1/.test(source),
    descriptionGrade: description ? readabilityStats(description).grade : null,
    // This tool has no record of what the operator has read, and inventing one
    // would mean writing to a data source. Always false, and honest about it:
    // the list is the prompt to review, not a claim about what was reviewed.
    reviewed: false,
  };
}

/**
 * Find generated scripts under a transcript tree.
 *
 * Layout: <transcriptsDir>/<projectDir>/<sessionId>/workflows/scripts/*.js. The
 * session and project are recovered from the path, so a script can be traced back
 * to the run that produced it.
 */
function generatedScripts(transcriptsDir: string): WorkflowScript[] {
  const out: WorkflowScript[] = [];
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const projectEntry of projectDirs) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(transcriptsDir, projectEntry.name);

    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      const scriptsDir = path.join(
        projectPath,
        sessionEntry.name,
        "workflows",
        "scripts",
      );
      if (!fs.existsSync(scriptsDir)) continue;

      let files: string[];
      try {
        files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const file of files) {
        const script = describeScript(
          path.join(scriptsDir, file),
          "generated",
          sessionEntry.name,
          projectEntry.name,
        );
        if (script) out.push(script);
      }
    }
  }
  return out;
}

/** Named, reusable workflow definitions the operator kept. */
function savedScripts(workflowsDir: string): WorkflowScript[] {
  if (!fs.existsSync(workflowsDir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith(".js"));
  } catch {
    return [];
  }
  return files
    .map((file) => describeScript(path.join(workflowsDir, file), "saved", null, null))
    .filter((script): script is WorkflowScript => script !== null);
}

export type WorkflowInventory = {
  scripts: WorkflowScript[];
  stats: {
    total: number;
    saved: number;
    generated: number;
    /** Sum of agent call sites, an upper bound on distinct spawn points. */
    agentCallSites: number;
    /** Scripts that fan out, so their real agent count is not the call-site count. */
    fanOut: number;
    /** Scripts that run agents in isolated worktrees, meaning they write files. */
    writeIsolated: number;
    totalBytes: number;
  };
  note: string;
};

/**
 * Every orchestration script on this machine, newest first.
 *
 * `agentCallSites` counts call sites in the source, not agents that ran. A script
 * that maps one call over a list spawns as many agents as the list is long, so for
 * anything using fan-out the real number is unbounded by the source. Reported this
 * way rather than as an estimate, because an estimate would be wrong in the
 * direction that matters.
 */
export function workflowInventory(
  transcriptsDir: string,
  workflowsDir: string,
): WorkflowInventory {
  if (!fs.existsSync(transcriptsDir) && !fs.existsSync(workflowsDir)) {
    throw new SourceMissingError("workflow scripts", `${workflowsDir}, ${transcriptsDir}`);
  }

  const scripts = [
    ...savedScripts(workflowsDir),
    ...generatedScripts(transcriptsDir),
  ].sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));

  return {
    scripts,
    stats: {
      total: scripts.length,
      saved: scripts.filter((s) => s.kind === "saved").length,
      generated: scripts.filter((s) => s.kind === "generated").length,
      agentCallSites: scripts.reduce((sum, s) => sum + s.agentCallSites, 0),
      fanOut: scripts.filter((s) => s.usesParallel || s.usesPipeline).length,
      writeIsolated: scripts.filter((s) => s.usesWorktrees).length,
      totalBytes: scripts.reduce((sum, s) => sum + s.sizeBytes, 0),
    },
    note:
      "Scripts are read as text and never imported or executed. Agent call sites " +
      "count occurrences in the source, not agents that ran: a script that fans " +
      "out spawns as many agents as its input is long.",
  };
}

/** One script's full source, for actually reading it. */
export function readWorkflowScript(
  transcriptsDir: string,
  workflowsDir: string,
  scriptPath: string,
): { script: WorkflowScript; source: string } | null {
  // The path comes from a client, so it is only served when it is one this
  // inventory produced. Comparing against the known set is stricter than a
  // prefix check and cannot be defeated by traversal or a symlink.
  const inventory = workflowInventory(transcriptsDir, workflowsDir);
  const script = inventory.scripts.find((entry) => entry.path === scriptPath);
  if (!script) return null;
  try {
    return { script, source: fs.readFileSync(script.path, "utf8") };
  } catch {
    return null;
  }
}
