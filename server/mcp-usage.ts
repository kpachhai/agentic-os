import {
  listSubagentTranscriptFiles,
  listTranscriptFiles,
  scanCached,
  streamTranscript,
  type TranscriptRecord,
} from "./transcripts.js";

/**
 * Which MCP servers actually get called, as opposed to which ones are configured.
 *
 * Every configured server ships its tool definitions into the context window before
 * the operator types a word, so the weight of one that is never called is paid on
 * every single turn. The configured list alone cannot say which those are; the
 * transcripts can, because a call leaves a record. So this counts calls from the
 * history already on disk and hands the result to a join against the configured
 * names, which produces the list worth acting on: configured and never called.
 *
 * Calls made inside a subagent are counted too, and counted apart. A tool a
 * subagent invoked was still invoked, so leaving those out would report a server
 * that only ever gets used by delegated work as never called - wrong in the
 * direction that produces bad advice. But a subagent is not a session, so folding
 * its calls into the session figures would inflate numbers a reader takes to mean
 * "what I did in this session". Hence two counts everywhere one would do.
 *
 * A call count is a count of calls. It is not a cost and cannot be turned into one
 * here: the tokens a server spends are mostly its tool definitions, which are
 * charged whether or not anything calls them, and nothing in a transcript
 * attributes those tokens to a server. So nothing in this module is priced.
 */

/** Tool names Claude Code gives MCP tools: mcp__<server>__<tool>. */
const TOOL_NAME_PREFIX = "mcp__";

/**
 * The delimiter between the three parts of an MCP tool name is a DOUBLE
 * underscore, and that detail is the whole parser.
 *
 * A server name routinely contains single underscores of its own - a hosted
 * connector's display name arrives with its spaces and dots flattened onto
 * underscores, and a plugin-provided server carries its plugin and server names
 * joined the same way. Splitting such a name on every underscore shreds it into
 * fragments and reports one server as several, each with a fraction of its calls.
 *
 * The tool part can also contain a double underscore in principle, so the split is
 * at the FIRST delimiter after the prefix and everything past it is the tool. That
 * asymmetry is deliberate: the server segment is the grouping key and has to be
 * exact, while the tool segment only has to round-trip as a label.
 */
const SEGMENT_DELIMITER = "__";

export type McpToolName = { server: string; tool: string };

/**
 * Split an MCP tool name into its server and tool, or null when the name is not
 * one.
 *
 * Null covers both a plain built-in tool name and a malformed MCP one. A caller
 * that gets null must not guess a server: an entry filed under a mangled name is
 * indistinguishable from a real server that nobody has heard of.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith(TOOL_NAME_PREFIX)) return null;
  const rest = name.slice(TOOL_NAME_PREFIX.length);

  const delimiterAt = rest.indexOf(SEGMENT_DELIMITER);
  // At index 0 the server segment is empty, and with no delimiter at all there is
  // no tool segment; neither is a name this module can attribute.
  if (delimiterAt <= 0) return null;

  const server = rest.slice(0, delimiterAt);
  const tool = rest.slice(delimiterAt + SEGMENT_DELIMITER.length);
  if (!tool) return null;
  return { server, tool };
}

/**
 * A comparison key that survives the several spellings one server has.
 *
 * The same server appears as a tool-name segment with punctuation flattened onto
 * underscores, as a configuration key with its original punctuation, and as a
 * display name with spaces and dots. Lowercasing and collapsing every run of
 * non-alphanumeric characters onto a single underscore makes those spellings meet.
 *
 * Two configured servers whose names differ only in punctuation collide here and
 * would be reported as one. That is accepted for MATCHING - the alternative is
 * failing to match a server's own usage to itself, which lists a heavily used
 * server as never called - but it is never accepted for COUNTING: joinConfigured
 * keeps every supplied spelling of a collided key and reports the collision, so no
 * supplied name disappears from the counts because another one canonicalised the
 * same way.
 */
export function canonicalServerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Where a called server's name says it comes from.
 *
 * Claude Code does not name every server the way a local configuration file does.
 * A connector enabled on the account and a server a plugin brings with it both
 * arrive with the client's own namespace in front of the server's real name, and
 * that namespace is itself the evidence: a name carrying one cannot be a server
 * somebody wrote into the file a caller reads, and its absence from that file is
 * therefore not a sign that anything was removed. A "plain" name is the bare
 * spelling a configuration file uses.
 *
 * This is read off the name and nothing else, so it is evidence about provenance,
 * never proof of configuration. It is consulted only for a server that matched no
 * supplied name at all - a supplied name always wins, so an operator who does
 * configure a server under a namespaced spelling still matches normally.
 */
