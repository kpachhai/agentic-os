import { redactCommandArgs } from "./redact.js";
import {
  listTranscriptFiles,
  streamTranscript,
  type TranscriptRecord,
} from "./transcripts.js";

export type HookStats = {
  /** Short readable name, derived from the command for grouping in a list. */
  label: string;
  /** The command as configured, with any credential-shaped part removed. */
  command: string;
  invocations: number;
  /** Runs whose duration the record did not carry; excluded from percentiles. */
  durationsMissing: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Total time this hook has cost across the scanned sessions. */
  totalMs: number;
  sessions: number;
};

export type HookHealth = {
  sessionsScanned: number;
  /** Sessions that carried no hook records at all. */
  sessionsWithoutHooks: number;
  totalInvocations: number;
  /** Records that reported a hook error, whatever the hook was. */
  errorRecords: number;
  /** Records where a hook stopped the turn from continuing. */
  blockedTurns: number;
  /** Summed hook time across everything scanned, the honest cost figure. */
  totalMs: number;
  hooks: HookStats[];
};

/**
 * A readable name for a hook command.
 *
 * Hook commands are shell one-liners and routinely run past a hundred
 * characters, so a list keyed on the raw string is unreadable. A script path
 * reduces to its filename, which is what the operator actually calls it; anything
 * else keeps its first few words. The full command is reported alongside, so
 * nothing is hidden by shortening it.
 */
function deriveLabel(command: string): string {
  const scriptMatch = command.match(/([\w.-]+\.(?:sh|mjs|js|ts|py|rb|zsh|bash))\b/);
  if (scriptMatch) return scriptMatch[1]!;

  const trimmed = command.trim().replace(/\s+/g, " ");
  const prefix = (): string =>
    trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;

  const firstWord = trimmed.split(" ")[0] ?? "";
  if (!firstWord) return prefix();

  // A first word that is a shell builtin, an interpreter, or an environment
  // assignment names the machinery rather than the hook, and so does any
  // one-liner built out of shell operators. "command" alone tells the operator
  // nothing about which hook it is, so those all fall back to a readable prefix
  // of the whole line.
  const isMachinery =
    firstWord.includes("=") ||
    /^(sh|bash|zsh|node|npx|python3?|command|test|exec|eval|if|while|\[)$/.test(firstWord);
  const hasShellOperators = /(\|\||&&|[|;><])/.test(trimmed);
  if (isMachinery || hasShellOperators) return prefix();

  return firstWord.split("/").pop() || firstWord;
}

/**
 * Remove credential material from a hook command before it is displayed.
 *
 * A hook command is an operator-authored shell line and can carry a token inline,
 * so it cannot be rendered raw. It is inspected as an argument vector, which is
 * what the redaction module understands, after stripping the quoting that would
 * otherwise hide a flag or a header name from the scan.
 *
 * The result is for reading only: whitespace is normalised and quoting is not
 * reconstructed, so the string shown is not a runnable command. Displaying
 * something safe matters more here than displaying something executable, and the
 * operator's real hook configuration is one file away.
 */
function redactShellCommand(command: string): string {
  return redactCommandArgs(tokenizeShellCommand(command)).join(" ");
}

/**
 * Split a shell command the way the shell would: on unquoted whitespace, with a
 * quoted span staying one token and the quote characters dropped.
 *
 * Splitting on whitespace alone is not good enough, and the failure is a security
 * one rather than a cosmetic one. A header is passed as a single argument,
 * `-H 'Authorization: Bearer <token>'`, so a naive split turns it into three
 * separate tokens and the redaction pass never sees a name-and-value pair to
 * match. Keeping the quoted span intact is what lets the header be recognised.
 *
 * Escapes and expansions are not interpreted. This tokenizer serves inspection
 * and display, not execution.
 */
function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      // An empty quoted span is still an argument, so remember that this token
      // exists even before any character lands in it.
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  // Nearest-rank on a sorted array: index 0 for the minimum, last index for the
  // maximum, and no interpolation, so every reported number is a duration that
  // was actually observed rather than one computed between two of them.
  const rank = Math.ceil(fraction * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(rank, 0), sortedValues.length - 1)]!;
}

