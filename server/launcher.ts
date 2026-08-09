import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";

export type LaunchStatus =
  | "running"
  | "done"
  | "error"
  | "timed_out"
  | "cancelled";

export type LaunchRecord = {
  launchId: string;
  prompt: string;
  argv: string[];
  cwd: string;
  allowedTools: string;
  startedAt: string;
  status: LaunchStatus;
  exitCode: number | null;
  result?: string;
  sessionId?: string;
  totalCostUsd?: number;
  usage?: object;
  isError?: boolean;
  numTurns?: number;
  durationMs?: number;
  events: object[];
};

export type LaunchOptions = {
  prompt: string;
  model?: string;
  cwd?: string;
  allowedTools?: string;
  maxBudgetUsd?: number | null;
  timeoutSeconds?: number;
};

const MAX_BUFFERED_EVENTS = 5000;

/** Finished launch records kept in memory before the oldest are dropped. */
const MAX_RETAINED_LAUNCHES = 50;

/**
 * Subscription to a live launch. `buffered` is snapshotted at the same instant
 * the listeners attach, so replaying it and then following the live feed
 * delivers every event exactly once.
 */
export type LaunchSubscription = {
  buffered: object[];
  /** True when the run already finished: no `done` event is still coming. */
  finished: boolean;
  unsubscribe: () => void;
};

/**
 * Intersect a requested allowlist with the configured default. The result is
 * only ever a subset of the default, so a per-launch override can restrict
 * but never expand the granted tools. An empty/absent request keeps the full
 * default.
 */
export function narrowAllowlist(
  defaultTools: string,
  requested: string | undefined,
): string {
  const base = defaultTools
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!requested || !requested.trim()) return base.join(",");
  const allowed = new Set(base);
  const requestedList = requested
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return requestedList.filter((t) => allowed.has(t)).join(",");
}

/**
 * A per-launch cwd may only narrow to a subdirectory of the configured one.
 * Same reasoning as the allowlist: a request reaching this endpoint must not
 * be able to point an agent holding Edit and Write at a wider tree than the
 * operator's config allows.
 */
export function narrowCwd(
  defaultCwd: string,
  requested: string | undefined,
): string {
  if (!requested || !requested.trim()) return defaultCwd;
  const base = path.resolve(defaultCwd);
  const target = path.resolve(base, requested.trim());
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`launch cwd must be inside ${base}: ${requested}`);
  }
  return target;
}

/**
 * A per-launch timeout may only shorten the configured one. Clamping also
 * keeps the value inside setTimeout's 32-bit range, where a large enough
 * delay wraps around and fires immediately - killing the run it was meant
 * to protect.
 */
export function narrowTimeout(
  defaultSeconds: number,
  requested: number | undefined,
): number {
  if (requested === undefined) return defaultSeconds;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`timeoutSeconds must be a positive number: ${requested}`);
  }
  return Math.min(requested, defaultSeconds);
}

/**
 * A per-launch budget may only tighten the configured cap. When the config
 * sets no cap, a requested one still applies - that narrows too.
 */
export function narrowBudget(
  defaultBudget: number | null,
  requested: number | null | undefined,
): number | null {
  if (requested == null) return defaultBudget;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`maxBudgetUsd must be a positive number: ${requested}`);
  }
  return defaultBudget == null ? requested : Math.min(requested, defaultBudget);
}

/**
 * In-memory launch manager. Spawns `claude -p` (or the hermetic smoke
 * command), parses newline-delimited stream-json events, buffers them per
 * launch, and fans them out to SSE subscribers via one EventEmitter each.
 *
 * Bounds: per-launch wall-clock timeout (kill on expiry -> timed_out) and an
 * optional --max-budget-usd. There is deliberately no turn cap: the CLI
 * exposes no --max-turns flag (verified against 2.1.202), so the wall clock
 * is the only hard stop and must never be made optional.
 */
export class LaunchManager {
  private records = new Map<string, LaunchRecord>();
  private emitters = new Map<string, EventEmitter>();
  private children = new Map<string, ChildProcess>();
  private finishedIds = new Set<string>();

  constructor(private config: AppConfig) {}

  get(launchId: string): LaunchRecord | null {
    return this.records.get(launchId) ?? null;
  }

