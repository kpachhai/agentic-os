# Agentic OS

A local-only web control panel over your Claude Code install, in one dark
dashboard. Clone it, run it, and it reads what is already on your disk.

**Works on any Claude Code install, with no configuration:**

- **Sessions** - every session as a browsable timeline, named by the plain-English
  title Claude Code already writes into its own transcripts. Per-turn token usage
  across all four cache tiers, tool mix, model mix, which skills fired, which tool
  calls you denied, and where a rewind forked the conversation.
- **Skills + Launch** - one catalog of every skill on the machine, with Claude
  Code's own usage counters joined on, so the catalog doubles as a decay report:
  which skills are active, which have gone cold, and which you installed and never
  once invoked. Each is launchable headlessly via `claude -p` with streamed progress.
- **Hook Health** - what your hooks actually cost. Per-hook run count, duration
  percentiles, worst run, and total time, derived entirely from records already in
  the transcripts. No collector, no listener, no settings change.
- **Unfinished Work** - task boards left pending when a session was closed or
  cleared, which none of the other pillars can tell you.
- **What you asked for** - every prompt you have typed, across every project,
  searchable, with the shape of your own working day: prompts per project, per
  hour, median length, and which ones carried pasted content. This is the one
  record of *intent* rather than of what Claude did with it.
- **Usage + Pacing** - your spend grouped into the five-hour windows your
  subscription limits are actually expressed in, priced from a table vendored into
  this repo rather than fetched at runtime, shown with how many days ago that table
  was last verified and the shelf life it is measured against. If you install the
  optional capture hook, it also shows how much of your five-hour and seven-day
  windows you have consumed - the one number that lives in your account and nowhere
  on disk.
- **Memory graph** - the link structure between your memory notes, and the faults
  in it: references to notes that do not exist, notes nothing links to, and dead
  ends.
- **Orchestration** - the scripts Claude wrote to drive its own multi-agent runs
  on this machine, with what each declared and how wide it fanned out. Code you
  did not write, which decided how many agents ran; the panel exists so you can
  read it. Scripts are read as text, never imported or executed.
- **Blast radius per session** - every file a session edited, including files whose
  changes were later reverted or overwritten, with the ones you then fixed by hand
  flagged. A diff shows what survived; this shows where the session had been.
- **File version history** - Claude Code keeps its own versioned copy of every file it
  edits, and nothing else reads it. Browse the version chain of any file and diff any
  two versions, including intermediate versions that were later reverted and so never
  reached a commit. A version is addressed by session, not by file: version numbers
  restart per session, and the same file versioned in two sessions reuses them for
  different content.
- **MCP usage against configured** - every configured MCP server costs context before
  you type a word, so "configured and never called" is the actionable list. Configured
  names are gathered from all four places they hide: your settings, each project's
  settings, the hosted connectors the client records, and the servers an installed
  plugin brings with it. Reading only the first left most real traffic unexplained and
  the never-called list nearly empty. Each name carries where it was found, because a
  settings entry is configured now while a connector is only recorded as having
  connected once - a weaker claim that must not be acted on the same way.
- **Delegation** - what you handed to subagents and what came back, counted as two
  separate things that are allowed to disagree. Dispatches by specialist, and on the
  result side the transcripts, records, tool calls and output tokens the delegated work
  produced. The one local evidence of whether you are delegating at all.
- **Instructions in effect** - what instruction text loads before you type, per project,
  against the ceiling where Claude Code starts warning. Counted honestly: a skill
  contributes its name and description, never its body, which is a difference of more
  than an order of magnitude.
- **Skill usage over time** - when each skill was actually used, and a ranked deletion
  shortlist with a reason for each candidate. The catalog's lifetime counter cannot tell
  "seventeen uses over six months" from "seventeen uses in one week last April"; the
  transcripts can. No verdict reads as "proven unused" when the truth is "no evidence
  found".
- **Outcomes** - whether the work went anywhere, which is the one thing the
  transcripts do not record. Claude Code's `/insights` command writes a per-session
  judgement to disk; this reads it and never asks a model anything of its own. Those
  verdicts are opinions, so they are shown as categories and never averaged into a
  score, and every figure carries how many sessions it covers and when the store was
  generated - it is written in one pass and never refreshed, so on this machine it
  described 32 of 490 sessions.
- **Detected, never logged** - friction that analysis found in a session which never
  became an entry in your log, which is the loop leaking. The join is by time window,
  not by meaning: your log's vocabulary and the analysis's are disjoint, so "logged"
  claims only that you were capturing during that session, never that you captured
  *that*.
