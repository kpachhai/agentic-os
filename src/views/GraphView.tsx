import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type GraphNode = {
  id: string;
  name: string;
  title: string;
  type: string;
  outbound: string[];
  inbound: string[];
  broken: string[];
  orphan: boolean;
  leaf: boolean;
};

type MemoryGraph = {
  nodes: GraphNode[];
  brokenLinks: Array<{ from: string; target: string }>;
  orphans: string[];
  leaves: string[];
  stats: {
    entries: number;
    links: number;
    brokenLinks: number;
    orphans: number;
    leaves: number;
    mostLinkedCount: number;
    mostLinked: string | null;
  };
};

type Lens = "linked" | "orphans" | "broken" | "leaves";

const LENSES: Array<{ key: Lens; label: string; hint: string }> = [
  { key: "linked", label: "most linked", hint: "notes others point at" },
  { key: "orphans", label: "orphans", hint: "nothing links here" },
  { key: "broken", label: "broken links", hint: "points at a note that does not exist" },
  { key: "leaves", label: "leaves", hint: "links to nothing" },
];

export function GraphView() {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [lens, setLens] = useState<Lens>("linked");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<MemoryGraph>("/api/graph")
      .then((data) => {
        setGraph(data);
        setError(null);
      })
      .catch(setError);
  }, []);

  const header = (
    <>
      <h1 className="view-title">
        Memory <span className="accent">Graph</span>
      </h1>
      <p className="view-sub">
        the link structure between your memory notes, and the faults in it - broken
        links, orphans, and dead ends
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
  if (!graph) {
    return (
      <div>
        {header}
        <Skeleton kind="tiles" count={3} label="reading memory notes..." />
      </div>
    );
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nameOf = (id: string): string => byId.get(id)?.name ?? id;

  const rows =
    lens === "linked"
      ? graph.nodes.filter((node) => node.inbound.length > 0)
      : lens === "orphans"
        ? graph.nodes.filter((node) => node.orphan)
        : lens === "broken"
          ? graph.nodes.filter((node) => node.broken.length > 0)
          : graph.nodes.filter((node) => node.leaf);

  return (
    <div>
      {header}

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="num">{graph.stats.entries}</div>
          <div className="row-meta">notes</div>
        </div>
        <div className="stat-tile">
          <div className="num">{graph.stats.links}</div>
          <div className="row-meta">links</div>
        </div>
        <div className="stat-tile bounded">
          <div className="num">{graph.stats.brokenLinks}</div>
          <div className="row-meta">broken</div>
        </div>
        <div className="stat-tile">
          <div className="num">{graph.stats.orphans}</div>
          <div className="row-meta">orphans</div>
        </div>
      </div>
      <RailLegend present={["measured", "bounded"]} />

      <div className="toolbar">
        {LENSES.map((option) => (
          <button
            key={option.key}
            className={`chip${lens === option.key ? " active" : ""}`}
            onClick={() => setLens(option.key)}
            title={option.hint}
          >
            {option.label}
          </button>
        ))}
        <span className="row-meta">
          {rows.length} note{rows.length === 1 ? "" : "s"} -{" "}
          {LENSES.find((l) => l.key === lens)!.hint}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          {lens === "broken"
            ? "no broken links - every reference resolves to a note that exists"
            : "nothing in this view"}
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>note</th>
              <th className="num-cell">in</th>
              <th className="num-cell">out</th>
              <th>{lens === "broken" ? "points at (missing)" : "links"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => (
              <tr key={node.id}>
                <td>
                  <div>{node.name}</div>
                  <div className="row-meta">{node.title}</div>
                </td>
                <td className="num-cell">{node.inbound.length}</td>
                <td className="num-cell">{node.outbound.length}</td>
                <td className="row-meta">
                  {lens === "broken"
                    ? node.broken.join(", ")
                    : lens === "orphans"
                      ? node.outbound.map(nameOf).join(", ") || "-"
                      : node.inbound.map(nameOf).join(", ") || "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="row-meta" style={{ marginTop: 16 }}>
        A broken link is a reference you believe exists and does not, which is why
        it is reported rather than silently dropped. Bash test syntax and POSIX
        character classes use the same double brackets and appear throughout notes
        that quote shell, so link targets are matched narrowly enough to exclude
        them - otherwise thousands of false positives would bury the real ones.
      </p>
    </div>
  );
}