  /**
   * Attach to a launch's event feed. The buffer snapshot and the listener
   * attach happen with no await between them, so an event emitted while a
   * subscriber is still replaying the buffer is queued by the live listener
   * instead of falling into the gap.
   */
  subscribe(
    launchId: string,
    handlers: {
      onEvent: (event: object) => void;
      onDone: (record: LaunchRecord) => void;
    },
  ): LaunchSubscription | null {
    const record = this.records.get(launchId);
    const emitter = this.emitters.get(launchId);
    if (!record || !emitter) return null;
    const buffered = [...record.events];
    const finished = this.finishedIds.has(launchId);
    emitter.on("event", handlers.onEvent);
    emitter.on("done", handlers.onDone);
    return {
      buffered,
      finished,
      unsubscribe: () => {
        emitter.off("event", handlers.onEvent);
        emitter.off("done", handlers.onDone);
      },
    };
  }

  /** Launch a skill (or any prompt) headlessly via claude -p. */
  launch(opts: LaunchOptions): LaunchRecord {
    const prompt = opts.prompt.trim();
    if (!prompt) throw new Error("prompt must be a non-empty string");

    const cwd = narrowCwd(this.config.launchDefaults.cwd, opts.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`launch cwd is not a directory: ${cwd}`);
    }
    // A per-launch allowlist may only NARROW the configured default, never
    // widen it. Intersect rather than replace, so a request reaching this
    // endpoint cannot grant itself tools the operator's config withholds.
    const allowedTools = narrowAllowlist(
      this.config.launchDefaults.allowedTools,
      opts.allowedTools,
    );