- **Did the situation ever come up** - for each standing rule, whether its trigger
  occurred at all in a window, so an instruction audit starts from evidence with
  deletion candidates pre-marked. Occurrence only, and deliberately no adherence
  figure: detecting a rule violation from a transcript was measured at nine hits and
  nine false positives, because a transcript records what command ran and never whose
  repository it ran in. Rules whose trigger is a keystroke or a hook are held in their
  own bucket rather than being called unused.
- **Run diff** - two runs of the same task aligned on tool-call structure, showing
  where they parted. The similarity figure always travels with the step counts behind
  it and a short-run flag, because shape is cheap: of 70 sampled real pairs, four
  matched perfectly and three of those were unrelated tasks.
- **Disk footprint** - what the install is keeping, by category, with the retention
  setting that bounds the largest one shown beside it. Pure stat calls: nothing is
  opened or parsed, so the byte counts are measured rather than estimated.
  Symlinks are counted as the link and never followed, so a skill linked in from
  another checkout is not billed to this tree.
- **Command palette** - `Ctrl/Cmd+K` to jump to any pillar or search the whole
  corpus. Navigation keeps working when the index is cold.
- **Live sessions strip** - which repositories have a Claude session open right
  now, on every page. Useful before launching a skill into a checkout an
  interactive session already owns.
- **Search everything** - one query across sessions, memory, friction and wraps,
  answered in milliseconds from a rebuildable index. Deleting the index loses
  nothing; the gate proves that by deleting it and requiring identical answers.
  A sync that cannot read one of those four sources keeps what it already holds
  from it and names the path on screen, rather than reading "saw no files" as
  "every file was deleted"; with none of the four present the pillar answers
  `503 source missing` like any other, because the index outlives its sources and
  a stale hit shown as current is worse than an empty answer.
- **What is in effect** - resolved settings annotated by which file won each key,
  the MCP servers configured, and where each plugin came from with its usage
  count. Rendered field by field from an allowlist, never by filtering a parsed
  config, because credentials hide in environment blocks, headers and inline URLs.

**Optional, and specific to one operator's note-taking:**

- **Memory** - browse and search a markdown vault with ranked, typo-tolerant
  search (prefix matching and field boosting; no embedding model, no daemon, no MCP).
- **Friction Log** - a friction/lessons log as a timeline, each Resolution linked
  to the Friction it closes, with an All/Open/Resolved toggle. Open loops carry how
  long they have stayed open, since status says whether a loop closed and age says
  how long it took - and only the second one applies pressure.
- **Session Wraps** - session-wrap history, newest first, rendered as markdown.
- **Token Trends** - long-run cost trends from a claude-token-analyzer SQLite
  database, opened strictly read-only.

Missing one of these four is a first-run state, not a failure. The pillar says so
in plain language, names the path it looked for and the one config key that fixes
it, and the navigation dims what has nothing to show. Run `npm run doctor` to see
every source at once.

Nothing leaves the machine. See **Network posture** below for the exact claim and
how to check it yourself, because "local only" is the property this tool exists to
have and it deserves more than an assurance.

## Network posture

The data here is the most intimate record a developer keeps: every prompt typed,
every file edited, every correction made. So the network claim is stated precisely
rather than broadly, and every part of it is mechanically checkable.

**The dashboard makes no outbound network calls at all.**

- It binds `127.0.0.1` and nothing else. `BIND_HOST` is a constant, not a config
  key, and gate check 12 asserts that a connection from this machine's LAN address
  is refused. That assertion needs a non-loopback address to connect from, so on a
  machine that has none it reports SKIP rather than PASS - read check 12's own
  line, not the gate's colour. See **Verify** below.
- The only `fetch()` calls in the server are three in `server/digest.ts`, and every
  candidate URL is filtered through `isLoopbackUrl` first. Pointing `localModelUrl`
  at a remote host does not send data there; the address is rejected.
- There are no outbound-capable dependencies. The only absolute URLs in shipped
  code are loopback ports for local model runners, plus one `example.test` string
  in a test.
- The price table is vendored into `server/pricing.ts` with its as-of date and its
  age in days printed on screen, precisely so that showing you a cost never
  requires a request.
- No CDN fonts, no external stylesheets, no remote images. The UI works with the
  network off.

Verify it yourself, without trusting this file:

```bash
grep -rnE "\bfetch\(|axios|undici|node-fetch|net\.connect" server/ | grep -v '\.test\.'
grep -rhoE "https?://[A-Za-z0-9._:/@-]+" server/ src/          # loopback only
npm run gate                                                    # check 12 proves the bind
```

