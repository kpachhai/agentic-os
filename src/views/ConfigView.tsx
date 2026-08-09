import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, Skeleton } from "../PillarState";

type SettingsEntry = {
  key: string;
  wonBy: string;
  setBy: string[];
  value: string | number | boolean | null;
  summary: string | null;
  rendered: boolean;
};

type Settings = {
  entries: SettingsEntry[];
  layersFound: string[];
  note: string;
};

type McpServerInfo = {
  name: string;
  transport: string;
  host: string | null;
  command: string | null;
  argumentCount: number | null;
  environmentKeys: string[];
  headerKeys: string[];
  carriesSecrets: boolean;
};

type PluginInfo = {
  name: string;
  marketplace: string;
  scope: string;
  version: string;
  commit: string;
  installedAt: string;
  lastUpdated: string;
  usageCount: number | null;
  lastUsedAt: number | null;
};

function daysAgo(epochMs: number | null): string {
  if (!epochMs) return "never";
  const days = Math.floor((Date.now() - epochMs) / 86400000);
  return days === 0 ? "today" : `${days}d ago`;
}

export function ConfigView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [servers, setServers] = useState<{ servers: McpServerInfo[]; note: string } | null>(null);
  const [plugins, setPlugins] = useState<{ plugins: PluginInfo[]; note: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    apiGet<Settings>("/api/config/settings").then(setSettings).catch(setError);
    // The MCP and plugin sections are independent: one absent source must not
    // blank the others, so only the settings failure decides the page state.
    apiGet<{ servers: McpServerInfo[]; note: string }>("/api/config/mcp")
      .then(setServers)
      .catch(() => setServers(null));
    apiGet<{ plugins: PluginInfo[]; note: string }>("/api/config/plugins")
      .then(setPlugins)
      .catch(() => setPlugins(null));
  }, []);

  const header = (
    <>
      <h1 className="view-title">
        What Is <span className="accent">In Effect</span>
      </h1>
      <p className="view-sub">
        resolved settings, MCP servers and plugin provenance - rendered field by
        field from an allowlist, never by filtering a whole config
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

  const neverUsed = plugins?.plugins.filter((p) => !p.usageCount).length ?? 0;

  return (
    <div>
      {header}

      <h3>Settings</h3>
      {!settings ? (
        <Skeleton kind="rows" count={5} label="reading settings..." />
      ) : (
        <>
          <p className="row-meta">
            layers present: {settings.layersFound.join(", ")}. {settings.note}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>key</th>
                <th>value</th>
                <th>set in</th>
              </tr>
            </thead>
            <tbody>
              {settings.entries.map((entry) => (
                <tr key={entry.key}>
                  <td>{entry.key}</td>
                  <td>
                    {entry.rendered ? (
                      <code>{String(entry.value)}</code>
                    ) : (
                      <span className="row-meta" title="withheld: this key can hold credentials or is too large to print">
                        {entry.summary}
                      </span>
                    )}
                  </td>
                  <td className="row-meta">
                    {entry.setBy.join(" -> ")}
                    {entry.setBy.length > 1 && ` (${entry.wonBy} wins)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={{ marginTop: 26 }}>MCP servers</h3>
      {!servers ? (
        <div className="row-meta">no MCP configuration found on this machine</div>
      ) : servers.servers.length === 0 ? (
        <div className="empty-state">no MCP servers configured</div>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>server</th>
                <th>transport</th>
                <th>points at</th>
                <th>credentials</th>
              </tr>
            </thead>
            <tbody>
              {servers.servers.map((server) => (
                <tr key={server.name}>
                  <td>{server.name}</td>
                  <td className="row-meta">{server.transport}</td>
                  <td className="row-meta">
                    {server.host ??
                      (server.command
                        ? `${server.command}${
                            server.argumentCount ? ` (${server.argumentCount} args)` : ""
                          }`
                        : "unknown")}
                  </td>
                  <td>
                    {server.carriesSecrets ? (
                      <>
                        <span className="badge warn">set</span>{" "}
                        <span className="row-meta">
                          {[...server.environmentKeys, ...server.headerKeys].join(", ")}
                        </span>
                      </>
                    ) : (
                      <span className="row-meta">none configured</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="row-meta" style={{ marginTop: 8 }}>
            {servers.note}
          </p>
        </>
      )}

      <h3 style={{ marginTop: 26 }}>Plugins</h3>
      {!plugins ? (
        <div className="row-meta">no plugin manifest found on this machine</div>
      ) : (
        <>
          <p className="row-meta">
            {plugins.plugins.length} installed, {neverUsed} never used. {plugins.note}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>plugin</th>
                <th>marketplace</th>
                <th>commit</th>
                <th className="num-cell">uses</th>
                <th>last used</th>
              </tr>
            </thead>
            <tbody>
              {plugins.plugins.map((plugin) => (
                <tr key={`${plugin.name}@${plugin.marketplace}`}>
                  <td>{plugin.name}</td>
                  <td className="row-meta">{plugin.marketplace}</td>
                  <td className="row-meta">
                    <code>{plugin.commit}</code>
                  </td>
                  <td className="num-cell">{plugin.usageCount ?? "-"}</td>
                  <td className="row-meta">{daysAgo(plugin.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
