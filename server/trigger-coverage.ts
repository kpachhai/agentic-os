import { SourceMissingError } from "./config.js";
import fs from "node:fs";
import {
  listTranscriptFiles,
  scanCached,
  streamTranscript,
  type TranscriptRecord,
} from "./transcripts.js";

/**
 * Which of the operator's standing rules ever had their trigger occur.
 *
 * The instruction-budget pillar answers what the rules cost. This answers a
 * different question: whether the situation a rule is about has come up at all
 * lately. A rule whose trigger never fired in the window is a deletion
 * candidate, pre-marked, so a periodic instruction audit starts from evidence
 * instead of from a blank page.
 *
 * WHAT THIS DELIBERATELY REFUSES TO DO. It does not score adherence, and there
 * is no percentage anywhere in its output. Detecting a *violation* from a
 * transcript was measured and it does not work: over 476 transcripts and 257
 * real `git commit` invocations, a signed-commit check produced nine hits and
 * all nine were false positives - fixtures in temp repos, a test OF the
 * signing-check hook whose violating command was passed as data, and commits
 * run over SSH as a different user on another machine. The cause is structural
 * rather than a weak pattern: a transcript records what command ran, never whose
 * repository it ran in or whose policy applied. So occurrence is reported and
 * compliance is not, because occurrence is the half the evidence supports.
 *
 * THE THIRD BUCKET IS NOT A HEDGE. Plenty of real rules have no observable
 * trigger at all - the trigger is a keystroke, a hook firing, or a judgement
 * about prose. Reporting those as "never triggered" would mark good rules for
 * deletion on the strength of evidence that could not exist. They are named and
 * held apart.
 */

export type TriggerKind = "bash" | "tool" | "mcp" | "skill" | "not-observable";

export type TriggerProbe = {
  id: string;
  /** The standing rule or topic this is evidence for. */
  topic: string;
  kind: TriggerKind;
  /**
   * What counts as an occurrence. For `bash`, the command heads that must START
   * a segment. For `tool`, `mcp` and `skill`, the recorded names. Empty for a
   * rule with no observable trigger, which is the point of that kind.
   */
  match?: string[];
  /**
   * File suffixes whose editing also counts as the trigger occurring.
   *
   * Needed because a language convention is not only observable through its
   * toolchain. Measured here: `forge`, `cast`, `anvil` and `slither` are invoked
   * exactly zero times in a 502-session corpus, so a CLI-only probe called the
   * Solidity rule a deletion candidate for an operator who writes Solidity. The
   * work shows up as edits to `.sol` files instead. A rule reported unused on
   * evidence that was never going to exist is the one output this pillar cannot
   * afford.
   */
  extensions?: string[];
  /** Only for `not-observable`: why no transcript can speak to this rule. */
  why?: string;
};

/**
 * The declared probe table.
 *
 * Hand-written on purpose. Deriving a trigger from the prose of a rule would be
 * a model judgement about what the rule means, and this pillar exists precisely
 * because that class of inference did not survive measurement. A probe is a
 * claim the operator can check by reading one line.
 */
