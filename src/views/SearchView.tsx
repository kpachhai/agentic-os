import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api";
import { FailureState, Skeleton } from "../PillarState";

type Kind = "session" | "thought" | "friction" | "wrap";

type SearchHit = {
  id: number;
  kind: Kind;
  ref: string;
  locator: string;
  title: string;
  timestamp: string;
  score: number;
  excerpt: string;
};

type IndexStats = {
  path: string;
  exists: boolean;
  sizeBytes: number;
  documents: number;
  byKind: Record<string, number>;
  files: number;
  lastSyncedAt: string | null;
};

type SyncReport = {
  filesScanned: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  documents: number;
  elapsedMs: number;
  /** Sources this sync could not read; their documents were kept, not removed. */
  sourcesUnreadable: Array<{ kind: string; path: string }>;
};

const KINDS: Array<{ key: Kind | "all"; label: string }> = [
  { key: "all", label: "everything" },
  { key: "session", label: "sessions" },
  { key: "thought", label: "memory" },
  { key: "friction", label: "friction" },
  { key: "wrap", label: "wraps" },
];

function kindBadge(kind: Kind): string {
  if (kind === "session") return "badge info";
  if (kind === "thought") return "badge purple";
  if (kind === "friction") return "badge warn";
  return "badge success";
}

/**
 * Render an excerpt with the matched terms marked.
 *
 * The index brackets each match rather than returning HTML, so this splits on
 * those brackets and emits elements. Nothing from the source is ever interpreted
 * as markup: the excerpt is the operator's own text and arrives here as a string.
 */
function Excerpt({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <span className="digest-text">
      {parts.map((part, index) =>
        part.startsWith("[") && part.endsWith("]") ? (
          <mark key={index} className="hit-mark">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

/** Where clicking a hit should take the reader, given how each pillar addresses records. */
function hitHref(hit: SearchHit): string {
  if (hit.kind === "session") return "#/sessions";
  if (hit.kind === "thought") return "#/engram";
  if (hit.kind === "friction") return "#/friction";
  return "#/wraps";
}

export function SearchView() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  const loadStats = (): void => {
    apiGet<IndexStats>("/api/index/stats").then(setStats).catch(setError);
  };

  useEffect(loadStats, []);

  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const params = new URLSearchParams({ q: query, limit: "40" });
    if (kind !== "all") params.set("kind", kind);
    // Debounced so typing does not fire a query per keystroke; the index answers
    // in milliseconds, but the request itself is still worth not spamming.
    const timer = window.setTimeout(() => {
      apiGet<{ hits: SearchHit[] }>(`/api/search?${params}`)
        .then((res) => {
          setHits(res.hits);
          setError(null);
        })
        .catch(setError);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, kind]);

  const sync = (): void => {
    setSyncing(true);
    apiPost<SyncReport>("/api/index/sync", {})
      .then((report) => {
        setLastSync(report);
        loadStats();
      })
      .catch(setError)
      .finally(() => setSyncing(false));
  };

  const header = (
    <>
      <h1 className="view-title">
        Search <span className="accent">Everything</span>
      </h1>
      <p className="view-sub">
        one query across sessions, memory, friction and wraps, from a cache you can
        delete at any time
      </p>
    </>
  );

  if (error) {
    return (
      <div>
        {header}
        <FailureState error={error} />
      </div>
    );
  }

  return (
    <div>
      {header}

      <div className="toolbar">
        <input
          type="search"
          placeholder="search every pillar at once"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 380 }}
          autoFocus
        />
        {KINDS.map((option) => (
          <button
            key={option.key}
            className={`chip${kind === option.key ? " active" : ""}`}
            onClick={() => setKind(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {stats && (
        <p className="row-meta" style={{ marginBottom: 16 }}>
          {stats.documents} documents from {stats.files} files
          {stats.sizeBytes > 0 &&
            `, ${(stats.sizeBytes / 1048576).toFixed(1)} MB on disk`}
          {stats.lastSyncedAt && ` - last synced ${stats.lastSyncedAt.slice(0, 16).replace("T", " ")}`}
          {". "}
          <button className="chip" onClick={sync} disabled={syncing}>
            {syncing ? "syncing..." : "sync index"}
          </button>
          {lastSync && (
            <>
              {" "}
              indexed {lastSync.filesIndexed}, unchanged {lastSync.filesUnchanged}
              {lastSync.filesRemoved > 0 && `, removed ${lastSync.filesRemoved}`} in{" "}
              {lastSync.elapsedMs}ms
            </>
          )}
        </p>
      )}

      {lastSync && lastSync.sourcesUnreadable.length > 0 && (
        <div className="empty-state" style={{ marginBottom: 16 }}>
          {lastSync.sourcesUnreadable.length === 1 ? "one source was" : "these sources were"}{" "}
          not read this sync, so what was already indexed from{" "}
          {lastSync.sourcesUnreadable.length === 1 ? "it" : "them"} was kept rather
          than removed:{" "}
          {lastSync.sourcesUnreadable
            .map((source) => `${source.kind} (${source.path})`)
            .join(", ")}
        </div>
      )}

      {stats && stats.documents === 0 && (
        <div className="empty-state">
          the index is empty - run a sync to build it from whatever sources this
          machine has
        </div>
      )}

      {query.trim() && hits === null && <Skeleton kind="rows" count={4} label="searching..." />}
      {hits !== null && hits.length === 0 && (
        <div className="empty-state">
          nothing matches every one of those words
        </div>
      )}

      {hits?.map((hit) => (
        <a
          className="card list-row"
          key={`${hit.kind}-${hit.id}`}
          href={hitHref(hit)}
          style={{ display: "block", textDecoration: "none" }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className={kindBadge(hit.kind)}>{hit.kind}</span>
            {hit.timestamp && (
              <span className="row-meta">{hit.timestamp.slice(0, 10)}</span>
            )}
          </div>
          <div style={{ margin: "7px 0 0", color: "var(--text)", lineHeight: 1.45 }}>
            {hit.title}
          </div>
          {hit.excerpt && (
            <div style={{ marginTop: 5 }}>
              <Excerpt text={hit.excerpt} />
            </div>
          )}
        </a>
      ))}

      {hits !== null && hits.length > 0 && (
        <p className="row-meta" style={{ marginTop: 14 }}>
          Every word must match, so adding a word narrows rather than widens.
          Session text covers your own prompts and the session title, not replies:
          indexing replies would grow this cache to the size of the corpus it
          summarises.
        </p>
      )}
    </div>
  );
}
