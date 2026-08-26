#!/usr/bin/env node
// npm run gate - the mechanical acceptance check for this repo: green gate
// means a working install. Plain Node, zero deps (it must
// survive check 1 wiping node_modules). Runs 17 checks in order - numbered
// 1-13 plus the vitest suite as 3b and later additions as 10b, 10c and 10d, so
// the check numbers referenced across the repo stay stable - and exits non-zero
// on the first hard failure. A pillar whose data source is absent is reported
// SKIPPED (source missing) - loud, never silent. A check the run never reached
// is reported SKIP (not reached) for the same reason: absence from the summary
// would read as a pass.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HANG_GUARD_MS } from "./gate-budgets.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
process.chdir(ROOT);

/**
 * What the machine is doing, as a diagnostic string.
 *
 * Read where it is printed and never at process start: the gate's own npm ci,
 * typecheck, build and suite are the heaviest things on this box while it runs,
 * so a reading taken before them describes a machine that no longer exists. It
 * used to be read once at the top and used to choose between a narrow and a wide
 * wall-clock budget, which made the verdict a function of what the machine
 * happened to be doing at second zero: the same tree passed on a busy box and
 * failed on an idle one.
 *
 * Nothing branches on this now. It returns a string, and a string cannot be a
 * budget; the budgets are machine-independent constants in gate-budgets.mjs, so
 * a busy machine and an idle one reach the same verdict on the same tree. What
 * this is for is the other half of that problem: a slow step and a broken one
 * look identical from outside, and the load at the moment of the failure is what
 * tells them apart.
 */
function loadNote() {
  return `load ${os.loadavg()[0].toFixed(2)} on ${os.cpus().length} threads`;
}

const results = [];
let bootedServer = null;
let serverLog = "";

/**
 * Every check this script can run, in order, with the name each one reports.
 *
 * Declared up front so a hard failure cannot silently shorten the summary. bail()
 * exits immediately, so checks after the failure never call record() and used to
 * vanish from the output entirely - leaving a reader to infer from a list of eight
 * that the other five had passed, when in fact they had not run. Unreached checks
 * are now listed as SKIP (not reached), which is the same principle as reporting a
 * missing source loudly rather than as an empty pillar.
 */
const ROSTER = [
  [1, "npm ci"],
  [2, "typecheck (tsc --noEmit)"],
  [3, "vite build + dist/index.html"],
  ["3b", "vitest per-pillar smokes"],
  [4, "server boot + /api/health"],
  [5, "memory vault thoughts"],
  [6, "friction log entries"],
  [7, "skill inventory"],
  [8, "launcher wiring (smoke command)"],
  [9, "token trends (readonly)"],
  [10, "session wraps"],
  ["10b", "sessions + hooks (transcripts)"],
  ["10c", "source availability report"],
  ["10d", "derived index is disposable"],
  [11, "UI render smoke (playwright)"],
  [12, "localhost-only bind"],
  [13, "heavy reads are idempotent"],
];

function record(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  const tag = status === "PASS" ? "PASS" : status === "SKIP" ? "SKIP" : "FAIL";
  console.log(`[gate] ${String(id).padStart(2)} ${tag}  ${name}${detail ? ` - ${detail}` : ""}`);
}

function summarize() {
  console.log("\n[gate] ---- summary ----");
  // The roster drives the order, so a check that never ran still has a line. A
  // reader has to be able to tell "passed" from "was never reached", and the two
  // were previously indistinguishable by absence.
  const byId = new Map(results.map((r) => [String(r.id), r]));
  const rows = ROSTER.map(([id, name]) => {
    const found = byId.get(String(id));
    return found ?? { id, name, status: "SKIP", detail: "not reached" };
  });
  // Anything recorded under an id the roster does not know about is still printed
  // rather than dropped; a check added without a roster entry must not disappear.
  for (const r of results) {
    if (!ROSTER.some(([id]) => String(id) === String(r.id))) rows.push(r);
  }
  for (const r of rows) {
    console.log(`  ${String(r.id).padStart(2)}  ${r.status.padEnd(4)}  ${r.name}${r.detail ? ` - ${r.detail}` : ""}`);
  }
  const failed = rows.filter((r) => r.status === "FAIL");
  const unreached = rows.filter((r) => r.detail === "not reached");
  const skipped = rows.filter((r) => r.status === "SKIP" && r.detail !== "not reached");
  if (skipped.length) {
    console.log(`[gate] ${skipped.length} check(s) SKIPPED (source missing) - see above; skips are loud, not silent.`);
  }
  if (unreached.length) {
    console.log(
      `[gate] ${unreached.length} check(s) never ran - the run stopped at the first hard ` +
        `failure, so these are unknown rather than passing.`,
    );
  }
  // Everything from check 4 onward runs against the booted server, so its
  // output is the first thing worth reading when one of them fails.
  if (failed.length && serverLog.trim()) {
    console.log("\n[gate] ---- server output (tail) ----");
    console.log(serverLog.trim().split("\n").slice(-40).map((l) => `      ${l}`).join("\n"));
  }
  console.log(
    failed.length === 0
      ? "[gate] GREEN - all executed checks passed."
      : `[gate] RED - ${failed.length} check(s) failed.`,
  );
  return failed.length === 0 ? 0 : 1;
}

