// The wall-clock hang guards `npm run gate` runs under, in one place, as plain
// numbers. Zero imports, like the rest of the gate: check 1 wipes node_modules,
// and a value that cannot read the machine cannot vary with it.
//
// NONE OF THESE IS A PERFORMANCE ASSERTION. No gate check asserts how fast
// anything runs. Check 3b asserts the suite passes, check 4 asserts the server
// answers /api/health, check 11 asserts every route renders. The wall clock is
// here only so a step that has stopped making progress cannot park the gate
// forever, and the diagnostic that fires says so.
//
// So each is the widest value that step has ever run under - the one the gate
// already applied whenever it believed the machine was busy - now applied
// unconditionally. Every second below that margin buys nothing, because nothing
// here asserts speed, and costs a false red on a machine that was merely busy.
//
// What this replaces. The gate used to pick between a narrow and a wide value per
// step from `os.loadavg()` read once at process start, before npm ci, the
// typecheck, the build and the whole suite had run - which are the heaviest
// things on the box while the gate is running. The reading therefore described a
// machine that no longer existed by the time any budget was applied, so the same
// tree passed on a machine that was busy at second zero and failed on one that
// was idle. A verdict that turns on ambient load is not a gate, so the load
// reading is now a diagnostic string printed beside the elapsed time and decides
// nothing. tests/gate-budgets.test.ts holds both halves of that.

export const HANG_GUARD_MS = Object.freeze({
  /** check 3b: the whole vitest suite under the forked pool, per attempt. */
  vitestSuite: 480000,
  /**
   * check 4: one server boot attempt, of three. A child that exits ends its own
   * attempt immediately, so this bounds only a live child that never answers.
   */
  serverBootAttempt: 75000,
  /** check 11: one route's navigation, and its data selector, in the browser. */
  uiRoute: 45000,
});
