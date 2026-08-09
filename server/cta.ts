import fs from "node:fs";
import Database from "better-sqlite3";
import { SourceMissingError } from "./config.js";

export type CtaDay = {
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionCount: number;
};

export type CtaModelRow = {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
};

export type CtaProjectRow = {
  projectPath: string;
  costUsd: number;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
};

export type CtaSummary = {
  totalCostUsd: number;
  totalSessions: number;
  meanCacheHitRate: number | null;
  subagentShare: number;
  compressionEvents: number;
};

/**
 * A lock or checkpoint collision is the only failure another attempt can
 * clear. A corrupt file or a missing table fails identically three times, so
 * retrying it just delays the error by 150ms.
 */
function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|readonly database/i.test(
    message,
  );
}

/** Sleep without burning a core; these query paths are synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a read-only query with a small retry. A live process may hold the DB in
 * WAL mode; RO readers can hit a transient "attempt to write a readonly
 * database" while that process checkpoints, so the retry is load-bearing
 * rather than defensive. Never open with immutable=1: it would promise the
 * file cannot change underneath us, which is exactly the opposite of true
 * here, and returns stale or corrupt pages instead of retrying.
 */
function withDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  if (!fs.existsSync(dbPath)) {
    throw new SourceMissingError("token-analyzer database", dbPath);
  }
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      return fn(db);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      sleepSync(50 * (i + 1)); // 50ms, then 100ms
    } finally {
      db?.close();
    }
  }
  throw lastErr;
}

/** Daily cost/token buckets grouped on date(first_timestamp). */
export function trends(dbPath: string): CtaDay[] {
  return withDb(dbPath, (db) =>
    db
      .prepare(
        `SELECT date(first_timestamp) AS date,
                COALESCE(SUM(total_cost_usd), 0)            AS costUsd,
                COALESCE(SUM(total_input_tokens), 0)        AS inputTokens,
                COALESCE(SUM(total_output_tokens), 0)       AS outputTokens,
                COALESCE(SUM(total_cache_read_tokens), 0)   AS cacheReadTokens,
                COALESCE(SUM(total_cache_creation_tokens), 0) AS cacheCreationTokens,
                COUNT(*)                                    AS sessionCount
         FROM sessions
         WHERE first_timestamp IS NOT NULL
         GROUP BY date(first_timestamp)
         ORDER BY date ASC`,
      )
      .all(),
  ) as CtaDay[];
}

/** Per-model aggregates from session_models. */
export function byModel(dbPath: string): CtaModelRow[] {
  return withDb(dbPath, (db) =>
    db
      .prepare(
        `SELECT model,
                COALESCE(SUM(cost_usd), 0)      AS costUsd,
                COALESCE(SUM(total_input), 0)   AS inputTokens,
                COALESCE(SUM(total_output), 0)  AS outputTokens,
                COALESCE(SUM(turn_count), 0)    AS turnCount
         FROM session_models
         GROUP BY model
         ORDER BY costUsd DESC`,
      )
      .all(),
  ) as CtaModelRow[];
}

/** Per-project aggregates from sessions. */
export function byProject(dbPath: string): CtaProjectRow[] {
  return withDb(dbPath, (db) =>
    db
      .prepare(
        `SELECT project_path                                  AS projectPath,
                COALESCE(SUM(total_cost_usd), 0)              AS costUsd,
                COUNT(*)                                      AS sessionCount,
                COALESCE(SUM(total_input_tokens), 0)          AS inputTokens,
                COALESCE(SUM(total_output_tokens), 0)         AS outputTokens
         FROM sessions
         GROUP BY project_path
         ORDER BY costUsd DESC`,
      )
      .all(),
  ) as CtaProjectRow[];
}

/** Headline stats; all values bounds-checked at the source. */
export function summary(dbPath: string): CtaSummary {
  return withDb(dbPath, (db) => {
    const s = db
      .prepare(
        `SELECT COALESCE(SUM(total_cost_usd), 0) AS totalCost,
                COUNT(*)                          AS totalSessions,
                AVG(CASE WHEN cache_hit_rate BETWEEN 0 AND 1
                         THEN cache_hit_rate END) AS meanCacheHitRate,
                AVG(CASE WHEN is_subagent IN (0,1)
                         THEN is_subagent END)    AS subagentShare
         FROM sessions`,
      )
      .get() as {
      totalCost: number;
      totalSessions: number;
      meanCacheHitRate: number | null;
      subagentShare: number | null;
    };
    const c = db
      .prepare(`SELECT COUNT(*) AS n FROM compression_events`)
      .get() as { n: number };

    // Bounds discipline: rates in [0,1], no negative costs.
    const clamp01 = (v: number | null) =>
      v === null ? null : Math.min(1, Math.max(0, v));
    return {
      totalCostUsd: Math.max(0, s.totalCost),
      totalSessions: s.totalSessions,
      meanCacheHitRate: clamp01(s.meanCacheHitRate),
      subagentShare: clamp01(s.subagentShare) ?? 0,
      compressionEvents: c.n,
    };
  });
}
