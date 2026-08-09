import { useEffect, useState } from "react";
import { renderMarkdown } from "../markdown";
import { apiGet } from "../api";
import { FailureState, Skeleton } from "../PillarState";
import { DigestPanel } from "../DigestPanel";

type ThoughtSummary = {
  id: string;
  title: string;
  type: string;
  timestamp: string;
  snippet: string;
};

type ThoughtFull = ThoughtSummary & {
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
};

const PAGE_SIZE = 50;

function badgeClass(type: string): string {
  const t = type.toLowerCase();
  if (t === "friction") return "badge warn";
  if (t === "resolution") return "badge success";
  if (t === "decision" || t === "pattern") return "badge purple";
  return "badge info";
}

export function EngramView() {
  const [thoughts, setThoughts] = useState<ThoughtSummary[] | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ThoughtFull | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<string[]>("/api/engram/types").then(setTypes).catch(() => {});
  }, []);

  useEffect(() => {
    setThoughts(null);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    apiGet<ThoughtSummary[]>(`/api/engram/thoughts?${params}`)
      .then((rows) => {
        setThoughts(rows);
        setError(null);
      })
      .catch(setError);
  }, [q, type, offset]);

  function open(id: string) {
    apiGet<ThoughtFull>(`/api/engram/thoughts/${encodeURIComponent(id)}`)
      .then(setSelected)
      .catch(setError);
  }

  return (
    <div>
      <h1 className="view-title">
        engram <span className="accent">Memory</span>
      </h1>
      <p className="view-sub">
        markdown vault, read directly - no daemon, no MCP
      </p>

      <div className="toolbar">
        <input
          type="search"
          placeholder="keyword search (title + body)"
          value={q}
          onChange={(e) => {
            setOffset(0);
            setQ(e.target.value);
          }}
          style={{ width: 280 }}
        />
        <select
          value={type}
          onChange={(e) => {
            setOffset(0);
            setType(e.target.value);
          }}
        >
          <option value="">all types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          prev
        </button>
        <button
          disabled={!thoughts || thoughts.length < PAGE_SIZE}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          next
        </button>
        <span className="row-meta">offset {offset}</span>
      </div>

      {error != null && <FailureState error={error} />}

      <div className="split">
        <div>
          {thoughts === null && !error && (
            <Skeleton kind="rows" count={6} label="loading thoughts..." />
          )}
          {thoughts !== null && thoughts.length === 0 && (
            <div className="empty-state">
              no thoughts match this query - adjust the search or filter
            </div>
          )}
          {thoughts?.map((t) => (
            <div
              key={t.id}
              className={`card list-row${selected?.id === t.id ? " selected" : ""}`}
              onClick={() => open(t.id)}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className={badgeClass(t.type)}>{t.type}</span>
                <span className="row-meta">{t.timestamp.slice(0, 10)}</span>
              </div>
              <div
                style={{ color: "var(--text)", fontWeight: 600, margin: "6px 0 4px" }}
              >
                {t.title}
              </div>
              <div className="row-meta" style={{ fontFamily: "var(--font-ui)" }}>
                {t.snippet.slice(0, 140)}
                {t.snippet.length >= 140 ? "..." : ""}
              </div>
            </div>
          ))}
        </div>

        <div className="detail-pane">
          {selected ? (
            <div className="card">
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className={badgeClass(selected.type)}>{selected.type}</span>
                <span className="row-meta">{selected.timestamp}</span>
              </div>
              <h2 style={{ fontSize: 16 }}>{selected.title}</h2>
              {/* Above the body on purpose: the digest is meant to be read first,
                  and it sits next to the source so the two can be compared. */}
              <DigestPanel kind="thought" id={selected.id} />
              <div
                className="md-body"
                // Sanitized via DOMPurify in renderMarkdown.
                dangerouslySetInnerHTML={{ __html: renderMarkdown(selected.body) }}
              />
              <div className="row-meta" style={{ marginTop: 12 }}>
                {selected.path}
              </div>
            </div>
          ) : (
            <div className="empty-state">select a thought to inspect</div>
          )}
        </div>
      </div>
    </div>
  );
}
