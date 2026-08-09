import { useEffect, useState, type ReactNode } from "react";
import { apiGet, SourceMissing } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

/**
 * Types copied from the server module this view renders. The UI never imports
 * server code, so the shapes are restated here; the field meanings are the
 * module's, not this file's guesses.
 */
type BudgetBucket = "always" | "conditional" | "identity-only" | "unverified";

type InstructionKind =
  | "global-instructions"
  | "project-instructions"
  | "nested-project-instructions"
  | "imported-instructions"
  | "skill-identity"
  | "agent-identity";

type CeilingStatus = "ok" | "warning" | "over";

type InstructionSource = {
  label: string;
  path: string;
  kind: InstructionKind;
  bucket: BudgetBucket;
  chars: number;
  estimatedTokens: number;
  /** Null for an identity row: a ceiling on one description would mean nothing. */
  ceilingStatus: CeilingStatus | null;
};

type BucketTotal = {
  bucket: BudgetBucket;
  label: string;
  files: number;
  chars: number;
  estimatedTokens: number;
};

type AlwaysLoadedTotal = {
  files: number;
  chars: number;
  estimatedTokens: number;
  largestFileChars: number;
  largestFilePath: string | null;
  headroomOnLargestFile: number;
  percentOfCeilingLargestFile: number;
  filesAtWarning: number;
  filesOverCeiling: number;
  worstFileStatus: CeilingStatus;
  ceilingChars: number;
  warningChars: number;
  ceilingAppliesTo: string;
};

type SkillBodiesExcluded = {
  files: number;
  chars: number;
  estimatedTokens: number;
  identityChars: number;
  overstatementFactor: number | null;
};

type SkipCount = { reason: string; count: number };

type SkillEnumerationReport = {
  counted: number;
  dirsScanned: number;
  skipped: SkipCount[];
  depthTruncated: boolean;
};

type AgentEnumerationReport = {
  counted: number;
  skipped: SkipCount[];
};

type NestedWalkReport = {
  maxDepth: number;
  dirLimit: number;
  dirsVisited: number;
  skippedByDepth: number;
  skippedByDirLimit: number;
  unreadableDirs: number;
  truncated: boolean;
};

type ImportReport = {
  seen: number;
  counted: number;
  skipped: SkipCount[];
  maxHops: number;
  maxFiles: number;
  truncated: boolean;
};

type InstructionBudget = {
  sources: InstructionSource[];
  buckets: BucketTotal[];
  alwaysLoaded: AlwaysLoadedTotal;
  skillBodiesExcluded: SkillBodiesExcluded;
  skillEnumeration: SkillEnumerationReport;
  agentEnumeration: AgentEnumerationReport;
  nestedWalk: NestedWalkReport;
  imports: ImportReport;
  missingSources: string[];
  charsPerToken: number;
  note: string;
};

/** Exact character counts read at a glance; the token figures beside them do not. */
function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** Token estimates are approximate by construction, so they read approximate. */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Last two segments name a file without spending a line on the path to it. */
function shorten(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || fullPath;
}

/** Plural forms used on this page, including the two that are not just an "s". */
const PLURALS: Record<string, string> = {
  directory: "directories",
  subdirectory: "subdirectories",
};

function plural(word: string, howMany: number): string {
  if (howMany === 1) return word;
  return PLURALS[word] ?? `${word}s`;
}

/**
 * What to print for one row, and what to print under it.
 *
 * A nested row's label is its path relative to the project directory, which can
 * run several directories deep, so it is shortened the same way any other path
 * is and the whole relative path goes underneath. A skill's label is the slash
 * command the operator types and is left exactly as it is - the leading slash is
 * part of it.
 */
function rowLabels(row: InstructionSource): { primary: string; secondary: string } {
  const isRelativePath = row.label.includes("/", 1);
  return {
    primary: isRelativePath ? shorten(row.label) : row.label,
    secondary: isRelativePath ? row.label : shorten(row.path),
  };
}