**Two deliberate exceptions, both yours to trigger:**

1. **Launching a skill** spawns `claude -p`, your own authenticated Claude Code CLI,
   which does talk to Anthropic. That is the entire point of the launch button and
   the only egress path in the tool. It is bounded - the tool allowlist is
   intersected with your configured default, the working directory must stay inside
   it, and timeout and budget are clamped - but whatever a launched agent reads can
   reach the API. Nothing launches on its own.
2. **A local model runner**, if you run one, is reached over loopback HTTP to
   paraphrase a digest. That is why the digest engine is built around a local model
   instead of an API: producing readable summaries of your own notes should not
   require sending them anywhere. The app never starts a runner, never downloads
   weights, and treats an absent one as a missing source.

**What this does not protect against.** The loopback endpoint is unauthenticated,
so any process already running as you can call it - the unit of trust is the
machine, not the process. And the guarantee covers the *running tool*, not your
development of it: if you point an AI coding assistant at this repo and it reads
your transcripts or friction log while working, that content goes wherever that
assistant sends it. The tests and gate deliberately run against your real data, so
that is a live consideration rather than a hypothetical.

## What problem this solves

A personal Claude meta-stack accretes into separate subsystems, each with its
own storage shape and its own inspection ritual. Seeing the state of the stack
used to mean five different rituals:

| Subsystem | Where it lives | Inspected by hand via | Friction |
|---|---|---|---|
| Memory vault | a markdown vault | `find`/`grep`, or an MCP call needing a live session | no browse or search UI |
| Friction log | one flat markdown file, 3 intermixed formats | scrolling 100+ entries | no timeline; open-vs-resolved invisible |
| Skills | several skill and plugin directories | `ls` each dir, read each `SKILL.md` | no inventory; launching means hand-typing a `claude -p` invocation |
| Token usage | a SQLite database | ad-hoc `sqlite3` queries | no trend view; cost drift invisible until queried |
| Session wraps | `session_wrap_*.md` files | opening files one at a time | no history; no way to skim what shipped when |

The cost of that friction is that **the stack is only as useful as it is
legible.** Lessons captured but never re-read are a write-only log. Skills that
are annoying to launch get under-used. Token spend that is never trended cannot
be tuned. The expensive part (capturing all this state) was already being paid
for; the missing piece was a cheap way to see and act on it.

The insight that keeps this small: those five subsystems look unrelated, but
they share one property - each is local, file- or SQLite-backed, and *already
the source of truth*. There is no service to call and no data to migrate. So
this needs no backend and no database of its own. It reads what is already on
disk and shells out to the one tool that already knows how to act (`claude -p`).
That is why it is a single-process control panel and not a platform.

Scope is deliberately **one operator, one machine**: no auth, no accounts, no
multi-user, no remote access. The loopback bind is the security boundary. Every
machine-specific path is config-driven, and the universal pillars derive their
defaults from `$HOME`, so a fork runs on someone else's machine without touching
code or writing a config file.

## Prerequisites (fresh macOS)

```bash
node -v      # need >= 24;  brew install node   (or: nvm install 24)
claude -v    # the Claude Code CLI, installed AND authenticated
```

- **Node.js >= 24** (Active LTS). Developed and gated against v24.2.0 / npm
  11.9.0.
- **The `claude` CLI**, installed and authenticated. Needed to *launch* a skill;
  every read-only pillar works without it. Having run Claude Code at least once
  is what gives the universal pillars something to read.
- **Chromium** for the render smoke. Not a manual step: `npm run gate`
  downloads it on first run via Playwright.
- **Your own data sources.** Nothing is bundled and nothing is seeded - this tool
  only ever reads state you already have, and it will not fabricate sample data to
  look busier than your machine is. A source you lack degrades loudly and
  identically on every pillar: the endpoint answers `503 source missing` naming the
  path it looked for, the UI renders a *not configured* panel explaining what that
  pillar would show and which config key sets it, the navigation dims the entry,
  and the gate reports it. A missing source never crashes the server, never empties
  a pillar silently, never passes quietly, and never reads as an error.

## Setup

```bash
git clone <this-repo-url> agentic-os
cd agentic-os
npm ci
npm run doctor                        # what this machine has, and what it is missing
npm run build
npm start                             # -> http://127.0.0.1:4317
```

The universal pillars need no `config.json` at all; their defaults derive from
`$HOME`. Add one only to point the optional personal pillars at your own files:

```bash
cp config.example.json config.json    # then edit it - see the table below
# or let the doctor write one from the paths it detected:
npm run doctor -- --write-config
```