export type McpServerOrigin = "connector" | "plugin" | "plain";

/** Namespace the client puts in front of a connector enabled on the account. */
const CONNECTOR_SEGMENT_PREFIX = "claude_ai_";

/**
 * Namespace the client puts in front of a server a plugin supplies, as
 * plugin_<plugin>_<server>. Both inner names keep their own hyphens and only the
 * two joins are underscores, so a segment with exactly three underscore-delimited
 * parts can be separated and one with more cannot.
 */
const PLUGIN_SEGMENT_PREFIX = "plugin_";
const PLUGIN_SEGMENT_PARTS = 3;

export type McpServerNaming = {
  /** Comparison key of the segment exactly as the transcripts spell it. */
  key: string;
  origin: McpServerOrigin;
  /**
   * Comparison key of the server's own name with the client's namespace stripped,
   * or null when the name is plain or when the namespace cannot be told from the
   * name it wraps.
   *
   * This is the key that makes the join work at all for a namespaced server: a
   * configuration file names it without the namespace, so matching on the full
   * segment alone can never find it and files every one of its calls under
   * "nothing configured explains this". Null rather than a guess, because a
   * wrongly separated name matches a different server.
   */
  bareKey: string | null;
};

/** Read a called server segment for its comparison keys and its provenance. */
export function serverNaming(segment: string): McpServerNaming {
  const key = canonicalServerKey(segment);

  if (segment.startsWith(CONNECTOR_SEGMENT_PREFIX)) {
    const bare = canonicalServerKey(segment.slice(CONNECTOR_SEGMENT_PREFIX.length));
    return { key, origin: "connector", bareKey: bare || null };
  }

  if (segment.startsWith(PLUGIN_SEGMENT_PREFIX)) {
    const parts = segment.split("_");
    const serverPart = parts.length === PLUGIN_SEGMENT_PARTS ? parts[2] : undefined;
    const bare = serverPart ? canonicalServerKey(serverPart) : "";
    return { key, origin: "plugin", bareKey: bare || null };
  }

  return { key, origin: "plain", bareKey: null };
}

export type McpToolCount = {
  tool: string;
  /** Calls recorded in a session's own transcript. */
  calls: number;
  /** Calls recorded in a subagent transcript that session spawned. */
  subagentCalls: number;
};

export type McpServerUsage = {
  /** Server segment exactly as it appears in the tool names on disk. */
  server: string;
  /**
   * The readable name Claude Code uses for the same server, when the transcripts
   * happened to record one. Null is common and means nothing is wrong.
   */
  displayName: string | null;
  /** Calls recorded in sessions' own transcripts. Calls only; never a cost. */
  calls: number;
  /**
   * Calls recorded in subagent transcripts. Separate from `calls` because a
   * subagent is not a session, and present because a call a subagent made is
   * still a call.
   */
  subagentCalls: number;
  /** calls + subagentCalls; the figure servers are ranked by. */
  callsTotal: number;
  /**
   * Distinct tools of this server that were called, from either site. Counted per
   * server, so the same tool name on two servers is two tools, because it is.
   */
  distinctTools: number;
  /** Per-tool call counts, most called first. */
  tools: McpToolCount[];
  /**
   * Window of the calls, from both sites, normalised to ISO-8601 UTC; empty when
   * no call carried a usable timestamp.
   *
   * Normalised rather than echoed as written, because the two ends have to be
   * comparable with each other: a record stamped with a UTC offset instead of a
   * trailing Z sorts by its wall-clock digits and can otherwise land after a call
   * that really happened later, inverting the window it is supposed to describe.
   */
  firstUsedAt: string;
  lastUsedAt: string;
  /** Distinct sessions whose own transcript called it. */
  sessions: number;
  /** Distinct sessions whose subagents called it. */
  subagentSessions: number;
  /**
   * Encoded project directory names the calls came from, from either site.
   * Encoded rather than decoded because the encoding is not reversible; see
   * decodeProjectDir.
   */
  projects: string[];
};