/**
 * Why something was passed over, in words a reader can act on. The server sends
 * these as stable slugs; an unrecognised one falls through to its own text
 * rather than being dropped, since a skip nobody can read is a skip nobody sees.
 */
const REASONS: Record<string, string> = {
  "beyond-import-hop-bound":
    "beyond the hop bound, so the rest of that import chain was not followed",
  "beyond-import-file-bound":
    "beyond the limit on how many imported files to follow",
  "outside-importing-directory":
    "pointing outside the importing file's own directory, which this reader will not follow",
  "import-target-not-a-readable-file":
    "not a readable file: either a missing file, or prose that looked like an import",
  "already-counted-under-another-name":
    "already counted under another name; counting it twice would inflate the total",
  "plugin-install-directory-missing":
    "a plugin install directory that is not on disk",
  "unreadable-skill-directory": "a skills directory that could not be listed",
  "broken-symlink": "a link pointing at nothing",
  "skill-directory-below-depth-bound": "deeper than the skill walk goes",
  "directory-already-visited":
    "already visited; this is how a link back up the tree is kept from looping",
  "no-description-in-frontmatter":
    "no description in the frontmatter, so there is nothing surfaced to count",
  "duplicate-slash-command":
    "a command another skill already claims, and only one of the two can be reached",
  "unreadable-agents-directory": "an agents directory that could not be listed",
  "no-frontmatter-identity":
    "no name or description in the frontmatter, so there is nothing surfaced to count",
};

function reasonText(reason: string): string {
  return REASONS[reason] ?? reason.replace(/-/g, " ");
}

/** Short heading for a bucket. The server's own label carries the full meaning. */
const BUCKET_HEADING: Record<BudgetBucket, string> = {
  always: "always loaded",
  conditional: "conditionally loaded",
  "identity-only": "identity only",
  unverified: "unverified",
};

/**
 * What each bucket costs, which is the distinction the whole page turns on. The
 * four are not four flavours of one figure: one is paid every turn, one only if
 * you go there, one is a fraction of what its files hold, and one may cost
 * nothing at all.
 */
const BUCKET_MEANING: Record<BudgetBucket, string> = {
  always:
    "Paid on every turn of every session started in this project. It is in the window before you type, and nothing you do during the session takes it back out.",
  conditional:
    "A real cost, but only from the moment work moves into the subtree that holds it. Kept out of the standing total because a subtree you never enter costs you nothing.",
  "identity-only":
    "A skill contributes its name and its description so the model can decide whether to reach for it. The body loads only once the skill is actually used, so the bodies are deliberately not in this figure.",
  unverified:
    "Reported here and in none of the totals. Whether these are surfaced on every session, or only when agent dispatch comes up, cannot be established from the files on disk - so this is not a cost you can be told you are paying.",
};

/** How a row reaches the model, in place of the server's slug. */
const KIND_LABEL: Record<InstructionKind, string> = {
  "global-instructions": "global, every project",
  "project-instructions": "the project, or a directory above it",
  "nested-project-instructions": "below the project directory",
  "imported-instructions": "pulled in by an @path line",
  "skill-identity": "skill name and description",
  "agent-identity": "agent name and description",
};

/** A list of skips, or the one quiet line that says there were none. */
/**
 * Reasons whose tally is directories rather than identity files.
 *
 * Naming the unit per reason matters: a directory of skills that could not be read is one
 * skipped directory and an unknown number of skills, so printing it as "1 skill" would
 * understate what is missing from the figure above.
 */
const DIRECTORY_SCOPED_REASONS = new Set([
  "plugin-install-directory-missing",
  "unreadable-skill-directory",
  "unreadable-directory",
  "depth-bound-reached",
  "not-a-directory",
]);