`config.example.json` ships with `<placeholder>` path segments on purpose - it
cannot guess your repo layout. Point each key at a real path, or delete the key
to accept the `$HOME`-derived default.

| Key | What it points at |
|-----|-------------------|
| `port` | HTTP port (default 4317, override with `PORT=<n>`) |
| `transcriptsDir` | Claude Code session transcripts (`~/.claude/projects`) - powers Sessions and Hook Health |
| `liveSessionsDir` | the running-session registry (`~/.claude/sessions`) |
| `tasksDir` | task boards (`~/.claude/tasks`) |
| `claudeConfigPath` | `~/.claude.json`, read only for its per-skill usage counters |
| `claudeSettingsPath` | `~/.claude/settings.json` |
| `historyPath` | `~/.claude/history.jsonl`, your prompt history - the most sensitive file this reads |
| `fileHistoryDir` | Claude Code's versioned copies of files it edited (`~/.claude/file-history`) |
| `claudeMdPath` | your global instruction file, counted by the instruction budget |
| `agentsDir` | agent definitions, whose identity text loads with every session |
| `workflowsDir` | saved orchestration scripts (`~/.claude/workflows`); generated ones are found under `transcriptsDir` |
| `pacingLogPath` | where the optional statusline hook appends rate-limit samples; absent by default |
| `pluginsDir` | the plugin store |
| `indexPath` | where the disposable derived cache is written; deleting it loses nothing |
| `digest` | plain-language digest settings: `localModelUrl`, `model`, `maxGrade` |
| `engramVaultPath` | engram vault root (contains `thoughts/`) |
| `frictionLogPath` | the friction-log markdown file |
| `skillRoots` | directories scanned for `SKILL.md` files; a Claude Code plugin store is resolved through its `installed_plugins.json` so only live installs count |
| `ctaDbPath` | claude-token-analyzer SQLite database |
| `wrapsDir` | directory containing `session_wrap_*.md` files |
| `frictionResolveWindowDays` | Friction->Resolution fallback match window |
| `claudeBinary` | the claude CLI binary name/path |
| `launchDefaults` | launch working dir, tool allowlist, permission mode, budget cap, timeout - the ceiling a per-launch override can only narrow |
| `smokeCommand` | hermetic command the gate uses to test launcher wiring |

Paths use `~/` syntax and expand to `$HOME` at load. `config.json` is
gitignored; defaults derive from `$HOME` when it is absent.

## Run

`npm start` serves the built UI and the API from one process on
`http://127.0.0.1:4317`. Override the port with `PORT=<n> npm start` or the
`port` key in `config.json`; an invalid port fails fast rather than hopping to
another one.

Dev mode, in two terminals:

```bash
npm run dev:server     # tsx watch on the Hono server
npm run dev:ui         # vite dev server for the UI
```

`CONFIG_PATH=<path>` points the server (and the gate) at an alternate config
file; the default is `config.json` in the repo root.

Other scripts: `npm test` (vitest), `npm run typecheck` (`tsc --noEmit`),
`npm run build` (vite build), `npm run gate` (the full acceptance gate, below).

## Verify

```bash
npm run gate
```

Runs the acceptance gate: install, typecheck, build, the vitest suites, server
boot, per-pillar smoke tests against your real data, a hermetic launcher wiring
check, a transcript-derived sessions and hooks check including a path traversal
refusal, the source-availability report, an index-disposability proof, a headless
Playwright render smoke over every pillar route, a localhost-only bind assertion,
and a cache-idempotence proof over the three heaviest routes. The roster is
declared at the top of `scripts/gate.mjs` and every run prints all of it, so the
list of checks is read off the run rather than restated here. Checks are numbered
1-13 with the vitest suite as 3b and later additions as 10b, 10c and 10d, so check
numbers referenced elsewhere stay stable. Green gate = working install.

Several checks report the size of what they looked at, not only a verdict, because
a verdict over a shrunken corpus is the failure this repo keeps finding. Check 3b
prints how many tests ran and how many skipped themselves for a missing source.
Check 10c compares the source report the server serves against the probe the gate
printed at the start of the run and requires the two sets of source keys to be
equal, so a probe disappearing from either side reddens it. Check 11 prints how
many routes it walked.

A check the run never reached reports `SKIP (not reached)`. The gate stops at the
first hard failure, so the checks after it are unknown rather than passing, and
leaving them out of the summary made a short list read as a clean one.