export type McpUsageReport = {
  /** Most-called server first, ranked on callsTotal. */
  servers: McpServerUsage[];
  totals: {
    servers: number;
    /** Calls in sessions' own transcripts. */
    calls: number;
    /** Calls in subagent transcripts. */
    subagentCalls: number;
    callsTotal: number;
    /** Distinct server-and-tool pairs across every server. */
    distinctTools: number;
    /** Session transcript files read. */
    transcriptFilesScanned: number;
    /**
     * Distinct session ids among those files, which is the unit the per-server
     * `sessions` field also counts. It can be lower than the file count, and the
     * two are reported separately rather than one standing in for the other.
     */
    sessionsScanned: number;
    /** Distinct sessions with at least one MCP call in their own transcript. */
    sessionsWithCalls: number;
    /** Subagent transcript files read. */
    subagentFilesScanned: number;
    /** Distinct sessions whose subagents made at least one MCP call. */
    sessionsWithSubagentCalls: number;
    /**
     * How many times a tool name looked like an MCP name and could not be split.
     * One unrecognised name seen four times is four here and one in
     * unparsedNamesDistinct; the two are separate fields because a single count
     * cannot answer both "how much traffic went unattributed" and "how many
     * spellings does the convention now have".
     */
    unparsedNameOccurrences: number;
    /** Distinct such names, the length of unparsedToolNames. */
    unparsedNamesDistinct: number;
    /** Session transcript lines that could not be parsed; expected on a live session. */
    skippedLines: number;
    /**
     * Lines in delegated transcripts that did not parse as a record.
     *
     * Deliberately not described as a torn tail the way the mainline count is. Every
     * one of these observed on a real tree came from whole files that are not
     * transcripts at all - a plugin's hook log, sitting under a session directory -
     * so a high number here usually means a non-transcript file was walked rather
     * than that delegated history was lost. The count stays because the alternative
     * is dropping lines silently, but it does not license the mainline reading.
     */
    subagentSkippedLines: number;
  };
  /**
   * The distinct unparseable names themselves, from both sites, so a
   * naming-convention change shows up as a visible list rather than as a quiet
   * drop in call counts.
   */
  unparsedToolNames: string[];
  note: string;
};

type ToolTally = { calls: number; subagentCalls: number };

type ServerAccumulator = {
  server: string;
  calls: number;
  subagentCalls: number;
  tools: Map<string, ToolTally>;
  firstUsedAt: string;
  firstUsedAtMs: number;
  lastUsedAt: string;
  lastUsedAtMs: number;
  sessions: Set<string>;
  subagentSessions: Set<string>;
  projects: Set<string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string {
  return typeof source[key] === "string" ? (source[key] as string) : "";
}

/** An instant, kept both as the value to compare and as the string to render. */
type Instant = { iso: string; ms: number };

/**
 * The record's own timestamp, or null when it does not carry a usable one.
 *
 * Null rather than the current time: stamping now would make a call from months
 * ago read as one that just happened, which is the opposite of what a missing
 * timestamp means.
 *
 * The epoch value is carried alongside the rendered string because comparing the
 * strings is only sound when every one of them is in the same offset, and a
 * timestamp being parseable is no promise that it is.
 */
function recordTimestamp(record: TranscriptRecord): Instant | null {
  const raw = str(record, "timestamp");
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return { iso: new Date(ms).toISOString(), ms };
}

/**
 * Every tool_use name in one assistant record.
 *
 * Only tool_use blocks count. A tool name appearing in the prose of a text block -
 * a model discussing a tool, or a system notice listing the ones available -
 * is not a call, and counting those would inflate a quiet server into a busy one.
 */
function toolUseNames(record: TranscriptRecord): string[] {
  const message = asRecord(record.message);
  if (!message) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const names: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (str(block, "type") !== "tool_use") continue;
    const name = str(block, "name");
    if (name) names.push(name);
  }
  return names;
}

function accumulatorFor(
  byServer: Map<string, ServerAccumulator>,
  server: string,
): ServerAccumulator {
  const existing = byServer.get(server);
  if (existing) return existing;
  const created: ServerAccumulator = {
    server,
    calls: 0,
    subagentCalls: 0,
    tools: new Map(),
    firstUsedAt: "",
    firstUsedAtMs: 0,
    lastUsedAt: "",
    lastUsedAtMs: 0,
    sessions: new Set(),
    subagentSessions: new Set(),
    projects: new Set(),
  };
  byServer.set(server, created);
  return created;
}

