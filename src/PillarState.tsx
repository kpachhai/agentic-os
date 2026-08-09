import { SourceMissing } from "./api";

/**
 * What each pillar needs from its source, and how to get it. Shown when the
 * source is absent, so the page explains itself instead of showing a failure.
 *
 * Keyed by the pillar name the server puts in its 503 body, which is the only
 * identifier the client has to work with.
 */
const GUIDANCE: Record<string, { shows: string; configKey: string; how: string }> = {
  "memory notes": {
    shows: "the link structure between your memory notes, and the faults in it",
    configKey: "transcriptsDir",
    how: "Read from the memory directories Claude Code keeps beside each project's transcripts, so this appears once you have written a memory note.",
  },
  "prompt history": {
    shows: "every prompt you have typed, searchable, and the shape of your working day",
    configKey: "historyPath",
    how: "Written by Claude Code as you use it. This is the most sensitive file the panel reads, so it is read-only and excerpted.",
  },
  "workflow scripts": {
    shows: "the orchestration scripts Claude wrote to drive its own multi-agent runs",
    configKey: "workflowsDir",
    how: "Saved scripts live in the workflows directory; generated ones are found under the transcript tree, so either source is enough.",
  },
  "pacing log": {
    shows: "how much of your five-hour and seven-day rate-limit windows you have consumed",
    configKey: "pacingLogPath",
    how: "Absent by default, and that is the normal state. Rate-limit figures exist only in the payload Claude Code hands its statusline command, so capturing them needs a hook you install yourself; the Usage page prints the command.",
  },
  "claude config": {
    shows: "per-skill usage counters, the MCP server list, and where each plugin came from",
    configKey: "claudeConfigPath",
    how: "Created by Claude Code on first run.",
  },
  "claude settings": {
    shows: "your resolved settings, annotated by which file won each key",
    configKey: "claudeSettingsPath",
    how: "Optional. Absent means you have never customised settings, which is a real answer rather than a fault.",
  },
  "plugin manifest": {
    shows: "which plugins are installed, and which version of each is live",
    configKey: "pluginsDir",
    how: "Created by Claude Code when you install your first plugin.",
  },
  "file history": {
    shows: "every version Claude Code stored of a file it edited, including ones later reverted",
    configKey: "fileHistoryDir",
    how: "Written by Claude Code whenever it edits a file, so an absent directory means no edit has been recorded as this user yet.",
  },
  "subagent dispatches": {
    shows: "what work was handed to subagents, and what the delegated runs produced",
    configKey: "transcriptsDir",
    how: "Read out of the session transcripts, so this appears once Claude Code has recorded a session.",
  },
  "skill attribution": {
    shows: "when each skill was actually used, and which look safe to delete",
    configKey: "transcriptsDir",
    how: "Read out of the session transcripts, so this appears once Claude Code has recorded a session.",
  },
  "engram vault": {
    shows: "your captured notes, browsable and searchable",
    configKey: "engramVaultPath",
    how: "Point it at a directory of markdown notes with YAML frontmatter, holding a thoughts/ subdirectory.",
  },
  "friction log": {
    shows: "corrections paired with the resolutions that closed them",
    configKey: "frictionLogPath",
    how: "A single markdown file of dated entries. Create one and start appending, or point this at a log you already keep.",
  },
  "skill roots": {
    shows: "every skill on this machine, and the launcher",
    configKey: "skillRoots",
    how: "Install a skill or a plugin, or point this at wherever yours live.",
  },
  "wraps dir": {
    shows: "end-of-session retrospectives, newest first",
    configKey: "wrapsDir",
    how: "A directory of session_wrap_YYYY_MM_DD_<slug>.md files.",
  },
  "token-analyzer database": {
    shows: "long-run cost and token aggregates",
    configKey: "ctaDbPath",
    how: "Comes from a third-party token-analyzer plugin. The Sessions pillar derives token counts straight from your transcripts, so this one is an enhancement rather than a requirement.",
  },
  transcripts: {
    shows: "your sessions: titles, timelines, tokens, and tool use",
    configKey: "transcriptsDir",
    how: "Every Claude Code install writes these. If they are missing, either Claude Code has never run as this user, or cleanupPeriodDays has aged them out.",
  },
  "live sessions": {
    shows: "which repositories have a Claude session open right now",
    configKey: "liveSessionsDir",
    how: "Created by Claude Code the first time a session starts.",
  },
  "tasks dir": {
    shows: "work left unfinished by sessions that have ended",
    configKey: "tasksDir",
    how: "Created the first time a session uses the task tools.",
  },
};

