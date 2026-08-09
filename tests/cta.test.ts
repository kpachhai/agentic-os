import { describe, expect, it } from "vitest";
import fs from "node:fs";
import Database from "better-sqlite3";
import { loadConfig, SourceMissingError } from "../server/config.js";
import { byModel, byProject, summary, trends } from "../server/cta.js";

const config = loadConfig();
const dbPresent = fs.existsSync(config.ctaDbPath);

// Smoke against the REAL token-analyzer database (gate check 9). Asserts
// shape and bounds only - never the operator's actual numbers, which change.
describe.skipIf(!dbPresent)("CTA analytics (real data, read-only)", () => {
  it("returns >= 1 day bucket with summed cost > 0", () => {
    const days = trends(config.ctaDbPath);
    expect(days.length).toBeGreaterThanOrEqual(1);
    const total = days.reduce((s, d) => s + d.costUsd, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("aggregates >= 1 model and >= 1 project", () => {
    expect(byModel(config.ctaDbPath).length).toBeGreaterThanOrEqual(1);
    expect(byProject(config.ctaDbPath).length).toBeGreaterThanOrEqual(1);
  });

  it("summary respects logical bounds", () => {
    const s = summary(config.ctaDbPath);
    expect(s.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(s.totalSessions).toBeGreaterThanOrEqual(1);
    if (s.meanCacheHitRate !== null) {
      expect(s.meanCacheHitRate).toBeGreaterThanOrEqual(0);
      expect(s.meanCacheHitRate).toBeLessThanOrEqual(1);
    }
    expect(s.subagentShare).toBeGreaterThanOrEqual(0);
    expect(s.subagentShare).toBeLessThanOrEqual(1);
    expect(s.compressionEvents).toBeGreaterThanOrEqual(0);
  });

  it("reports an absent database as a missing source, without retrying", () => {
    // Retrying a file that is not there just delays the error; the check has
    // to happen before the open loop.
    const started = Date.now();
    expect(() => trends("/no/such/token-analyzer.db")).toThrow(
      SourceMissingError,
    );
    // The point is that no retry loop ran, not that the machine was fast. The WAL
    // retry this guards against sleeps between attempts and would cost seconds, so
    // a bound clear of ordinary load still catches it while surviving the busy
    // machine the acceptance gate creates.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("opens the DB read-only: a write attempt throws", () => {
    const db = new Database(config.ctaDbPath, { readonly: true });
    try {
      expect(() =>
        db.prepare("CREATE TABLE IF NOT EXISTS smoke_write_probe (x)").run(),
      ).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });
});