/** Widen the window on the compared instant, keeping the string that goes with it. */
function widenWindow(accumulator: ServerAccumulator, at: Instant): void {
  if (!accumulator.firstUsedAt || at.ms < accumulator.firstUsedAtMs) {
    accumulator.firstUsedAt = at.iso;
    accumulator.firstUsedAtMs = at.ms;
  }
  if (!accumulator.lastUsedAt || at.ms > accumulator.lastUsedAtMs) {
    accumulator.lastUsedAt = at.iso;
    accumulator.lastUsedAtMs = at.ms;
  }
}

/**
 * Remember the readable spelling of a server name for later display.
 *
 * Some records carry a top-level server attribution string, which holds the
 * readable form of a server name that the tool names only carry flattened. It is
 * used for that and for nothing else, because it is not a per-call marker: on a
 * real corpus it appears on several times as many records as there are calls, and
 * on a single record it sometimes names a different server than the tool that
 * record actually invoked. Counting it would put a number under a label it does
 * not mean, so calls come from tool_use blocks alone.
 */
function rememberDisplayName(
  displayNames: Map<string, string>,
  record: TranscriptRecord,
): void {
  const attributed = str(record, "attributionMcpServer");
  if (!attributed) return;
  const key = canonicalServerKey(attributed);
  if (!key || displayNames.has(key)) return;
  displayNames.set(key, attributed);
}

function toUsage(
  accumulator: ServerAccumulator,
  displayNames: Map<string, string>,
): McpServerUsage {
  const tools: McpToolCount[] = [...accumulator.tools.entries()]
    .map(([tool, tally]) => ({
      tool,
      calls: tally.calls,
      subagentCalls: tally.subagentCalls,
    }))
    .sort(
      (a, b) =>
        b.calls + b.subagentCalls - (a.calls + a.subagentCalls) ||
        a.tool.localeCompare(b.tool),
    );

  return {
    server: accumulator.server,
    displayName: displayNames.get(canonicalServerKey(accumulator.server)) ?? null,
    calls: accumulator.calls,
    subagentCalls: accumulator.subagentCalls,
    callsTotal: accumulator.calls + accumulator.subagentCalls,
    distinctTools: tools.length,
    tools,
    firstUsedAt: accumulator.firstUsedAt,
    lastUsedAt: accumulator.lastUsedAt,
    sessions: accumulator.sessions.size,
    subagentSessions: accumulator.subagentSessions.size,
    projects: [...accumulator.projects].sort(),
  };
}

/**
 * Which transcript a call was found in. A subagent's transcript belongs to the
 * session that dispatched the work, so both sites attribute to a session id; what
 * differs is which counter the call lands in.
 */
type CallSite = "mainline" | "subagent";

/** One transcript to read, already attributed to the session that owns it. */
type ScanTarget = {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  sessionId: string;
  projectDir: string;
};

type ScanOutcome = {
  sessionIds: Set<string>;
  sessionIdsWithCalls: Set<string>;
  skippedLines: number;
};

/**
 * Everything one transcript contributes, with nothing about where it sits.
 *
 * Which session owns the file and whether it is delegated work are properties of
 * this request, not of the file's bytes, so they stay out of here and are applied
 * in the fold. That is what makes the scan shareable: the same transcript read
 * once answers for the mainline pass and, were it ever listed twice, would answer
 * identically both times.
 */
type ScannedCalls = {
  /** One entry per tool_use block naming a parseable MCP tool, in record order. */
  calls: Array<{ server: string; tool: string; at: Instant | null }>;
  /** Canonical key to readable spelling, first spelling in the file winning. */
  displayNames: Array<[string, string]>;
  /** Prefixed tool names that did not parse, with how often each appeared. */
  unparsed: Array<[string, number]>;
  skippedLines: number;
};

/** Identifies this module's scans in the shared per-file cache. */
const EXTRACTOR_ID = "mcp-usage";

/** Pull the MCP calls out of one transcript. */
function scanCalls(filePath: string): ScannedCalls {
  const calls: ScannedCalls["calls"] = [];
  const displayNames = new Map<string, string>();
  const unparsed = new Map<string, number>();
  let skippedLines = 0;

  for (const line of streamTranscript(filePath)) {
    if (!line.ok) {
      skippedLines++;
      continue;
    }
    const record = line.record;
    // tool_use blocks ride on assistant records. The matching user record
    // carries the tool_result instead, so restricting to assistant records is
    // what keeps one call from being counted twice.
    if (record.type !== "assistant") continue;

    rememberDisplayName(displayNames, record);

    const at = recordTimestamp(record);
    for (const name of toolUseNames(record)) {
      if (!name.startsWith(TOOL_NAME_PREFIX)) continue;
      const parsed = parseMcpToolName(name);
      if (!parsed) {
        unparsed.set(name, (unparsed.get(name) ?? 0) + 1);
        continue;
      }
      // One record can carry several tool_use blocks, and each one is a call.
      calls.push({ server: parsed.server, tool: parsed.tool, at });
    }
  }

  return {
    calls,
    displayNames: [...displayNames],
    unparsed: [...unparsed],
    skippedLines,
  };
}

