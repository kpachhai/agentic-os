import { useEffect, useState } from "react";
import { apiGet, apiPost, SourceMissing } from "./api";

type Provenance = "verbatim" | "selected" | "paraphrase";

type DigestLine = {
  text: string;
  provenance: Provenance;
  sourceIndex: number | null;
  sourceText: string | null;
};

type Digest = {
  label: string;
  lines: DigestLine[];
  keywords: string[];
  grade: number;
  sentenceCount: number;
  tiers: string[];
  model?: string | null;
};

/**
 * What each provenance is allowed to claim, in the reader's language rather than
 * the field's.
 *
 * This mapping is the whole feature. A digest that does not say which of these it
 * is would leave the operator unable to tell their own writing from a machine's
 * summary of it, which is worse than showing no digest at all.
 */
const PROVENANCE: Record<Provenance, { badge: string; label: string; title: string }> = {
  verbatim: {
    badge: "badge info",
    label: "your words",
    title: "Reproduced exactly from the record; nothing was rewritten.",
  },
  selected: {
    badge: "badge purple",
    label: "selected",
    title:
      "One of your own sentences, chosen by ranking the document. Selected, never rewritten.",
  },
  paraphrase: {
    badge: "badge spark",
    label: "machine paraphrase",
    title:
      "Written by a model running on this machine, from the lines above. Not your wording; check it against them.",
  },
};

/**
 * A plain-language digest of one record.
 *
 * Two tiers always work and need nothing installed: the record's own summary
 * field, then its own most central sentences. A local model, if one is already
 * listening on loopback, can add a paraphrase on request - never automatically,
 * because on a CPU-only machine it costs seconds per record.
 */
export function DigestPanel({ kind, id }: { kind: "thought" | "wrap"; id: string }) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [paraphrasing, setParaphrasing] = useState(false);
  const [paraphraseNote, setParaphraseNote] = useState<string | null>(null);

  useEffect(() => {
    setDigest(null);
    setError(null);
    setParaphraseNote(null);
    apiGet<Digest>(`/api/digest/${kind}/${encodeURIComponent(id)}`)
      .then(setDigest)
      .catch(setError);
  }, [kind, id]);

  useEffect(() => {
    apiGet<{ state: string }>("/api/digest/model")
      .then((state) => setModelReady(state.state === "ready"))
      .catch(() => setModelReady(false));
  }, []);

  const requestParaphrase = (): void => {
    setParaphrasing(true);
    setParaphraseNote(null);
    apiPost<Digest>(`/api/digest/${kind}/${encodeURIComponent(id)}/paraphrase`, {})
      .then(setDigest)
      .catch((err) => {
        // An absent model runner is reported as a missing source, so it reads the
        // same way any unconfigured source does rather than as a failure.
        setParaphraseNote(
          err instanceof SourceMissing
            ? "No local model is running, so there is nothing to rewrite with. " +
                "Start one on loopback and try again; nothing is downloaded for you."
            : String(err),
        );
      })
      .finally(() => setParaphrasing(false));
  };

  if (error) {
    return <div className="row-meta">no digest available for this record</div>;
  }
  if (!digest) return <div className="row-meta">building digest...</div>;
  if (digest.lines.length === 0) {
    return <div className="row-meta">this record has no prose to digest</div>;
  }

  const hasParaphrase = digest.lines.some((l) => l.provenance === "paraphrase");

  return (
    <div className="digest">
      <div className="digest-head">
        <span className="row-meta">in short</span>
        {digest.keywords.slice(0, 4).map((keyword) => (
          <span className="chip static" key={keyword}>
            {keyword}
          </span>
        ))}
      </div>

      {digest.lines.map((line, index) => {
        const meta = PROVENANCE[line.provenance];
        return (
          <div className="digest-line" key={`${line.provenance}-${index}`}>
            <span className={meta.badge} title={meta.title}>
              {meta.label}
            </span>
            <span className="digest-text">{line.text}</span>
          </div>
        );
      })}

      <div className="digest-foot">
        <span className="row-meta">
          reading grade {digest.grade.toFixed(1)} &middot; {digest.sentenceCount}{" "}
          sentences in the source
        </span>
        {!hasParaphrase && modelReady && (
          <button className="chip" onClick={requestParaphrase} disabled={paraphrasing}>
            {paraphrasing ? "rewriting locally..." : "rewrite in plainer language"}
          </button>
        )}
        {!hasParaphrase && modelReady === false && (
          <span
            className="row-meta"
            title="Plain-language rewriting needs a model server already listening on loopback. This tool starts nothing and downloads nothing."
          >
            no local model running
          </span>
        )}
        {hasParaphrase && digest.model && (
          <span className="row-meta">rewritten by {digest.model} on this machine</span>
        )}
      </div>

      {paraphraseNote && <div className="row-meta">{paraphraseNote}</div>}
    </div>
  );
}