export const TRIGGER_PROBES: TriggerProbe[] = [
  {
    id: "solidity",
    topic: "Solidity and EVM contract conventions",
    kind: "bash",
    match: ["forge", "cast", "anvil", "slither"],
    extensions: [".sol"],
  },
  {
    id: "rust",
    topic: "Rust conventions",
    kind: "bash",
    match: ["cargo", "rustc", "rustup"],
    extensions: [".rs"],
  },
  {
    id: "go",
    topic: "Go conventions",
    kind: "bash",
    match: ["go", "gofmt"],
    extensions: [".go"],
  },
  { id: "python", topic: "Python conventions", kind: "bash", match: ["python", "python3", "pip", "pip3", "uv", "pytest", "ruff"], extensions: [".py"] },
  { id: "chezmoi", topic: "dotfiles discipline: generic vs machine-local", kind: "bash", match: ["chezmoi"] },
  { id: "docker", topic: "container and image conventions", kind: "bash", match: ["docker", "docker-compose", "podman"] },
  { id: "kubernetes", topic: "cluster operations", kind: "bash", match: ["kubectl", "helm", "k9s"] },
  {
    id: "pii-scrub",
    topic: "PII discipline for publishable repos",
    kind: "bash",
    match: ["pii-scan.sh", "scrub-pii-history.sh", "planning-vocab-scan.sh"],
  },
  { id: "git-commit", topic: "signed, signed-off commits", kind: "bash", match: ["git"] },
  { id: "web-research", topic: "URL retrieval and citation discipline", kind: "tool", match: ["WebFetch", "WebSearch"] },
  { id: "delegation", topic: "subagent and orchestration discipline", kind: "tool", match: ["Task", "Agent"] },
  {
    id: "signing-hook",
    topic: "commit signing enforced before the commit lands",
    kind: "not-observable",
    why: "A PostToolUse hook decides this. Hook records carry a count and an exit status, never which rule they were enforcing, so no transcript can attribute an outcome to this rule.",
  },
  {
    id: "hash-capture",
    topic: "capture corrections as durable rules with #",
    kind: "not-observable",
    why: "The trigger is a keystroke in the terminal. It leaves no tool call and no record of any kind in a transcript.",
  },
  {
    id: "hedging",
    topic: "hedge rather than state an unverified fact",
    kind: "not-observable",
    why: "Whether a sentence should have hedged is a judgement about prose. Detecting it would need a model reading the transcript, which is the inference this pillar refuses to make.",
  },
];

export type TriggerBucket = "triggered" | "never-triggered" | "not-observable";

export type TriggerCoverageRow = {
  id: string;
  topic: string;
  kind: TriggerKind;
  match: string[];
  extensions: string[];
  bucket: TriggerBucket;
  /** Occurrences in the window; always 0 for a rule with no observable trigger. */
  occurrences: number;
  /** Distinct sessions the trigger occurred in. */
  sessions: number;
  lastSeenAt: string | null;
  why?: string;
};

export type TriggerCoverageReport = {
  rows: TriggerCoverageRow[];
  triggeredCount: number;
  neverTriggeredCount: number;
  notObservableCount: number;
  /** Sessions actually read, and how far back the window reaches. */
  sessionsScanned: number;
  windowDays: number;
  earliestRecordAt: string | null;
  /**
   * Deliberately absent: any adherence figure. Stated in the payload so a client
   * cannot quietly compute one and present it as this pillar's answer.
   */
  adherenceReported: false;
};

// Bump whenever the scan changes what it counts. The memo is keyed on this, so a
// stale id would serve results computed by the previous logic against files that
// have not changed - the file-edit observable was added and every cached tally
// predating it is missing those counts.
const EXTRACTOR_ID = "trigger-coverage-v2";