function bail(code) {
  if (bootedServer) bootedServer.kill("SIGTERM");
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? 300000,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    ok: res.status === 0,
    status: res.status,
    out: (res.stdout ?? "") + (res.stderr ?? ""),
  };
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The fallback paths below duplicate defaults() in server/config.ts, because
// this script stays dependency-free and cannot import a TypeScript module. The
// same duplication exists in scripts/doctor.mjs, so there are three copies of
// one list: a stale one here mis-reports which sources exist and silently skips
// a check that should have run. Keeping them in step is no longer a convention -
// tests/script-config-parity.test.ts compares all three and reddens on a drift.
function loadGateConfig() {
  const file = process.env.CONFIG_PATH ?? path.join(ROOT, "config.json");
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    engramVaultPath: expandHome(raw.engramVaultPath ?? "~/engram-vault"),
    frictionLogPath: expandHome(raw.frictionLogPath ?? "~/.claude/friction-log.md"),
    skillRoots: (raw.skillRoots ?? ["~/.claude/skills", "~/.claude/plugins"]).map(expandHome),
    ctaDbPath: expandHome(
      raw.ctaDbPath ??
        "~/.claude/plugins/data/claude-token-analyzer-claude-token-analyzer/token-analyzer.db",
    ),
    wrapsDir: expandHome(raw.wrapsDir ?? "~/.claude/memory"),
    transcriptsDir: expandHome(raw.transcriptsDir ?? "~/.claude/projects"),
    liveSessionsDir: expandHome(raw.liveSessionsDir ?? "~/.claude/sessions"),
    tasksDir: expandHome(raw.tasksDir ?? "~/.claude/tasks"),
    claudeSettingsPath: expandHome(raw.claudeSettingsPath ?? "~/.claude/settings.json"),
    historyPath: expandHome(raw.historyPath ?? "~/.claude/history.jsonl"),
    pacingLogPath: expandHome(raw.pacingLogPath ?? "~/.claude/pacing-log.jsonl"),
    workflowsDir: expandHome(raw.workflowsDir ?? "~/.claude/workflows"),
    fileHistoryDir: expandHome(raw.fileHistoryDir ?? "~/.claude/file-history"),
    usageDataDir: expandHome(raw.usageDataDir ?? "~/.claude/usage-data"),
    claudeHome: expandHome(raw.claudeHome ?? "~/.claude"),
    claudeMdPath: expandHome(raw.claudeMdPath ?? "~/.claude/CLAUDE.md"),
    indexPath: expandHome(raw.indexPath ?? path.join(ROOT, ".cache", "index.db")),
  };
}

