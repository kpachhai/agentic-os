import fs from "node:fs";
import { SourceMissingError } from "./config.js";

/**
 * Reader over rate-limit samples captured from Claude Code's statusline.
 *
 * WHY THIS IS THE ONLY WAY TO SEE THIS. A subscription's limits are expressed as
 * five-hour and seven-day windows, and how much of each is consumed lives in
 * Anthropic's account state, not in any file on disk. The one place it surfaces
 * locally is the JSON blob Claude Code pipes to a statusline command on every
 * render. Reading account usage any other way means an outbound API call, which
 * this tool will not make. So the operator installs a one-line hook that appends
 * that blob to a file, and this reads the file.
 *
 * CAPTURE AND READ STAY SEPARATE, and that separation is the design. The hook
 * writes; this only ever reads. Nothing here accepts a POST, listens for events,
 * or asks Claude Code for anything - which keeps the dashboard a reader over files
 * rather than a service with an ingest path and state of its own.
 *
 * Absent by default, and that is correct: nobody has this file until they choose
 * to install the hook, so the pillar reports itself unconfigured until then.
 */

export type RateWindow = {
  usedPercent: number;
  /** When the window resets, ISO 8601, converted from the recorded epoch seconds. */
  resetsAt: string;
  /** Milliseconds until reset; negative once the recorded reset has passed. */
  resetsInMs: number;
};

export type PacingSample = {
  capturedAt: string;
  sessionId: string;
  model: string;
  /** Working directory the sample was taken in. */
  cwd: string;
  /** Session cost as Claude Code reported it, not derived here. */
  sessionCostUsd: number | null;
  sessionDurationMs: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  contextUsedPercent: number | null;
  contextTotalTokens: number | null;
  exceedsLargeContext: boolean | null;
  effortLevel: string | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
};

type RawSample = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(source: Record<string, unknown> | null, key: string): number | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(source: Record<string, unknown> | null, key: string): string {
  if (!source) return "";
  return typeof source[key] === "string" ? (source[key] as string) : "";
}

/**
 * One rate-limit window.
 *
 * `resets_at` is recorded as Unix epoch SECONDS, not milliseconds. Treating it as
 * milliseconds would place every reset in 1970 and make a fresh window look
 * permanently expired, so the conversion is explicit here.
 */
function readWindow(raw: unknown, now: number): RateWindow | null {
  const window = asRecord(raw);
  if (!window) return null;
  const usedPercent = num(window, "used_percentage");
  const resetsAtSeconds = num(window, "resets_at");
  if (usedPercent === null) return null;

  const resetsAtMs = resetsAtSeconds !== null ? resetsAtSeconds * 1000 : 0;
  return {
    usedPercent,
    resetsAt: resetsAtMs > 0 ? new Date(resetsAtMs).toISOString() : "",
    resetsInMs: resetsAtMs > 0 ? resetsAtMs - now : 0,
  };
}

function parseSample(line: string, now: number): PacingSample | null {
  let raw: RawSample;
  try {
    raw = JSON.parse(line) as RawSample;
  } catch {
    return null;
  }

  const workspace = asRecord(raw.workspace);
  const cost = asRecord(raw.cost);
  const contextWindow = asRecord(raw.context_window);
  const rateLimits = asRecord(raw.rate_limits);
  const model = asRecord(raw.model);
  const effort = asRecord(raw.effort);

  // A blob with no session id is not a statusline sample; refusing it here keeps
  // an unrelated JSON file pointed at this path from rendering as pacing data.
  const sessionId = str(raw, "session_id");
  if (!sessionId) return null;

  return {
    // The blob carries no capture time of its own, so the reader stamps one only
    // when the hook added it; an absent stamp stays empty rather than becoming
    // "now", which would make every historical sample look current.
    capturedAt: str(raw, "captured_at"),
    sessionId,
    model: str(model, "display_name") || str(model, "id"),
    cwd: str(workspace, "current_dir"),
    sessionCostUsd: num(cost, "total_cost_usd"),
    sessionDurationMs: num(cost, "total_duration_ms"),
    linesAdded: num(cost, "total_lines_added"),
    linesRemoved: num(cost, "total_lines_removed"),
    contextUsedPercent: num(contextWindow, "used_percentage"),
    contextTotalTokens: num(contextWindow, "total_input_tokens"),
    exceedsLargeContext:
      typeof raw.exceeds_200k_tokens === "boolean" ? raw.exceeds_200k_tokens : null,
    effortLevel: str(effort, "level") || null,
    fiveHour: readWindow(rateLimits?.five_hour, now),
    sevenDay: readWindow(rateLimits?.seven_day, now),
  };
}

export type Pacing = {
  /** Newest sample carrying rate-limit data, which is the current picture. */
  current: PacingSample | null;
  /** Recent samples, newest first, for a trend. */
  samples: PacingSample[];
  totalSamples: number;
  /** Samples that carried no rate-limit block; see note. */
  samplesWithoutLimits: number;
  note: string;
};

/**
 * Read captured pacing samples, newest first.
 *
 * Rate-limit data is absent from a sample more often than one might expect: the
 * block only appears for subscription accounts, and only after the session's first
 * API response. So `current` is the newest sample that actually carries limits
 * rather than simply the newest sample - otherwise opening a fresh session would
 * blank a reading that is still perfectly valid.
 */
export function readPacing(pacingLogPath: string, limit = 200): Pacing {
  if (!fs.existsSync(pacingLogPath)) {
    throw new SourceMissingError("pacing log", pacingLogPath);
  }

  const now = Date.now();
  const lines = fs.readFileSync(pacingLogPath, "utf8").split("\n");
  const samples: PacingSample[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const sample = parseSample(line, now);
    if (sample) samples.push(sample);
  }
  samples.reverse();

  const withLimits = samples.filter((s) => s.fiveHour !== null || s.sevenDay !== null);

  return {
    current: withLimits[0] ?? null,
    samples: samples.slice(0, Math.min(Math.max(limit, 1), 2000)),
    totalSamples: samples.length,
    samplesWithoutLimits: samples.length - withLimits.length,
    note:
      "Captured by an operator-installed statusline hook that appends to this " +
      "file; this tool only reads it. Rate-limit blocks appear only for " +
      "subscription accounts and only after a session's first API response, so " +
      "some samples legitimately carry none.",
  };
}

/**
 * The shell command that installs the capture hook.
 *
 * Returned as text for the operator to run, never executed. Installing it edits
 * Claude Code's settings, and this tool does not modify the operator's
 * configuration - printing the command keeps the decision, and the action, theirs.
 */
export function captureHookCommand(pacingLogPath: string): {
  statusLineCommand: string;
  explanation: string;
} {
  return {
    statusLineCommand:
      `jq -c '. + {captured_at: (now | todate)}' >> ${pacingLogPath}; ` +
      `printf ''`,
    explanation:
      "Set this as your statusLine command in Claude Code settings. It appends " +
      "each statusline payload to the log, stamps it with a capture time, and " +
      "prints an empty status line. Claude Code passes the payload on stdin on " +
      "every render, so the log grows steadily; truncate it whenever you like - " +
      "nothing here depends on its history.",
  };
}
