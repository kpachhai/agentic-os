import fs from "node:fs";
import path from "node:path";
import { SourceMissingError } from "./config.js";

/**
 * Read-only view of what is actually in effect: settings resolved across their
 * layers, the MCP servers configured, and where each plugin came from.
 *
 * This module renders from ALLOWLISTS, never by redacting a whole parsed config.
 * That choice is the security design, not a style preference. Credentials hide in
 * at least three different shapes in real MCP configuration - an `env` block, a
 * `headers` block, and inline in a connection URL - and a key-name denylist broad
 * enough to catch all of them would blank out ordinary settings too. So nothing is
 * rendered unless this file names it as safe to render, and an unrecognised field
 * is reported as present-but-not-shown rather than printed.
 */

export type SettingsLayer = "user" | "project" | "project-local";

export type SettingsEntry = {
  key: string;
  /** Which layer supplied the winning value. */
  wonBy: SettingsLayer;
  /** Every layer that set this key, so an override is visible as an override. */
  setBy: SettingsLayer[];
  /**
   * The value, when the key is on the scalar allowlist. Structural keys report a
   * summary instead, and unknown keys report nothing at all.
   */
  value: string | number | boolean | null;
  /** Shape description for a structural key, e.g. "5 events". */
  summary: string | null;
  rendered: boolean;
};

/**
 * Settings whose values are plain switches with no credential potential, so the
 * value itself is worth showing.
 *
 * `cleanupPeriodDays` earns its place for a specific reason: it decides how long
 * transcripts survive, so it silently bounds how far back every transcript-derived
 * view in this app can see.
 */
const SCALAR_SETTINGS = new Set([
  "model",
  "effortLevel",
  "tui",
  "teammateMode",
  "cleanupPeriodDays",
  "autoMemoryEnabled",
  "autoMemoryDirectory",
  "fileCheckpointingEnabled",
  "disableAllHooks",
  "includeCoAuthoredBy",
  "voiceEnabled",
  "remoteControlAtStartup",
  "inputNeededNotifEnabled",
  "agentPushNotifEnabled",
  "skipAutoPermissionPrompt",
  "skipDangerousModePermissionPrompt",
  "skipWorkflowUsageWarning",
  "outputStyle",
  "statusLine",
  "forceLoginMethod",
]);

/**
 * Settings that are containers. Their shape is informative and their contents are
 * not safe to print: `env` holds credentials by design, and `permissions` and
 * `hooks` are long enough that printing them buries everything else.
 */
const STRUCTURAL_SETTINGS: Record<string, string> = {
  env: "environment variables",
  permissions: "permission rules",
  hooks: "hook events",
  enabledPlugins: "enabled plugins",
  extraKnownMarketplaces: "extra marketplaces",
  autoMode: "auto-mode options",
  voice: "voice options",
  allowedHttpHookUrls: "allowed hook URLs",
  claudeMdExcludes: "excluded memory files",
};

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (err) {
    console.warn(`config-surface: cannot parse ${filePath}:`, err);
    return null;
  }
}

function describeContainer(key: string, value: unknown): string {
  const noun = STRUCTURAL_SETTINGS[key] ?? "entries";
  if (Array.isArray(value)) return `${value.length} ${noun}`;
  if (typeof value === "object" && value !== null) {
    return `${Object.keys(value).length} ${noun}`;
  }
  return noun;
}

/**
 * Resolve settings across their layers, annotating each key with which file won.
 *
 * Later layers override earlier ones, which is the order Claude Code documents.
 * Enterprise-managed policy is deliberately not read: it lives outside the
 * operator's home directory, and reporting a partial precedence chain as if it
 * were complete would be worse than saying plainly that this covers three layers.
 */
