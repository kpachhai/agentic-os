import { useEffect, useState } from "react";
import { apiGet, useApi } from "../api";
import { FailureState, RailLegend, Skeleton, isSourceMissing } from "../PillarState";

/**
 * Claude Code's own versioned copies of every file it edited.
 *
 * Payload types are copied from the server module rather than imported, since the
 * UI never imports server code. Field meanings are taken from that module's own
 * comments; the ones that say what a total does NOT cover are rendered on screen
 * next to the total, which is the whole point of the pillar.
 */

type FileVersionEntry = {
  sessionId: string;
  version: number;
  sizeBytes: number;
  modifiedAt: string;
};

type SessionChain = {
  sessionId: string;
  versions: FileVersionEntry[];
  versionCount: number;
  firstVersion: number;
  highestVersion: number;
};

type PathStatus = "resolved" | "ambiguous" | "hash-too-short" | "no-match";

type VersionedFile = {
  hash: string;
  path: string;
  sessions: string[];
  chains: SessionChain[];
  versionCount: number;
  longestChainVersions: number;
  highestVersion: number;
  totalBytes: number;
  firstModifiedAt: string;
  lastModifiedAt: string;
};

type UnresolvedFile = {
  hash: string;
  pathStatus: Exclude<PathStatus, "resolved">;
  candidatePaths: number;
  sessions: string[];
  chains: SessionChain[];
  versionCount: number;
  longestChainVersions: number;
  highestVersion: number;
  totalBytes: number;
  firstModifiedAt: string;
  lastModifiedAt: string;
};

type FileHistorySkips = {
  unparsedNames: number;
  symlinkedEntries: number;
  nonFileEntries: number;
  vanishedEntries: number;
  symlinkedSessionDirs: number;
  unreadableSessionDirs: number;
  nonDirectoryRootEntries: number;
  unparsedTranscriptLines: number;
};

type HashAmbiguity = {
  hashChars: number;
  ambiguousHashes: number;
  pathsInvolved: number;
};

type UnresolvedBreakdown = Record<
  Exclude<PathStatus, "resolved">,
  { hashes: number; versions: number }
>;

type FileHistoryStats = {
  sessionDirs: number;
  totalVersions: number;
  skipped: FileHistorySkips;
  resolvedFiles: number;
  unresolvedHashes: number;
  unresolvedVersions: number;
  unresolvedByReason: UnresolvedBreakdown;
  filesWithMultipleVersions: number;
  chainsWithMultipleVersions: number;
  deepestChainVersions: number;
  highestVersionNumber: number;
  totalBytes: number;
  knownPaths: number;
  hashAmbiguities: HashAmbiguity[];
  transcriptsScanned: number;
};

type FileHistoryIndex = {
  files: VersionedFile[];
  unresolved: UnresolvedFile[];
  stats: FileHistoryStats;
  note: string;
};

type FileVersionText = {
  path: string | null;
  pathStatus: PathStatus;
  candidatePaths: number;
  unparsedTranscriptLines: number;
  hash: string;
  sessionId: string;
  version: number;
  text: string;
  sizeBytes: number;
  lines: number;
  modifiedAt: string;
};

type DiffLineKind = "context" | "add" | "remove";

