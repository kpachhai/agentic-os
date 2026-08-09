import { useEffect, useState } from "react";
import { useApi } from "../api";
import { FailureState, RailLegend, Skeleton } from "../PillarState";

/*
 * Payload types, copied from server/mcp-usage.ts rather than imported: the UI does
 * not import server code. Field meanings are taken from that module's own comments,
 * and the ones that matter here are the bucket boundaries - "not in the configured
 * list" is three different claims, not one.
 */

type McpToolCount = {
  tool: string;
  /** Calls recorded in a session's own transcript. */
  calls: number;
  /** Calls recorded in a subagent transcript that session spawned. */
  subagentCalls: number;
};

type McpServerUsage = {
  /** Server segment exactly as the tool names on disk spell it. */
  server: string;
  /** The readable spelling, when a transcript happened to record one. */
  displayName: string | null;
  calls: number;
  subagentCalls: number;
  callsTotal: number;
  distinctTools: number;
  tools: McpToolCount[];
  /** Empty when no call for this server carried a usable timestamp. */
  firstUsedAt: string;
  lastUsedAt: string;
  sessions: number;
  subagentSessions: number;
  /** Encoded project directory names; the encoding is not reversible. */
  projects: string[];
};

type McpUsageReport = {
  servers: McpServerUsage[];
  totals: {
    servers: number;
    calls: number;
    subagentCalls: number;
    callsTotal: number;
    distinctTools: number;
    transcriptFilesScanned: number;
    sessionsScanned: number;
    sessionsWithCalls: number;
    subagentFilesScanned: number;
    sessionsWithSubagentCalls: number;
    unparsedNameOccurrences: number;
    unparsedNamesDistinct: number;
    skippedLines: number;
    subagentSkippedLines: number;
  };
  unparsedToolNames: string[];
  note: string;
};

type ConfiguredUsage = {
  configuredNames: string[];
  usages: McpServerUsage[];
  calls: number;
  subagentCalls: number;
  callsTotal: number;
  /** True when a match needed the client's namespace stripped off first. */
  matchedByStrippedNamespace: boolean;
};

type ProvidedElsewhere = {
  origin: "connector" | "plugin";
  usage: McpServerUsage;
};

type McpDecayReport = {
  usedAndConfigured: ConfiguredUsage[];
  configuredNeverCalled: string[];
  calledProvidedElsewhere: ProvidedElsewhere[];
  calledUnaccounted: McpServerUsage[];
  configuredNameCollisions: string[][];
  configuredNamesUnusable: string[];
  stats: {
    configuredNames: number;
    configuredServers: number;
    configuredNamesCalled: number;
    configuredNamesNeverCalled: number;
    calledServers: number;
    calledServersConfigured: number;
    calledServersMatchedByStrippedNamespace: number;
    calledServersProvidedElsewhere: number;
    calledServersUnaccounted: number;
    callsConfigured: number;
    callsProvidedElsewhere: number;
    callsUnaccounted: number;
    subagentCallsConfigured: number;
    subagentCallsProvidedElsewhere: number;
    subagentCallsUnaccounted: number;
  };
  note: string;
};

type ConfiguredMcpOrigin =
  | "user-config"
  | "project-config"
  | "hosted-connector"
  | "plugin";

type ConfiguredMcpName = { name: string; origin: ConfiguredMcpOrigin; plugin?: string };

type ConfiguredMcpNames = {
  names: ConfiguredMcpName[];
  counts: Record<ConfiguredMcpOrigin, number>;
  unreadable: string[];
  note: string;
};

type McpUsageResponse = {
  usage: McpUsageReport;
  decay: McpDecayReport;
  /** Null when the config could not be read at all. */
  configuredNames: ConfiguredMcpNames | null;
};

/**
 * How strong each source's claim is, in the words the reader needs before acting.
 *
 * A settings entry is configured now. A connector is one the client records as
 * having connected at some point, which is a weaker claim and must not be acted on
 * as though it were the same thing.
 */
const ORIGIN_CLAIM: Record<ConfiguredMcpOrigin, { label: string; badge: string; claim: string }> = {
  "user-config": {
    label: "your settings",
    badge: "badge purple",
    claim: "named in your own configuration, so it is configured now",
  },
  "project-config": {
    label: "a project's settings",
    badge: "badge purple",
    claim: "named in one project's configuration, so it loads in that project",
  },
  "hosted-connector": {
    label: "hosted connector",
    badge: "badge info",
    claim:
      "recorded as having connected at some point, which is not the same as enabled today - check before treating it as live",
  },
  plugin: {
    label: "plugin-supplied",
    badge: "badge spark",
    claim: "declared by an installed plugin, so removing it means changing the plugin",
  },
};