**The same tree gets the same verdict on a busy machine and an idle one.** The
three wall-clock budgets that decide anything - the suite, one server boot
attempt, and one route in the render smoke - assert nothing about speed. They
assert that the suite passes, that the server answers `/api/health`, and that
every route renders. So each wall clock is a hang guard, not a budget you can
fail on merit: the values live in `scripts/gate-budgets.mjs` as plain literals in
a file that imports nothing, and they are deliberately wide. They used to be
chosen at process start from `os.loadavg()`, which is read before `npm ci`, the
typecheck, the build and the whole suite have run - the four heaviest things on
the machine while the gate is running - so one tree could come back red on an
idle box and green on a loaded one. The load figure still appears beside a
failure, because a slow step and a broken one look identical from outside, but it
is read at the moment it is printed and it decides nothing.
`tests/gate-budgets.test.ts` fails if a budget can read the machine again.

**A skip is not a pass, and some checks can skip on any machine.** Every
per-pillar smoke (5, 6, 7, 9, 10, 10b) skips when its source is absent, which for
the four personal pillars is the normal state on a fresh clone. Three more skip for
reasons worth knowing before you read a green summary:

- **Check 10d (derived index is disposable)** needs something to index. With none
  of the four index sources present, the sync answers `503 source missing` and
  there are no documents to compare - a missing source rather than a broken cache.
- **Check 12 (localhost-only bind)** needs a non-loopback IPv4 address to attempt
  a connection from. An offline laptop or a container with only `lo` gives it
  nothing to observe, so it reports SKIP and **the bind is untested by the gate on
  that run.** Known gap as of 2026-08-25: until the skip was added this check
  printed PASS in that state, which is a check printing what a passing check prints
  while observing nothing. The bind is still a constant, and
  `grep -n BIND_HOST server/index.ts` shows that much without a network.
- **Check 13 (heavy reads are idempotent)** skips when its routes have no source,
  and also when the transcript tree moves mid-check or the UTC date rolls over
  during it. A live Claude session appending while the gate runs produces exactly
  the signature a cache bug would, so that run is recorded as untested rather than
  as either a pass or a failure. Re-run it on a quiet tree.

Check 11 does not skip a route whose source is missing; it requires that route to
render the not-configured panel. That state is what a fresh clone actually shows,
so leaving it unrendered by the gate would mean the most common first-run screen
was never checked. Both outcomes pass. An error panel or a blank page fails.

The launcher check runs the configured `smokeCommand` (default
`claude --version`), not a real skill: it proves spawn/stream/exit wiring
without cost or nondeterminism. Real skill launches are exercised manually.

### What runs on a push

`.github/workflows/ci.yml` runs on every push and pull request: `npm ci`,
`npm run typecheck`, `npm run build`, `npm test`, on Node 24. `npm ci` rather than
`npm install`, because it fails when `package-lock.json` and `package.json`
disagree and nothing else verifies the lock file.

It deliberately does not run `npm run gate`. The gate's per-pillar checks read
your own transcripts, memory vault, friction log and token-analyzer database,
which a runner has none of, so they would report SKIPPED and certify nothing, and
check 10d would skip for the same reason rather than proving the cache is
disposable. The launcher smoke needs a `claude` binary no runner has. What is
left needs a booted server on loopback, a headless Chromium, or a real
non-loopback interface.

So a green run there means: it installs, it typechecks, it builds, and every suite
that does not need an operator's own files passes. **It does not mean the gate is
green.** The acceptance claim lives in `npm run gate`, run locally against real
data, and CI is the layer underneath it - the checks that need no data at all,
run often enough that a broken tree cannot sit unnoticed between gate runs.

## How it works

One Node process. Hono serves both the JSON API and the built UI; there is no
database of its own, no cache, no daemon, and no build step at runtime. Each
pillar is a thin reader over a source that is already authoritative on disk.