function recordCall(
  accumulator: ServerAccumulator,
  tool: string,
  site: CallSite,
  target: ScanTarget,
  at: Instant | null,
): void {
  const tally = accumulator.tools.get(tool) ?? { calls: 0, subagentCalls: 0 };
  if (site === "mainline") {
    accumulator.calls++;
    tally.calls++;
    accumulator.sessions.add(target.sessionId);
  } else {
    accumulator.subagentCalls++;
    tally.subagentCalls++;
    accumulator.subagentSessions.add(target.sessionId);
  }
  accumulator.tools.set(tool, tally);
  accumulator.projects.add(target.projectDir);
  if (at) widenWindow(accumulator, at);
}

/** Fold one set of transcripts into the shared accumulators. */
function scanTranscripts(
  targets: ScanTarget[],
  site: CallSite,
  byServer: Map<string, ServerAccumulator>,
  displayNames: Map<string, string>,
  unparsed: Map<string, number>,
): ScanOutcome {
  const sessionIds = new Set<string>();
  const sessionIdsWithCalls = new Set<string>();
  let skippedLines = 0;

  for (const target of targets) {
    sessionIds.add(target.sessionId);
    // A live session can rotate a transcript between the listing and the read.
    // The session still counts as scanned - it was listed - but it contributes
    // nothing, which is what it did.
    const scanned = scanCached(target, EXTRACTOR_ID, scanCalls);
    if (scanned === null) continue;

    // Every number below is read off the scan rather than incremented where the
    // file is read, so a warm call reports the same corpus as a cold one.
    skippedLines += scanned.skippedLines;
    for (const [key, spelling] of scanned.displayNames) {
      if (!displayNames.has(key)) displayNames.set(key, spelling);
    }
    for (const [name, count] of scanned.unparsed) {
      unparsed.set(name, (unparsed.get(name) ?? 0) + count);
    }
    for (const call of scanned.calls) {
      const accumulator = accumulatorFor(byServer, call.server);
      recordCall(accumulator, call.tool, site, target, call.at);
    }
    if (scanned.calls.length > 0) sessionIdsWithCalls.add(target.sessionId);
  }

  return { sessionIds, sessionIdsWithCalls, skippedLines };
}

/**
 * Count MCP tool calls across the whole transcript tree.
 *
 * The whole tree on purpose, rather than the most recent sessions. The question
 * this feeds is "which server has never been called", and a scan of the last
 * handful of sessions would answer it wrongly for anything used monthly. A full
 * pass over a working machine's corpus took roughly two and a half seconds when this
 * was written, over about 180 mainline and 400 delegated transcripts, which is the
 * price of the claim being true. Treat that figure as the order of magnitude rather
 * than a measurement: it grows with the operator's history, and it doubled once
 * delegated transcripts were included.
 *
 * Both the session transcripts and the subagent transcripts nested beneath them
 * are read, for the same reason: a server called only by delegated work would
 * otherwise report as never called.
 *
 * Even so, "never called" only ever means "not in the transcripts still on disk".
 * Claude Code prunes old ones, so the window is the retained history and the scan
 * counts are reported alongside for that reason.
 */
