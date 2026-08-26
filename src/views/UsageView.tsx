import { useEffect, useState } from "react";
import { apiGet, SourceMissing } from "../api";
import { compact } from "../format";
import { FailureState, Skeleton } from "../PillarState";

type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

type UsageBlock = {
  startedAt: string;
  endedAt: string;
  tokens: TokenTotals;
  sessions: number;
  turns: number;
  costUsd: number | null;
  models: string[];
};

type CostBreakdown = {
  model: string;
  /** Null when the model is not in the table; never zero. */
  totalUsd: number | null;
  inputUsd: number | null;
  outputUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  priced: boolean;
  note: string | null;
};

type CostTotals = {
  totalUsd: number;
  unpricedModels: string[];
  unpricedTokens: number;
  perModel: CostBreakdown[];
  asOf: string;
};

type BlocksResponse = {
  blocks: UsageBlock[];
  totals: CostTotals;
  pricing: {
    asOf: string;
    ageDays: number;
    shelfLifeDays: number;
    stale: boolean;
    models: string[];
  };
  note: string;
};

function usd(value: number | null): string {
  if (value === null) return "not priced";
  if (value === 0) return "$0";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

type RateWindow = {
  usedPercent: number;
  resetsAt: string;
  resetsInMs: number;
};

type PacingSample = {
  capturedAt: string;
  sessionId: string;
  model: string;
  cwd: string;
  sessionCostUsd: number | null;
  contextUsedPercent: number | null;
  effortLevel: string | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
};

type Pacing = {
  current: PacingSample | null;
  samples: PacingSample[];
  totalSamples: number;
  samplesWithoutLimits: number;
  note: string;
};

type Setup = { statusLineCommand: string; explanation: string };

function untilReset(ms: number): string {
  if (ms <= 0) return "reset passed";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m left`;
}

/** A window meter. Ember past this share, since that is where pacing matters. */
const PRESSURE_PERCENT = 75;

function WindowMeter({ label, window: rateWindow }: { label: string; window: RateWindow }) {
  const pressured = rateWindow.usedPercent >= PRESSURE_PERCENT;
  return (
    <div className="stat-tile">
      <div className={`num${pressured ? " accent" : ""}`}>
        {rateWindow.usedPercent.toFixed(0)}%
      </div>
      <div className="row-meta">{label}</div>
      <div className="bar-cell" style={{ marginTop: 8 }}>
        <div className="bar-track">
          <div
            className={`bar-fill${pressured ? " warn" : ""}`}
            style={{ width: `${Math.min(rateWindow.usedPercent, 100)}%` }}
          />
        </div>
      </div>
      <div className="row-meta" style={{ marginTop: 4 }}>
        {untilReset(rateWindow.resetsInMs)}
      </div>
    </div>
  );
}

export function UsageView() {
  const [blocks, setBlocks] = useState<BlocksResponse | null>(null);
  const [pacing, setPacing] = useState<Pacing | null>(null);
  const [pacingMissing, setPacingMissing] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<BlocksResponse>("/api/blocks?limit=40").then(setBlocks).catch(setError);
    apiGet<Pacing>("/api/pacing")
      .then(setPacing)
      .catch((err) => {
        // Pacing needs a hook the operator installs, so its absence is the default
        // state rather than a fault, and it must not take the blocks half down.
        if (err instanceof SourceMissing) setPacingMissing(true);
        else setPacing(null);
      });
    apiGet<Setup>("/api/pacing/setup").then(setSetup).catch(() => setSetup(null));
  }, []);

  const header = (
    <>
      <h1 className="view-title">
        Usage <span className="accent">and Pacing</span>
      </h1>
      <p className="view-sub">
        five-hour windows, priced from a table vendored into this repo - the same
        unit your subscription limits are expressed in
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

  const widest = blocks?.blocks.reduce(
    (max, block) => Math.max(max, block.tokens.cacheRead + block.tokens.output),
    1,
  ) ?? 1;

  return (
    <div>
      {header}

      <h3>Rate-limit windows</h3>
      {pacingMissing ? (
        <div className="not-configured">
          <div className="not-configured-head">
            <span className="badge info">not configured</span>
            <span className="row-meta">rate-limit capture</span>
          </div>
          <p className="not-configured-lead">
            How much of your five-hour and seven-day windows you have consumed lives
            in your account, not in any file. The one place it surfaces locally is
            the payload Claude Code hands its statusline command on every render, so
            reading it means capturing that payload to a file. Nothing here can do
            that for you without editing your settings, which this tool does not do.
          </p>
          {setup && (
            <>
              <p className="not-configured-how">{setup.explanation}</p>
              <div className="not-configured-path">
                <span className="row-meta">statusLine command</span>
                <code>{setup.statusLineCommand}</code>
              </div>
            </>
          )}
        </div>
      ) : !pacing ? (
        <Skeleton kind="tiles" count={3} label="reading capture log..." />
      ) : !pacing.current ? (
        <div className="empty-state">
          {pacing.totalSamples} samples captured, none carrying rate limits yet -
          the block appears only for subscription accounts and only after a
          session's first API response
        </div>
      ) : (
        <>
          <div className="stat-grid">
            {pacing.current.fiveHour && (
              <WindowMeter label="five-hour window" window={pacing.current.fiveHour} />
            )}
            {pacing.current.sevenDay && (
              <WindowMeter label="seven-day window" window={pacing.current.sevenDay} />
            )}
            {pacing.current.contextUsedPercent !== null && (
              <div className="stat-tile">
                <div className="num">
                  {pacing.current.contextUsedPercent.toFixed(0)}%
                </div>
                <div className="row-meta">context in that session</div>
              </div>
            )}
            {pacing.current.sessionCostUsd !== null && (
              <div className="stat-tile">
                <div className="num">${pacing.current.sessionCostUsd.toFixed(2)}</div>
                <div className="row-meta">session cost, as reported</div>
              </div>
            )}
          </div>
          <p className="row-meta" style={{ marginTop: -8, marginBottom: 20 }}>
            {pacing.totalSamples} samples captured
            {pacing.samplesWithoutLimits > 0 &&
              `, ${pacing.samplesWithoutLimits} without a rate-limit block`}
            . {pacing.note}
          </p>
        </>
      )}

      <h3 style={{ marginTop: 26 }}>Five-hour windows</h3>
      {!blocks ? (
        <Skeleton kind="rows" count={4} label="reading sessions..." />
      ) : blocks.blocks.length === 0 ? (
        <div className="empty-state">no session activity to group</div>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>window</th>
                <th className="num-cell">sessions</th>
                <th className="num-cell">output</th>
                <th className="num-cell">cache read</th>
                <th className="num-cell">cost</th>
                <th style={{ width: "22%" }}>relative volume</th>
              </tr>
            </thead>
            <tbody>
              {blocks.blocks.map((block) => (
                <tr key={block.startedAt}>
                  <td>
                    <div>{block.startedAt.slice(0, 16).replace("T", " ")}</div>
                    <div className="row-meta">{block.models.join(", ")}</div>
                  </td>
                  <td className="num-cell">{block.sessions}</td>
                  <td className="num-cell">{compact(block.tokens.output)}</td>
                  <td className="num-cell">{compact(block.tokens.cacheRead)}</td>
                  <td className="num-cell">
                    {block.costUsd === null ? (
                      <span
                        className="row-meta"
                        title="a model in this window is not in the vendored pricing table, so no figure is shown rather than a partial one"
                      >
                        not priced
                      </span>
                    ) : (
                      `$${block.costUsd.toFixed(2)}`
                    )}
                  </td>
                  <td>
                    <div className="bar-cell">
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${
                              ((block.tokens.cacheRead + block.tokens.output) / widest) * 100
                            }%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Per-model spend, and what caching is actually costing and saving.
              totalCost computed all of this already and the payload kept one
              scalar per block, so the two questions a reader brings to a cost
              page - where is the money going, and is my caching worth it - were
              being computed and discarded on every request. Derived, every one:
              a vendored rate card multiplied by a token count is not a
              measurement. */}
          {blocks.totals.perModel.length > 0 && (
            <>
              <h3 style={{ marginTop: 26 }}>Cost by model</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>model</th>
                    <th style={{ textAlign: "right" }}>total</th>
                    <th style={{ textAlign: "right" }}>output</th>
                    <th style={{ textAlign: "right" }}>input</th>
                    <th style={{ textAlign: "right" }}>cache read</th>
                    <th style={{ textAlign: "right" }}>cache write</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.totals.perModel.map((row) => (
                    <tr key={row.model}>
                      <td>
                        {row.model}
                        {!row.priced && (
                          <>
                            {" "}
                            <span className="badge warn" title={row.note ?? undefined}>
                              not in table
                            </span>
                          </>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>{usd(row.totalUsd)}</td>
                      <td style={{ textAlign: "right" }}>{usd(row.outputUsd)}</td>
                      <td style={{ textAlign: "right" }}>{usd(row.inputUsd)}</td>
                      <td style={{ textAlign: "right" }}>{usd(row.cacheReadUsd)}</td>
                      <td style={{ textAlign: "right" }}>{usd(row.cacheWriteUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="row-meta" style={{ marginTop: 10, lineHeight: 1.55 }}>
                {usd(blocks.totals.totalUsd)} across{" "}
                {blocks.totals.perModel.filter((row) => row.priced).length} priced
                model(s), over the turns this page read rather than over your whole
                history - a bounded figure, and a computed one: every cell here is a
                vendored rate multiplied by a token count, never a number read off
                disk.{" "}
                {blocks.totals.unpricedModels.length > 0 ? (
                  <>
                    A further {compact(blocks.totals.unpricedTokens)} token(s) belong to{" "}
                    {blocks.totals.unpricedModels.join(", ")}, which the table cannot
                    price - so the total above is short by whatever those cost, and that
                    gap has a size rather than only a mention.
                  </>
                ) : (
                  <>Every model here is in the table, so nothing is missing from it.</>
                )}
              </p>
            </>
          )}

          <p className="row-meta" style={{ marginTop: 14 }}>
            Prices come from a table vendored into this repo, last verified{" "}
            <strong>{blocks.pricing.asOf}</strong> -{" "}
            <strong>{blocks.pricing.ageDays} days ago</strong>, against a{" "}
            {blocks.pricing.shelfLifeDays}-day shelf life
            {blocks.pricing.stale
              ? ", so it is past due for a re-read of the vendor's published pricing"
              : ""}
            . It covers {blocks.pricing.models.length} models. Nothing is fetched at
            runtime, so the table can go stale without any error - which is why the
            date and its age are on screen. A window containing a model the table
            does not price shows no cost rather than a partial one.
          </p>
        </>
      )}
    </div>
  );
}
