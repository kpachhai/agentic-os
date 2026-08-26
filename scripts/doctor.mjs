#!/usr/bin/env node
// npm run doctor - report which data sources this machine actually has, and what
// each missing one costs you. Diagnostic by default: it reads, it never installs
// anything and it never writes into a data source. `--write-config` is the only
// mode that writes, and it writes exactly one file, the app's own config.json.
//
// Deliberately NOT an installer. Installing plugins or MCP servers, or writing
// into somebody's ~/.claude, is invasive and hard to undo, and this tool's whole
// claim is that it only ever reads. So the doctor prints the command and the
// operator decides.
//
// Plain Node, zero dependencies, for the same reason scripts/gate.mjs is: it has
// to run on a fresh clone before anything is installed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOME = os.homedir();

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const writeConfig = args.has("--write-config");
const strict = args.has("--strict");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: npm run doctor [-- <flags>]

  --write-config   write a config.json from the paths detected here
                   (refuses to overwrite an existing config.json)
  --json           machine-readable output
  --strict         exit non-zero when any source is missing
                   (off by default: a missing source is a normal first run)
  --help           this message
`);
  process.exit(0);
}

function expandHome(p) {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

// These defaults duplicate defaults() in server/config.ts, because this script
// stays dependency-free and cannot import a TypeScript module. The same
// duplication exists in scripts/gate.mjs; keep all three in sync, or the doctor
// will confidently report on a path the server does not actually read.
const SOURCES = [
  {
    key: "transcriptsDir",
    label: "session transcripts",
    fallback: "~/.claude/projects",
    kind: "dir",
    tier: "universal",
    powers: "Sessions pillar: titles, timelines, per-turn tokens, tool and model mix",
    remedy:
      "Every Claude Code install writes these. If it is missing, either you have never run Claude Code as this user, or settings.cleanupPeriodDays has aged the files out.",
  },
  {
    key: "liveSessionsDir",
    label: "live session registry",
    fallback: "~/.claude/sessions",
    kind: "dir",
    tier: "universal",
    powers: "which repos have a Claude session open right now",
    remedy: "Created by Claude Code the first time a session starts.",
  },
  {
    key: "tasksDir",
    label: "task boards",
    fallback: "~/.claude/tasks",
    kind: "dir",
    tier: "universal",
    powers: "unfinished work left behind by sessions that ended",
    remedy: "Created the first time a session uses the task tools.",
  },
  {
    key: "claudeConfigPath",
    label: "Claude Code config",
    fallback: "~/.claude.json",
    kind: "file",
    tier: "universal",
    powers: "skill and plugin usage counts, which turn the skill catalog into a decay report",
    remedy: "Created by Claude Code on first run.",
  },
  {
    key: "claudeSettingsPath",
    label: "Claude Code settings",
    fallback: "~/.claude/settings.json",
    kind: "file",
    tier: "universal",
    powers: "the resolved settings view, annotated by which file won each key",
    remedy: "Optional. Absent means you have never customized settings.",
  },
  {
    key: "fileHistoryDir",
    label: "file version history",
    fallback: "~/.claude/file-history",
    kind: "dir",
    tier: "universal",
    powers: "every intermediate version of a file Claude edited, including ones later reverted",
    remedy: "Written by Claude Code whenever it edits a file. Absent means no edit has been recorded as this user.",
  },
  {
    key: "usageDataDir",
    label: "insights usage data",
    fallback: "~/.claude/usage-data",
    kind: "dir",
    tier: "universal",
    powers: "the Outcomes pillar, and the friction your sessions had that never reached your log",
    remedy:
      "Written by Claude Code's /insights command, in one pass, and never refreshed afterwards. Absent means you have not run it; stale means you have not run it lately, which is why every view over it shows its coverage and the date it was generated.",
  },
  {
    key: "claudeHome",
    label: "Claude Code home",
    fallback: "~/.claude",
    kind: "dir",
    tier: "universal",
    powers: "the disk-footprint pillar: what this install keeps, by category",
    remedy: "Created by Claude Code on first run. Its absence would mean no install to read.",
  },
  {
    key: "claudeMdPath",
    label: "global instruction file",
    fallback: "~/.claude/CLAUDE.md",
    kind: "file",
    tier: "universal",
    powers: "the instruction-budget figure: what loads before you type a word",
    remedy: "Optional. Absent means you have written no global instructions, which is a real answer rather than a fault.",
  },
  {
    key: "agentsDir",
    label: "agent definitions",
    fallback: "~/.claude/agents",
    kind: "dir",
    tier: "universal",
    powers: "the identity text agent definitions contribute to every session",
    remedy: "Optional. Created when you define your first subagent.",
  },
  {
    key: "historyPath",
    label: "prompt history",
    fallback: "~/.claude/history.jsonl",
    kind: "file",
    tier: "universal",
    powers: "the prompts you have typed, searchable, and the shape of your working day",
    remedy: "Written by Claude Code as you use it. Absent means no prompt has been recorded as this user.",
  },
  {
    key: "pacingLogPath",
    label: "rate-limit capture log",
    fallback: "~/.claude/pacing-log.jsonl",
    kind: "file",
    tier: "bespoke",
    powers: "how much of your five-hour and seven-day windows you have consumed",
    remedy:
      "Absent by default, and that is the normal state. Rate-limit consumption exists only in the payload Claude Code hands its statusline command, so capturing it needs a statusLine hook you install yourself. GET /api/pacing/setup prints the command; this tool will not edit your settings for you.",
  },
  {
    key: "skillRoots",
    label: "skill roots",
    fallback: ["~/.claude/skills", "~/.claude/plugins"],
    kind: "any-dir",
    tier: "universal",
    powers: "Skills pillar: the catalog, and the launcher",
    remedy:
      "Install a skill or a plugin, or point skillRoots at wherever yours live.",
  },
  {
    key: "engramVaultPath",
    label: "memory vault",
    fallback: "~/engram-vault",
    kind: "dir",
    tier: "bespoke",
    powers: "Memory pillar: browse and search your captured notes",
    remedy:
      "This one is specific to a personal memory vault of markdown files with YAML frontmatter, under a thoughts/ directory. Point engramVaultPath at yours, or leave it unset and the pillar reports itself unconfigured.",
  },
  {
    key: "frictionLogPath",
    label: "friction log",
    fallback: "~/.claude/friction-log.md",
    kind: "file",
    tier: "bespoke",
    powers: "Friction pillar: corrections paired with the resolutions that closed them",
    remedy:
      "A single markdown file of dated entries. Create it and start appending, or point frictionLogPath at an existing log.",
  },
  {
    key: "wrapsDir",
    label: "session wraps",
    fallback: "~/.claude/memory",
    kind: "dir",
    tier: "bespoke",
    powers: "Wraps pillar: end-of-session retrospectives, newest first",
    remedy:
      "A directory of session_wrap_YYYY_MM_DD_<slug>.md files. Point wrapsDir at yours.",
  },
  {
    key: "ctaDbPath",
    label: "token-analyzer database",
    fallback:
      "~/.claude/plugins/data/claude-token-analyzer-claude-token-analyzer/token-analyzer.db",
    kind: "file",
    tier: "bespoke",
    powers: "Token Trends pillar: long-run cost and token aggregates",
    remedy:
      "Provided by a third-party token-analyzer plugin. Without it, the Sessions pillar still derives token counts straight from your transcripts, so this is an enhancement rather than a requirement.",
  },
];

function loadRawConfig() {
  const file = process.env.CONFIG_PATH ?? path.join(ROOT, "config.json");
  if (!fs.existsSync(file)) return { file, raw: {}, exists: false };
  try {
    return { file, raw: JSON.parse(fs.readFileSync(file, "utf8")), exists: true };
  } catch (err) {
    // A malformed config is a hard error everywhere else in this tool, and the
    // doctor is the one place that should say so in plain language rather than
    // throwing a parse trace at you.
    console.error(`[doctor] config.json is present but not valid JSON: ${file}`);
    console.error(`[doctor] ${err.message}`);
    process.exit(1);
  }
}

function probe(source, raw) {
  const configured = raw[source.key] !== undefined;
  if (source.kind === "any-dir") {
    const candidates = (configured ? raw[source.key] : source.fallback).map(expandHome);
    const found = candidates.filter((p) => fs.existsSync(p));
    return {
      ...source,
      configured,
      paths: candidates,
      present: found.length > 0,
      detail: found.length ? `${found.length}/${candidates.length} roots found` : "",
    };
  }

  const resolved = expandHome(configured ? raw[source.key] : source.fallback);
  if (!fs.existsSync(resolved)) {
    return { ...source, configured, paths: [resolved], present: false, detail: "" };
  }

  // A path that exists but is the wrong kind is its own failure, and it is a
  // common config typo: pointing a directory key at a file reads as "present"
  // to a bare existence check and then fails at read time.
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return {
      ...source,
      configured,
      paths: [resolved],
      present: false,
      detail: `unreadable: ${err.code ?? err.message}`,
    };
  }
  const wantDir = source.kind === "dir";
  if (wantDir !== stat.isDirectory()) {
    return {
      ...source,
      configured,
      paths: [resolved],
      present: false,
      detail: wantDir ? "exists but is a file, not a directory" : "exists but is a directory, not a file",
    };
  }

  let detail = "";
  if (wantDir) {
    try {
      detail = `${fs.readdirSync(resolved).length} entries`;
    } catch (err) {
      return {
        ...source,
        configured,
        paths: [resolved],
        present: false,
        detail: `unreadable: ${err.code ?? err.message}`,
      };
    }
  } else {
    detail = `${(stat.size / 1024).toFixed(1)} KB`;
  }
  return { ...source, configured, paths: [resolved], present: true, detail };
}

function checkClaudeBinary(raw) {
  const name = raw.claudeBinary ?? "claude";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { present: true, detail: candidate };
    } catch {
      // Not in this PATH entry; keep looking.
    }
  }
  return { present: false, detail: `not found on PATH as "${name}"` };
}

/**
 * How old the vendored price table's verification is.
 *
 * The two constants are read out of server/pricing.ts rather than copied here,
 * because a copy would be a fourth place holding one value and the copy would be
 * the stale one. This script is dependency-free, so it reads them as text - and
 * an unreadable one is reported rather than defaulted, since a fallback of "zero
 * days old" would turn a renamed constant into a reassuring line about a table
 * nobody has checked.
 */
function checkPricingAge() {
  const file = path.join(ROOT, "server", "pricing.ts");
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return { readable: false, detail: `could not read ${file}` };
  }
  const asOf = source.match(/export const PRICING_AS_OF = "(\d{4}-\d{2}-\d{2})";/);
  const shelfLife = source.match(/export const PRICING_SHELF_LIFE_DAYS = (\d+);/);
  if (!asOf || !shelfLife) {
    return {
      readable: false,
      detail:
        `PRICING_AS_OF or PRICING_SHELF_LIFE_DAYS not found in ${file}; ` +
        "the table's age cannot be reported until this reads them again",
    };
  }
  const ageDays = Math.floor(
    (Date.now() - Date.parse(`${asOf[1]}T00:00:00Z`)) / 86400000,
  );
  const shelfLifeDays = Number(shelfLife[1]);
  return {
    readable: true,
    asOf: asOf[1],
    ageDays,
    shelfLifeDays,
    stale: ageDays > shelfLifeDays,
    fromFuture: ageDays < 0,
  };
}

function checkLocalModel(raw) {
  // Reported, never started. Plain-language digests need a model runner already
  // listening on loopback; the app does not launch one and does not download
  // weights. Loopback only, so nothing leaves the machine.
  const url = raw.digest?.localModelUrl ?? "http://127.0.0.1:8080";
  return { url };
}

const { file: configFile, raw, exists: configExists } = loadRawConfig();
const results = SOURCES.map((source) => probe(source, raw));
const binary = checkClaudeBinary(raw);
const model = checkLocalModel(raw);
const pricing = checkPricingAge();

const universal = results.filter((r) => r.tier === "universal");
const bespoke = results.filter((r) => r.tier === "bespoke");
const missing = results.filter((r) => !r.present);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        configFile,
        configExists,
        claudeBinary: binary,
        localModelUrl: model.url,
        pricing,
        sources: results.map(({ key, label, tier, present, configured, paths, detail }) => ({
          key,
          label,
          tier,
          present,
          configured,
          paths,
          detail,
        })),
      },
      null,
      2,
    ),
  );
} else {
  const mark = (ok) => (ok ? "found  " : "missing");
  console.log("\nagentic-os doctor\n");
  console.log(`  config file : ${configFile}${configExists ? "" : "  (absent - using $HOME defaults)"}`);
  console.log(`  claude CLI  : ${binary.present ? binary.detail : binary.detail}`);
  console.log(`  local model : ${model.url}  (probed at request time, never started by this tool)`);
  // Printed on every run whatever the shelf life is set to, so the figure a
  // reader acts on is the measured age rather than a threshold's verdict.
  if (!pricing.readable) {
    console.log(`  price table : UNKNOWN AGE - ${pricing.detail}`);
  } else if (pricing.fromFuture) {
    console.log(
      `  price table : verified ${pricing.asOf}, which is in the future - ` +
        "PRICING_AS_OF in server/pricing.ts is mistyped",
    );
  } else {
    console.log(
      `  price table : verified ${pricing.asOf}, ${pricing.ageDays} days ago ` +
        `(shelf life ${pricing.shelfLifeDays} days)` +
        (pricing.stale
          ? " - past due; re-read the vendor's published pricing and update" +
            " PRICING_AS_OF in server/pricing.ts in the same commit"
          : ""),
    );
  }

  console.log(
    "\n  Universal sources - every Claude Code install has these.\n" +
      "  A fresh clone should light up on this group alone.\n",
  );
  for (const r of universal) {
    console.log(`   ${mark(r.present)}  ${r.label.padEnd(24)} ${r.detail}`);
    console.log(`            ${r.paths.join(", ")}`);
  }

  console.log(
    "\n  Personal sources - these describe one operator's own note-taking.\n" +
      "  Missing ones are unconfigured, not broken; their pillars say so.\n",
  );
  for (const r of bespoke) {
    console.log(`   ${mark(r.present)}  ${r.label.padEnd(24)} ${r.detail}`);
    console.log(`            ${r.paths.join(", ")}`);
  }

  if (missing.length) {
    console.log(`\n  ${missing.length} source(s) missing. What each one costs you:\n`);
    for (const r of missing) {
      console.log(`   ${r.label}  (config key: ${r.key})`);
      console.log(`     powers : ${r.powers}`);
      console.log(`     fix    : ${r.remedy}`);
      console.log("");
    }
  } else {
    console.log("\n  Every configured source was found.\n");
  }

  const presentCount = results.length - missing.length;
  console.log(
    `  ${presentCount}/${results.length} sources present ` +
      `(${universal.filter((r) => r.present).length}/${universal.length} universal, ` +
      `${bespoke.filter((r) => r.present).length}/${bespoke.length} personal)`,
  );
  if (!configExists) {
    console.log("\n  Tip: `npm run doctor -- --write-config` writes a config.json from what was found here.");
  }
  console.log("");
}

if (writeConfig) {
  const target = path.join(ROOT, "config.json");
  if (fs.existsSync(target)) {
    // Never clobber a config the operator has edited; that file holds their real
    // paths and launch policy.
    console.error(`[doctor] refusing to overwrite existing ${target}`);
    console.error("[doctor] move it aside first if you want a freshly detected one.");
    process.exit(1);
  }
  // Only sources that actually exist are written. Emitting a key for a path that
  // is not there would turn "unconfigured" into "misconfigured" and make the
  // pillar report a path the operator never chose.
  const detected = {};
  for (const r of results) {
    if (!r.present) continue;
    detected[r.key] = r.kind === "any-dir" ? r.paths.filter((p) => fs.existsSync(p)) : r.paths[0];
  }
  fs.writeFileSync(target, `${JSON.stringify(detected, null, 2)}\n`, "utf8");
  console.log(`[doctor] wrote ${target} with ${Object.keys(detected).length} detected source(s).`);
  console.log("[doctor] launchDefaults was NOT written: it decides where a launched agent may");
  console.log("[doctor] write, so it is yours to set deliberately. See config.example.json.");
}

process.exit(strict && missing.length ? 1 : 0);