/**
 * Strip heredoc bodies before anything else looks at the command.
 *
 * A heredoc carries arbitrary text, and that text routinely contains commands
 * that were written rather than run - a script being generated, a message being
 * composed. Left in, the body's lines look exactly like segments of the command
 * itself, which is one of the three ways a mention gets counted as an
 * invocation.
 */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let terminator: string | null = null;

  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (opener) {
      terminator = opener[2]!;
      // The line that opens the heredoc still ran, so it is kept; only the body
      // between it and the terminator is dropped.
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Split a command line into the segments a shell would execute, respecting
 * quotes so an operator inside a quoted string does not start a new segment.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n" || char === "&") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** Wrappers that delegate to the real command, so the head is the next token. */
const TRANSPARENT_HEADS = new Set([
  "sudo",
  "command",
  "time",
  "env",
  "nohup",
  "xargs",
  "nice",
  "exec",
]);

/**
 * The command a segment actually invokes, or null when it invokes nothing.
 *
 * Leading environment assignments and wrapper commands are stepped over, and a
 * path is reduced to its basename so `~/.claude/scripts/pii-scan.sh` and
 * `pii-scan.sh` are one thing. Anything that is not the head of a segment is not
 * an invocation, which is what keeps `echo "git commit"` and
 * `grep 'git commit' file` out of the counts.
 */
function segmentHead(segment: string): string | null {
  let tokens = segment
    .trim()
    .replace(/^[({!]\s*/, "")
    .split(/\s+/)
    .filter(Boolean);

  for (;;) {
    const head = tokens[0];
    if (head === undefined) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || TRANSPARENT_HEADS.has(head)) {
      tokens = tokens.slice(1);
      continue;
    }
    const bare = head.slice(head.lastIndexOf("/") + 1);
    return bare || null;
  }
}

/** Every command head a Bash invocation actually ran. */
export function invokedCommands(command: string): string[] {
  return splitSegments(stripHeredocs(command))
    .map(segmentHead)
    .filter((head): head is string => head !== null);
}

type FileTally = {
  /** probe id -> occurrences in this file */
  counts: Record<string, number>;
  /** probe id -> whether it occurred at all in this file */
  present: string[];
  lastSeenAt: Record<string, string>;
  earliestRecordAt: string;
  hasRecords: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string) : "";
}

/** Tools that name a file they changed, so an edit to it is observable. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const EXTENSION_PROBES = TRIGGER_PROBES.filter(
  (probe) => (probe.extensions?.length ?? 0) > 0,
);
const BASH_PROBES = TRIGGER_PROBES.filter((probe) => probe.kind === "bash");
const TOOL_PROBES = TRIGGER_PROBES.filter((probe) => probe.kind === "tool");
const MCP_PROBES = TRIGGER_PROBES.filter((probe) => probe.kind === "mcp");
const SKILL_PROBES = TRIGGER_PROBES.filter((probe) => probe.kind === "skill");

function scanFile(filePath: string): FileTally {
  const counts: Record<string, number> = {};
  const lastSeenAt: Record<string, string> = {};
  let earliestRecordAt = "";
  let hasRecords = false;

  const note = (probeId: string, timestamp: string): void => {
    counts[probeId] = (counts[probeId] ?? 0) + 1;
    if (timestamp && (!lastSeenAt[probeId] || timestamp > lastSeenAt[probeId]!)) {
      lastSeenAt[probeId] = timestamp;
    }
  };

  for (const line of streamTranscript(filePath)) {
    if (!line.ok) continue;
    const record: TranscriptRecord = line.record;
    const timestamp = str(record as Record<string, unknown>, "timestamp");
    if (timestamp) {
      hasRecords = true;
      if (!earliestRecordAt || timestamp < earliestRecordAt) earliestRecordAt = timestamp;
    }

    const skill = str(record as Record<string, unknown>, "attributionSkill");
    if (skill) {
      for (const probe of SKILL_PROBES) {
        if (probe.match?.includes(skill)) note(probe.id, timestamp);
      }
    }
    const mcpServer = str(record as Record<string, unknown>, "attributionMcpServer");
    if (mcpServer) {
      for (const probe of MCP_PROBES) {
        if (probe.match?.includes(mcpServer)) note(probe.id, timestamp);
      }
    }

    const message = asRecord((record as Record<string, unknown>).message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (!block || str(block, "type") !== "tool_use") continue;
      const toolName = str(block, "name");

      for (const probe of TOOL_PROBES) {
        if (probe.match?.includes(toolName)) note(probe.id, timestamp);
      }

      if (EDIT_TOOLS.has(toolName)) {
        const input = asRecord(block.input);
        const filePath = input ? str(input, "file_path") || str(input, "notebook_path") : "";
        if (filePath) {
          const lower = filePath.toLowerCase();
          for (const probe of EXTENSION_PROBES) {
            if (probe.extensions!.some((suffix) => lower.endsWith(suffix))) {
              note(probe.id, timestamp);
            }
          }
        }
      }

      if (toolName !== "Bash") continue;
      const input = asRecord(block.input);
      const command = input ? str(input, "command") : "";
      if (!command) continue;

      const heads = new Set(invokedCommands(command));
      for (const probe of BASH_PROBES) {
        if (probe.match?.some((name) => heads.has(name))) note(probe.id, timestamp);
      }
    }
  }

  return {
    counts,
    present: Object.keys(counts),
    lastSeenAt,
    earliestRecordAt,
    hasRecords,
  };
}

export type TriggerCoverageOptions = {
  /** How far back to look. Sessions older than this are not read. */
  windowDays?: number;
};

