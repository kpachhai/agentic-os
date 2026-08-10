import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

type DiskCategory = {
  key: string;
  label: string;
  meaning: string;
  bytes: number;
  files: number;
  newestMtime: string | null;
  path: string;
  present: boolean;
};

type DiskReport = {
  categories: DiskCategory[];
  totalBytes: number;
  totalFiles: number;
  otherBytes: number;
  unreadableDirs: number;
  root: string;
  cleanupPeriodDays: number | null;
};

function size(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DiskView() {
  const [report, setReport] = useState<DiskReport | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<DiskReport>("/api/disk").then(setReport).catch(setError);
  }, []);

  const header = (
    <>
      <h1 className="view-title">
        Disk <span className="accent">Footprint</span>
      </h1>
      <p className="view-sub">
        what this install is keeping, and which of it grows without a bound
      </p>
    </>
  );

  if (error != null) {
    return (
      <div>
        {header}
        <FailureState error={error} />
      </div>
    );
  }
  if (report === null) {
    return (
      <div>
        {header}
        <Skeleton kind="rows" count={5} label="measuring the install..." />
      </div>
    );
  }

  const largest = report.categories[0];

  return (
    <div>
      {header}

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="num">{size(report.totalBytes)}</div>
          <div className="row-meta">on disk</div>
        </div>
        <div className="stat-tile">
          <div className="num">{report.totalFiles.toLocaleString("en-US")}</div>
          <div className="row-meta">files counted</div>
        </div>
        <div className="stat-tile">
          <div className="num">{largest ? size(largest.bytes) : "-"}</div>
          <div className="row-meta">largest: {largest?.label ?? "none"}</div>
        </div>
        {/* The bound on the biggest category, or its absence. An unbounded
            transcript tree is the finding, so a missing setting is amber. */}
        <div
          className={`stat-tile${report.cleanupPeriodDays === null ? " bounded" : ""}`}
        >
          <div className={`num${report.cleanupPeriodDays === null ? " accent" : ""}`}>
            {report.cleanupPeriodDays === null ? "unset" : `${report.cleanupPeriodDays}d`}
          </div>
          <div className="row-meta">transcript retention</div>
        </div>
      </div>

      <p className="row-meta" style={{ marginTop: -8, marginBottom: 14 }}>
        Byte counts are measured, not estimated - this pillar opens nothing and
        parses nothing. Symlinks are counted as the link and never followed, so a
        skill linked in from another checkout is not billed to this tree.
        {report.cleanupPeriodDays === null
          ? " No transcript retention is set here, so the largest category grows without a bound; cleanupPeriodDays in your settings is what caps it."
          : ` Transcripts older than ${report.cleanupPeriodDays} days are cleaned up, which is what bounds the largest category.`}
        {report.otherBytes > 0 &&
          ` ${size(report.otherBytes)} sits outside the categories below and is counted in the total rather than dropped.`}
        {report.unreadableDirs > 0 &&
          ` ${report.unreadableDirs} directory(ies) could not be read, so the total is a floor.`}
      </p>
      <RailLegend present={["measured", "bounded"]} />

      <table className="data-table">
        <thead>
          <tr>
            <th>category</th>
            <th className="num-cell">size</th>
            <th className="num-cell">files</th>
            <th>newest write</th>
          </tr>
        </thead>
        <tbody>
          {report.categories.map((category) => (
            <tr key={category.key}>
              <td>
                {category.label}
                {!category.present && <span className="badge info"> absent</span>}
                <div className="row-meta" style={{ marginTop: 4 }}>
                  {category.meaning}
                </div>
              </td>
              <td className="num-cell">{size(category.bytes)}</td>
              <td className="num-cell">{category.files.toLocaleString("en-US")}</td>
              <td className="row-meta">
                {category.newestMtime ? category.newestMtime.slice(0, 10) : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