```
server/
  index.ts      Hono app: 127.0.0.1 bind, /api/* Host+Origin guard, all routes
  config.ts     config.json load, ~ expansion, $HOME-derived defaults
  engram.ts     memory vault reader (markdown + frontmatter, keyword search)
  friction.ts   friction-log parser (3 formats) + Friction<->Resolution linker
  skills.ts     SKILL.md scanner: classify source, de-dupe by slash command
  cta.ts        token-analyzer SQLite queries, opened strictly read-only
  wraps.ts      session_wrap_*.md reader + Shipped/Learned/Friction splitter
  history.ts    prompt-history reader; records that a paste happened, never its content
  pricing.ts    the vendored price table + five-hour window grouping
  pacing.ts     the optional rate-limit capture log, and the hook that writes it
  graph.ts      memory-note wikilink graph, matched narrowly to exclude bash syntax
  workflows.ts  orchestration script inventory; reads scripts as text, never imports
  file-history.ts   stored file versions, keyed by a hash of the path; hand-written diff
  mcp-usage.ts      MCP calls per server, joined against what is configured
  delegation.ts     subagent dispatches, and the delegated transcripts that answered them
  instruction-budget.ts  what always loads, what loads conditionally, what is identity only
  skill-trend.ts    skill attribution over time, and a report-only deletion shortlist
  launcher.ts   spawns `claude -p`, parses stream-json, fans out over SSE
src/
  App.tsx       hash router over every view, plus the Ctrl/Cmd+K palette
  views/        one view per pillar
  tokens.css    the palette; no remote fonts or CDN assets
scripts/
  gate.mjs      the acceptance gate (zero deps - it must survive wiping node_modules)
  gate-budgets.mjs  the gate's wall-clock hang guards, as literals; imports nothing
  doctor.mjs    source-by-source report of what this machine has (zero deps too)
  ui-smoke.mjs  headless Playwright render check across every route
tests/          vitest: synthetic parser fixtures + smokes against real data
.github/workflows/ci.yml   the data-independent half of the gate, on every push
```

Because `gate.mjs` and `doctor.mjs` must survive check 1 wiping `node_modules`,
neither can import `server/config.ts`, so the default source paths exist in three
copies. `tests/script-config-parity.test.ts` extracts all three by text and
compares them, and does the same for the pillar route list named in `src/App.tsx`,
`scripts/ui-smoke.mjs` and `scripts/gate.mjs`. A drift between any of them fails
`npm test` instead of waiting to be noticed. `tests/gate-budgets.test.ts` reads
the same two scripts the same way, for a different rule: every wall-clock guard
is a literal in `scripts/gate-budgets.mjs`, and every reading of the machine is
confined to the one helper that prints diagnostics.

The API, all under the loopback guard:

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness, version, bind host |
| `GET /api/sources` | which sources exist here, split into universal and personal |
| `GET /api/sessions`, `/sessions/totals`, `/sessions/:projectDir/:sessionId` | session list, bounded aggregates, one session with its timeline |
| `GET /api/hooks` | per-hook cost and reliability |
| `GET /api/live` | sessions running right now |
| `GET /api/tasks` | task boards; `?abandoned=true` for unfinished work only |
| `GET /api/search` | full-corpus search; `POST /api/index/sync` builds it and returns `sourcesUnreadable`, `GET /api/index/stats` reports it. All three answer `503 source missing` when none of the four index sources exists |
| `GET /api/config/settings`, `/config/mcp`, `/config/plugins` | what is actually in effect, allowlist-rendered |
| `GET /api/digest/:kind/:id` | plain-language digest; `POST .../paraphrase` adds a local-model rewrite |
| `GET /api/digest/model` | whether a local model runner is listening |
| `GET /api/engram/thoughts`, `/thoughts/:id`, `/types` | list/search, detail, type facets |
| `GET /api/friction` | parsed + linked entries, filterable by type and status |
| `GET /api/friction/aging` | how long loops stay open, over the whole log rather than the filtered view |
| `GET /api/history`, `/history/stats` | your prompts, searchable; and the shape of them with no prompt text |
| `GET /api/blocks` | spend grouped into five-hour windows, priced from the vendored table, whose as-of date and age in days travel with the figures |
| `GET /api/pacing`, `/pacing/setup` | captured rate-limit samples; and the hook command that starts capturing them |
| `GET /api/graph` | memory-note link structure, with broken links and orphans |
| `GET /api/file-history`, `/version`, `/diff` | stored version index; one version's text; a diff between two |
| `GET /api/mcp-usage` | MCP calls joined against every configured-server source, each name carrying where it was found |
| `GET /api/delegation` | subagent dispatches, and what the delegated work produced |
| `GET /api/instructions` | what loads before you type; `?projectDir=` for another project |
| `GET /api/skill-trend` | per-skill attribution over time, and the deletion shortlist |
| `GET /api/workflows`, `/workflows/source` | orchestration script inventory, and one script as text |
| `GET /api/skills` | the de-duped skill inventory |
| `POST /api/launch` | start a headless run; `GET /api/launch/:id` for the record, `/:id/stream` for live SSE, `POST /:id/cancel` to stop it |
| `GET /api/cta/trends`, `/by-model`, `/by-project`, `/summary` | token and cost aggregates |
| `GET /api/wraps`, `/wraps/:id` | wrap list and detail |

Every route lives under the loopback guard; an unmatched `/api/*` path answers
`404` as JSON rather than falling through to the SPA.