/** The readable spelling when one was recorded; the raw segment otherwise. */
function serverLabel(usage: McpServerUsage): string {
  return usage.displayName ?? usage.server;
}

function shortDay(iso: string): string {
  return iso ? iso.slice(0, 10) : "undated";
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The busiest few tools, so a row says what the calls actually were. */
function toolSummary(tools: McpToolCount[], keep: number): string {
  const shown = tools
    .slice(0, keep)
    // Session and delegated calls stay apart here for the same reason they do in the
    // tables: folding them would undo the split this page states it maintains.
    .map((tool) =>
      tool.subagentCalls > 0
        ? `${tool.tool} ${tool.calls}+${tool.subagentCalls} delegated`
        : `${tool.tool} ${tool.calls}`,
    )
    .join(", ");
  const rest = tools.length - Math.min(keep, tools.length);
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

/** ISO strings are normalised to UTC upstream, so comparing them is sound. */
function latestOf(usages: McpServerUsage[]): string {
  return usages.reduce(
    (latest, usage) => (usage.lastUsedAt > latest ? usage.lastUsedAt : latest),
    "",
  );
}

function BucketHeading({
  badge,
  title,
  count,
  meaning,
}: {
  badge: string;
  title: string;
  count: string;
  meaning: string;
}) {
  return (
    <>
      <h3 style={{ marginBottom: 4, display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className={`badge ${badge}`}>{count}</span>
        <span>{title}</span>
      </h3>
      <p className="row-meta" style={{ fontFamily: "var(--font-ui)", lineHeight: 1.55, margin: "0 0 10px", maxWidth: 780 }}>
        {meaning}
      </p>
    </>
  );
}

/** One table of called servers, with bars comparable across every bucket. */
function ServerTable({
  rows,
  widest,
  showProjects,
}: {
  rows: McpServerUsage[];
  widest: number;
  showProjects: boolean;
}) {
  return (
    <table className="data-table" style={{ marginBottom: 8 }}>
      <thead>
        <tr>
          <th>server</th>
          <th className="num-cell">session calls</th>
          <th className="num-cell">subagent calls</th>
          <th className="num-cell">tools</th>
          <th className="num-cell">last called</th>
          {/* Relative to the busiest server, not to the total: a bucket's own
              share of all calls is in the reconciliation table above. */}
          <th style={{ width: "16%" }}>relative volume</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((usage) => (
          <tr key={usage.server}>
            <td>
              <div style={{ color: "var(--text)" }} title={usage.server}>
                {serverLabel(usage)}
              </div>
              <div className="row-meta" style={{ marginTop: 3 }}>
                {toolSummary(usage.tools, 3)}
              </div>
              {showProjects && usage.projects.length > 0 && (
                <div
                  className="row-meta"
                  style={{ marginTop: 3 }}
                  title={usage.projects.join("\n")}
                >
                  called from {usage.projects.length}{" "}
                  {plural(usage.projects.length, "project directory", "project directories")}
                </div>
              )}
            </td>
            <td className="num-cell">{usage.calls}</td>
            <td className="num-cell">{usage.subagentCalls}</td>
            <td className="num-cell">{usage.distinctTools}</td>
            <td className="num-cell">{shortDay(usage.lastUsedAt)}</td>
            <td>
              <div className="bar-cell">
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${(usage.callsTotal / widest) * 100}%` }}
                  />
                </div>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function McpUsageView() {
  const { data, error } = useApi<McpUsageResponse>("/api/mcp-usage");

  const header = (
    <>
      <h1 className="view-title">
        MCP Servers <span className="accent">Called</span>
      </h1>
      <p className="view-sub">
        every configured server ships its tool definitions into the context window
        before you type a word, so the list worth acting on is the one that is
        configured and never called - counted from the calls your transcripts recorded
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
  if (!data) {
    return (
      <div>
        {header}
        <Skeleton kind="tiles" count={4} label="reading every transcript for MCP calls..." />
      </div>
    );
  }

  const { usage, decay, configuredNames } = data;
  // A name's source decides how strong the "never called" claim about it is, so the
  // chips below look it up rather than presenting every entry as equally actionable.
  const originByName = new Map(
    (configuredNames?.names ?? []).map((entry) => [entry.name, entry.origin]),
  );
  const originOf = (name: string): ConfiguredMcpOrigin | undefined =>
    originByName.get(name);
  const totals = usage.totals;
  const stats = decay.stats;
  const widest = usage.servers[0]?.callsTotal ?? 1;
  // A configured name can match more than one called segment, so a group total can exceed
  // the busiest single segment. Sizing group bars against the widest group keeps them
  // inside the track; using the per-segment maximum pushed a bar off the right edge.
  const widestGroup = Math.max(
    widest,
    ...decay.usedAndConfigured.map((entry) => entry.callsTotal),
    1,
  );
  const noConfiguredNames = stats.configuredNames === 0;

  // Non-zero caveats get their own visible line; the ones that came back clean are
  // summarised in one quiet sentence, because a reader still needs to know they were
  // checked rather than skipped.
  const flagged: { head: string; body: string; items?: string[] }[] = [];
  const clean: string[] = [];

  if (totals.subagentCalls > 0) {
    flagged.push({
      head: `${totals.subagentCalls} of ${totals.callsTotal} calls came from a subagent`,
      body:
        "A call a subagent made is still a call, so these are counted; leaving them out would report a server that only delegated work uses as never called. They stay in their own column because a subagent is not a session, and folding them into the session figures would inflate a number you would read as what you did yourself. By bucket: " +
        `${stats.subagentCallsConfigured} configured, ${stats.subagentCallsProvidedElsewhere} provided elsewhere, ${stats.subagentCallsUnaccounted} unaccounted for.`,
    });
  } else {
    clean.push("no call in this history came from a subagent");
  }

  if (stats.calledServersMatchedByStrippedNamespace > 0) {
    flagged.push({
      head: `${stats.calledServersMatchedByStrippedNamespace} ${plural(stats.calledServersMatchedByStrippedNamespace, "server matched", "servers matched")} only after a namespace was stripped`,
      body:
        "The recorded name did not match a configured name outright; it matched once the client's own namespace was removed from the front of it. That is the weaker of the two claims, because a connector and a locally configured server can share a bare name and still be two servers with two context costs. The match is still the better bet - refusing it files a server in daily use under never called - but a surprising row may be this.",
    });
  } else {
    clean.push("every configured match was on the recorded name itself, with no namespace stripped");
  }

  if (decay.configuredNamesUnusable.length > 0) {
    flagged.push({
      head: `${decay.configuredNamesUnusable.length} configured ${plural(decay.configuredNamesUnusable.length, "name", "names")} could not be used`,
      body:
        "These names carry no letter or digit, so they produce no comparison key and can neither match nor fail to match anything. They are listed rather than dropped, because a name silently ignored looks like a name that was checked.",
      items: decay.configuredNamesUnusable,
    });
  } else {
    clean.push("every configured name was usable for matching");
  }

  if (decay.configuredNameCollisions.length > 0) {
    flagged.push({
      head: `${decay.configuredNameCollisions.length} ${plural(decay.configuredNameCollisions.length, "group", "groups")} of configured names collapsed onto one server`,
      body:
        "Names that differ only in punctuation compare as one server. Matching has to treat them that way, or a server never matches its own usage; the counts do not, so every spelling is kept and the fold is shown here instead of happening quietly.",
      items: decay.configuredNameCollisions.map((group) => group.join(" = ")),
    });
  } else {
    clean.push("no two configured names collapsed onto the same server");
  }

  if (totals.unparsedNamesDistinct > 0) {
    flagged.push({
      head: `${totals.unparsedNameOccurrences} ${plural(totals.unparsedNameOccurrences, "call", "calls")} used ${totals.unparsedNamesDistinct} tool ${plural(totals.unparsedNamesDistinct, "name", "names")} that could not be attributed`,
      body:
        "These names look like MCP tool names and do not split into a server and a tool, so their calls are missing from every count above. They are shown so a change in the naming convention reads as a visible list rather than as a quiet drop in call counts.",
      items: usage.unparsedToolNames,
    });
  } else {
    clean.push("every tool name that looked like an MCP name parsed, so no calls went unattributed");
  }

  if (totals.skippedLines > 0 || totals.subagentSkippedLines > 0) {
    flagged.push({
      head: `${totals.skippedLines + totals.subagentSkippedLines} transcript lines did not parse`,
      body:
        `${totals.skippedLines} in session transcripts, which is expected on a session that is being written to right now, and ${totals.subagentSkippedLines} in delegated ones. The delegated number usually means a file that is not a transcript at all was walked - a plugin's log sitting in a session directory - rather than that any history was lost.`,
    });
  } else {
    clean.push("every transcript line parsed");
  }

  return (
    <div>
      {header}

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="num">{totals.servers}</div>
          <div className="row-meta">servers called</div>
        </div>
        <div className="stat-tile">
          <div className="num">{totals.calls}</div>
          <div className="row-meta">calls by sessions</div>
        </div>
        <div className="stat-tile">
          <div className="num">{totals.subagentCalls}</div>
          <div className="row-meta">calls by subagents</div>
        </div>
        <div className="stat-tile bounded">
          <div
            className={`num${!noConfiguredNames && stats.configuredNamesNeverCalled > 0 ? " accent" : ""}`}
            // A zero here would read as "nothing is idle" when the truth is that no
            // configured name reached this page, so nothing could be compared.
            title={
              noConfiguredNames
                ? "No configured server name reached this page, so no server could be checked against the calls."
                : undefined
            }
          >
            {noConfiguredNames ? "not checked" : stats.configuredNamesNeverCalled}
          </div>
          <div className="row-meta">configured, never called</div>
        </div>
      </div>
      <RailLegend present={["measured", "bounded"]} />

      <p className="row-meta" style={{ marginTop: -8, marginBottom: 22, fontFamily: "var(--font-ui)", lineHeight: 1.55, maxWidth: 820 }}>
        {totals.callsTotal} calls in all, over {totals.distinctTools} distinct
        server-and-tool pairs, read from {totals.transcriptFilesScanned} session
        transcripts ({totals.sessionsScanned} distinct sessions, {totals.sessionsWithCalls}{" "}
        of which called an MCP server) and {totals.subagentFilesScanned} delegated ones
        ({totals.sessionsWithSubagentCalls} owning{" "}
        {plural(totals.sessionsWithSubagentCalls, "session", "sessions")} whose subagents
        called one). The whole tree is read rather than the recent part, because
        "never called" would otherwise be wrong for anything used monthly. A count here
        is calls and never cost: a server's token weight is mostly its tool definitions,
        which are charged on every turn whether or not anything calls them, and nothing
        in a transcript attributes those tokens to a server.
      </p>

      <h3>Where the calls went</h3>
      <p className="row-meta" style={{ fontFamily: "var(--font-ui)", lineHeight: 1.55, margin: "0 0 10px", maxWidth: 820 }}>
        Every called server sits in exactly one of these three rows, and the three mean
        different things. Reading them as one bucket called "not configured" is how an
        earlier version of this page put most of the real traffic under a label that
        argued for uninstalling servers in daily use.
      </p>
      <table className="data-table" style={{ marginBottom: 10 }}>
        <thead>
          <tr>
            <th>bucket</th>
            <th className="num-cell">servers</th>
            <th className="num-cell">session calls</th>
            <th className="num-cell">subagent calls</th>
            <th style={{ width: "16%" }}>share of all calls</th>
          </tr>
        </thead>
        <tbody>
          {[
            {
              label: "used and configured",
              servers: stats.calledServersConfigured,
              calls: stats.callsConfigured,
              subagentCalls: stats.subagentCallsConfigured,
            },
            {
              label: "called, provided elsewhere",
              servers: stats.calledServersProvidedElsewhere,
              calls: stats.callsProvidedElsewhere,
              subagentCalls: stats.subagentCallsProvidedElsewhere,
            },
            {
              label: "called, unaccounted for",
              servers: stats.calledServersUnaccounted,
              calls: stats.callsUnaccounted,
              subagentCalls: stats.subagentCallsUnaccounted,
            },
          ].map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="num-cell">{row.servers}</td>
              <td className="num-cell">{row.calls}</td>
              <td className="num-cell">{row.subagentCalls}</td>
              <td>
                <div className="bar-cell">
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${
                          totals.callsTotal === 0
                            ? 0
                            : ((row.calls + row.subagentCalls) / totals.callsTotal) * 100
                        }%`,
                      }}
                    />
                  </div>
                </div>
              </td>
            </tr>
          ))}
          <tr>
            <td style={{ color: "var(--text)" }}>all called servers</td>
            <td className="num-cell" style={{ color: "var(--text)" }}>
              {stats.calledServers}
            </td>
            <td className="num-cell" style={{ color: "var(--text)" }}>
              {totals.calls}
            </td>
            <td className="num-cell" style={{ color: "var(--text)" }}>
              {totals.subagentCalls}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <p className="row-meta" style={{ marginBottom: 26 }}>
        The configured list supplied {stats.configuredNames} usable{" "}
        {plural(stats.configuredNames, "name", "names")} describing{" "}
        {stats.configuredServers} {plural(stats.configuredServers, "server", "servers")};{" "}
        {stats.configuredNamesCalled} matched a called server and{" "}
        {stats.configuredNamesNeverCalled} never did.
      </p>

      {noConfiguredNames && (
        <div className="not-configured" style={{ marginBottom: 26 }}>
          <div className="not-configured-head">
            <span className="badge info">not configured</span>
            <span className="row-meta">configured server list</span>
          </div>
          <p className="not-configured-lead">
            The two lists that need to know what is configured - used and configured,
            and configured but never called - compare the calls above against the server
            names Claude Code keeps in its own configuration file. No usable name reached
            this page, which happens both when that file is absent and when it lists no
            MCP server at all. Until one does, the pruning list below is empty because
            nothing could be compared, not because nothing is idle.
          </p>
          <p className="row-meta">
            Set <code>claudeConfigPath</code> in <code>config.json</code> to the file
            holding your <code>mcpServers</code> block, then restart. Run{" "}
            <code>npm run doctor</code> to see every source at once.
          </p>
        </div>
      )}

      <BucketHeading
        badge="success"
        count={`${decay.usedAndConfigured.length} ${plural(decay.usedAndConfigured.length, "server", "servers")}`}
        title="used and configured"
        meaning="These names are in the configuration this page read, and calls for them appear in the transcripts. Nothing to act on: the context they cost on every turn is context something is using."
      />
      {decay.usedAndConfigured.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 22 }}>
          {noConfiguredNames
            ? "no configured name reached this page, so no call could be matched to one"
            : "no configured server was called in the scanned history"}
        </div>
      ) : (
        <table className="data-table" style={{ marginBottom: 22 }}>
          <thead>
            <tr>
              <th>configured name</th>
              <th className="num-cell">session calls</th>
              <th className="num-cell">subagent calls</th>
              <th className="num-cell">last called</th>
              <th style={{ width: "16%" }}>relative volume</th>
            </tr>
          </thead>
          <tbody>
            {decay.usedAndConfigured.map((entry) => (
              <tr key={entry.configuredNames.join("|")}>
                <td>
                  <div
                    style={{ color: "var(--text)", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}
                  >
                    {entry.configuredNames.join(", ")}
                    {entry.matchedByStrippedNamespace && (
                      <span
                        className="badge spark"
                        title="matched only after the client's namespace was stripped off the recorded name, which is the weaker of the two claims"
                      >
                        namespace stripped
                      </span>
                    )}
                  </div>
                  <div className="row-meta" style={{ marginTop: 3 }}>
                    called as {entry.usages.map((one) => serverLabel(one)).join(", ")}
                  </div>
                  <div className="row-meta" style={{ marginTop: 3 }}>
                    {entry.usages
                      .map((one) => toolSummary(one.tools, 3))
                      .filter((line) => line.length > 0)
                      .join(" | ")}
                  </div>
                </td>
                <td className="num-cell">{entry.calls}</td>
                <td className="num-cell">{entry.subagentCalls}</td>
                <td className="num-cell">{shortDay(latestOf(entry.usages))}</td>
                <td>
                  <div className="bar-cell">
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.min((entry.callsTotal / widestGroup) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {configuredNames && (
        <p className="row-meta" style={{ margin: "0 0 18px", lineHeight: 1.55, maxWidth: 820 }}>
          The configured list is {configuredNames.names.length} names drawn from four
          sources:{" "}
          {(Object.keys(ORIGIN_CLAIM) as ConfiguredMcpOrigin[])
            .filter((origin) => configuredNames.counts[origin] > 0)
            .map((origin) => `${configuredNames.counts[origin]} from ${ORIGIN_CLAIM[origin].label}`)
            .join(", ")}
          . {configuredNames.note}
          {configuredNames.unreadable.length > 0 && (
            <>
              {" "}
              <strong>
                {configuredNames.unreadable.length} source(s) could not be read, so this list
                is a floor rather than the whole set.
              </strong>
            </>
          )}
        </p>
      )}

      <BucketHeading
        badge="spark"
        count={`${decay.configuredNeverCalled.length} ${plural(decay.configuredNeverCalled.length, "name", "names")}`}
        title="configured but never called"
        meaning="The actionable list. Each of these loads its tool definitions on every turn and nothing has called it in the history still on disk, so each one is paid for and unused. It is not proof of disuse: Claude Code ages old transcripts out, so a server you reach for once a quarter can land here, and the fix for a name you recognise is to check before removing rather than to remove."
      />
      {decay.configuredNeverCalled.length === 0 ? (
        <p className="row-meta" style={{ marginBottom: 22 }}>
          {noConfiguredNames
            ? "Empty because no configured name reached this page, not because nothing is idle."
            : "Every configured name matched a called server, so there is nothing here to prune."}
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {decay.configuredNeverCalled.map((name) => {
              const origin = originOf(name);
              const claim = origin ? ORIGIN_CLAIM[origin] : null;
              return (
                <span
                  key={name}
                  className={claim ? claim.badge : "chip static"}
                  title={claim ? claim.claim : undefined}
                  style={{ padding: "4px 9px" }}
                >
                  {name}
                  {claim && (
                    <span className="row-meta" style={{ marginLeft: 6, opacity: 0.75 }}>
                      {claim.label}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
          <p className="row-meta" style={{ marginBottom: 22, lineHeight: 1.55 }}>
            Read the source on each one before acting. A name from your own settings is
            configured now and idle. A hosted connector is only recorded as having connected
            at some point, so its presence here may mean it was already turned off rather
            than that it is loaded and unused.
          </p>
        </>
      )}

      <BucketHeading
        badge="info"
        count={`${decay.calledProvidedElsewhere.length} ${plural(decay.calledProvidedElsewhere.length, "server", "servers")}`}
        title="called, but provided elsewhere"
        meaning="These servers are configured; just not in the file this page read. A connector enabled on your account and a server a plugin brings with it both arrive with the client's own namespace in front of their real name, and that namespace is the evidence. So their absence from the configured list says nothing was removed, and editing that file would not remove them either - honest to report, not actionable."
      />
      {decay.calledProvidedElsewhere.length === 0 ? (
        <p className="row-meta" style={{ marginBottom: 22 }}>
          No call came from a connector or from a plugin-supplied server.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            {(["connector", "plugin"] as const).map((origin) => {
              const count = decay.calledProvidedElsewhere.filter(
                (entry) => entry.origin === origin,
              ).length;
              return count === 0 ? null : (
                <span key={origin} className="chip static">
                  {count} {plural(count, "server", "servers")} from a {origin}
                </span>
              );
            })}
          </div>
          <ServerTable
            rows={decay.calledProvidedElsewhere.map((entry) => entry.usage)}
            widest={widest}
            showProjects={false}
          />
          <p className="row-meta" style={{ marginBottom: 22 }}>
            Origin is read off the name and nothing else, so it is evidence about where a
            server comes from rather than proof that it is configured.
          </p>
        </>
      )}

      <BucketHeading
        badge="purple"
        count={`${decay.calledUnaccounted.length} ${plural(decay.calledUnaccounted.length, "server", "servers")}`}
        title="called, but unaccounted for"
        meaning="Called, carrying a plain name, and matching no configured entry. That is the whole claim: nothing on disk here can name it. It covers both a server that really was removed and one configured in a file this page did not read, and a transcript cannot tell those apart, so this is a list to look into and never a removal to report. The calls happened either way, which is why they stay in the totals above."
      />
      {decay.calledUnaccounted.length === 0 ? (
        <p className="row-meta" style={{ marginBottom: 22 }}>
          Every called server was either configured or named for where it comes from.
        </p>
      ) : (
        <ServerTable rows={decay.calledUnaccounted} widest={widest} showProjects />
      )}

      <h3 style={{ marginTop: 26 }}>What these counts do not cover</h3>
      {flagged.map((item) => (
        <div className="card" key={item.head}>
          <div style={{ color: "var(--text)" }}>{item.head}</div>
          <div
            className="row-meta"
            style={{ fontFamily: "var(--font-ui)", lineHeight: 1.55, marginTop: 5 }}
          >
            {item.body}
          </div>
          {item.items && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {item.items.map((entry) => (
                <code key={entry} className="row-meta">
                  {entry}
                </code>
              ))}
            </div>
          )}
        </div>
      ))}
      {clean.length > 0 && (
        <p className="row-meta" style={{ marginTop: 10 }}>
          Checked and clean: {clean.join("; ")}.
        </p>
      )}

      <p className="row-meta" style={{ marginTop: 14, lineHeight: 1.6, maxWidth: 860 }}>
        {usage.note}
      </p>
      <p className="row-meta" style={{ marginTop: 10, lineHeight: 1.6, maxWidth: 860 }}>
        {decay.note}
      </p>
    </div>
  );
}
