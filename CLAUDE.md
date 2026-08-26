# CLAUDE.md - agentic-os

Project instructions for a Claude session working in this repo. Read `README.md`
for the user-facing purpose, setup, and architecture; this file covers what a
session needs that the README does not say.

## What this is, in one paragraph

A local-only control panel over a Claude Code install, plus one operator's own
meta-stack. Read-mostly pillars in two tiers, plus one write action (launching a
skill headlessly through `claude -p`). One Node process, Hono serving both API and
built UI on `127.0.0.1`. It owns no data - every pillar is a thin reader over a
file or SQLite database that is already the source of truth on disk.

**Universal pillars** read what every Claude Code install writes, so a fresh clone
on somebody else's machine shows real data with no configuration: sessions and
their timelines from the transcript tree, hook cost from records already in those
transcripts, the skill catalog with Claude Code's own usage counters joined on,
unfinished task boards, and which sessions are running right now.

**Personal pillars** describe one operator's note-taking and are optional by
design: a markdown memory vault, a friction log, session wraps, and a
third-party token-analyzer database. A stranger is missing all four by
definition, which is not a fault and must never read as one.

That split is the organising decision. When adding a pillar, prefer a source
every install has; reach for an operator-specific one only when nothing universal
can answer the question.

## Running and verifying

```bash
npm ci && npm run build && npm start     # -> http://127.0.0.1:4317
npm run doctor                           # which sources this machine has
npm run gate                             # the acceptance check
```

**`npm run gate` is the mechanical definition of "working."** It runs install,
typecheck, build, vitest, server boot, one smoke per pillar against real data,
launcher wiring, a headless Playwright render over every route (a route whose
source is missing must render the not-configured panel, not be skipped), an
off-machine bind refusal, and a proof that the memoized heavy reads answer the
same thing cold and warm. The roster is declared at the top of `scripts/gate.mjs`
and every run prints all of it, so the number of checks is read off the run rather
than restated in prose here or in the README. Checks are numbered 1-13 with the
vitest suite as 3b and later additions as 10b, 10c and 10d, so check numbers
referenced elsewhere stay stable. A check the run never
reached reports `SKIP (not reached)` rather than vanishing from the summary,
because absence reads as a pass. Green gate = working install. Do not claim a change
works until the gate is green; it catches things the unit tests do not (the
compact-axis regression was found by visual verification, not by tests).

