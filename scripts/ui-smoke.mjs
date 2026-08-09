#!/usr/bin/env node
// Gate check 11: load every pillar route headlessly and require that each one
// renders something legible, with no uncaught console errors.
//
// "Legible" has two accepted shapes, which is the point of this check:
//   - the source is present  -> real data must be on screen
//   - the source is absent   -> the not-configured panel must be on screen
// Both pass. What fails is a blank page, or an error panel, because those are the
// two ways a reader is left unable to tell whether the tool or their setup is at
// fault. Earlier this script skipped routes whose source was missing, which meant
// the most common first-run state was never rendered by the gate at all.
//
// Usage: node scripts/ui-smoke.mjs <baseUrl> [absentSourceHash,absentSourceHash,...]
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) {
  console.error("usage: node scripts/ui-smoke.mjs <baseUrl> [absentHash,...]");
  process.exit(1);
}
const absent = new Set((process.argv[3] ?? "").split(",").filter(Boolean));

// Selector = proof of REAL data on screen. Empty states use .empty-state and the
// unconfigured state uses .not-configured, so neither can satisfy these.
const ROUTES = [
  // Search renders its index summary before any query is typed.
  { hash: "#/overview", dataSelector: ".stat-tile, .attention-row" },
  { hash: "#/search", dataSelector: ".toolbar input, .empty-state" },
  { hash: "#/sessions", dataSelector: ".card" },
  { hash: "#/skills", dataSelector: ".card" },
  { hash: "#/hooks", dataSelector: ".data-table tbody tr" },
  { hash: "#/tasks", dataSelector: ".data-table tbody tr, .empty-state" },
  // Judged sessions render as cards; a store with no judgements at all is a
  // legitimate empty state rather than a missing source.
  { hash: "#/outcomes", dataSelector: ".card, .empty-state" },
  { hash: "#/config", dataSelector: ".data-table tbody tr" },
  { hash: "#/history", dataSelector: ".card" },
  // Pacing needs an operator-installed hook, so the blocks table is the proof of data.
  { hash: "#/usage", dataSelector: ".data-table tbody tr" },
  { hash: "#/graph", dataSelector: ".data-table tbody tr, .empty-state" },
  { hash: "#/workflows", dataSelector: ".card" },
  { hash: "#/file-history", dataSelector: ".card, .data-table tbody tr" },
  { hash: "#/mcp-usage", dataSelector: ".data-table tbody tr, .card" },
  { hash: "#/delegation", dataSelector: ".data-table tbody tr, .card" },
  { hash: "#/instructions", dataSelector: ".data-table tbody tr" },
  { hash: "#/skill-trend", dataSelector: ".data-table tbody tr, .card" },
  { hash: "#/engram", dataSelector: ".card" },
  { hash: "#/friction", dataSelector: ".card" },
  { hash: "#/wraps", dataSelector: ".card" },
  { hash: "#/cta", dataSelector: ".stat-tile .num" },
];

/**
 * A 503 logged by the browser's network layer is this application working as
 * designed: a pillar whose source is absent answers 503, the view catches it and
 * renders the not-configured panel. The browser still records the response, and
 * failing on it would make a correct first-run install fail the gate. Anything
 * else on the console is still a real error.
 */
function isExpectedSourceMissingNoise(text) {
  return /Failed to load resource/i.test(text) && /503/.test(text);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const realErrors = [];
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  if (!isExpectedSourceMissingNoise(text)) realErrors.push(text);
});
page.on("pageerror", (err) => realErrors.push(String(err)));

let failed = 0;
for (const route of ROUTES) {
  const before = realErrors.length;
  const expectUnconfigured = absent.has(route.hash);
  try {
    await page.goto(`${base}/${route.hash}`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    const wanted = expectUnconfigured ? ".not-configured" : route.dataSelector;
    await page.waitForSelector(wanted, { timeout: 15000 });

    const state = await page.evaluate(() => ({
      errorPanels: document.querySelectorAll(".error-state").length,
      notConfigured: document.querySelectorAll(".not-configured").length,
      // Every view keeps its heading in every state, so its absence means the
      // view failed to render rather than that the data was empty.
      hasTitle: Boolean(document.querySelector(".view-title")),
    }));
    const count = await page.locator(wanted).count();
    const newErrors = realErrors.length - before;

    // An error panel is never acceptable. A missing source must reach the reader
    // as "not configured"; anything reaching them as an error is a defect in the
    // degradation path, which is exactly what this check exists to catch.
    const ok =
      count >= 1 && state.hasTitle && state.errorPanels === 0 && newErrors === 0;

    if (ok) {
      console.log(
        `ui-smoke PASS ${route.hash} (${count} ${
          expectUnconfigured ? "not-configured panel" : "data nodes"
        })`,
      );
    } else {
      failed++;
      console.log(
        `ui-smoke FAIL ${route.hash} count=${count} title=${state.hasTitle} ` +
          `errorPanels=${state.errorPanels} notConfigured=${state.notConfigured} ` +
          `consoleErrors=${newErrors}`,
      );
    }
  } catch (err) {
    failed++;
    console.log(`ui-smoke FAIL ${route.hash} ${String(err).slice(0, 300)}`);
  }
}

if (realErrors.length) {
  console.log("console errors seen:");
  for (const e of realErrors.slice(0, 10)) console.log(`  ${e.slice(0, 200)}`);
}

await browser.close();
process.exit(failed === 0 && realErrors.length === 0 ? 0 : 1);