/**
 * The panel for a source that is not there.
 *
 * Tone is the whole point. This is a first-run state, not a fault, so it names
 * what the pillar would show, the exact path that was probed, and the one config
 * key that fixes it. It never says "error".
 */
export function SourceMissingPanel({ error }: { error: SourceMissing }) {
  const guidance = GUIDANCE[error.pillar];
  return (
    <div className="not-configured">
      <div className="not-configured-head">
        <span className="badge info">not configured</span>
        <span className="row-meta">{error.pillar}</span>
      </div>
      <p className="not-configured-lead">
        {guidance
          ? `This pillar shows ${guidance.shows}. It needs a source that is not on this machine yet.`
          : "This pillar needs a source that is not on this machine yet."}
      </p>
      <div className="not-configured-path">
        <span className="row-meta">looked for</span>
        <code>{error.sourcePath}</code>
      </div>
      {guidance && (
        <>
          <p className="not-configured-how">{guidance.how}</p>
          <p className="row-meta">
            Set <code>{guidance.configKey}</code> in <code>config.json</code>, then
            restart. Run <code>npm run doctor</code> to see every source at once.
          </p>
        </>
      )}
    </div>
  );
}

/** A genuine failure: unreadable file, parse crash, locked database. */
export function ErrorPanel({ error }: { error: unknown }) {
  return <div className="error-state">{String(error)}</div>;
}

/**
 * Render whichever of the two a pillar hit. Every view routes its failures
 * through here so the distinction is made in one place and cannot drift between
 * pillars - the identical-degradation rule this tool holds itself to.
 */
export function FailureState({ error }: { error: unknown }) {
  if (error instanceof SourceMissing) return <SourceMissingPanel error={error} />;
  return <ErrorPanel error={error} />;
}

/** True when this failure means "not set up" rather than "broken". */
export function isSourceMissing(error: unknown): boolean {
  return error instanceof SourceMissing;
}

/**
 * Legend for the provenance rails.
 *
 * The rail on each readout is only useful if the reader knows what four colours
 * mean, and a colour system nobody can decode is decoration. Views that classify
 * their figures show this once, near the first group of readouts.
 *
 * Only the statuses actually present are listed: naming a status no figure on the
 * page carries would invite the reader to look for something that is not there.
 */
export function RailLegend({
  present,
}: {
  present: Array<"measured" | "derived" | "bounded" | "unknown">;
}) {
  const MEANING = {
    measured: "read off disk",
    derived: "computed from what was read",
    bounded: "a floor or a ceiling, not a count",
    unknown: "could not be established",
  } as const;
  const shown = [...new Set(present)];
  if (shown.length === 0) return null;
  return (
    <div className="rail-legend">
      {shown.map((status) => (
        <span key={status} className={`is-${status}`}>
          {status} - {MEANING[status]}
        </span>
      ))}
    </div>
  );
}

/**
 * A placeholder in the shape of the content that is coming.
 *
 * The thing it replaces was a line of centred grey text with no animation, which
 * made an honest wait read as a hang: the heaviest pillar here takes over a second
 * to answer and nothing on screen said work was happening. A skeleton says the
 * same "not yet" while also saying what will be there, and it moves.
 *
 * The wording stays. Each pillar's placeholder text names what it is reading, and
 * a transcript scan that takes a second deserves to say so rather than being
 * replaced by anonymous grey boxes.
 *
 * It lives here, beside the missing-source and error panels, for the reason those
 * do: waiting, unconfigured and broken are the three states every pillar has, and
 * keeping them in one module is what stops them drifting apart between pillars.
 */
export function Skeleton({
  kind,
  count = 3,
  label,
}: {
  /** Which layout to imitate: stat tiles, a list of rows, or a table. */
  kind: "tiles" | "rows" | "table";
  count?: number;
  /** What is being read, in the pillar's own words. */
  label?: string;
}) {
  const items = Array.from({ length: count }, (_, index) => index);
  return (
    // Announced as busy rather than as content, so a screen reader is told a wait
    // is in progress instead of reading out a row of empty boxes.
    <div className="skeleton" role="status" aria-busy="true">
      {label ? <span className="skeleton-label">{label}</span> : null}
      <div className={`skeleton-shapes is-${kind}`} aria-hidden="true">
        {items.map((index) => (
          <div key={index} className="skeleton-shape" />
        ))}
      </div>
    </div>
  );
}