export function effectiveSettings(
  userSettingsPath: string,
  projectDir?: string,
): { entries: SettingsEntry[]; layersFound: SettingsLayer[]; note: string } {
  const layers: Array<{ layer: SettingsLayer; data: Record<string, unknown> | null }> = [
    { layer: "user", data: readJsonFile(userSettingsPath) },
    {
      layer: "project",
      data: projectDir
        ? readJsonFile(path.join(projectDir, ".claude", "settings.json"))
        : null,
    },
    {
      layer: "project-local",
      data: projectDir
        ? readJsonFile(path.join(projectDir, ".claude", "settings.local.json"))
        : null,
    },
  ];

  if (layers.every(({ data }) => data === null)) {
    throw new SourceMissingError("claude settings", userSettingsPath);
  }

  const setBy = new Map<string, SettingsLayer[]>();
  const winner = new Map<string, { layer: SettingsLayer; value: unknown }>();
  for (const { layer, data } of layers) {
    if (!data) continue;
    for (const [key, value] of Object.entries(data)) {
      setBy.set(key, [...(setBy.get(key) ?? []), layer]);
      winner.set(key, { layer, value });
    }
  }

  const entries: SettingsEntry[] = [...winner.entries()]
    .map(([key, { layer, value }]) => {
      const base = {
        key,
        wonBy: layer,
        setBy: setBy.get(key) ?? [layer],
      };

      if (SCALAR_SETTINGS.has(key)) {
        const isScalar =
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean";
        return {
          ...base,
          // A key on the scalar allowlist that unexpectedly holds an object is not
          // printed. The allowlist is a claim about the value's shape as much as
          // its name, and an unexpected shape means the claim no longer holds.
          value: isScalar ? (value as string | number | boolean) : null,
          summary: isScalar ? null : describeContainer(key, value),
          rendered: isScalar,
        };
      }

      if (key in STRUCTURAL_SETTINGS) {
        return {
          ...base,
          value: null,
          summary: describeContainer(key, value),
          rendered: false,
        };
      }

      // Not on any list. Report that it is set without showing what it is set to:
      // an unknown key could hold anything, including a credential.
      return {
        ...base,
        value: null,
        summary: `set (${Array.isArray(value) ? "list" : typeof value}), not shown`,
        rendered: false,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    entries,
    layersFound: layers.filter(({ data }) => data !== null).map(({ layer }) => layer),
    note:
      "Covers user, project and project-local settings. Enterprise-managed policy " +
      "is not read, so a managed override would not appear here.",
  };
}

// ---- MCP servers ----

export type McpServerInfo = {
  name: string;
  /** Transport as configured, e.g. stdio, http, sse. */
  transport: string;
  /**
   * Host only for a networked server; never the full URL.
   *
   * The host IS rendered, deliberately: an MCP inventory that hides where each
   * server points answers none of the questions it exists to answer. It is worth
   * knowing that a host can still be identifying infrastructure even when no
   * credential is attached to it, so this view is worth a second look before
   * screenshotting. The path, query and userinfo, which is where credentials
   * actually live, never reach this field.
   */
  host: string | null;
  /** Executable name only for a stdio server; never the full command line. */
  command: string | null;
  argumentCount: number | null;
  /** Names of environment variables set, never their values. */
  environmentKeys: string[];
  /** Names of headers set, never their values. */
  headerKeys: string[];
  /** True when this entry carries something credential-shaped that is not shown. */
  carriesSecrets: boolean;
};

/**
 * The configured MCP servers, rendered field by field from an allowlist.
 *
 * Every field here is chosen; nothing is copied through. A URL is reduced to its
 * host because a real configuration embeds credentials in userinfo and in query
 * parameters. A command is reduced to its executable name because arguments carry
 * `-e NAME=VALUE` pairs. Environment and header blocks contribute their KEY NAMES
 * only, which is the useful half - the operator wants to know that a token is
 * configured, not what it is.
 */
export function mcpServers(claudeConfigPath: string): {
  servers: McpServerInfo[];
  note: string;
} {
  const config = readJsonFile(claudeConfigPath);
  if (!config) throw new SourceMissingError("claude config", claudeConfigPath);

  const raw = config.mcpServers;
  const entries =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
      : [];

  const servers = entries.map(([name, value]) => {
    const cfg =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};

    let host: string | null = null;
    if (typeof cfg.url === "string") {
      try {
        host = new URL(cfg.url).host;
      } catch {
        // An unparseable URL is reported as unknown rather than echoed, since the
        // reason it failed to parse might be the credential inside it.
        host = "unparseable";
      }
    }

    const command =
      typeof cfg.command === "string" ? (cfg.command.split("/").pop() ?? null) : null;
    const environmentKeys =
      typeof cfg.env === "object" && cfg.env !== null
        ? Object.keys(cfg.env as Record<string, unknown>)
        : [];
    const headerKeys =
      typeof cfg.headers === "object" && cfg.headers !== null
        ? Object.keys(cfg.headers as Record<string, unknown>)
        : [];

    return {
      name,
      transport: typeof cfg.type === "string" ? cfg.type : "unknown",
      host,
      command,
      argumentCount: Array.isArray(cfg.args) ? cfg.args.length : null,
      environmentKeys,
      headerKeys,
      carriesSecrets: environmentKeys.length > 0 || headerKeys.length > 0,
    };
  });

  return {
    servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
    note:
      "Rendered from an allowlist: transport, host, executable name, and the NAMES " +
      "of environment variables and headers. No value from any of those is read " +
      "into this response, so a token configured here shows up as a name that is " +
      "set and never as a value that could be copied.",
  };
}

// ---- Plugin provenance ----

export type PluginInfo = {
  name: string;
  marketplace: string;
  scope: string;
  version: string;
  /** Short commit the install came from; the reliable identity when version is unknown. */
  commit: string;
  installedAt: string;
  lastUpdated: string;
  usageCount: number | null;
  lastUsedAt: number | null;
};

/**
 * Where each installed plugin came from and whether it is used.
 *
 * Keyed on commit rather than version for drift checks: official-marketplace
 * plugins routinely report a version of "unknown" while still carrying an exact
 * commit, so version comparison would silently compare nothing.
 */
export function installedPlugins(
  pluginsDir: string,
  claudeConfigPath: string,
): { plugins: PluginInfo[]; note: string } {
  const manifestPath = path.join(pluginsDir, "installed_plugins.json");
  const manifest = readJsonFile(manifestPath);
  if (!manifest) throw new SourceMissingError("plugin manifest", manifestPath);

  const usage = readJsonFile(claudeConfigPath)?.pluginUsage;
  const usageMap =
    typeof usage === "object" && usage !== null
      ? (usage as Record<string, { usageCount?: unknown; lastUsedAt?: unknown }>)
      : {};

  const plugins: PluginInfo[] = [];
  const raw = manifest.plugins;
  const pluginEntries =
    typeof raw === "object" && raw !== null ? Object.entries(raw as Record<string, unknown>) : [];

  for (const [key, installs] of pluginEntries) {
    const [name = key, marketplace = "unknown"] = key.split("@");
    for (const install of Array.isArray(installs) ? installs : []) {
      const info =
        typeof install === "object" && install !== null
          ? (install as Record<string, unknown>)
          : {};
      const recorded = usageMap[key] ?? usageMap[name] ?? {};
      const str = (field: string): string =>
        typeof info[field] === "string" ? (info[field] as string) : "unknown";

      plugins.push({
        name,
        marketplace,
        scope: str("scope"),
        version: str("version"),
        commit: str("gitCommitSha").slice(0, 10),
        installedAt: str("installedAt"),
        lastUpdated: str("lastUpdated"),
        usageCount:
          typeof recorded.usageCount === "number" ? recorded.usageCount : null,
        lastUsedAt:
          typeof recorded.lastUsedAt === "number" ? recorded.lastUsedAt : null,
      });
    }
  }

  return {
    plugins: plugins.sort(
      (a, b) => (b.usageCount ?? -1) - (a.usageCount ?? -1) || a.name.localeCompare(b.name),
    ),
    note:
      "Install paths are not rendered: they contain the operator's home directory. " +
      "Drift is keyed on commit rather than version, because an official-marketplace " +
      "plugin can report an unknown version while carrying an exact commit.",
  };
}

/**
 * Where a configured MCP server name was found.
 *
 * The origin travels with the name because the four sources do not make the same
 * claim. A name in a settings file is configured now; a connector Claude Code
 * records as ever-connected may have been turned off since. Flattening them into
 * one list would let "ever connected" read as "configured", which is the mistake
 * that makes a never-called list argue for removing something already gone.
 */
export type ConfiguredMcpOrigin =
  | "user-config"
  | "project-config"
  | "hosted-connector"
  | "plugin";

export type ConfiguredMcpName = {
  name: string;
  origin: ConfiguredMcpOrigin;
  /** For a plugin-supplied server, the plugin that brings it. */
  plugin?: string;
};

export type ConfiguredMcpNames = {
  names: ConfiguredMcpName[];
  counts: Record<ConfiguredMcpOrigin, number>;
  /** Sources this enumeration could not read, so a short list cannot read as complete. */
  unreadable: string[];
  note: string;
};

/** Server names declared by one plugin's own `.mcp.json`, if it has one. */
function pluginDeclaredServers(installPath: string): string[] {
  const declared = readJsonFile(path.join(installPath, ".mcp.json"));
  const servers = declared?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return [];
  }
  return Object.keys(servers).filter((name) => name.trim().length > 0);
}