type HookAccumulator = {
  command: string;
  durations: number[];
  invocations: number;
  durationsMissing: number;
  sessions: Set<string>;
};

function absorbHookRecord(
  record: TranscriptRecord,
  sessionId: string,
  byCommand: Map<string, HookAccumulator>,
): { invocations: number; hadError: boolean; blocked: boolean } {
  const hookInfos = record.hookInfos;
  let invocations = 0;

  if (Array.isArray(hookInfos)) {
    for (const rawInfo of hookInfos) {
      if (typeof rawInfo !== "object" || rawInfo === null) continue;
      const info = rawInfo as Record<string, unknown>;
      const command = typeof info.command === "string" ? info.command : "";
      if (!command) continue;

      let accumulator = byCommand.get(command);
      if (!accumulator) {
        accumulator = {
          command,
          durations: [],
          invocations: 0,
          durationsMissing: 0,
          sessions: new Set(),
        };
        byCommand.set(command, accumulator);
      }
      accumulator.invocations++;
      accumulator.sessions.add(sessionId);
      invocations++;

      // Not every entry carries a duration. Counting a missing one as zero would
      // drag the median toward zero and make a slow hook look fast, so it is
      // excluded from the percentiles and reported separately.
      const duration = info.durationMs;
      if (typeof duration === "number" && Number.isFinite(duration)) {
        accumulator.durations.push(duration);
      } else {
        accumulator.durationsMissing++;
      }
    }
  }

  const hookErrors = record.hookErrors;
  return {
    invocations,
    hadError: Array.isArray(hookErrors) && hookErrors.length > 0,
    blocked: record.preventedContinuation === true,
  };
}

/**
 * Per-hook cost and reliability, derived entirely from records Claude Code has
 * already written into its transcripts.
 *
 * This needs no collector, no listener and no change to the operator's settings,
 * which is the point: a hook that has grown slow taxes every single turn, and
 * until now the only way to notice was to feel it.
 */
export function hookHealth(transcriptsDir: string, limit = 40): HookHealth {
  const files = listTranscriptFiles(transcriptsDir).slice(0, Math.max(limit, 1));
  const byCommand = new Map<string, HookAccumulator>();
  let totalInvocations = 0;
  let errorRecords = 0;
  let blockedTurns = 0;
  let sessionsWithoutHooks = 0;

  for (const file of files) {
    let sawHook = false;
    for (const line of streamTranscript(file.filePath)) {
      if (!line.ok) continue;
      const record = line.record;
      if (record.type !== "system") continue;
      // Hook results ride on system records; other system records carry turn
      // timing and stop reasons that are not this pillar's business.
      if (record.hookInfos === undefined && record.hookCount === undefined) continue;

      const result = absorbHookRecord(record, file.sessionId, byCommand);
      if (result.invocations > 0) sawHook = true;
      totalInvocations += result.invocations;
      if (result.hadError) errorRecords++;
      if (result.blocked) blockedTurns++;
    }
    if (!sawHook) sessionsWithoutHooks++;
  }

  const hooks: HookStats[] = [...byCommand.values()]
    .map((accumulator) => {
      const sorted = [...accumulator.durations].sort((a, b) => a - b);
      const totalMs = sorted.reduce((sum, value) => sum + value, 0);
      return {
        label: deriveLabel(accumulator.command),
        command: redactShellCommand(accumulator.command),
        invocations: accumulator.invocations,
        durationsMissing: accumulator.durationsMissing,
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.length ? sorted[sorted.length - 1]! : 0,
        totalMs,
        sessions: accumulator.sessions.size,
      };
    })
    // Slowest in aggregate first: the hook costing the most total time is the one
    // worth looking at, not the one with the worst single run.
    .sort((a, b) => b.totalMs - a.totalMs || a.label.localeCompare(b.label));

  return {
    sessionsScanned: files.length,
    sessionsWithoutHooks,
    totalInvocations,
    errorRecords,
    blockedTurns,
    totalMs: hooks.reduce((sum, hook) => sum + hook.totalMs, 0),
    hooks,
  };
}