export function triggerCoverage(
  transcriptsDir: string,
  options: TriggerCoverageOptions = {},
): TriggerCoverageReport {
  if (!fs.existsSync(transcriptsDir)) {
    throw new SourceMissingError("transcripts", transcriptsDir);
  }
  const windowDays = Math.max(options.windowDays ?? 90, 1);
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const occurrences = new Map<string, number>();
  const sessionCounts = new Map<string, number>();
  const lastSeen = new Map<string, string>();
  let sessionsScanned = 0;
  let earliestRecordAt = "";

  for (const file of listTranscriptFiles(transcriptsDir)) {
    // The window is applied on the file's own mtime so an old session is never
    // opened at all; this is the difference between a fast pillar and one that
    // parses the whole corpus to discard most of it.
    if (file.mtimeMs < cutoffMs) continue;
    const tally = scanCached(file, EXTRACTOR_ID, scanFile);
    if (tally === null) continue;
    sessionsScanned += 1;
    if (tally.earliestRecordAt) {
      if (!earliestRecordAt || tally.earliestRecordAt < earliestRecordAt) {
        earliestRecordAt = tally.earliestRecordAt;
      }
    }

    for (const [probeId, count] of Object.entries(tally.counts)) {
      occurrences.set(probeId, (occurrences.get(probeId) ?? 0) + count);
    }
    for (const probeId of tally.present) {
      sessionCounts.set(probeId, (sessionCounts.get(probeId) ?? 0) + 1);
    }
    for (const [probeId, seenAt] of Object.entries(tally.lastSeenAt)) {
      const current = lastSeen.get(probeId);
      if (!current || seenAt > current) lastSeen.set(probeId, seenAt);
    }
  }

  const rows: TriggerCoverageRow[] = TRIGGER_PROBES.map((probe) => {
    if (probe.kind === "not-observable") {
      return {
        id: probe.id,
        topic: probe.topic,
        kind: probe.kind,
        match: probe.match ?? [],
        extensions: probe.extensions ?? [],
        bucket: "not-observable" as const,
        occurrences: 0,
        sessions: 0,
        lastSeenAt: null,
        why: probe.why,
      };
    }
    const count = occurrences.get(probe.id) ?? 0;
    return {
      id: probe.id,
      topic: probe.topic,
      kind: probe.kind,
      match: probe.match ?? [],
      extensions: probe.extensions ?? [],
      bucket: count > 0 ? ("triggered" as const) : ("never-triggered" as const),
      occurrences: count,
      sessions: sessionCounts.get(probe.id) ?? 0,
      lastSeenAt: lastSeen.get(probe.id) ?? null,
    };
  });

  // Most-used first among the triggered, then the deletion candidates, then the
  // rules no transcript can speak to.
  const order: Record<TriggerBucket, number> = {
    triggered: 0,
    "never-triggered": 1,
    "not-observable": 2,
  };
  rows.sort(
    (a, b) => order[a.bucket] - order[b.bucket] || b.occurrences - a.occurrences ||
      a.topic.localeCompare(b.topic),
  );

  return {
    rows,
    triggeredCount: rows.filter((row) => row.bucket === "triggered").length,
    neverTriggeredCount: rows.filter((row) => row.bucket === "never-triggered").length,
    notObservableCount: rows.filter((row) => row.bucket === "not-observable").length,
    sessionsScanned,
    windowDays,
    earliestRecordAt: earliestRecordAt || null,
    adherenceReported: false,
  };
}