Four more, added by the pillars above. **Prices are vendored, not fetched**: a
table in `server/pricing.ts` carries an explicit as-of date, and the Usage view
prints that date, how many days have passed since it, and the shelf life those
days are measured against - because a table that can go stale without erroring
needs its age visible rather than trusted, and a date on its own leaves the
arithmetic to the reader. The shelf life is a commitment, not a measurement:
nothing here can observe a vendor changing a list price, so it is the longest the
maintainer accepts having a possibly-wrong cost on screen before opening the
pricing page again. Past it, the line asks for a re-read; the age is printed either
way, so what you act on does not depend on that threshold being right.
`npm run doctor` prints the same age without starting the server. A window
containing a model the table does not price reports no cost at all rather than a
partial one. **Capture and reading are separate**:
rate-limit consumption exists only in the payload Claude Code hands its statusline
command, so reading it requires a hook that appends samples to a file - this tool
prints the command and never installs it, because editing your settings is not
something a dashboard should do behind your back. **Link matching is narrow on
purpose**: bash test syntax and POSIX character classes use the same double
brackets as a memory-note wikilink and appear thousands of times in notes that
quote shell, so a permissive pattern buries every real broken link under false
positives. **Orchestration scripts are read as text**, never imported or
evaluated; they are recorded agent programs, not modules.

Two design notes worth knowing before changing anything. The CTA database is
opened read-only with a WAL-retry wrapper and never `immutable=1`, because
Claude Code may be checkpointing the same file while you read it. And the
Friction-to-Resolution linking is deterministic, not fuzzy: it matches an
explicit `supersedes:` token first, then falls back to the nearest following
Resolution inside `frictionResolveWindowDays`. "Nearest" means nearest in
time, not in the file - the log's three formats interleave, so entries are
ordered chronologically before linking.

## Launch safety posture

The launch pillar is a powerful action surface; its envelope is:

- **Loopback bind.** The server listens on `127.0.0.1` only; the launch
  endpoint is unreachable from off-machine (gate check 12 asserts this, and
  reports SKIP rather than PASS on a machine with no non-loopback address to
  attempt the connection from - see **Verify**).
- **Browser-attack guard.** An `/api/*` middleware rejects any request whose
  `Host` is not loopback (DNS-rebinding defense) or whose `Origin` is
  off-machine (CSRF defense), so a malicious web page you visit cannot drive
  the launch endpoint on your localhost.
- **Every per-launch override narrows, none widen.** The tool allowlist is
  intersected with the configured default, the working directory must resolve
  inside `launchDefaults.cwd`, and the timeout and budget are clamped to the
  configured ceilings. A request reaching this endpoint cannot grant itself a
  tool, a directory, or a runtime the operator's config withholds.
- **Local processes are trusted; that is a scope boundary, not a gap.** The
  guard stops off-machine and browser-driven callers, not other processes on
  this machine. The loopback endpoint is unauthenticated, so any local process
  can POST `/api/launch` and get an agent with the configured allowlist. No
  unauthenticated localhost tool can prevent that: the unit of trust here is
  the machine, not the process.
- **Bounded runs.** Every launch gets a wall-clock timeout (default 600 s,
  shortenable per launch); on expiry the child is killed and the record is
  marked `timed_out`. An optional `maxBudgetUsd` maps to `--max-budget-usd`.
  A run can also be stopped from the UI, which marks it `cancelled`. Note:
  the CLI exposes no `--max-turns` flag (verified against 2.1.202), so there
  is no turn cap and the wall clock is the only hard stop.
- **Explicit tool allowlist.** Defaults to
  `Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch,TodoWrite,Task`; shown on
  every launch record and narrowable per launch. The allowlist's goal is
  prevent-hang, NOT sandboxing: it runs your own trusted skills headlessly,
  and a narrow list would make most real skills stall on their first tool.
- **`--permission-mode acceptEdits`**, not `bypassPermissions`: file edits
  proceed (so headless skills can work) while the run stays within the
  allowlist. This trades containment for usefulness on a single-operator
  machine; the loopback bind, timeout, and configured working directory are
  the real safety envelope.
- **Configured working directory.** Launches run in `launchDefaults.cwd`
  (never `/` or `$HOME` by default - with no `config.json` it falls back to
  the app's own repo dir, not the shell's) and the record shows it. A
  per-launch `cwd` may only name a subdirectory of it.

**If you fork this and expose it beyond loopback, you MUST narrow the
allowlist and reconsider the permission mode.** The defaults trust the
operator's own skills; they are not a sandbox for hostile input.

## Design