`.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, `npm run build` and
`npm test` on every push and pull request. It is the data-independent half of the
gate and nothing more: it cannot boot a server, drive Chromium, or read any source
the operator owns, so a green run there is not an acceptance claim and never
substitutes for a local gate run. Its own header comment says why each omitted
check is omitted; keep that comment true if you change either file.

A pillar whose data source is absent reports `SKIPPED (source missing)`. That is
a legitimate green - it is loud on purpose. Never convert a skip into a silent
pass, and never seed fake data to turn a skip into a PASS. The runtime half of
that contract: a missing source makes its pillar answer `503 source missing`
naming the path, on every pillar identically. Never let one degrade to an empty
list instead - an empty pillar reads as "no data", which is a different claim.

## Invariants - do not break these

- **Never fire a real launch to check that the launcher works.** Use the hermetic
  smoke, `POST /api/launch {"smoke": true}`, which is what gate check 8 does. A
  real launch spawns the operator's own authenticated `claude -p` and is billed to
  them, with `Edit`, `Write` and `Bash` under `acceptEdits` in the shipped
  defaults. The shipped `maxBudgetUsd` is `null` and the CLI exposes no turn cap,
  so `timeoutSeconds` - 600 by default - is the only ceiling on what one launch
  can spend. A short prompt closes nothing: it is still a billed launch, and the
  child decides how long it runs, not the prompt.
- **Loopback bind is the security boundary.** The server binds `127.0.0.1` only.
  Never widen it, and never add a config key that could. Gate check 12 asserts
  an off-machine connection is refused. Known gate gap: that assertion needs a
  non-loopback address to connect from, so on a machine that has none - offline,
  or a container with only `lo` - check 12 reports SKIP and the bind is untested
  by the gate. It reported PASS in that state until the skip was added, which is
  a check printing what a passing check prints while observing nothing.
- **The `/api/*` Host + Origin guard stays.** It defends against DNS rebinding
  and browser CSRF. Both have regression tests.
- **Every per-launch override may only narrow, never widen,** the configured
  default: `narrowAllowlist` intersects tools rather than replacing them,
  `narrowCwd` keeps the working directory inside `launchDefaults.cwd`, and
  `narrowTimeout`/`narrowBudget` clamp to the configured ceilings. A client
  cannot grant itself what the operator's policy withholds. Any new override
  gets the same treatment.
- **Launches never default to `/` or `$HOME`.** With no `config.json` the cwd
  falls back to the app's own bounded repo dir, resolved from the module's
  location rather than `process.cwd()` - the shell's directory must not be
  able to move it.
- **The CTA database is opened read-only, with WAL retry, never `immutable=1`.**
  Claude Code may be checkpointing the same file mid-read. Zero writes, ever.
- **No writes to any data source.** Launching is the only action this tool
  takes. Reading the operator's memory vault, friction log, and wraps is
  strictly read-only. This extends to the operator's *settings*: the rate-limit
  pacing pillar prints the statusline hook command and never installs it.
- **Orchestration scripts are read as text, never imported or executed.** They
  are recorded agent programs found on disk, and `readWorkflowScript` only serves
  paths the inventory itself produced.
- **The mainline and subagent transcript readers stay separate.**
  `listTranscriptFiles` returns only the `*.jsonl` sitting directly in a project
  directory; `listSubagentTranscriptFiles` walks the nested directories that hold
  delegated work. Sessions and hook cost are about the mainline conversation, so
  folding delegated turns into them would inflate a figure the reader takes for
  "this session". But a skill invoked inside a subagent was still invoked, and an
  MCP server a subagent called was still called - those readers must opt in, and
  omitting delegated records understated skill attribution by 40%. A session
  directory is recognised by its name being a session id: a plugin also writes
  `.jsonl` beside the transcripts, and accepting any sibling directory invented an
  owning session named after the plugin.
- **A title is a label; a message body is content.** Terminal escapes are stripped
  from every string the session reader produces, because an escape is noise
  wherever it lands. The slash-command envelope and markdown block markers are
  stripped from the *title only*: a `<command-name>` block or a `#` heading inside
  a timeline body is content the reader asked to see. Measured on the real corpus
  before this split existed, 145 of 482 titles opened with a markdown marker, 30
  carried a harness tag, and 29 timeline entries across 17 sessions still held raw
  escape bytes. Never apply `titleLine` to `TimelineEntry.text`.
- **Stored file versions are addressed by session, not by file.** Version numbers
  restart per session, and the same file versioned in two sessions reuses them for
  different content, so the addressable unit is the `(sessionId, hash, version)`
  triple. The hash is the first 16 hex chars of `sha256` of the absolute path;
  nothing on disk maps it back, so paths are recovered from the transcripts and an
  entry that matches more than one candidate is reported ambiguous rather than
  resolved to a guess.
- **A linked skill is an installed skill, and a variant copy is not.** The catalog
  follows symlinked directories, because installing a skill by linking it out of
  another checkout is ordinary and a directory entry's own type is `symlink` - four
  real skills were invisible here while Claude Code surfaced them. It also stops
  descending a directory that has its own `SKILL.md`, because skills keep variant
  copies inside themselves and walking past the identity file turned one install
  into three. The two errors partly cancelled, which is why the total looked
  plausible; check both when touching the scan.
- **Two usage units, never summed.** Claude Code's own counter counts skill
  *invocations*; transcript attribution counts *records produced* under a skill.
  They rank differently, so every field names its unit and nothing adds them. The
  deletion shortlist is report-only, and no verdict may read as "proven unused"
  when the evidence only supports "none found" - attribution is newer than some
  history.
- **The instruction budget counts only what actually auto-loads.** A skill
  contributes its frontmatter identity, never its body: counting bodies overstates
  the figure by more than an order of magnitude. A bucket the module cannot prove
  always loads is reported apart from the total rather than folded into it.
- **The price table is vendored and its age is on screen.** Nothing is
  fetched at runtime, so `PRICING_AS_OF` in `server/pricing.ts` is the only thing
  standing between a stale table and a wrong number. The date alone left the
  arithmetic to the reader, so `pricingFreshness()` reports the age in days beside
  it, in the Usage view and in `npm run doctor`, and `PRICING_SHELF_LIFE_DAYS` is
  the point past which the line asks for a re-read. That threshold is a commitment
  rather than a measurement - nothing here can observe a vendor changing a price -
  so the age is printed whatever it is set to, and a date later than today is
  reported as a mistyped constant rather than as a fresh table. When you re-verify,
  change the rates and `PRICING_AS_OF` in the same commit. An unpriced model makes
  the whole window report `null`, never a partial figure - a cost that silently
  omits one model is worse than no cost.
- **`~/.claude/history.jsonl` is the most sensitive file here.** It is every
  prompt verbatim, including anything ever pasted into one. Read-only, excerpted,
  and never captured into a fixture, a test, or gate output. `historyStats`
  returns counts and shapes only; `hadPaste` is a boolean, never the paste.
- **No outbound network calls, and the claim is mechanically checkable.** The only
  `fetch()` calls in the server are in `server/digest.ts` and every candidate URL
  goes through `isLoopbackUrl` first, so a config value pointing off-machine is
  rejected rather than used. There are no outbound-capable dependencies, and the
  only absolute URLs in shipped code are loopback. Adding a call that leaves the
  machine breaks the one property this tool exists to have. The launcher's
  `claude -p` child is the single deliberate exception; it is the operator's own
  authenticated CLI and it never starts by itself.
- **The guarantee covers the running tool, not the development of it.** The tests
  and gate run against the operator's real data by design, so an assistant working
  in this repo reads real transcripts, prompts and notes. That is a real exposure
  and it is not something the code can prevent; keep it in mind before pasting or
  screenshotting anything read from a live source.
- **Loopback HTTP to a local model runner is not an outbound call.** The digest
  engine may talk to a model server already listening on `127.0.0.1`. That is
  still zero-network in the sense that matters: no operator data leaves the
  machine. Stated explicitly so it does not get re-argued. The app never starts
  a runner, never downloads weights, and treats an absent runner exactly like
  any other missing source.
- **Every model output is untrusted text.** It keeps going through the existing
  `marked` + `dompurify` path, and any number a model returns is recomputed in
  TypeScript and the model's value discarded. Schema-constrained decoding
  guarantees shape, never truth: a 3B model given five friction lines returned
  valid JSON whose themes contradicted its own count. So the model paraphrases
  one already-classified record at a time and never counts, pairs, or classifies.
- **A local model runner counts as present only when it names a model.** A
  reachable port is not enough. The llama.cpp default port is a popular one, and
  an unrelated dev server there answered `/health` with a 200 and was reported as
  ready; the failure then surfaced as an HTTP 426 at the point of use, which is
  too late. Readiness requires a non-empty model list.
- **The readability ceiling applies to paraphrase output only.** The lower digest
  tiers reproduce or select the operator's own sentences, so holding them to a
  grade would mean rewriting the words the tier exists to preserve. A real session
  wrap digests to grade 14 because it is written that way. Report the grade at
  those tiers; assert it only against generated text.
- **Provenance is not optional on digest output.** Every line says whether it is
  the operator's own text, a selection from it with a link back to the source
  offset, or a machine paraphrase. A digest feature without this is the one
  outcome that would make this tool actively misleading about the operator's own
  history.
- **A derived index is a disposable cache, never a source.** Deleting it must
  lose nothing, it rebuilds from the files it summarizes, and every answer it
  gives must be reproducible by reading those files directly. It lives under the
  install, never inside a data source. Gate check 10d proves this by deleting the
  file and requiring identical answers, and the promise has to hold *while the
  server is running*: SQLite refuses writes on an unlinked database, so the index
  handle reopens itself rather than turning a delete into a 500.
- **An unread source is not an emptied one.** The sync's removal sweep treats "not
  seen this run" as "deleted", and a source that cannot be opened contributes
  exactly as many files as one that has been emptied: none. So `syncIndex` holds
  the documents of every source it could not read and names it in
  `sourcesUnreadable`. Measured against a copy of the real index, one mistyped
  vault path otherwise removed 891 files and all 891 memory documents at HTTP 200,
  while the Memory pillar answered 503 for the same path in the same run. The
  search routes carry the matching guard: with none of the four index sources
  present they answer `503 source missing` like every other pillar, rather than
  serving hits out of a cache whose sources have all moved.
- **Reading a whole collection asks for it once.** The vault reader re-reads every
  file per lookup by design, so an edit on disk is always visible. That is right
  for one lookup and quadratic for a caller that wants all of them: entry-by-entry
  reads turned a no-op index sync into 15 seconds. `allThoughts` exists for that,
  and a cap like `limit: 500` silently truncated a 765-entry vault, so prefer the
  whole-collection call over a large limit.
- **`server/redact.ts` is defense in depth, not the primary control.** Matching
  credentials by key name can never be complete. A renderer that shows
  configuration picks the fields it displays from an allowlist and passes those
  through redaction; it never hands over a whole parsed config and trusts
  redaction to subtract the dangerous parts.
- **"Not configured" and "broken" are different claims.** A `503 source missing`
  reaches the reader as a first-run panel naming the path and the config key,
  never as an error. Rendering both the same way made a fresh clone look like a
  broken install. `src/PillarState.tsx` makes the distinction in one place so it
  cannot drift between pillars, and gate check 11 asserts that a route whose
  source is absent renders that panel rather than being skipped.
- **The four provenance marks mean one thing each.** Steel is measured, sage
  derived, amber bounded, violet unknown, and nothing else may use those hues. A
  readout's rail is the claim its figure makes about its own evidence, so setting a
  status the payload does not support is the same defect as mislabelling the number.
  A view that shows rails shows the legend too; an undecodable colour system is a
  coloured border.
- **Layout regressions do not always overflow.** The master/detail grid handed its
  second column 186px at 768 and 0px at 430 while the page never scrolled sideways,
  so an overflow check passed throughout. Measure the columns and the content width,
  not only `scrollWidth`.
- **The forks pool is not negotiable.** `--pool=threads` runs the suite in 7s
  instead of 55s and never hits the worker handshake, but it shares one process, so
  module-level caches that forks isolate leak between files - under
  `--sequence.shuffle` that produced 3 failures in one run and 1 in another. The
  gate instead retries once, and only when a worker failed to start and no test
  failed. Speed that costs isolation is not speed.
- **The `/insights` store is a snapshot, not a feed.** `~/.claude/usage-data` is
  written in one pass when the operator runs that command and is never refreshed:
  all 200 statistics files shared one mtime and the 32 judgement files another,
  against 490 transcripts. So it is optional, stale by default, and sparse, and
  every figure derived from it ships with its coverage counts and the date it was
  generated. A count from it rendered bare would read as a statement about all of
  the operator's work when it is a statement about a third of it.
- **A facet is an opinion; nothing computes with it.** `outcome`,
  `claude_helpfulness`, `session_type`, `primary_success` and the goal categories
  are a model's reading of a transcript with no ground truth on disk. They are
  displayed as the categories they are, they carry the unknown rail, and no score
  is derived from them - a single number averaged over opinions would be the most
  confident-looking and least defensible figure in the tool.
- **The friction gap is a time-window join, never a semantic one.** The log is
  organised by the operator's capture prefixes and the judgements use a disjoint
  vocabulary (`buggy_code`, `missing_configuration`), so no mapping between them
  exists to be computed. The question asked is the weaker one the evidence
  supports: was anything logged while this session was running. "Logged" never
  claims the entry was about that friction.
- **Occurrence is reportable; adherence is not.** Violation detection over
  transcripts was measured and failed: 9 hits on 257 real `git commit`
  invocations, all 9 false positives, because a transcript records what command
  ran and never whose repository it ran in. So the trigger pillar reports whether
  a rule's trigger occurred and emits no percentage. Rules whose trigger is a
  keystroke, a hook, or a judgement about prose go in their own bucket rather
  than being called never-triggered on evidence that cannot exist. Counting an
  invocation means the command *starts* a segment: `echo "git commit"`, a grep for
  it, and a heredoc body that contains it are all mentions, and 15 real commands
  mentioned `git commit` without running it.
- **Never render diff similarity alone.** It measures shape, and shape is
  cheap: of 70 sampled real pairs, four scored a perfect match and three of those
  were unrelated tasks, because pairs matching at 90%+ averaged 7 turns against
  256 for the rest. The figure travels with `alignedSteps` of `comparedSteps` and
  the `shortRun` flag, or it is not shown.
- **The disk pillar measures; it must never interpret.** Byte counts come from
  `stat` and nothing else - no file is opened, so this is the one reader whose
  figures are measured rather than derived. Symlinks are counted as the link and
  never followed: a skill linked out of another checkout would otherwise be billed
  to this tree, and a link pointing upward would make the walk unbounded. Anything
  no declared category claims is reported as `otherBytes` and still counted in the
  total, because categories that quietly fail to add up to the install are worse
  than no categories.
- **The per-file scan memo is bounded per extractor, never globally.** A shared
  oldest-first bound is worse than no cache for its largest consumer: any reader
  sweeping more files than the bound evicts its own earliest entries before
  finishing one pass. Measured - the skill-attribution reader walks 1,111 files
  (mainline plus subagent) against what was a 1,000-entry global bound and
  answered in 14.4s cold and 15.6s warm, meaning it never hit once; a second
  full-corpus reader then evicted the first. Split per extractor it answers in
  0.07s warm. Any new bound must exceed the largest corpus a single extractor
  walks, or that extractor is uncached by construction.
- **Fail fast and loud.** No silent port hopping, no swallowed config errors, no
  empty catch blocks. A wrong config should crash, not degrade quietly.

## Conventions

- TypeScript strict; `npm run typecheck` must pass clean.
- `scripts/gate.mjs` has **zero dependencies** by design - check 1 wipes
  `node_modules`, so the gate must survive that. Keep it plain Node. The price of
  that is three copies of the source-path defaults - `server/config.ts`,
  `scripts/gate.mjs`, `scripts/doctor.mjs` - and one had already drifted while
  three comments asked a human to keep them in step.
  `tests/script-config-parity.test.ts` extracts all three by text and compares
  them, so a drift reddens rather than being noticed later.
- Machine-specific paths belong in `config.json` (gitignored), never in code.
  `config.example.json` uses `<placeholder>` segments deliberately; keep it
  generic. Defaults derive from `$HOME` via `os.homedir()` - never hardcode an
  absolute user path.
- No remote assets. No CDN fonts, no external stylesheets; the UI must work with
  no network.
- Adding a dependency needs a reason. The point of this tool is that it is small.

## Data sensitivity

The tests and the gate run against the operator's **real personal data** -
memory vault, friction log, token spend, session history. Two consequences:

1. **Never commit captured output, fixtures, or snapshots taken from real
   sources.** Existing tests assert structure (counts, ordering, non-emptiness)
   with synthetic fixtures for the parsers. Keep it that way; that choice is
   what makes this repo safe to publish.
2. **Never paste real vault or friction-log content into commit messages, docs,
   or issues.** Gate output with real numbers is fine; real entry text is not.

Also keep out of committed content: real names (the `package.json` `author`
field and the `LICENSE` copyright line are the exceptions), email addresses,
employer or client names, absolute `/Users/<name>/` paths, and the names of
private repos.

## Comments: state the why, never cite

This repo was generated from a planning document that is deliberately not
committed - it carries personal paths and identifying detail. Comments used to
cite it (`PRD C3`, `PRD D2`, `Pillar A`), which read as dead references to
anyone who never saw it. Those citations are gone; each comment now carries its
own reasoning.

Keep it that way. A comment explains *why* the code is the way it is, in terms
a reader with no outside context can follow. Do not add references to external
documents, planning-stage labels, or letter-coded feature names. If a rule came
from somewhere else, restate the reason rather than pointing at the source.
References to things that live *in* this repo (`gate check 8`) are fine, since
a reader can actually go read them.