export function mcpUsage(transcriptsDir: string): McpUsageReport {
  // listTranscriptFiles raises SourceMissingError naming the path when the tree is
  // absent or is not a directory, which is what makes this pillar report a missing
  // source the same way every other pillar does instead of an empty server list.
  const sessionFiles = listTranscriptFiles(transcriptsDir);
  const subagentScan = listSubagentTranscriptFiles(transcriptsDir);
  const subagentFiles = subagentScan.files;

  const byServer = new Map<string, ServerAccumulator>();
  const displayNames = new Map<string, string>();
  const unparsed = new Map<string, number>();

  const mainline = scanTranscripts(
    sessionFiles.map((file) => ({
      filePath: file.filePath,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
      sessionId: file.sessionId,
      projectDir: file.projectDir,
    })),
    "mainline",
    byServer,
    displayNames,
    unparsed,
  );
  const subagent = scanTranscripts(
    // A subagent transcript is attributed to the session that dispatched it, not
    // to its own file name: the reader's question is which of their sessions used
    // a server, and a subagent is not one of their sessions.
    subagentFiles.map((file) => ({
      filePath: file.filePath,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
      sessionId: file.ownerSessionId,
      projectDir: file.projectDir,
    })),
    "subagent",
    byServer,
    displayNames,
    unparsed,
  );

  const servers = [...byServer.values()]
    .map((accumulator) => toUsage(accumulator, displayNames))
    .sort((a, b) => b.callsTotal - a.callsTotal || a.server.localeCompare(b.server));

  const calls = servers.reduce((sum, entry) => sum + entry.calls, 0);
  const subagentCalls = servers.reduce((sum, entry) => sum + entry.subagentCalls, 0);

  return {
    servers,
    totals: {
      servers: servers.length,
      calls,
      subagentCalls,
      callsTotal: calls + subagentCalls,
      distinctTools: servers.reduce((sum, entry) => sum + entry.distinctTools, 0),
      transcriptFilesScanned: sessionFiles.length,
      sessionsScanned: mainline.sessionIds.size,
      sessionsWithCalls: mainline.sessionIdsWithCalls.size,
      subagentFilesScanned: subagentFiles.length,
      sessionsWithSubagentCalls: subagent.sessionIdsWithCalls.size,
      unparsedNameOccurrences: [...unparsed.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      unparsedNamesDistinct: unparsed.size,
      skippedLines: mainline.skippedLines,
      subagentSkippedLines: subagent.skippedLines,
    },
    unparsedToolNames: [...unparsed.keys()].sort(),
    note:
      "Counts are tool calls recorded in transcripts, not cost: a server's token " +
      "weight is mostly its tool definitions, which are charged on every turn " +
      "whether anything calls them or not. Calls a subagent made are counted " +
      "separately from calls a session made, never folded into them. A server " +
      "counts as never called when no call for it appears in the transcripts still " +
      "on disk.",
  };
}

/**
 * A configured server that was called, with every supplied spelling of its name.
 *
 * Names and called segments are both plural because neither side is guaranteed to
 * be one. Two supplied names can differ only in punctuation, and two segments on
 * disk can spell one server two ways; listing all of them is what keeps the counts
 * reconciling instead of quietly keeping the first of each.
 */
export type ConfiguredUsage = {
  /** Supplied configured names that mean this server, alphabetical. */
  configuredNames: string[];
  /** Called server segments that matched one of those names, most-called first. */
  usages: McpServerUsage[];
  /** Calls in sessions' own transcripts, across every segment above. */
  calls: number;
  /** Calls in subagent transcripts, across every segment above. */
  subagentCalls: number;
  /** calls + subagentCalls. */
  callsTotal: number;
  /**
   * True when at least one segment above matched only after the client's namespace
   * was stripped off it, rather than matching the recorded spelling outright.
   *
   * Flagged because it is the weaker of the two claims. A connector and a locally
   * configured server can carry the same bare name and still be two servers with
   * two context costs, so a match made on the stripped name alone could be joining
   * two things. Taking the match is still the better bet - refusing it files a
   * server in daily use under "never called" - but a reader who sees a surprising
   * row deserves to know which kind of match produced it.
   */
  matchedByStrippedNamespace: boolean;
};

/**
 * A called server the supplied list does not name, whose own name says where it
 * comes from.
 */
export type ProvidedElsewhere = {
  /** Which of the client's namespaces the server's name carries. */
  origin: Exclude<McpServerOrigin, "plain">;
  usage: McpServerUsage;
};

export type McpDecayReport = {
  /** Configured and called, most-called first. */
  usedAndConfigured: ConfiguredUsage[];
  /**
   * Configured and never called in the scanned history - the actionable list,
   * since each of these is paid for on every turn for nothing.
   *
   * Every supplied spelling appears, not one per server, so this list plus the
   * names inside usedAndConfigured accounts for every usable supplied name.
   */
  configuredNeverCalled: string[];
  /**
   * Called, absent from the supplied list, and named for the place it comes from:
   * a connector enabled on the account, or a server a named plugin supplies.
   *
   * These servers ARE configured. They are simply configured somewhere a caller
   * reading one configuration file does not see, and their names say so. On a
   * working machine this is the large bucket by far, which is exactly why it is
   * kept out of the one below: reporting these as unaccounted for would describe
   * most of the operator's real MCP traffic as a mystery.
   */
  calledProvidedElsewhere: ProvidedElsewhere[];
  /**
   * Called, absent from the supplied list, and carrying nothing that says where it
   * came from.
   *
   * This is a list to look into, never a removal to report. A plain name with no
   * configured entry is either a server the operator really did remove or one
   * configured in a file the caller did not read, and nothing in a transcript can
   * tell those apart. The calls happened either way, so the history is kept rather
   * than dropped; discarding it would make these totals disagree with the usage
   * report they came from.
   */
  calledUnaccounted: McpServerUsage[];
  /**
   * Groups of supplied names that share one comparison key, so a fold is visible
   * instead of silent. Matching has to treat them as one server; counting must not,
   * and the caller usually wants to know it supplied one server twice.
   */
  configuredNameCollisions: string[][];
  /**
   * Supplied names with no alphanumeric character at all, which produce no
   * comparison key and so can never match or fail to match anything. Reported
   * rather than dropped, because a name silently ignored looks like a name that
   * was checked.
   */
  configuredNamesUnusable: string[];
  stats: {
    /** Distinct usable configured names supplied by the caller. */
    configuredNames: number;
    /**
     * Distinct servers those names describe. Lower than configuredNames when two
     * supplied spellings collapse onto one comparison key.
     */
    configuredServers: number;
    /** Supplied names whose server was called; adds up with the next field. */
    configuredNamesCalled: number;
    configuredNamesNeverCalled: number;
    /** Called server segments; adds up with the three fields after it. */
    calledServers: number;
    calledServersConfigured: number;
    /**
     * Of those, how many matched only once the client's namespace was stripped off
     * the recorded name. Reported because it is the weaker claim; see
     * ConfiguredUsage.matchedByStrippedNamespace.
     */
    calledServersMatchedByStrippedNamespace: number;
    calledServersProvidedElsewhere: number;
    calledServersUnaccounted: number;
    /** Calls in sessions' own transcripts, by bucket. */
    callsConfigured: number;
    callsProvidedElsewhere: number;
    callsUnaccounted: number;
    /** Calls in subagent transcripts, by the same buckets. */
    subagentCallsConfigured: number;
    subagentCallsProvidedElsewhere: number;
    subagentCallsUnaccounted: number;
  };
  note: string;
};

function sumCalls(usages: McpServerUsage[]): {
  calls: number;
  subagentCalls: number;
} {
  return {
    calls: usages.reduce((sum, usage) => sum + usage.calls, 0),
    subagentCalls: usages.reduce((sum, usage) => sum + usage.subagentCalls, 0),
  };
}

function byCallsDescending(a: McpServerUsage, b: McpServerUsage): number {
  return b.callsTotal - a.callsTotal || a.server.localeCompare(b.server);
}

/**
 * Join recorded usage against the configured server names.
 *
 * The names are a parameter rather than something read here. Configuration lives
 * in several files and the caller already knows which of them apply on this
 * machine; a second reader in this module would be a second answer to that
 * question, free to disagree with the first.
 *
 * Matching is on the comparison key, and on the key of the server's own name once
 * the client's namespace is stripped, so a server configured under its bare name
 * still matches calls recorded under the namespaced spelling the client gives it.
 * Without that second key, every connector and every plugin-supplied server fails
 * to match by construction and its whole call history reads as unexplained.
 */
export function joinConfigured(
  usage: McpUsageReport,
  configuredServerNames: string[],
): McpDecayReport {
  // A blank entry names no server and the same name supplied twice is still one
  // name, so neither pads the count. Names that share a comparison key are all
  // kept under it: matching needs one server, the counts need every name.
  const namesByKey = new Map<string, string[]>();
  const seenNames = new Set<string>();
  const configuredNamesUnusable: string[] = [];
  let configuredNames = 0;

  for (const raw of configuredServerNames) {
    const name = raw.trim();
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    const key = canonicalServerKey(name);
    if (!key) {
      configuredNamesUnusable.push(name);
      continue;
    }
    configuredNames++;
    const sharing = namesByKey.get(key);
    if (sharing) sharing.push(name);
    else namesByKey.set(key, [name]);
  }

  const matchedByKey = new Map<string, McpServerUsage[]>();
  const calledProvidedElsewhere: ProvidedElsewhere[] = [];
  const calledUnaccounted: McpServerUsage[] = [];
  // Segments that only matched once the namespace was stripped, so the weaker kind
  // of match can be reported rather than passing for an exact one.
  const strippedMatches = new Set<string>();

  for (const server of usage.servers) {
    const naming = serverNaming(server.server);
    // A supplied name wins over anything the segment's own namespace suggests.
    let key: string | null = null;
    if (namesByKey.has(naming.key)) {
      key = naming.key;
    } else if (naming.bareKey && namesByKey.has(naming.bareKey)) {
      key = naming.bareKey;
      strippedMatches.add(server.server);
    }

    if (key !== null) {
      const matched = matchedByKey.get(key);
      if (matched) matched.push(server);
      else matchedByKey.set(key, [server]);
      continue;
    }

    if (naming.origin === "plain") calledUnaccounted.push(server);
    else calledProvidedElsewhere.push({ origin: naming.origin, usage: server });
  }

  const usedAndConfigured: ConfiguredUsage[] = [...matchedByKey.entries()]
    .map(([key, usages]) => {
      const ordered = [...usages].sort(byCallsDescending);
      const totals = sumCalls(ordered);
      return {
        configuredNames: [...(namesByKey.get(key) ?? [])].sort((a, b) =>
          a.localeCompare(b),
        ),
        usages: ordered,
        calls: totals.calls,
        subagentCalls: totals.subagentCalls,
        callsTotal: totals.calls + totals.subagentCalls,
        matchedByStrippedNamespace: ordered.some((entry) =>
          strippedMatches.has(entry.server),
        ),
      };
    })
    .sort(
      (a, b) =>
        b.callsTotal - a.callsTotal ||
        (a.configuredNames[0] ?? "").localeCompare(b.configuredNames[0] ?? ""),
    );

  // Nothing orders these by usage, because they have none; alphabetical keeps the
  // list stable between runs.
  const configuredNeverCalled = [...namesByKey.entries()]
    .filter(([key]) => !matchedByKey.has(key))
    .flatMap(([, names]) => names)
    .sort((a, b) => a.localeCompare(b));

  const configuredNamesCalled = usedAndConfigured.reduce(
    (sum, entry) => sum + entry.configuredNames.length,
    0,
  );
  const configuredCalls = sumCalls(usedAndConfigured.flatMap((entry) => entry.usages));
  const elsewhereCalls = sumCalls(calledProvidedElsewhere.map((entry) => entry.usage));
  const unaccountedCalls = sumCalls(calledUnaccounted);

  return {
    usedAndConfigured,
    configuredNeverCalled,
    calledProvidedElsewhere,
    calledUnaccounted,
    configuredNameCollisions: [...namesByKey.values()]
      .filter((names) => names.length > 1)
      .map((names) => [...names].sort((a, b) => a.localeCompare(b)))
      .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")),
    configuredNamesUnusable: [...configuredNamesUnusable].sort((a, b) =>
      a.localeCompare(b),
    ),
    stats: {
      configuredNames,
      configuredServers: namesByKey.size,
      configuredNamesCalled,
      configuredNamesNeverCalled: configuredNeverCalled.length,
      calledServers: usage.servers.length,
      calledServersConfigured: usedAndConfigured.reduce(
        (sum, entry) => sum + entry.usages.length,
        0,
      ),
      calledServersMatchedByStrippedNamespace: strippedMatches.size,
      calledServersProvidedElsewhere: calledProvidedElsewhere.length,
      calledServersUnaccounted: calledUnaccounted.length,
      callsConfigured: configuredCalls.calls,
      callsProvidedElsewhere: elsewhereCalls.calls,
      callsUnaccounted: unaccountedCalls.calls,
      subagentCallsConfigured: configuredCalls.subagentCalls,
      subagentCallsProvidedElsewhere: elsewhereCalls.subagentCalls,
      subagentCallsUnaccounted: unaccountedCalls.subagentCalls,
    },
    note:
      "Configured names come from the caller, not from any file read here. Never " +
      "called means no call appears in the scanned transcripts, from a session or " +
      "from a subagent. A called server absent from the supplied list is sorted by " +
      "what its own name says: a connector or plugin namespace means it is " +
      "configured somewhere the caller did not read, and a plain name with no " +
      "entry means only that nothing here explains it - which covers both a server " +
      "the operator removed and one configured in a file the caller did not read.",
  };
}