type DiffLine = {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

type DiffStats = {
  added: number;
  removed: number;
  /** Null exactly when `minimal` is false: counting shared lines IS the refused work. */
  unchanged: number | null;
  contextLines: number;
  minimal: boolean;
};

type FileVersionDiff = {
  path: string | null;
  pathStatus: PathStatus;
  candidatePaths: number;
  unparsedTranscriptLines: number;
  hash: string;
  from: { sessionId: string; version: number; lines: number; sizeBytes: number };
  to: { sessionId: string; version: number; lines: number; sizeBytes: number };
  hunks: DiffHunk[];
  stats: DiffStats;
  changesNotShown: number;
  trailingNewlineChanged: boolean;
  truncated: boolean;
  truncationReason: string | null;
};

/**
 * One list row, resolved or not, so the detail pane has a single shape to render.
 *
 * An entry whose path could not be recovered is still a stored version, and the
 * pane has to be able to show it - dropping it would understate how much history
 * is on disk, which is the one number this pillar exists for.
 */
type Row = {
  hash: string;
  path: string | null;
  pathStatus: PathStatus;
  candidatePaths: number;
  sessions: string[];
  chains: SessionChain[];
  versionCount: number;
  longestChainVersions: number;
  highestVersion: number;
  totalBytes: number;
  firstModifiedAt: string;
  lastModifiedAt: string;
};

/**
 * Rows drawn at once before the list asks the reader to filter.
 *
 * A machine with hundreds of versioned files makes an unbounded list unreadable
 * and slow. The cap is a display choice and never a count, so the row beneath it
 * says how many rows exist rather than letting the shown number pass for the total.
 */
const MAX_ROWS = 60;

/** Absolute paths are long and the distinguishing part is at the end. */
function shortFile(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.length <= 3 ? fullPath : `.../${parts.slice(-3).join("/")}`;
}

/** A session id is a uuid; the leading block is enough to tell two apart on screen. */
function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function bytes(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} kB`;
  return `${value} B`;
}

function when(iso: string): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "unknown";
}

/** Why an entry has no path next to it, said the way the module means it. */
function statusExplanation(status: PathStatus, candidatePaths: number): string {
  if (status === "resolved") return "one known path hashes to this entry";
  if (status === "ambiguous") {
    return `${candidatePaths} distinct known paths share this truncated hash, so naming one of them would be a guess`;
  }
  if (status === "hash-too-short") {
    return "exactly one known path matches, but the hash is too narrow for that match to mean anything";
  }
  return (
    "no path recovered from the transcripts hashes to it. The recovered set is only the " +
    "paths a tool result named, so this means the path was never seen there, not that the " +
    "file never existed"
  );
}

function statusBadge(status: PathStatus): string {
  if (status === "resolved") return "badge success";
  if (status === "ambiguous") return "badge spark";
  return "badge info";
}

/** Skip counters in reading order, each with the refusal it stands for. */
const SKIP_LABELS: Array<[keyof FileHistorySkips, string]> = [
  ["unparsedNames", "names that are not <hash>@v<N>, so not counted as versions"],
  ["symlinkedEntries", "version entries that were symlinks, which are never followed"],
  ["nonFileEntries", "version-named entries that are not regular files"],
  ["vanishedEntries", "entries that disappeared between the directory read and the stat"],
  ["symlinkedSessionDirs", "session directories that were symlinks, so their versions are excluded"],
  ["unreadableSessionDirs", "session directories that could not be read at all"],
  ["nonDirectoryRootEntries", "names at the history root that are not directories"],
];

/** Emerald for added, red for removed, quiet for the lines that only give context. */
const LINE_COLOR: Record<DiffLineKind, string> = {
  add: "var(--success)",
  remove: "var(--warn)",
  context: "var(--text-sub)",
};

const LINE_MARK: Record<DiffLineKind, string> = { add: "+", remove: "-", context: " " };

function SkipSummary({ skipped }: { skipped: FileHistorySkips }) {
  const nonZero = SKIP_LABELS.filter(([key]) => skipped[key] > 0);
  // Unparsed transcript lines are deliberately not in the addable list. They are lines
  // of a different file entirely, and adding them to a count of stored versions would
  // be adding two unlike things.
  const transcriptLines = skipped.unparsedTranscriptLines;
  if (nonZero.length === 0 && transcriptLines === 0) {
    return (
      <p className="row-meta" style={{ marginTop: 8, lineHeight: 1.55 }}>
        Nothing was skipped: every name under the history root parsed as a version, every
        one was a regular file, no session directory was a symlink or unreadable, and every
        transcript line parsed. The count above is therefore the on-disk count.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      {transcriptLines > 0 && (
        <p className="row-meta" style={{ margin: "0 0 6px", lineHeight: 1.55 }}>
          <strong>{transcriptLines}</strong> transcript line(s) would not parse while
          recovering paths. That is a separate count from the versions below and is not added
          to the total: it bounds how many paths could be recovered, not how many versions
          are stored.
        </p>
      )}
      {nonZero.length > 0 && (
      <p className="row-meta" style={{ margin: "0 0 6px", lineHeight: 1.55 }}>
        These entries exist on disk and are not in the total above. Add them to it for the
        on-disk count.
      </p>
      )}
      {nonZero.map(([key, label]) => (
        <div className="row-meta" key={key} style={{ lineHeight: 1.6 }}>
          <strong>{skipped[key]}</strong> {label}
        </div>
      ))}
    </div>
  );
}

function UnresolvedSection({
  index,
  selectedHash,
  onSelect,
}: {
  index: FileHistoryIndex;
  selectedHash: string | null;
  onSelect: (row: Row) => void;
}) {
  const { unresolved, stats } = index;
  if (unresolved.length === 0) {
    return (
      <p className="row-meta" style={{ lineHeight: 1.55 }}>
        Every hash on this machine was matched back to a path, so no stored version is
        listed without a name.
      </p>
    );
  }
  return (
    <>
      <p className="row-meta" style={{ margin: "0 0 8px", lineHeight: 1.55 }}>
        {stats.unresolvedHashes} hash(es) covering {stats.unresolvedVersions} stored
        version(s) could not be given a path. These are real versions on disk; they are
        listed rather than dropped, because omitting them would understate how much
        unrecoverable history is here. By reason: {stats.unresolvedByReason.ambiguous.hashes}{" "}
        ambiguous, {stats.unresolvedByReason["hash-too-short"].hashes} hash too short,{" "}
        {stats.unresolvedByReason["no-match"].hashes} no match.
      </p>
      <table className="data-table" style={{ marginBottom: 14 }}>
        <thead>
          <tr>
            <th>hash</th>
            <th>why it has no path</th>
            <th className="num-cell">candidate paths</th>
            <th className="num-cell">versions</th>
            <th className="num-cell">sessions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {unresolved.map((entry) => (
            <tr key={entry.hash}>
              <td>
                <code>{entry.hash}</code>
              </td>
              <td>
                <span className={statusBadge(entry.pathStatus)}>{entry.pathStatus}</span>
                <div className="row-meta" style={{ marginTop: 4 }}>
                  {statusExplanation(entry.pathStatus, entry.candidatePaths)}
                </div>
              </td>
              <td className="num-cell">{entry.candidatePaths}</td>
              <td className="num-cell">{entry.versionCount}</td>
              <td className="num-cell">{entry.sessions.length}</td>
              <td>
                <button
                  onClick={() => onSelect({ ...entry, path: null })}
                  disabled={selectedHash === entry.hash}
                >
                  open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function DiffPanel({ diff }: { diff: FileVersionDiff }) {
  const { stats } = diff;
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="badge purple">diff</span>
        <span className="row-meta">
          v{diff.from.version} to v{diff.to.version} in session{" "}
          <span title={diff.from.sessionId}>{shortSession(diff.from.sessionId)}</span>
        </span>
        {/* The diff payload carries its own path claim, and it is stated here rather
            than left to the index card above: this panel is what a reader looks at
            while reading the change, and "which file is this" must not depend on
            what else happens to be on screen. */}
        <span className={statusBadge(diff.pathStatus)}>{diff.pathStatus}</span>
        {!stats.minimal && (
          <span
            className="badge ember"
            title="the comparison was capped, so added and removed are upper bounds rather than the real edit size"
          >
            counts are upper bounds
          </span>
        )}
      </div>

      <div className="stat-grid" style={{ marginTop: 12, marginBottom: 10 }}>
        <div className="stat-tile">
          <div className="num">+{stats.added}</div>
          <div className="row-meta">lines only in v{diff.to.version}</div>
        </div>
        <div className="stat-tile">
          <div className="num">-{stats.removed}</div>
          <div className="row-meta">lines only in v{diff.from.version}</div>
        </div>
        <div className="stat-tile">
          {stats.unchanged === null ? (
            <>
              <div className="num" style={{ fontSize: 16, color: "var(--text-sub)" }}>
                not computed
              </div>
              <div className="row-meta">lines the two share</div>
            </>
          ) : (
            <>
              <div className="num">{stats.unchanged}</div>
              <div className="row-meta">lines the two share</div>
            </>
          )}
        </div>
      </div>

      {stats.unchanged === null && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          Working out which lines the two versions share is exactly the comparison that was
          refused here, so there is no count to give. A number would be read as the answer,
          and the shared prefix and suffix alone would report two versions differing by one
          moved line as sharing nothing.
        </p>
      )}

      {diff.pathStatus !== "resolved" && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          This diff is addressed by hash, not by name:{" "}
          {statusExplanation(diff.pathStatus, diff.candidatePaths)}. The two versions are
          still the same entry compared against itself, so the change below is real - it is
          the file's identity that is unproven, not the edit.
        </p>
      )}

      <p className="row-meta" style={{ lineHeight: 1.55 }}>
        {diff.from.lines} lines to {diff.to.lines} lines; {bytes(diff.from.sizeBytes)} to{" "}
        {bytes(diff.to.sizeBytes)}.{" "}
        {stats.minimal
          ? "Added and removed count only lines present in one version and not the other."
          : "Because the comparison was capped, added and removed include lines the two " +
            "versions share: the differing middle is reported as one wholesale replacement " +
            "rather than line by line."}{" "}
        A further {stats.contextLines} unchanged line(s) appear inside the hunks to place each
        change in the file, and are never folded into those two counts.
      </p>

      {diff.changesNotShown > 0 && (
        <p className="row-meta" style={{ lineHeight: 1.55, color: "var(--warn)" }}>
          The hunks below stop short of {diff.changesNotShown} change line(s) this edit
          script holds. What you can read here is not the whole edit.
        </p>
      )}

      {diff.truncationReason !== null && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          Why it was capped: {diff.truncationReason}.
        </p>
      )}

      {diff.trailingNewlineChanged && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          One of these two versions ends in a newline and the other does not. That
          difference cannot appear in the hunks, which is why it is stated here.
        </p>
      )}

      {diff.unparsedTranscriptLines > 0 && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          {diff.unparsedTranscriptLines} transcript line(s) would not parse while looking up
          this hash's path, so the pool of known paths behind the name above is short by at
          most that many.
        </p>
      )}

      {diff.hunks.length === 0 ? (
        <div className="empty-state">
          the hunks are empty: these two versions have no differing lines
        </div>
      ) : (
        <div
          style={{
            border: "1px solid var(--steel-border)",
            background: "var(--surface-mid)",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            maxHeight: "44vh",
            overflow: "auto",
            marginTop: 8,
          }}
        >
          {diff.hunks.map((hunk, hunkIndex) => (
            <div key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
              <div
                style={{
                  padding: "5px 8px",
                  color: "var(--primary)",
                  borderTop: hunkIndex > 0 ? "1px solid var(--steel-border)" : undefined,
                  background: "var(--surface-dark)",
                }}
              >
                lines {hunk.oldStart}+{hunk.oldLines} in v{diff.from.version}, {hunk.newStart}
                +{hunk.newLines} in v{diff.to.version}
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={lineIndex}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "0 8px",
                    color: LINE_COLOR[line.kind],
                  }}
                >
                  <span
                    style={{
                      flex: "0 0 76px",
                      textAlign: "right",
                      color: "var(--text-sub)",
                      opacity: 0.55,
                    }}
                  >
                    {line.oldLine ?? "-"} / {line.newLine ?? "-"}
                  </span>
                  <span style={{ flex: "0 0 8px" }}>{LINE_MARK[line.kind]}</span>
                  <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionTextPanel({ version }: { version: FileVersionText }) {
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="badge purple">stored text</span>
        <span className="row-meta">
          v{version.version} in session{" "}
          <span title={version.sessionId}>{shortSession(version.sessionId)}</span>
        </span>
        <span className="row-meta">
          {version.lines} lines, {bytes(version.sizeBytes)}, written {when(version.modifiedAt)}
        </span>
      </div>
      <p className="row-meta" style={{ marginTop: 8, lineHeight: 1.55 }}>
        This is the file's verbatim content as of that version, read from disk unmodified
        and fetched only because you asked for this one entry. Listing the history never
        opens a version, so nothing above this line carries file contents.
      </p>
      {version.pathStatus !== "resolved" && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          No path is shown for it: {statusExplanation(version.pathStatus, version.candidatePaths)}.
        </p>
      )}
      {version.unparsedTranscriptLines > 0 && (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          {version.unparsedTranscriptLines} transcript line(s) would not parse during that
          lookup, which bounds how complete the pool of known paths was.
        </p>
      )}
      <pre style={{ maxHeight: "44vh", overflow: "auto", fontSize: 11.5 }}>{version.text}</pre>
    </div>
  );
}

function ChainCard({
  chain,
  fromVersion,
  toVersion,
  onFrom,
  onTo,
  onText,
}: {
  chain: SessionChain;
  fromVersion: number | null;
  toVersion: number | null;
  onFrom: (version: number) => void;
  onTo: (version: number) => void;
  onText: (version: number) => void;
}) {
  const widest = chain.versions.reduce((max, entry) => Math.max(max, entry.sizeBytes), 1);
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="badge purple">session {shortSession(chain.sessionId)}</span>
        <span className="row-meta" title={chain.sessionId}>
          {chain.versionCount} stored version(s), numbered v{chain.firstVersion} to v
          {chain.highestVersion}
        </span>
      </div>
      {chain.firstVersion > 1 && (
        <p className="row-meta" style={{ marginTop: 6, lineHeight: 1.55 }}>
          This chain begins at v{chain.firstVersion}, not v1. The earlier versions were
          either kept under a different session or never kept at all, so this is not the
          file's original state.
        </p>
      )}
      <table className="data-table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>version</th>
            <th className="num-cell">size</th>
            <th>written</th>
            <th style={{ width: "22%" }}>size against the chain</th>
            <th>compare</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {chain.versions.map((entry) => (
            <tr key={entry.version}>
              <td>v{entry.version}</td>
              <td className="num-cell">{bytes(entry.sizeBytes)}</td>
              <td className="row-meta">{when(entry.modifiedAt)}</td>
              <td>
                <div className="bar-cell">
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${(entry.sizeBytes / widest) * 100}%` }}
                    />
                  </div>
                </div>
              </td>
              <td>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className={`chip${fromVersion === entry.version ? " active" : ""}`}
                    onClick={() => onFrom(entry.version)}
                  >
                    older
                  </button>
                  <button
                    className={`chip${toVersion === entry.version ? " active" : ""}`}
                    onClick={() => onTo(entry.version)}
                  >
                    newer
                  </button>
                </div>
              </td>
              <td>
                <button className="chip" onClick={() => onText(entry.version)}>
                  read text
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FileHistoryView() {
  const { data: index, error } = useApi<FileHistoryIndex>("/api/file-history");
  const [filter, setFilter] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [fromVersion, setFromVersion] = useState<number | null>(null);
  const [toVersion, setToVersion] = useState<number | null>(null);
  const [diff, setDiff] = useState<FileVersionDiff | null>(null);
  const [diffProblem, setDiffProblem] = useState<string | null>(null);
  const [textVersion, setTextVersion] = useState<number | null>(null);
  const [text, setText] = useState<FileVersionText | null>(null);
  const [textProblem, setTextProblem] = useState<string | null>(null);


  // Both ends of a diff come from one chain, so both session ids are the active
  // one. Version numbers are scoped to a session, so a pair drawn from two
  // sessions would compare two unrelated pieces of content.
  useEffect(() => {
    if (selectedHash === null || activeSession === null) return;
    if (fromVersion === null || toVersion === null || fromVersion === toVersion) {
      setDiff(null);
      setDiffProblem(null);
      return;
    }
    const older = Math.min(fromVersion, toVersion);
    const newer = Math.max(fromVersion, toVersion);
    const query =
      `hash=${encodeURIComponent(selectedHash)}` +
      `&fromSession=${encodeURIComponent(activeSession)}&fromVersion=${older}` +
      `&toSession=${encodeURIComponent(activeSession)}&toVersion=${newer}`;
    let current = true;
    setDiff(null);
    setDiffProblem(null);
    apiGet<FileVersionDiff>(`/api/file-history/diff?${query}`)
      .then((res) => {
        if (current) setDiff(res);
      })
      .catch(() => {
        if (current) setDiffProblem("could not compare these two versions");
      });
    return () => {
      current = false;
    };
  }, [selectedHash, activeSession, fromVersion, toVersion]);

  // Version text is fetched for one named entry, only once the reader asks: it is
  // the file's contents verbatim, so nothing here prefetches it.
  useEffect(() => {
    if (selectedHash === null || activeSession === null || textVersion === null) {
      setText(null);
      setTextProblem(null);
      return;
    }
    const query =
      `sessionId=${encodeURIComponent(activeSession)}` +
      `&hash=${encodeURIComponent(selectedHash)}&version=${textVersion}`;
    let current = true;
    setText(null);
    setTextProblem(null);
    apiGet<FileVersionText>(`/api/file-history/version?${query}`)
      .then((res) => {
        if (current) setText(res);
      })
      .catch(() => {
        if (current) setTextProblem("could not read this stored version");
      });
    return () => {
      current = false;
    };
  }, [selectedHash, activeSession, textVersion]);

  const header = (
    <>
      <h1 className="view-title">
        File <span className="accent">History</span>
      </h1>
      <p className="view-sub">
        every intermediate copy claude code kept of a file it edited, including versions it
        later reverted or overwrote - git shows only what survived, and these never reached a
        commit, so this is the one place they can be read
      </p>
    </>
  );

  if (error) {
    return (
      <div>
        {header}
        <FailureState error={error} />
        {isSourceMissing(error) && (
          <p className="row-meta" style={{ marginTop: 12, lineHeight: 1.55, maxWidth: 720 }}>
            Claude Code writes this tree itself, so it appears the first time a session
            edits a file. <code>fileHistoryDir</code> in <code>config.json</code> is what
            points at it if yours lives somewhere other than the default.
          </p>
        )}
      </div>
    );
  }
  if (!index) {
    return (
      <div>
        {header}
        <Skeleton kind="tiles" count={4} label="scanning stored versions..." />
      </div>
    );
  }

  const { stats } = index;
  const rows: Row[] = index.files.map((file) => ({
    ...file,
    pathStatus: "resolved" as const,
    candidatePaths: 1,
  }));
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? rows.filter((row) => (row.path ?? row.hash).toLowerCase().includes(needle))
    : rows;
  const shown = matching.slice(0, MAX_ROWS);

  const selected: Row | null =
    selectedHash === null
      ? null
      : (rows.find((row) => row.hash === selectedHash) ??
        (() => {
          const entry = index.unresolved.find((item) => item.hash === selectedHash);
          return entry ? { ...entry, path: null } : null;
        })());
  const chain = selected?.chains.find((item) => item.sessionId === activeSession) ?? null;

  const select = (row: Row): void => {
    setSelectedHash(row.hash);
    const first = row.chains[0]!;
    setActiveSession(first.sessionId);
    setFromVersion(first.firstVersion);
    setToVersion(first.versionCount > 1 ? first.highestVersion : null);
    setTextVersion(null);
  };

  const switchChain = (next: SessionChain): void => {
    setActiveSession(next.sessionId);
    setFromVersion(next.firstVersion);
    setToVersion(next.versionCount > 1 ? next.highestVersion : null);
    setTextVersion(null);
  };

  return (
    <div>
      {header}

      <div className="stat-grid">
        <div className="stat-tile bounded">
          <div className="num">{stats.totalVersions}</div>
          <div className="row-meta">stored versions parsed</div>
        </div>
        <div className="stat-tile">
          <div className="num">{stats.resolvedFiles}</div>
          <div className="row-meta">files given a path</div>
        </div>
        <div className="stat-tile">
          <div className="num">{stats.deepestChainVersions}</div>
          <div className="row-meta">versions in the deepest chain</div>
        </div>
        <div className="stat-tile derived">
          <div className="num">{bytes(stats.totalBytes)}</div>
          <div className="row-meta">of past file states</div>
        </div>
      </div>
      <RailLegend present={["measured", "derived", "bounded"]} />

      <p className="row-meta" style={{ marginTop: -8, lineHeight: 1.55 }}>
        Across {stats.sessionDirs} session directories. {stats.filesWithMultipleVersions} of
        the named files hold more than one stored version; {stats.chainsWithMultipleVersions}{" "}
        per-session chains hold more than one version, counted over every hash on disk rather
        than only the named ones. The deepest single chain holds{" "}
        {stats.deepestChainVersions} versions while the highest version number seen anywhere
        is v{stats.highestVersionNumber}; those differ because a chain does not have to begin
        at v1.
      </p>

      <h3 style={{ marginTop: 22 }}>What this total does not cover</h3>
      <p className="row-meta" style={{ lineHeight: 1.55 }}>
        {stats.totalVersions} counts the entries the scan parsed, which is not the same as
        every name on disk.
      </p>
      <SkipSummary skipped={stats.skipped} />

      <p className="row-meta" style={{ marginTop: 12, lineHeight: 1.55 }}>
        Nothing on disk records which file a stored version belongs to; the name is only a
        truncated digest of the path. Paths are recovered by hashing the {stats.knownPaths}{" "}
        distinct absolute paths found in {stats.transcriptsScanned} transcripts and matching
        the digest, so the pool is only ever as complete as those transcripts. An entry can
        be a real stored version and still have no name here.
      </p>
      {stats.hashAmbiguities.length === 0 ? (
        <p className="row-meta" style={{ lineHeight: 1.55 }}>
          No truncated hash in that pool is shared by two different paths, so no name above
          rests on picking between candidates.
        </p>
      ) : (
        <div style={{ marginTop: 4 }}>
          {stats.hashAmbiguities.map((row) => (
            <div className="row-meta" key={row.hashChars} style={{ lineHeight: 1.6 }}>
              At {row.hashChars} hex characters, <strong>{row.ambiguousHashes}</strong> hash(es)
              are shared by {row.pathsInvolved} known paths between them. None of those
              hashes is resolved to any of its candidates.
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 22 }}>Versions with no name</h3>
      <UnresolvedSection index={index} selectedHash={selectedHash} onSelect={select} />

      <h3 style={{ marginTop: 22 }}>Most-versioned files</h3>
      <div className="toolbar">
        <input
          type="search"
          placeholder="filter by path"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          style={{ minWidth: 260 }}
        />
        <span className="row-meta">
          {matching.length === rows.length
            ? `${rows.length} named files`
            : `${matching.length} of ${rows.length} named files match`}
          {shown.length < matching.length &&
            `; the first ${shown.length} are drawn, so filter to reach the rest`}
        </span>
      </div>

      <div className="split">
        <div>
          {shown.length === 0 ? (
            <div className="empty-state">no named file matches that filter</div>
          ) : (
            shown.map((row) => (
              <div
                className={`card list-row${selectedHash === row.hash ? " selected" : ""}`}
                key={row.hash}
                onClick={() => select(row)}
              >
                <div style={{ color: "var(--text)" }} title={row.path ?? row.hash}>
                  {row.path === null ? row.hash : shortFile(row.path)}
                </div>
                <div className="row-meta" style={{ marginTop: 5 }}>
                  {row.versionCount} stored version(s) over {row.sessions.length} session(s);
                  deepest chain {row.longestChainVersions}, highest number v
                  {row.highestVersion}
                </div>
                <div className="row-meta" style={{ marginTop: 4 }}>
                  {bytes(row.totalBytes)} - {when(row.firstModifiedAt)} to{" "}
                  {when(row.lastModifiedAt)}
                </div>
                <div className="row-meta" style={{ marginTop: 4 }}>
                  {row.sessions.slice(0, 4).map((sessionId) => (
                    <span key={sessionId} title={sessionId} style={{ marginRight: 8 }}>
                      {shortSession(sessionId)}
                    </span>
                  ))}
                  {row.sessions.length > 4 && `and ${row.sessions.length - 4} more`}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="detail-pane">
          {selected === null ? (
            <div className="empty-state">
              select a file to read its version chain, and any two of its versions against
              each other
            </div>
          ) : (
            <>
              <div className="card">
                <div style={{ color: "var(--text)", wordBreak: "break-all" }}>
                  {selected.path ?? `no path recovered for ${selected.hash}`}
                </div>
                <div className="row-meta" style={{ marginTop: 6 }}>
                  <span className={statusBadge(selected.pathStatus)}>
                    {selected.pathStatus}
                  </span>{" "}
                  {statusExplanation(selected.pathStatus, selected.candidatePaths)}. Entry
                  name digest <code>{selected.hash}</code>.
                </div>
                <p className="row-meta" style={{ marginTop: 8, lineHeight: 1.55 }}>
                  {selected.versionCount} stored version(s) in total, the deepest single
                  chain holding {selected.longestChainVersions}, and v{selected.highestVersion}{" "}
                  the highest number used. The three are different questions: versions in two
                  sessions outnumber either chain, and a chain starting at v2 has a highest
                  number one above its own length.
                </p>
                {selected.chains.length > 1 && (
                  <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
                    {selected.chains.map((item) => (
                      <button
                        key={item.sessionId}
                        className={`chip${item.sessionId === activeSession ? " active" : ""}`}
                        title={item.sessionId}
                        onClick={() => switchChain(item)}
                      >
                        {shortSession(item.sessionId)} ({item.versionCount})
                      </button>
                    ))}
                  </div>
                )}
                {selected.chains.length > 1 && (
                  <p className="row-meta" style={{ marginTop: 8, lineHeight: 1.55 }}>
                    This file was versioned in {selected.chains.length} sessions, and each
                    session numbers its own versions from scratch. The same v2 under two of
                    them is two different pieces of content, so a comparison is only offered
                    within one session's chain.
                  </p>
                )}
              </div>

              {chain && (
                <ChainCard
                  chain={chain}
                  fromVersion={fromVersion}
                  toVersion={toVersion}
                  onFrom={setFromVersion}
                  onTo={setToVersion}
                  onText={setTextVersion}
                />
              )}

              {diffProblem !== null ? (
                <div className="error-state">{diffProblem}</div>
              ) : diff !== null ? (
                <DiffPanel diff={diff} />
              ) : fromVersion !== null && toVersion !== null && fromVersion !== toVersion ? (
                <Skeleton kind="table" count={8} label="comparing two stored versions..." />
              ) : (
                <div className="empty-state">
                  pick an older and a newer version in this chain to compare them
                </div>
              )}

              {textProblem !== null ? (
                <div className="error-state">{textProblem}</div>
              ) : text !== null ? (
                <VersionTextPanel version={text} />
              ) : textVersion !== null ? (
                <Skeleton kind="table" count={8} label="reading one stored version..." />
              ) : null}
            </>
          )}
        </div>
      </div>

      <p className="row-meta" style={{ marginTop: 16, lineHeight: 1.55 }}>
        A stored version is the file's contents as they were, read from disk unmodified and
        never edited by this tool. Listing the history stats entries without opening any, and
        text is fetched one named version at a time only when you ask for it, so a config or
        dotfile Claude once edited is not put on screen by browsing. {index.note}
      </p>
    </div>
  );
}