The look comes from measuring equipment rather than from dashboards, because the
thing this tool does that others do not is refuse to state a figure more
confidently than its evidence supports. The ground is cool graphite rather than
near-black, figures are set in paper-white ink so a number is the brightest thing
near it, and every numeric readout uses tabular figures so a column aligns
digit-for-digit and a changing value never shifts its neighbours.

Four desaturated hues carry the one idea, each naming an epistemic status and used
for nothing else:

| Mark | Status | Meaning |
|---|---|---|
| steel | measured | read straight off disk |
| sage | derived | computed from what was read |
| amber | bounded | a floor or a ceiling, not a count |
| violet | unknown | could not be established |

They appear only on a 3px rail down a readout's left edge, a small label, and a
scale tick, so they read as instrumentation rather than decoration. A view that
classifies its figures shows the legend once, near the first group, because a
colour system nobody can decode is just a coloured border. Everything else stays
graphite and ink. Sharp edges throughout; fonts are system stacks, so nothing
loads from a CDN.

Layout holds down to a phone. Below 1180px the master/detail grid collapses to one
column, because its second column was being handed widths nobody could read (186px
at 768, 0px at 430) without ever overflowing the page - the failure mode that
survives an overflow check. Below 900px the sidebar becomes a scrolling strip
across the top rather than shrinking, and a dense table scrolls inside its own
frame so the page keeps a single vertical axis.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A pillar shows `source missing` and names a path | That configured path does not exist. Fix the matching key in `config.json`; `npm run gate` prints a `precondition probe` line listing which sources it found. |
| `403 forbidden host` or `403 cross-origin request rejected` | You reached the API over a non-loopback name (LAN hostname, `0.0.0.0`, a tunnel) or from an off-machine page. Use `http://127.0.0.1:<port>` directly. This guard is working as intended. |
| Server exits complaining about the port | Invalid or occupied port. It fails loudly instead of silently hopping. Set `PORT` or the `port` key. |
| A launch ends `error` with a `spawn_error` event in its stream | The `claude` binary was not found or is not runnable. Check `claude -v` and the `claudeBinary` config key. |
| A launch ends `timed_out` | It hit the wall-clock cap (default 600 s). Raise `launchDefaults.timeoutSeconds` in `config.json` - a per-launch value can only shorten it. The timeout is the hard stop; there is no turn cap. |
| Launch starts but the run fails immediately | Usually authentication. The child inherits your environment and uses your existing Claude Code credentials; confirm the CLI works standalone first. |
| CTA pillar intermittently errors on a locked database | Claude Code is checkpointing the same SQLite file. The reader is read-only with WAL retry; if it persists, retry once the write settles. |
| First `npm run gate` is slow at check 11 | Playwright is downloading Chromium. One-time. |
| Check 3b fails with `Failed to start ... worker` and no failing test | The machine is too busy for vitest to start a worker inside its own start timeout, which is fixed inside vitest and not configurable here. The gate re-runs with fewer workers, capped at 2 and then one at a time; if that also missed it, no test ran and nothing was verified, which is why it is red rather than skipped. Re-run when the box is quieter. |
| A sync reports that a source was not read | That configured path could not be opened this run, so what was already indexed from it was kept rather than removed. Fix the key it names, or ignore it if you simply do not have that source - the sync cannot tell a wrong path from one you never had, so it reports both the same way. |
| Search says `source missing` while the index file still exists | The index is a cache, not a source. All four of `transcriptsDir`, `engramVaultPath`, `wrapsDir` and `frictionLogPath` are gone, so it stopped answering out of a cache whose sources have all moved. Any one of them being present is enough. |
| The Usage view says the price table is past due | The vendored table's last verification is older than its shelf life. Re-read the vendor's published pricing and update the rates and `PRICING_AS_OF` in `server/pricing.ts` in the same commit. `npm run doctor` prints the same line. |

## Non-goals (v1)

No writes to any data source from the UI (launching is the only action; the
search index is a cache under the install, not a data source), no
semantic/vector search (ranked keyword search first; embeddings would cost roughly
378 MB of `node_modules` for a corpus this size), no auth/multi-user/remote
access, no mobile layout, and no packaging beyond `npm` scripts.

Deliberately declined, with reasons: accepting hook POSTs for real-time updates
(it would invert the read-only posture and make the app stateful); OpenTelemetry
export (it needs operator env-var config, emits account identifiers by default,
and one endpoint typo would ship prompt content off-machine); and *fetching* a
pricing table at runtime. Costs are shown, but from a table vendored into the repo
with its as-of date printed beside the figures, so the way it goes wrong is a
visibly old date rather than a silent outbound request.