    const argv = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.config.launchDefaults.permissionMode,
      "--allowedTools",
      allowedTools,
      "--add-dir",
      cwd,
    ];
    if (opts.model) argv.push("--model", opts.model);
    const budget = narrowBudget(
      this.config.launchDefaults.maxBudgetUsd,
      opts.maxBudgetUsd,
    );
    if (budget != null) argv.push("--max-budget-usd", String(budget));

    return this.spawnTracked(this.config.claudeBinary, argv, {
      prompt,
      cwd,
      allowedTools,
      timeoutSeconds: narrowTimeout(
        this.config.launchDefaults.timeoutSeconds,
        opts.timeoutSeconds,
      ),
      parseNdjson: true,
    });
  }

  /**
   * Hermetic launcher smoke (gate check 8): runs the configured smokeCommand
   * (default `claude --version`) through the same spawn/stream/record
   * plumbing. Asserts wiring, NOT a real skill run - free and deterministic.
   */
  launchSmoke(): LaunchRecord {
    const parts = this.config.smokeCommand.split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new Error("smokeCommand is empty");
    return this.spawnTracked(parts[0]!, parts.slice(1), {
      prompt: this.config.smokeCommand,
      cwd: process.cwd(),
      allowedTools: "",
      timeoutSeconds: 60,
      parseNdjson: false,
    });
  }

  /** Kill a running launch (also used by the timeout and by cancel). */
  kill(launchId: string, reason: LaunchStatus = "error"): boolean {
    const child = this.children.get(launchId);
    const record = this.records.get(launchId);
    if (!child || !record || record.status !== "running") return false;
    record.status = reason;
    child.kill("SIGTERM");
    // Escalate if the child ignores SIGTERM. The test is whether it has
    // actually exited - `child.killed` only reports that a signal was sent,
    // so checking it here would never escalate.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000).unref();
    return true;
  }

  private spawnTracked(
    bin: string,
    argv: string[],
    meta: {
      prompt: string;
      cwd: string;
      allowedTools: string;
      timeoutSeconds: number;
      parseNdjson: boolean;
    },
  ): LaunchRecord {
    const launchId = crypto.randomUUID();
    const record: LaunchRecord = {
      launchId,
      prompt: meta.prompt,
      argv: [bin, ...argv],
      cwd: meta.cwd,
      allowedTools: meta.allowedTools,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      events: [],
    };
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    this.records.set(launchId, record);
    this.emitters.set(launchId, emitter);
    this.prune();

    let child: ChildProcess;
    try {
      child = spawn(bin, argv, {
        cwd: meta.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      record.status = "error";
      record.exitCode = -1;
      this.pushEvent(record, emitter, { type: "spawn_error", message: String(err) });
      return record;
    }
    this.children.set(launchId, child);

    const timeout = setTimeout(() => {
      this.pushEvent(record, emitter, {
        type: "timeout",
        afterSeconds: meta.timeoutSeconds,
      });
      this.kill(launchId, "timed_out");
    }, meta.timeoutSeconds * 1000);
    timeout.unref();

    let stdoutBuf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        this.ingestLine(record, emitter, line, meta.parseNdjson);
      }
    });

    let stderrBuf = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      record.status = "error";
      record.exitCode = -1;
      this.pushEvent(record, emitter, { type: "spawn_error", message: String(err) });
      this.finish(launchId, record, emitter);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      // flush a trailing unterminated line
      const tail = stdoutBuf.trim();
      if (tail) this.ingestLine(record, emitter, tail, meta.parseNdjson);

      record.exitCode = code;
      if (record.status === "running") {
        // Exit code is the authoritative failure signal - not the presence of
        // stderr text, which the CLI also uses for warnings and banners.
        record.status = code === 0 ? "done" : "error";
      }
      if (stderrBuf.trim()) {
        this.pushEvent(record, emitter, {
          type: "stderr",
          text: stderrBuf.trim().slice(-4000),
        });
      }
      this.pushEvent(record, emitter, {
        type: "exit",
        exitCode: code,
        status: record.status,
      });
      this.finish(launchId, record, emitter);
    });

    return record;
  }

  /**
   * Mark a launch terminal, then announce it. Marking first means a subscriber
   * attaching during the announcement sees `finished` and stops waiting for a
   * `done` event that has already gone out.
   */
  private finish(
    launchId: string,
    record: LaunchRecord,
    emitter: EventEmitter,
  ): void {
    this.finishedIds.add(launchId);
    this.children.delete(launchId);
    emitter.emit("done", record);
  }

  /**
   * Records are held in memory for the process lifetime, so a long-running
   * server would accumulate them without bound. Drop finished ones oldest
   * first (Map preserves insertion order); a running launch is never dropped.
   */
  private prune(): void {
    for (const id of this.records.keys()) {
      if (this.records.size <= MAX_RETAINED_LAUNCHES) return;
      if (!this.finishedIds.has(id)) continue;
      this.records.delete(id);
      this.emitters.delete(id);
      this.finishedIds.delete(id);
    }
  }

  private ingestLine(
    record: LaunchRecord,
    emitter: EventEmitter,
    line: string,
    parseNdjson: boolean,
  ): void {
    if (!parseNdjson) {
      this.pushEvent(record, emitter, { type: "stdout", text: line });
      return;
    }
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      // Final result object shape verified at build time (probe run):
      // {type:"result", is_error, num_turns, duration_ms, result, session_id,
      //  total_cost_usd, usage, ...}
      if (event.type === "result") {
        if (typeof event.result === "string") record.result = event.result;
        if (typeof event.session_id === "string") record.sessionId = event.session_id;
        if (typeof event.total_cost_usd === "number")
          record.totalCostUsd = event.total_cost_usd;
        if (event.usage && typeof event.usage === "object")
          record.usage = event.usage as object;
        if (typeof event.is_error === "boolean") record.isError = event.is_error;
        if (typeof event.num_turns === "number") record.numTurns = event.num_turns;
        if (typeof event.duration_ms === "number")
          record.durationMs = event.duration_ms;
      }
      this.pushEvent(record, emitter, event);
    } catch {
      // Not JSON (warnings, banners): keep it as raw text, never crash.
      this.pushEvent(record, emitter, { type: "stdout", text: line });
    }
  }

  private pushEvent(
    record: LaunchRecord,
    emitter: EventEmitter,
    event: object,
  ): void {
    if (record.events.length < MAX_BUFFERED_EVENTS) {
      record.events.push(event);
    } else if (record.events.length === MAX_BUFFERED_EVENTS) {
      // Say so once instead of silently dropping the rest of the record. Live
      // subscribers still receive every event; only the replay buffer stops.
      record.events.push({
        type: "buffer_truncated",
        limit: MAX_BUFFERED_EVENTS,
      });
    }
    emitter.emit("event", event);
  }
}