async function postJson(url, timeoutMs = 120000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchJson(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const config = loadGateConfig();

  // ---- precondition probe: which data sources actually exist here ----
  const sources = {
    engram: fs.existsSync(config.engramVaultPath),
    friction: fs.existsSync(config.frictionLogPath),
    skills: config.skillRoots.some((r) => fs.existsSync(r)),
    cta: fs.existsSync(config.ctaDbPath),
    wraps: fs.existsSync(config.wrapsDir),
    sessions: fs.existsSync(config.transcriptsDir),
    // Hook records live inside the transcripts, so the two share one source.
    hooks: fs.existsSync(config.transcriptsDir),
    tasks: fs.existsSync(config.tasksDir),
    // The index spans four sources and is answerable while any one of them
    // exists, which is the condition indexSourcePaths() applies in
    // server/sources.ts. The two have to agree: if this said "absent" where the
    // server says "present", check 11 would demand a first-run panel the server
    // will never render.
    search: [
      config.transcriptsDir,
      config.engramVaultPath,
      config.wrapsDir,
      config.frictionLogPath,
    ].some((p) => fs.existsSync(p)),
    config: fs.existsSync(config.claudeSettingsPath),
    history: fs.existsSync(config.historyPath),
    // The memory-note graph, usage blocks and orchestration scripts all live under
    // the transcript tree, so they share its availability.
    graph: fs.existsSync(config.transcriptsDir),
    blocks: fs.existsSync(config.transcriptsDir),
    workflows: fs.existsSync(config.transcriptsDir),
    fileHistory: fs.existsSync(config.fileHistoryDir),
    // MCP calls, subagent dispatches and skill attribution are all read out of the
    // transcript tree, so they share its availability.
    mcpUsage: fs.existsSync(config.transcriptsDir),
    delegation: fs.existsSync(config.transcriptsDir),
    skillTrend: fs.existsSync(config.transcriptsDir),
    instructions: fs.existsSync(config.claudeMdPath),
    live: fs.existsSync(config.liveSessionsDir),
    // Outcomes reads the /insights store, which one command writes in a single
    // pass and never refreshes.
    usageData: fs.existsSync(config.usageDataDir),
    disk: fs.existsSync(config.claudeHome),
    // Absent by default: rate-limit figures exist only in the payload Claude Code
    // hands its statusline command, so capturing them needs a hook the operator
    // installs themselves.
    pacing: fs.existsSync(config.pacingLogPath),
  };
  // Every key here names a source the server also probes, and check 10c requires
  // the two sets to match. Anything that is a combination of sources rather than
  // a source of its own is computed where it is needed, so this stays comparable.
  console.log("[gate] precondition probe:", JSON.stringify(sources));

  // ---- 1: npm ci ----
  console.log("[gate] check 1: npm ci (this reinstalls node_modules)...");
  const ci = run("npm", ["ci"], { timeoutMs: 420000 });
  if (!ci.ok) {
    record(1, "npm ci", "FAIL", ci.out.slice(-800));
    return bail(summarize());
  }
  record(1, "npm ci", "PASS");

  // ---- 2: typecheck ----
  const tc = run("npm", ["run", "typecheck"]);
  if (!tc.ok) {
    record(2, "typecheck (tsc --noEmit)", "FAIL", tc.out.slice(-800));
    return bail(summarize());
  }
  record(2, "typecheck (tsc --noEmit)", "PASS");

  // ---- 3: build ----
  const build = run("npm", ["run", "build"]);
  const distIndex = path.join(ROOT, "dist", "index.html");
  if (!build.ok || !fs.existsSync(distIndex)) {
    record(3, "vite build + dist/index.html", "FAIL", build.out.slice(-800));
    return bail(summarize());
  }
  record(3, "vite build + dist/index.html", "PASS");

  // ---- unit/parser smokes (per-pillar Vitest suites) ----
  // Two failures look identical from here and only one is the suite's fault.
  //
  // vitest spawns a forked worker per file. On an oversubscribed box a worker can
  // fail its own start handshake - "Failed to start forks worker ... Timeout
  // waiting for worker to respond" - which surfaces as every test passing, one
  // unhandled error, and a non-zero exit. That reads as a broken suite and is not
  // one, so it is re-run with fewer workers and the re-run is reported.
  //
  // The forks pool is not negotiable, tempting as it looks: --pool=threads runs
  // this suite in 7s instead of 55s and never hits the handshake, but it shares one
  // process, so the module-level caches that forks isolate leak between files. Under
  // --sequence.shuffle that produced 3 failures in one run and 1 in another. Speed
  // that costs isolation is not speed.
  const WORKER_START_FAILURE = /Failed to start .* worker|Timeout waiting for worker to respond/;
  const VITEST_MS = HANG_GUARD_MS.vitestSuite;
  // Fewer forks at a time, in order. The handshake has a start timeout of its own
  // inside vitest - 60000ms, read out of vitest 4.1.10 in node_modules rather than
  // from its documentation - and nothing here can configure it, so capping
  // concurrency is the only lever this script has over the contention that misses
  // it. Capped at 2 was not enough at load 42.70 across 8 threads, measured, with
  // no test failing. maxWorkers changes how many files run at once and never
  // whether each gets its own process, so the isolation above is untouched.
  const WORKER_LADDER = [
    { args: [], how: "as many workers as vitest chose" },
    { args: ["--maxWorkers=2"], how: "workers capped at 2" },
    { args: ["--maxWorkers=1"], how: "one worker at a time" },
  ];
  let vt = run("npx", ["vitest", "run", ...WORKER_LADDER[0].args], { timeoutMs: VITEST_MS });
  let ranAs = "";
  for (let rung = 1; rung < WORKER_LADDER.length; rung++) {
    if (vt.ok || !WORKER_START_FAILURE.test(vt.out) || /Failed Tests/.test(vt.out)) break;
    ranAs = WORKER_LADDER[rung].how;
    console.log(
      `[gate] check 3b: a worker failed to start under ${loadNote()} and no test ` +
        `failed, so the suite is being re-run with ${ranAs}`,
    );
    vt = run("npx", ["vitest", "run", ...WORKER_LADDER[rung].args], { timeoutMs: VITEST_MS });
  }
  if (!vt.ok) {
    const tail = vt.out.trim();
    // Down to one worker and still unable to start one, with nothing failing, is
    // the machine rather than the tree. It stays a failure anyway: a suite that
    // never ran has verified nothing, and reporting that as a skip would put a
    // green summary on a run that checked none of this.
    const detail = WORKER_START_FAILURE.test(vt.out) && !/Failed Tests/.test(vt.out)
      ? `${loadNote()}; no test failed - the suite could not start a worker inside ` +
        `vitest's own start timeout, down to one at a time. That is this machine, ` +
        `not this tree, and it is still red because nothing was verified. Re-run ` +
        `when the box is quieter.\n${tail.slice(-800)}`
      : tail
        ? `${loadNote()}\n${tail.slice(-1200)}`
        : `${loadNote()}; the suite produced no output before it was killed, which is ` +
          `what exceeding the ${VITEST_MS}ms hang guard looks like rather than a failing test`;
    record("3b", "vitest per-pillar smokes", "FAIL", detail);
    return bail(summarize());
  }
  // The size of the corpus, not only the verdict. Six suites gate themselves on
  // the operator's real sources, so a moved vault or wraps directory turns them
  // off - and this line was identical whether 838 tests ran or 816 did. The
  // parse is required rather than defaulted: falling back to zero would turn a
  // reworded vitest summary into a silent green, which is the defect this check
  // exists to notice in the pillars.
  const vtCounts = vt.out.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/);
  if (!vtCounts) {
    record(
      "3b",
      "vitest per-pillar smokes",
      "FAIL",
      "the suite exited 0 but its own summary line could not be read, so the " +
        "number of tests that ran is unknown; last output:\n" +
        vt.out.trim().slice(-600),
    );
    return bail(summarize());
  }
  record(
    "3b",
    "vitest per-pillar smokes",
    "PASS",
    [
      `tests=${vtCounts[1]} skipped=${vtCounts[2] ?? 0}`,
      ranAs ? `${loadNote()}; re-run with ${ranAs} after a worker failed to start` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );

  // ---- 4: boot on an ephemeral port + health poll ----
  // Run the server on this very Node with tsx as a loader, rather than through
  // `npx tsx` or the .bin/tsx shim. Both add exec hops - npx may resolve a
  // package and block on a stdin prompt that is not connected, and the shim's
  // `#!/usr/bin/env node` line costs two more execs. This form has no PATH
  // lookup and no shebang, so what boots here is what `npm start` boots.
  //
  // The boot is retried because a cold exec can stall: check 1 rewrote every
  // binary under node_modules, and the OS validates a newly written binary the
  // first time it runs. Right after the process burst of the test suite, that
  // validation can park a fresh process in dyld for tens of seconds having
  // printed nothing. A stalled attempt is killed and respawned; a server that
  // is actually broken fails every attempt, and its output prints below.
  //
  // The per-attempt budget is a hang guard and nothing else. This check asserts
  // that the server answers /api/health at all; no assertion here is about how
  // long that took, so a budget tight enough for a busy box to exceed can only
  // produce a false red. It used to be narrow on an idle machine and wide on a
  // loaded one, decided by a load reading taken before any of the work above -
  // one box at load 10.6 across 8 threads failed at 75s while the same boot took
  // 2s standalone, which is a true statement about the machine and a false one
  // about the server.
  //
  // What makes a wide guard cheap is below: an attempt ends the moment the child
  // exits, so a server that is genuinely broken fails this in about a second and
  // only a live child that never answers ever reaches the clock.
  const BOOT_ATTEMPT_MS = HANG_GUARD_MS.serverBootAttempt;
  const BOOT_ATTEMPTS = 3;
  // These pipes must be drained, not just opened: the child blocks on write
  // once the OS buffer fills, and the skills scan warns per shadowed skill.
  const capture = (chunk) => {
    serverLog += chunk.toString("utf8");
    if (serverLog.length > 40000) serverLog = serverLog.slice(-40000);
  };

  let health = null;
  let port = 0;
  let base = "";
  // Per attempt and total are both kept. Timing the whole loop from one mark
  // outside it reported three exhausted 25s attempts as a single 75s boot, which
  // reads as one catastrophically slow start rather than as three that never
  // answered - opposite diagnoses from the same number.
  const firstAttemptStart = Date.now();
  let attemptMs = 0;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS && !health; attempt++) {
    const attemptStart = Date.now();
    // A fresh port per attempt, so a stalled child that later wakes up and
    // binds cannot be mistaken for the current one.
    port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    bootedServer = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bootedServer.stdout.on("data", capture);
    bootedServer.stderr.on("data", capture);
    bootedServer.on("error", (err) => capture(Buffer.from(`spawn error: ${err}\n`)));
    // A child that has exited will never answer, and the clock has nothing left
    // to measure. Ending the attempt on the exit rather than on the deadline is
    // what the budget is actually protecting against - a stall, not a crash - and
    // it is what lets the guard be wide enough never to fire on a busy machine
    // without making a genuinely broken server take three full budgets to report.
    let exited = null;
    bootedServer.on("exit", (code, signal) => {
      exited = `code=${code} signal=${signal}`;
      capture(Buffer.from(`server exited: ${exited}\n`));
    });

    const deadline = Date.now() + BOOT_ATTEMPT_MS;
    while (Date.now() < deadline && !health && !exited) {
      try {
        health = await fetchJson(`${base}/api/health`, 2000);
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    attemptMs = Date.now() - attemptStart;
    if (!health) {
      console.log(
        `[gate] check 4: boot attempt ${attempt}/${BOOT_ATTEMPTS} ` +
          `${exited ? `exited (${exited})` : "stalled"} after ` +
          `${attemptMs}ms (${loadNote()})` +
          `${serverLog.trim() ? "" : "; child printed nothing"}; respawning`,
      );
      bootedServer.kill("SIGKILL");
    }
  }
  const totalBootMs = Date.now() - firstAttemptStart;
  if (!health?.ok) {
    // Distinguish "it crashed and said why" from "it never spoke at all" - the
    // second means the child stalled before reaching any of our code. The load
    // figure travels with the failure because those two look identical in the
    // output and an oversubscribed machine is the commonest cause of the second.
    const silent = !serverLog.trim()
      ? `; child produced no output across ${BOOT_ATTEMPTS} attempts`
      : "";
    record(
      4,
      "server boot + /api/health",
      "FAIL",
      `no health after ${BOOT_ATTEMPTS} attempts, ${totalBootMs}ms total ` +
        `(hang guard ${BOOT_ATTEMPT_MS}ms each, ${loadNote()})${silent}`,
    );
    return bail(summarize());
  }
  record(
    4,
    "server boot + /api/health",
    "PASS",
    `port ${port}, ${attemptMs}ms to answer, ${totalBootMs}ms total`,
  );

  // ---- 5: memory vault smoke ----
  if (!sources.engram) {
    record(5, "memory vault thoughts", "SKIP", "source missing (engram vault)");
  } else {
    try {
      const rows = await fetchJson(`${base}/api/engram/thoughts?limit=5`);
      const ok =
        Array.isArray(rows) &&
        rows.length >= 1 &&
        rows.every((r) => r.id && r.title);
      record(5, "memory vault thoughts", ok ? "PASS" : "FAIL", `items=${rows.length}`);
      if (!ok) return bail(summarize());
    } catch (err) {
      record(5, "memory vault thoughts", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 6: friction log smoke ----
  if (!sources.friction) {
    record(6, "friction log entries", "SKIP", "source missing (friction log)");
  } else {
    try {
      const rows = await fetchJson(`${base}/api/friction`);
      const frictions = rows.filter((e) => e.type === "Friction").length;
      const resolutions = rows.filter((e) => e.type === "Resolution").length;
      const formats = new Set(rows.map((e) => e.format));
      const rawText = fs.readFileSync(config.frictionLogPath, "utf8");
      const formatsExpected = [
        ["pipe", /^\d{4}-\d{2}-\d{2}T[^|]*\|\s*\[/m.test(rawText)],
        ["section", /^##\s+\d{4}-\d{2}-\d{2}/m.test(rawText)],
        ["table", /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/m.test(rawText)],
      ];
      const formatsOk = formatsExpected.every(([f, present]) => !present || formats.has(f));
      const ok = frictions >= 1 && resolutions >= 1 && formatsOk;
      record(6, "friction log entries", ok ? "PASS" : "FAIL",
        `friction=${frictions} resolution=${resolutions} formats=${[...formats].join(",")}`);
      if (!ok) return bail(summarize());
    } catch (err) {
      record(6, "friction log entries", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 7: skill inventory smoke ----
  if (!sources.skills) {
    record(7, "skill inventory", "SKIP", "source missing (skill roots)");
  } else {
    try {
      const rows = await fetchJson(`${base}/api/skills`);
      const ok =
        Array.isArray(rows) &&
        rows.length >= 10 &&
        rows.every((s) => s.name && s.description);
      record(7, "skill inventory", ok ? "PASS" : "FAIL", `skills=${rows.length}`);
      if (!ok) return bail(summarize());
    } catch (err) {
      record(7, "skill inventory", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 8: launcher wiring smoke (hermetic - no LLM run) ----
  try {
    const { launchId } = await (
      await fetch(`${base}/api/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smoke: true }),
      })
    ).json();
    if (!launchId) throw new Error("no launchId returned");

    // read >= 1 SSE event from the stream
    const sseRes = await fetch(`${base}/api/launch/${launchId}/stream`, {
      signal: AbortSignal.timeout(30000),
    });
    const reader = sseRes.body.getReader();
    let sseText = "";
    while (sseText.split("event:").length - 1 < 1) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += Buffer.from(value).toString("utf8");
    }
    reader.cancel().catch(() => {});
    const sseEvents = sseText.split("event:").length - 1;

    // poll the record to a terminal status with a captured exitCode
    let rec = null;
    const recDeadline = Date.now() + 60000;
    while (Date.now() < recDeadline) {
      rec = await fetchJson(`${base}/api/launch/${launchId}`);
      if (rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ok =
      sseEvents >= 1 && rec && rec.status !== "running" && rec.exitCode !== null;
    record(8, "launcher wiring (smoke command)", ok ? "PASS" : "FAIL",
      `sseEvents=${sseEvents} status=${rec?.status} exit=${rec?.exitCode}`);
    console.log(
      "[gate] NOTE: check 8 asserts launcher WIRING via the hermetic smoke command;" +
        " it does NOT run a real LLM skill (cost/nondeterminism). Real skill" +
        " launches are exercised manually by the maintainer.",
    );
    if (!ok) return bail(summarize());
  } catch (err) {
    record(8, "launcher wiring (smoke command)", "FAIL", String(err));
    return bail(summarize());
  }

  // ---- 9: token trends smoke ----
  if (!sources.cta) {
    record(9, "token trends (readonly)", "SKIP", "source missing (CTA db)");
  } else {
    try {
      const rows = await fetchJson(`${base}/api/cta/trends`);
      const total = rows.reduce((s, d) => s + d.costUsd, 0);
      // readonly assertion: a write attempt through better-sqlite3 must throw
      const probe = run("node", ["--input-type=module", "-e",
        `import Database from 'better-sqlite3';
         const db = new Database(${JSON.stringify(config.ctaDbPath)}, { readonly: true });
         try { db.prepare('CREATE TABLE gate_probe (x)').run(); console.log('WRITE-SUCCEEDED'); process.exit(2); }
         catch (e) { console.log('write blocked:', e.message); }`,
      ]);
      const ok = rows.length >= 1 && total > 0 && probe.ok && !probe.out.includes("WRITE-SUCCEEDED");
      record(9, "token trends (readonly)", ok ? "PASS" : "FAIL",
        `days=${rows.length} cost=$${total.toFixed(2)} readonly=${probe.ok}`);
      if (!ok) return bail(summarize());
    } catch (err) {
      record(9, "token trends (readonly)", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 10: session wraps smoke ----
  if (!sources.wraps) {
    record(10, "session wraps", "SKIP", "source missing (wraps dir)");
  } else {
    try {
      const rows = await fetchJson(`${base}/api/wraps`);
      const ok =
        Array.isArray(rows) &&
        rows.length >= 10 &&
        rows.every((w) => w.date && w.title);
      record(10, "session wraps", ok ? "PASS" : "FAIL", `wraps=${rows.length}`);
      if (!ok) return bail(summarize());
    } catch (err) {
      record(10, "session wraps", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 10b: universal pillars (transcripts, hooks, tasks, live) ----
  // These read what every Claude Code install writes, so on a machine that has
  // ever run Claude Code they exercise real data without any third-party plugin.
  if (!sources.sessions) {
    record("10b", "sessions + hooks (transcripts)", "SKIP", "source missing (transcripts)");
  } else {
    try {
      const rows = await fetchJson(`${base}/api/sessions?limit=5`);
      const sessionsOk =
        Array.isArray(rows) &&
        rows.length >= 1 &&
        rows.every((s) => s.sessionId && s.title && s.projectDir);

      // A round trip through the detail route proves the identifiers the list
      // hands out are the ones the detail route accepts.
      const first = rows[0];
      const detail = await fetchJson(
        `${base}/api/sessions/${encodeURIComponent(first.projectDir)}/${encodeURIComponent(first.sessionId)}`,
      );
      const detailOk = Array.isArray(detail.timeline) && detail.timeline.length >= 1;

      // Traversal in either identifier must not reach a file outside the tree.
      const traversal = await fetch(
        `${base}/api/sessions/${encodeURIComponent("../..")}/${encodeURIComponent("passwd")}`,
      );
      const traversalRefused = traversal.status === 404;

      const hooks = await fetchJson(`${base}/api/hooks?limit=10`);
      const hooksOk =
        typeof hooks.totalInvocations === "number" && Array.isArray(hooks.hooks);

      const ok = sessionsOk && detailOk && traversalRefused && hooksOk;
      record(
        "10b",
        "sessions + hooks (transcripts)",
        ok ? "PASS" : "FAIL",
        `sessions=${rows.length} timeline=${detail.timeline?.length ?? 0} ` +
          `traversalRefused=${traversalRefused} hooks=${hooks.hooks?.length ?? 0}`,
      );
      if (!ok) return bail(summarize());
    } catch (err) {
      record("10b", "sessions + hooks (transcripts)", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 10c: source availability report drives the shell's navigation ----
  // Compared against the probe at the top of this run rather than against a
  // floor. The floor was "at least eight rows" while the report carried
  // twenty-three, so fifteen probes could have disappeared - the navigation
  // quietly no longer dimming them - with this check still passing. The two
  // lists name the same set of sources by construction, so requiring them to be
  // equal makes each the other's verifier: a probe added on either side reddens
  // this until both know about it. A report with no rows at all fails outright,
  // because two empty sets match and would certify nothing.
  try {
    const rows = await fetchJson(`${base}/api/sources`);
    const shaped =
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every(
        (s) =>
          typeof s.key === "string" &&
          typeof s.present === "boolean" &&
          (s.tier === "universal" || s.tier === "personal"),
      );
    const reported = new Set(shaped ? rows.map((s) => s.key) : []);
    const probed = new Set(Object.keys(sources));
    const unreported = [...probed].filter((k) => !reported.has(k));
    const unprobed = [...reported].filter((k) => !probed.has(k));
    const ok = shaped && unreported.length === 0 && unprobed.length === 0;
    const present = shaped ? rows.filter((s) => s.present).length : 0;
    record(
      "10c",
      "source availability report",
      ok ? "PASS" : "FAIL",
      [
        `${present}/${reported.size} present, ${probed.size} probed by this script`,
        unreported.length ? `probed here but not reported: ${unreported.join(", ")}` : "",
        unprobed.length ? `reported but not probed here: ${unprobed.join(", ")}` : "",
        shaped ? "" : "the report is empty or malformed",
      ]
        .filter(Boolean)
        .join("; "),
    );
    if (!ok) return bail(summarize());
  } catch (err) {
    record("10c", "source availability report", "FAIL", String(err));
    return bail(summarize());
  }

  // ---- 10d: the derived index is genuinely disposable ----
  // The index is only compatible with this tool owning no data if deleting it
  // loses nothing. That claim is worth a check rather than a comment: build it,
  // record what it answers, delete the file, rebuild, and require the identical
  // answer. A drift here means the cache has become a source.
  //
  // It needs something to index. With none of the four index sources on this
  // machine the sync answers 503 and there are no documents to compare, which is
  // a missing source rather than a broken cache - so it is reported as a skip,
  // the way every other pillar's absence is, rather than as the hard failure it
  // looked like on a fresh clone.
  if (!sources.search) {
    record(
      "10d",
      "derived index is disposable",
      "SKIP",
      "source missing (nothing to index)",
    );
  } else {
    try {
      const sync = await postJson(`${base}/api/index/sync`);
      const probe = "loopback";
      const before = await fetchJson(`${base}/api/search?q=${probe}&limit=10`);
      const key = (r) => r.hits.map((h) => `${h.kind}:${h.ref}:${h.locator}`).join("|");

      fs.rmSync(config.indexPath, { force: true });
      const indexGone = !fs.existsSync(config.indexPath);

      const resync = await postJson(`${base}/api/index/sync`);
      const after = await fetchJson(`${base}/api/search?q=${probe}&limit=10`);

      const ok =
        indexGone &&
        sync.documents > 0 &&
        resync.documents === sync.documents &&
        key(after) === key(before);
      record(
        "10d",
        "derived index is disposable",
        ok ? "PASS" : "FAIL",
        `docs=${sync.documents} rebuilt=${resync.documents} hits=${before.hits.length} identical=${key(after) === key(before)}`,
      );
      if (!ok) return bail(summarize());
    } catch (err) {
      record("10d", "derived index is disposable", "FAIL", String(err));
      return bail(summarize());
    }
  }

  // ---- 11: Playwright UI render smoke over every pillar route ----
  console.log("[gate] check 11: installing chromium if needed + UI smoke...");
  const pwInstall = run("npx", ["playwright", "install", "chromium"], { timeoutMs: 420000 });
  if (!pwInstall.ok) {
    record(11, "UI render smoke (playwright)", "FAIL", "chromium install failed: " + pwInstall.out.slice(-400));
    return bail(summarize());
  }
  // A route whose source is missing is no longer skipped: it must render the
  // not-configured panel. That state is what a fresh clone actually shows, so
  // leaving it unrendered by the gate meant the most common first-run screen was
  // never checked. Both outcomes pass; an error panel or a blank page fails.
  const absentRoutes = [
    ["sessions", "#/overview"],
    ["search", "#/search"],
    ["sessions", "#/sessions"],
    ["skills", "#/skills"],
    ["hooks", "#/hooks"],
    ["tasks", "#/tasks"],
    // The run diff reads the transcript tree, so it shares the sessions source.
    // Its absence from this list meant the smoke walked it asking for real data
    // on a machine that has none, and the first-run screen it was meant to prove
    // failed with a selector timeout instead.
    ["sessions", "#/diff"],
    ["config", "#/config"],
    ["history", "#/history"],
    ["blocks", "#/usage"],
    ["graph", "#/graph"],
    ["workflows", "#/workflows"],
    ["fileHistory", "#/file-history"],
    ["usageData", "#/outcomes"],
    ["disk", "#/disk"],
    ["mcpUsage", "#/mcp-usage"],
    ["delegation", "#/delegation"],
    ["instructions", "#/instructions"],
    ["skillTrend", "#/skill-trend"],
    ["engram", "#/engram"],
    ["friction", "#/friction"],
    ["wraps", "#/wraps"],
    ["cta", "#/cta"],
  ]
    .filter(([key]) => !sources[key])
    .map(([, hash]) => hash);
  const uiArgs = ["scripts/ui-smoke.mjs", base];
  if (absentRoutes.length) uiArgs.push(absentRoutes.join(","));
  // The per-route hang guard lives in gate-budgets.mjs and the smoke reads it
  // itself, so it is stated once. The whole-run timeout below is the older,
  // coarser guard on the smoke process; it does not dominate the per-route guard
  // across every route, so a run where many routes hang is killed here and
  // reports the process rather than naming the route. That pairing already
  // shipped, unchanged - it is what every busy machine ran under.
  const ui = run("node", uiArgs, { timeoutMs: 180000 });
  console.log(ui.out.trim().split("\n").map((l) => `      ${l}`).join("\n"));
  // Counted from what the smoke actually reported rather than written into this
  // string. The hardcoded number said 20 while the script walked 23, which is
  // the same class of defect the pillars are held to: a count that drifted from
  // the thing it counts, and nothing failed to say so.
  const routesWalked = (ui.out.match(/^ui-smoke (?:PASS|FAIL) /gm) ?? []).length;
  const uiLabel = `UI render smoke (playwright, ${routesWalked} routes)`;
  if (!ui.ok) {
    record(11, uiLabel, "FAIL", `${loadNote()}\n${ui.out.slice(-600)}`);
    return bail(summarize());
  }
  record(
    11,
    uiLabel,
    "PASS",
    absentRoutes.length ? `not-configured panel asserted for: ${absentRoutes.join(", ")}` : "",
  );

  // ---- 12: localhost-only bind ----
  try {
    // Retry health: after the SSE + subprocess churn the undici pool can drop
    // a single connection transiently; the bind itself is unchanged.
    let h = null;
    for (let i = 0; i < 10 && !h; i++) {
      try {
        h = await fetchJson(`${base}/api/health`, 2000);
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!h) throw new Error("health unreachable after retries");
    // The only real observation here is the refused connection from an address
    // that is not loopback. The server's own /api/health echoes the constant it
    // bound with, so comparing that against "127.0.0.1" compares a literal with
    // itself and would pass on a server bound to the world. On a machine with no
    // non-loopback IPv4 - an offline laptop, a container with only lo - there is
    // nothing to observe, and this reports a skip rather than printing what a
    // passing check prints.
    const lanIp = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!lanIp) {
      record(
        12,
        "localhost-only bind",
        "SKIP",
        "no non-loopback IPv4 on this machine, so an off-machine connection " +
          "could not be attempted; the bind was not tested",
      );
    } else {
      let loopbackOk = true;
      let lanDetail = "";
      try {
        await fetch(`http://${lanIp}:${port}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        loopbackOk = false;
        lanDetail = `server REACHABLE on ${lanIp}:${port} - bind is not loopback-only`;
      } catch {
        lanDetail = `connection to ${lanIp}:${port} refused, as required`;
      }
      record(12, "localhost-only bind", loopbackOk ? "PASS" : "FAIL", lanDetail);
      if (!loopbackOk) return bail(summarize());
    }
  } catch (err) {
    record(12, "localhost-only bind", "FAIL", String(err));
    return bail(summarize());
  }

  // ---- 13: the heavy reads answer the same thing twice ----
  // The three slowest routes memoize their per-file transcript scans, and the
  // whole risk of that is a warm call answering differently from a cold one: a
  // counter incremented where the file is read rather than read off the scan is
  // counted once and then never again. The warm path is what a long-running
  // server actually serves, so that bug's normal behaviour would be the wrong
  // number, with the right one appearing only on the first request after a
  // restart. Same shape as check 10d, which deletes the derived index and
  // requires identical answers.
  //
  // Each route is gated on its own source, not on the transcript tree alone. The
  // file-history pillar has a second source of its own, and a machine without it
  // answers 503 there - which this check has to report as a skip like every other
  // check does, rather than as a failure. Reading a missing source as broken is
  // the exact confusion the whole source-missing contract exists to prevent.
  const HEAVY = [
    ["/api/file-history", sources.fileHistory && sources.sessions, "file-history dir"],
    ["/api/mcp-usage", sources.mcpUsage, "transcripts"],
    ["/api/delegation", sources.delegation, "transcripts"],
  ];
  const readable = HEAVY.filter(([, present]) => present);
  const absent = HEAVY.filter(([, present]) => !present);
  if (readable.length === 0) {
    record(
      13,
      "heavy reads are idempotent",
      "SKIP",
      `source missing (${[...new Set(absent.map(([, , why]) => why))].join(", ")})`,
    );
  } else {
    try {
      // Three reads, not two, and the third is what makes the first pair
      // interpretable.
      //
      // Only the first read can be cold, so read 1 against read 2 is the only
      // comparison that can catch cache-dependence at all. Retrying that pair on
      // disagreement is worse than useless: reads 2 and 3 are both warm, so a
      // retry agrees with itself and turns the very bug this check exists for into
      // a PASS. That was the first version of this check, and injecting the bug
      // proved it silent.
      //
      // So a disagreement is diagnosed instead of retried. If reads 2 and 3 agree,
      // the tree is quiet and a 1-against-2 difference can only be the cache. If
      // reads 2 and 3 also disagree, a live session is appending mid-check and this
      // run cannot prove anything either way - which is recorded as unknown, never
      // as a pass.
      // Reads 2 and 3 agreeing proves the tree was quiet AFTER read 2, which is
      // not the window that matters: the only pair that can catch
      // cache-dependence is read 1 against read 2. A session appending in THAT
      // gap re-keys the memo for one transcript and produces the failing
      // signature exactly - cold different, both warm reads alike - with no
      // cache bug present. Observed here: the check failed on /api/file-history
      // while the operator's own session was writing, and three reads taken
      // seconds later on a quiet tree were byte-identical. So the tree is
      // fingerprinted around the whole trio, and movement makes the run unknown
      // rather than failed.
      const treeFingerprint = (dir) => {
        let count = 0;
        let bytes = 0;
        let newest = 0;
        const walk = (current) => {
          let entries;
          try {
            entries = fs.readdirSync(current, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.name.endsWith(".jsonl")) {
              try {
                const stat = fs.statSync(full);
                count += 1;
                bytes += stat.size;
                if (stat.mtimeMs > newest) newest = stat.mtimeMs;
              } catch {
                // Vanished mid-walk. The fingerprint changing is the point.
              }
            }
          }
        };
        walk(dir);
        return `${count}:${bytes}:${newest}`;
      };

      const cacheDependent = [];
      const unstable = [];
      const moved = [];
      let dateRolled = false;
      for (const [route] of readable) {
        // The delegation report zero-fills its monthly trend up to the read time,
        // so a run straddling UTC midnight produces two different and both-correct
        // payloads. Recorded as unknown rather than failed.
        const dayBefore = new Date().toISOString().slice(0, 10);
        const treeBefore = treeFingerprint(config.transcriptsDir);
        const cold = JSON.stringify(await fetchJson(`${base}${route}`, 60000));
        const warm = JSON.stringify(await fetchJson(`${base}${route}`, 60000));
        const warmAgain = JSON.stringify(await fetchJson(`${base}${route}`, 60000));
        const treeAfter = treeFingerprint(config.transcriptsDir);
        if (dayBefore !== new Date().toISOString().slice(0, 10)) {
          dateRolled = true;
          break;
        }
        if (cold === warm) continue;
        // Source movement is checked before the warm pair is believed, because a
        // moving tree explains the same evidence and the cache does not have to.
        if (treeBefore !== treeAfter) moved.push(route);
        else if (warm === warmAgain) cacheDependent.push(route);
        else unstable.push(route);
      }

      if (cacheDependent.length) {
        record(
          13,
          "heavy reads are idempotent",
          "FAIL",
          `cold and warm reads differ while the tree is quiet: ${cacheDependent.join(", ")} ` +
            `- a per-file scan is accumulating where the file is read instead of from ` +
            `the cached result`,
        );
        return bail(summarize());
      }
      if (dateRolled) {
        record(
          13,
          "heavy reads are idempotent",
          "SKIP",
          "UTC date changed mid-check; the monthly zero-fill moved, so this run proves nothing",
        );
      } else if (moved.length) {
        record(
          13,
          "heavy reads are idempotent",
          "SKIP",
          `the transcript tree changed mid-check on ${moved.join(", ")}; a re-keyed memo ` +
            `explains the difference, so cache-dependence is untested rather than absent`,
        );
      } else if (unstable.length) {
        record(
          13,
          "heavy reads are idempotent",
          "SKIP",
          `a session appended mid-check on ${unstable.join(", ")}; two warm reads also ` +
            `differed, so cache-dependence is untested rather than absent`,
        );
      } else {
        record(
          13,
          "heavy reads are idempotent",
          "PASS",
          [
            `${readable.length} route(s) cold-vs-warm`,
            // Never silent about what was not covered: a pass over two of three
            // routes must not read as a pass over all three.
            absent.length
              ? `${absent.map(([route]) => route).join(", ")} skipped, source missing`
              : "",
          ]
            .filter(Boolean)
            .join(", "),
        );
      }
    } catch (err) {
      record(13, "heavy reads are idempotent", "FAIL", String(err));
      return bail(summarize());
    }
  }

  return bail(summarize());
}

main().catch((err) => {
  console.error("[gate] unexpected error:", err);
  bail(1);
});
