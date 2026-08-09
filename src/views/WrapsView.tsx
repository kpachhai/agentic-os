import { useEffect, useState } from "react";
import { renderMarkdown } from "../markdown";
import { apiGet } from "../api";
import { FailureState, Skeleton } from "../PillarState";
import { DigestPanel } from "../DigestPanel";

type WrapSummary = {
  id: string;
  date: string;
  title: string;
  description: string;
  path: string;
};

type WrapFull = WrapSummary & {
  frontmatter: Record<string, unknown>;
  body: string;
  sections: Partial<Record<"shipped" | "learned" | "friction" | "parked", string>>;
};

export function WrapsView() {
  const [wraps, setWraps] = useState<WrapSummary[] | null>(null);
  const [selected, setSelected] = useState<WrapFull | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<WrapSummary[]>("/api/wraps")
      .then((rows) => {
        setWraps(rows);
        setError(null);
      })
      .catch(setError);
  }, []);

  function open(id: string) {
    apiGet<WrapFull>(`/api/wraps/${encodeURIComponent(id)}`)
      .then(setSelected)
      .catch(setError);
  }

  return (
    <div>
      <h1 className="view-title">
        Session <span className="accent">Wraps</span>
      </h1>
      <p className="view-sub">what shipped, when - newest first</p>

      {error != null && <FailureState error={error} />}
      {wraps === null && !error && <Skeleton kind="rows" count={5} label="loading wraps..." />}
      {wraps !== null && wraps.length === 0 && (
        <div className="empty-state">no session wraps found in the memory dir</div>
      )}

      <div className="split">
        <div>
          {wraps?.map((w) => (
            <div
              key={w.id}
              className={`card list-row${selected?.id === w.id ? " selected" : ""}`}
              onClick={() => open(w.id)}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className="badge purple">{w.date}</span>
              </div>
              <div style={{ color: "var(--text)", fontWeight: 600, margin: "6px 0 4px" }}>
                {w.title}
              </div>
              <div className="row-meta" style={{ fontFamily: "var(--font-ui)" }}>
                {w.description.slice(0, 160)}
                {w.description.length > 160 ? "..." : ""}
              </div>
            </div>
          ))}
        </div>

        <div className="detail-pane">
          {selected ? (
            <div className="card">
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span className="badge purple">{selected.date}</span>
                {Object.keys(selected.sections).map((k) => (
                  <span
                    key={k}
                    className={`badge ${k === "friction" ? "warn" : k === "shipped" ? "success" : "info"}`}
                  >
                    {k}
                  </span>
                ))}
              </div>
              <h2 style={{ fontSize: 16 }}>{selected.title}</h2>
              {/* Above the body on purpose: the digest is meant to be read first,
                  and it sits next to the source so the two can be compared. */}
              <DigestPanel kind="wrap" id={selected.id} />
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
            <div className="empty-state">select a wrap to read it</div>
          )}
        </div>
      </div>
    </div>
  );
}