function SkipList({
  skipped,
  subject,
}: {
  skipped: SkipCount[];
  subject: string;
}) {
  if (skipped.length === 0) {
    return (
      <p className="row-meta" style={{ margin: "6px 0 0" }}>
        Nothing was passed over; every {subject} the walk reached was counted.
      </p>
    );
  }
  return (
    <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.55 }}>
      {skipped.map((skip) => {
        const unit = DIRECTORY_SCOPED_REASONS.has(skip.reason) ? "directory" : subject;
        return (
          <li key={skip.reason} style={{ marginBottom: 4 }}>
            {count(skip.count)} {plural(unit, skip.count)}: {reasonText(skip.reason)}
            {unit === "directory" && ", so an unknown number of entries behind it are not in the figure above"}.
          </li>
        );
      })}
    </ul>
  );
}

/** A flag saying the figure above it is a floor rather than a count. */
function FloorFlag({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "baseline", marginTop: 8 }}>
      <span className="badge spark">floor, not a count</span>
      <span style={{ lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

function SourceTable({
  rows,
  showCeiling,
}: {
  rows: InstructionSource[];
  showCeiling: boolean;
}) {
  const widest = rows.reduce((max, row) => Math.max(max, row.chars), 1);
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>source</th>
          <th>how it reaches the model</th>
          <th className="num-cell">chars</th>
          <th className="num-cell">tokens est.</th>
          {showCeiling && <th className="num-cell">per-file ceiling</th>}
          <th style={{ width: "16%" }}>relative size</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const flagged =
            row.ceilingStatus === "over" || row.ceilingStatus === "warning";
          const names = rowLabels(row);
          return (
            <tr key={`${row.path}-${index}`}>
              <td>
                <div style={{ color: "var(--text)" }} title={row.path}>
                  {names.primary}
                </div>
                <div className="row-meta" title={row.path}>
                  {names.secondary}
                </div>
              </td>
              <td className="row-meta">{KIND_LABEL[row.kind]}</td>
              <td className="num-cell">{count(row.chars)}</td>
              <td className="num-cell">{tokens(row.estimatedTokens)}</td>
              {showCeiling && (
                <td className="num-cell">
                  {row.ceilingStatus === null ? (
                    <span
                      className="row-meta"
                      title="the ceiling is a per-file convention, and one name and description is not a file"
                    >
                      does not apply
                    </span>
                  ) : row.ceilingStatus === "ok" ? (
                    <span className="row-meta">under</span>
                  ) : (
                    <span
                      className={row.ceilingStatus === "over" ? "badge warn" : "badge spark"}
                    >
                      {row.ceilingStatus === "over" ? "over" : "near"}
                    </span>
                  )}
                </td>
              )}
              <td>
                <div className="bar-cell">
                  <div className="bar-track">
                    <div
                      className={`bar-fill${flagged ? " warn" : ""}`}
                      style={{ width: `${(row.chars / widest) * 100}%` }}
                    />
                  </div>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** How many rows a bucket shows before the reader asks for the rest. */
const PREVIEW_ROWS = 10;

function BucketSection({
  total,
  rows,
}: {
  total: BucketTotal;
  rows: InstructionSource[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, PREVIEW_ROWS);
  const showCeiling = total.bucket === "always" || total.bucket === "conditional";
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ margin: "0 0 2px" }}>
        {BUCKET_HEADING[total.bucket]} - {count(total.chars)} chars over{" "}
        {count(total.files)} {plural("file", total.files)}
      </h3>
      <p className="row-meta" style={{ margin: "0 0 10px" }}>
        {total.label}. Largest first, so the biggest contributors to this bucket
        are the ones on top.
      </p>
      <SourceTable rows={visible} showCeiling={showCeiling} />
      {rows.length > PREVIEW_ROWS && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
          <button className="chip" onClick={() => setShowAll(!showAll)}>
            {showAll ? `show the largest ${PREVIEW_ROWS}` : `show all ${rows.length} rows`}
          </button>
          <span className="row-meta">
            {showAll
              ? `all ${rows.length} rows shown`
              : `showing the largest ${visible.length} of ${rows.length}; the totals above cover all ${rows.length}`}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The rail a bucket earns, taken from the bucket itself rather than written in.
 *
 * Always-loaded and identity-only are counted straight off the files, so they are
 * measured. The conditional bucket becomes a floor the moment the nested walk stops
 * early, which is a different claim and has to look like one. The unverified bucket
 * is the module saying it could not establish that these load at all, which is what
 * unknown means - reporting it as measured would be the same defect as mislabelling
 * the number.
 */
function railFor(bucket: string, walkTruncated: boolean): string {
  if (bucket === "unverified") return "unknown";
  if (bucket === "conditional") return walkTruncated ? "bounded" : "measured";
  return "measured";
}

export function InstructionsView() {
  // The directory the figure is for. Empty means no query was sent, so the
  // server answered for the launch directory in config.json.
  const [projectDir, setProjectDir] = useState("");
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<InstructionBudget | null>(null);
  const [missing, setMissing] = useState<SourceMissing | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setData(null);
    setMissing(null);
    setError(null);
    const query = projectDir
      ? `?projectDir=${encodeURIComponent(projectDir)}`
      : "";
    apiGet<InstructionBudget>(`/api/instructions${query}`)
      .then(setData)
      .catch((err) => {
        // With no instruction file anywhere the pillar has nothing to report,
        // which on a fresh machine is a first-run state rather than a fault.
        if (err instanceof SourceMissing) setMissing(err);
        else setError(err);
      });
  }, [projectDir]);

  const header = (
    <>
      <h1 className="view-title">
        Instruction <span className="accent">Budget</span>
      </h1>
      <p className="view-sub">
        what instruction text is already in the window before you type a word -
        four buckets rather than one total, because a skill's name is not its body
        and a file you never open is not a standing cost
      </p>
    </>
  );

  const chooser = (
    <>
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setProjectDir(draft.trim());
        }}
      >
        <input
          type="text"
          value={draft}
          placeholder="/path/to/a/project"
          style={{ minWidth: 320 }}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit">budget this directory</button>
        {projectDir !== "" && (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setProjectDir("");
            }}
          >
            back to the configured default
          </button>
        )}
      </form>
      <p className="row-meta" style={{ margin: "-6px 0 18px", lineHeight: 1.6 }}>
        {projectDir === "" ? (
          <>
            Answered for the launch directory configured in{" "}
            <code>config.json</code> (<code>launchDefaults.cwd</code>). The reply
            carries the files that were found rather than the directory it was
            asked about, so the paths on the always-loaded rows are what identify
            it.
          </>
        ) : (
          <>
            Answered for{" "}
            <code title={projectDir}>{shorten(projectDir)}</code>.
          </>
        )}{" "}
        This is a per-project figure, not a machine-wide one: an instruction file
        in the project directory and in every directory above it loads in full, so
        a different project gives a different total.
      </p>
    </>
  );

  if (error) {
    return (
      <div>
        {header}
        {chooser}
        <FailureState error={error} />
      </div>
    );
  }

  if (missing) {
    return (
      <div>
        {header}
        {chooser}
        <div className="not-configured">
          <div className="not-configured-head">
            <span className="badge info">not configured</span>
            <span className="row-meta">{missing.pillar}</span>
          </div>
          <p className="not-configured-lead">
            No instruction file was found for this directory, or for the global
            path, or for any directory in between. Rather than report a budget of
            zero - which would read as "nothing is loaded before you type", a
            false claim on any machine that has one - the pillar names what it
            looked for.
          </p>
          <div className="not-configured-path">
            <span className="row-meta">looked for</span>
            <code>{missing.sourcePath}</code>
          </div>
          <p className="not-configured-how">
            Write a <code>CLAUDE.md</code> in the project directory, or point this
            at a directory that already has one.
          </p>
          <p className="row-meta">
            Set <code>claudeMdPath</code> for the global file and{" "}
            <code>launchDefaults.cwd</code> for the default project directory in{" "}
            <code>config.json</code>, then restart.
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        {header}
        {chooser}
        <Skeleton kind="tiles" count={4} label="reading instruction files..." />
      </div>
    );
  }

  const always = data.alwaysLoaded;
  const bodies = data.skillBodiesExcluded;
  const nested = data.nestedWalk;
  const imports = data.imports;
  const widestBucket = data.buckets.reduce(
    (max, bucket) => Math.max(max, bucket.chars),
    1,
  );
  const ceilingShare = Math.min(always.percentOfCeilingLargestFile, 100);

  return (
    <div>
      {header}
      {chooser}

      <div
        className="stat-grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(255px, 1fr))" }}
      >
        {data.buckets.map((bucket) => (
          <div className={`stat-tile ${railFor(bucket.bucket, data.nestedWalk.truncated)}`} key={bucket.bucket}>
            {/* Ember once per view, on the figure this page exists to surface:
                the standing per-turn cost. Every other reading stays quiet. */}
            <div className={`num${bucket.bucket === "always" ? " accent" : ""}`}>
              {count(bucket.chars)}
            </div>
            <div className="row-meta">
              chars, {BUCKET_HEADING[bucket.bucket]}
            </div>
            <div className="bar-cell" style={{ marginTop: 8 }}>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(bucket.chars / widestBucket) * 100}%` }}
                />
              </div>
            </div>
            <div className="row-meta" style={{ marginTop: 6 }}>
              {bucket.files === 0
                ? "no files"
                : `${count(bucket.files)} ${plural("file", bucket.files)}, about ${tokens(bucket.estimatedTokens)} tokens`}
            </div>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--text-body)",
              }}
            >
              {bucket.files === 0
                ? `Nothing found in this bucket for this directory. ${BUCKET_MEANING[bucket.bucket]}`
                : BUCKET_MEANING[bucket.bucket]}
            </p>
          </div>
        ))}
      </div>
      <RailLegend
        present={[
          ...new Set(
            data.buckets.map((bucket) =>
              railFor(bucket.bucket, data.nestedWalk.truncated),
            ),
          ),
        ] as Array<"measured" | "derived" | "bounded" | "unknown">}
      />

      <p className="row-meta" style={{ margin: "-8px 0 22px", lineHeight: 1.6 }}>
        Character counts are exact. Token figures are estimates from a fixed
        assumption of {data.charsPerToken} characters per token, not a tokeniser,
        and markdown full of punctuation and code fences tokenises worse than
        prose. Do not add the four buckets together: only the first is a standing
        cost, and the last is in no total at all.
      </p>

      <h3 style={{ marginTop: 0 }}>The largest always-loaded file, against the ceiling</h3>
      <div className="card">
        {always.largestFilePath === null ? (
          <p style={{ margin: 0 }}>
            No always-loaded file to measure against the ceiling.
          </p>
        ) : (
          <>
            <div
              style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}
            >
              <span style={{ color: "var(--text)" }} title={always.largestFilePath}>
                {shorten(always.largestFilePath)}
              </span>
              <span className="row-meta">
                {count(always.largestFileChars)} of {count(always.ceilingChars)}{" "}
                chars, {always.percentOfCeilingLargestFile.toFixed(1)}% of the
                ceiling
              </span>
              {always.worstFileStatus === "over" && (
                <span className="badge warn">over the ceiling</span>
              )}
              {always.worstFileStatus === "warning" && (
                <span className="badge spark">past the warning line</span>
              )}
            </div>
            <div className="bar-cell" style={{ marginTop: 10 }}>
              <div className="bar-track" style={{ height: 10 }}>
                <div
                  className={`bar-fill${always.worstFileStatus === "ok" ? "" : " warn"}`}
                  style={{ width: `${ceilingShare}%` }}
                />
              </div>
              <span className="row-meta">
                {count(always.headroomOnLargestFile)} chars of headroom
              </span>
            </div>
            <p style={{ margin: "12px 0 0", lineHeight: 1.55 }}>
              The ceiling applies to {always.ceilingAppliesTo}{" "}
              {always.files === 1
                ? "Here there is one always-loaded file, so the sum and the biggest file are the same figure."
                : `Here that is ${count(always.files)} files summing to ${count(always.chars)} chars, which is what the context pays; the ceiling is measured against the biggest single file instead.`}
            </p>
            <p className="row-meta" style={{ margin: "10px 0 0", lineHeight: 1.6 }}>
              Both lines are conventions rather than measurements:{" "}
              {count(always.ceilingChars)} characters is where Claude Code raises
              its own "this file is large" warning, and{" "}
              {count(always.warningChars)} is the earlier line this tool flags at
              so a file is caught while there is still room to trim it.{" "}
              {always.filesOverCeiling === 0 && always.filesAtWarning === 0
                ? "No always-loaded file has reached either line."
                : `${count(always.filesOverCeiling)} ${plural("file", always.filesOverCeiling)} at or past the ceiling, ${count(always.filesAtWarning)} between the warning line and the ceiling.`}
            </p>
          </>
        )}
      </div>

      <h3 style={{ marginTop: 22 }}>What is correctly not counted</h3>
      <div className="card">
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          The {count(bodies.files)} {plural("skill", bodies.files)} above
          contribute {count(bodies.identityChars)} chars of name and description.
          Their files hold {count(bodies.chars)} chars in total, about{" "}
          {tokens(bodies.estimatedTokens)} tokens - a whole-file figure that includes
          the frontmatter, so the identity chars above are inside it rather than
          additional to it. What no figure on this page counts is the remainder, the{" "}
          {count(Math.max(bodies.chars - bodies.identityChars, 0))} chars of body text
          that only load once a skill is actually invoked.
          {bodies.overstatementFactor !== null && (
            <>
              {" "}
              Counting the bodies would put the identity bucket{" "}
              {bodies.overstatementFactor}x higher, which is not a rounding error
              but the wrong answer by an order of magnitude.
            </>
          )}{" "}
          A skill body loads when the skill is used, so the size shown here is
          what you avoid paying by not using it.
        </p>
      </div>

      <h3 style={{ marginTop: 22 }}>What these figures do not cover</h3>

      <div className="card">
        <div style={{ color: "var(--text)" }}>
          The walk below the project directory
        </div>
        <p className="row-meta" style={{ margin: "5px 0 0", lineHeight: 1.6 }}>
          {count(nested.dirsVisited)} {plural("directory", nested.dirsVisited)}{" "}
          opened, bounded at {nested.maxDepth} levels deep and{" "}
          {count(nested.dirLimit)} directories in total. Anything the walk did not
          reach is a nested instruction file the conditional bucket does not
          include.
        </p>
        {nested.truncated ? (
          <FloorFlag>
            The conditional bucket is a floor: there may be more nested
            instruction files than it counts.
          </FloorFlag>
        ) : (
          <p className="row-meta" style={{ margin: "6px 0 0" }}>
            Nothing cut the walk short, so the conditional bucket is a count
            rather than a floor.
          </p>
        )}
        {(nested.skippedByDepth > 0 ||
          nested.skippedByDirLimit > 0 ||
          nested.unreadableDirs > 0) && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.55 }}>
            {nested.skippedByDepth > 0 && (
              <li>
                {count(nested.skippedByDepth)}{" "}
                {plural("subdirectory", nested.skippedByDepth)} never opened
                because the walk stops at {nested.maxDepth} levels.
              </li>
            )}
            {nested.skippedByDirLimit > 0 && (
              <li>
                {count(nested.skippedByDirLimit)}{" "}
                {plural("subdirectory", nested.skippedByDirLimit)} never opened
                because the {count(nested.dirLimit)}-directory budget ran out.
              </li>
            )}
            {nested.unreadableDirs > 0 && (
              <li>
                {count(nested.unreadableDirs)}{" "}
                {plural("directory", nested.unreadableDirs)} could not be read at
                all, so anything inside is unseen. Nothing chose to stop there;
                permission did.
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="card">
        <div style={{ color: "var(--text)" }}>Files pulled in by an @path line</div>
        <p className="row-meta" style={{ margin: "5px 0 0", lineHeight: 1.6 }}>
          {imports.seen === 0
            ? "No @path import line was found in the counted files, so nothing was pulled in beyond them. An imported file would land in the same bucket as the file that imported it."
            : `${count(imports.counted)} of ${count(imports.seen)} @path references were followed and counted into the bucket of the file that imported them, up to ${imports.maxHops} hops and ${count(imports.maxFiles)} files.`}
        </p>
        {imports.seen > 0 && (
          <SkipList skipped={imports.skipped} subject="reference" />
        )}
        {imports.truncated && (
          <FloorFlag>
            A bound stopped the import walk, so the always-loaded total is a
            floor: an imported file beyond the bound loads without being counted.
          </FloorFlag>
        )}
      </div>

      <div className="card">
        <div style={{ color: "var(--text)" }}>The skill and agent walks</div>
        <p className="row-meta" style={{ margin: "5px 0 0", lineHeight: 1.6 }}>
          {count(data.skillEnumeration.counted)}{" "}
          {plural("skill", data.skillEnumeration.counted)} counted across{" "}
          {count(data.skillEnumeration.dirsScanned)}{" "}
          {plural("directory", data.skillEnumeration.dirsScanned)} scanned, and{" "}
          {count(data.agentEnumeration.counted)} agent{" "}
          {plural("definition", data.agentEnumeration.counted)} read.
        </p>
        <SkipList skipped={data.skillEnumeration.skipped} subject="skill" />
        <SkipList skipped={data.agentEnumeration.skipped} subject="agent file" />
        {data.skillEnumeration.depthTruncated && (
          <FloorFlag>
            A skills walk stopped at its depth bound, so the identity bucket is a
            floor rather than a count.
          </FloorFlag>
        )}
      </div>

      <div className="card">
        <div style={{ color: "var(--text)" }}>Configured sources that are absent</div>
        {data.missingSources.length === 0 ? (
          <p className="row-meta" style={{ margin: "5px 0 0" }}>
            Every configured source was found, so no bucket is short a source.
          </p>
        ) : (
          <>
            <p className="row-meta" style={{ margin: "5px 0 0", lineHeight: 1.6 }}>
              {count(data.missingSources.length)}{" "}
              {plural("source", data.missingSources.length)} named in the config
              are not on disk. Whatever they hold is missing from the buckets
              above, and a mistyped path looks exactly like this.
            </p>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.55 }}>
              {data.missingSources.map((source) => (
                <li key={source} className="row-meta" title={source}>
                  {shorten(source)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <h3 style={{ marginTop: 24 }}>Every source, by bucket</h3>
      {data.buckets
        .filter((bucket) => bucket.files > 0)
        .map((bucket) => (
          <BucketSection
            key={bucket.bucket}
            total={bucket}
            rows={data.sources
              .filter((source) => source.bucket === bucket.bucket)
              .sort((left, right) => right.chars - left.chars)}
          />
        ))}

      <p className="row-meta" style={{ marginTop: 8, lineHeight: 1.6 }}>
        {data.note}
      </p>

      <TriggerCoverage />
    </div>
  );
}

type TriggerCoverageRow = {
  id: string;
  topic: string;
  kind: string;
  match: string[];
  bucket: "triggered" | "never-triggered" | "not-observable";
  occurrences: number;
  sessions: number;
  lastSeenAt: string | null;
  why?: string;
};

type TriggerCoverageReport = {
  rows: TriggerCoverageRow[];
  triggeredCount: number;
  neverTriggeredCount: number;
  notObservableCount: number;
  sessionsScanned: number;
  windowDays: number;
  earliestRecordAt: string | null;
};

const WINDOWS = [30, 90, 180];

/**
 * Which rules have had their trigger occur, so an instruction audit starts from
 * evidence. Occurrence only - there is no adherence figure here and there is not
 * meant to be one, which the panel says out loud rather than leaving the reader
 * to wonder where the compliance number went.
 */
function TriggerCoverage() {
  const [report, setReport] = useState<TriggerCoverageReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [days, setDays] = useState(90);

  useEffect(() => {
    setReport(null);
    apiGet<TriggerCoverageReport>(`/api/instructions/triggers?days=${days}`)
      .then(setReport)
      .catch(setError);
  }, [days]);

  const badge = (bucket: TriggerCoverageRow["bucket"]) => {
    if (bucket === "triggered") return "badge success";
    if (bucket === "never-triggered") return "badge warn";
    return "badge purple";
  };

  return (
    <section className="gap-panel">
      <h2 className="section-title">Did the situation ever come up</h2>
      <p className="view-sub">
        whether each rule's trigger occurred at all, so deletion candidates are
        pre-marked instead of audited blind
      </p>

      {error != null && <FailureState error={error} />}
      {report === null && error == null && (
        <Skeleton kind="rows" count={3} label="scanning transcripts for triggers..." />
      )}

      {report && (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="num">{report.triggeredCount}</div>
              <div className="row-meta">triggered</div>
            </div>
            <div className="stat-tile bounded">
              <div className={`num${report.neverTriggeredCount > 0 ? " accent" : ""}`}>
                {report.neverTriggeredCount}
              </div>
              <div className="row-meta">never triggered, deletion candidates</div>
            </div>
            <div className="stat-tile unknown">
              <div className="num">{report.notObservableCount}</div>
              <div className="row-meta">no transcript can say</div>
            </div>
            <div className="stat-tile">
              <div className="num">{report.sessionsScanned}</div>
              <div className="row-meta">sessions read</div>
            </div>
          </div>

          <p className="row-meta" style={{ marginTop: -8, marginBottom: 12 }}>
            No adherence percentage is reported, and that is deliberate. Detecting a
            rule <em>violation</em> from a transcript was measured on this corpus and
            produced nine hits of which nine were false positives, because a
            transcript records what command ran and never whose repository it ran in.
            Occurrence is the half the evidence supports. A never-triggered rule is a
            candidate to delete, not a rule you broke.
          </p>

          <div className="toolbar">
            {WINDOWS.map((window) => (
              <button
                key={window}
                className={`chip${days === window ? " active" : ""}`}
                onClick={() => setDays(window)}
              >
                {window}d
              </button>
            ))}
            <span className="row-meta">
              window of {report.windowDays} days
              {report.earliestRecordAt
                ? `, oldest record read ${report.earliestRecordAt.slice(0, 10)}`
                : ""}
            </span>
          </div>
          <RailLegend present={["measured", "bounded", "unknown"]} />

          <table className="data-table">
            <thead>
              <tr>
                <th>rule or topic</th>
                <th>what would show it</th>
                <th className="num-cell">times</th>
                <th className="num-cell">sessions</th>
                <th>last seen</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className={badge(row.bucket)}>
                      {row.bucket.replace(/-/g, " ")}
                    </span>{" "}
                    {row.topic}
                    {row.why && (
                      <div className="row-meta" style={{ marginTop: 4 }}>
                        {row.why}
                      </div>
                    )}
                  </td>
                  <td className="row-meta">
                    {row.match.length > 0 ? row.match.join(", ") : "nothing on disk"}
                  </td>
                  <td className="num-cell">{row.bucket === "not-observable" ? "-" : row.occurrences}</td>
                  <td className="num-cell">{row.bucket === "not-observable" ? "-" : row.sessions}</td>
                  <td className="row-meta">
                    {row.lastSeenAt ? row.lastSeenAt.slice(0, 10) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