/**
 * Every MCP server name this machine can be shown to have configured, with where
 * each was found.
 *
 * Reading only the top-level `mcpServers` block leaves most real traffic
 * unexplained: on a working machine that block held three names while calls had
 * been made to eight servers, so a "configured but never called" list built from it
 * alone is technically honest and practically useless. The other three sources are
 * the per-project blocks, the hosted connectors the client records, and the servers
 * an installed plugin brings with it.
 *
 * Only plugins the install manifest lists are consulted. A marketplace clone on
 * disk is not installed, and counting its declared servers would invent
 * configuration the operator never chose.
 */
export function configuredMcpNames(
  claudeConfigPath: string,
  pluginsDir: string,
): ConfiguredMcpNames {
  const config = readJsonFile(claudeConfigPath);
  if (!config) throw new SourceMissingError("claude config", claudeConfigPath);

  const names: ConfiguredMcpName[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();

  const add = (name: string, origin: ConfiguredMcpOrigin, plugin?: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // The same server can appear in more than one source; the first sighting keeps
    // the origin, so a name in a settings file is never downgraded to a connector.
    const dedupeKey = `${origin}:${trimmed}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    names.push(plugin ? { name: trimmed, origin, plugin } : { name: trimmed, origin });
  };

  const objectKeys = (value: unknown): string[] =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
      : [];

  for (const name of objectKeys(config.mcpServers)) add(name, "user-config");

  const projects = config.projects;
  if (typeof projects === "object" && projects !== null && !Array.isArray(projects)) {
    for (const project of Object.values(projects as Record<string, unknown>)) {
      if (typeof project !== "object" || project === null) continue;
      for (const name of objectKeys((project as Record<string, unknown>).mcpServers)) {
        add(name, "project-config");
      }
    }
  }

  // Recorded as ever-connected rather than as currently enabled, which is why the
  // origin says so and the note repeats it.
  const connectors = config.claudeAiMcpEverConnected;
  if (Array.isArray(connectors)) {
    for (const entry of connectors) {
      if (typeof entry === "string") add(entry, "hosted-connector");
    }
  }

  try {
    const manifestPath = path.join(pluginsDir, "installed_plugins.json");
    const manifest = readJsonFile(manifestPath);
    if (!manifest) {
      unreadable.push(manifestPath);
    } else {
      const raw = manifest.plugins;
      const entries =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? Object.entries(raw as Record<string, Array<{ installPath?: string }>>)
          : [];
      for (const [key, installs] of entries) {
        const pluginName = key.split("@")[0] ?? key;
        for (const install of Array.isArray(installs) ? installs : []) {
          if (typeof install?.installPath !== "string") continue;
          for (const server of pluginDeclaredServers(install.installPath)) {
            add(server, "plugin", pluginName);
          }
        }
      }
    }
  } catch (err) {
    // One unreadable plugin store must not blank the other three sources, but the
    // gap is reported rather than hidden.
    unreadable.push(`${pluginsDir}: ${String(err)}`);
  }

  const counts: Record<ConfiguredMcpOrigin, number> = {
    "user-config": 0,
    "project-config": 0,
    "hosted-connector": 0,
    plugin: 0,
  };
  for (const entry of names) counts[entry.origin] += 1;

  return {
    names,
    counts,
    unreadable,
    note:
      "Four sources, and they do not make the same claim. A name from a settings " +
      "file is configured now. A hosted connector is one the client records as ever " +
      "having connected, which is not the same as enabled today, so a connector " +
      "appearing here is weaker evidence than a file entry. Plugin-supplied names " +
      "come only from plugins the install manifest lists, never from a marketplace " +
      "clone sitting on disk.",
  };
}
