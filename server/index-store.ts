import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import { allThoughts, getThought } from "./engram.js";
import { readFrictionLog } from "./friction.js";
import { operatorProse, stripAnsi, titleLine } from "./sessions.js";
import { listTranscriptFiles, streamTranscript } from "./transcripts.js";
import { getWrap, listWraps } from "./wraps.js";

/**
 * A rebuildable search index over everything this tool can read.
 *
 * THE INVARIANT THAT MAKES THIS COMPATIBLE WITH OWNING NO DATA: this file is a
 * disposable cache. Deleting it loses nothing, it rebuilds from the files it
 * summarises, and every answer it gives must be reproducible by reading those
 * files directly. It is written under the install, never inside a data source,
 * and no source file is ever opened for writing.
 *
 * It exists because the alternative does not scale: session aggregates were
 * bounded to the newest few dozen transcripts, because parsing hundreds of
 * megabytes of JSONL per request is not something a page load can absorb.
 *
 * A schema change is handled by rebuilding rather than migrating. That is the
 * disposability claim being used rather than merely asserted: if the cache can
 * always be regenerated, a migration path is machinery with no purpose.
 */

/** Bump to invalidate every existing index. A mismatch triggers a full rebuild. */
const SCHEMA_VERSION = 1;

export type IndexedKind = "session" | "thought" | "friction" | "wrap";

export type IndexedDocument = {
  id: number;
  kind: IndexedKind;
  /** Identifier the owning pillar can resolve back to the real record. */
  ref: string;
  title: string;
  timestamp: string;
  /** Extra locator for kinds that need two parts, e.g. a session's project dir. */
  locator: string;
};

export type SearchHit = IndexedDocument & {
  /** Lower is better; this is bm25's convention and it is not rescaled. */
  score: number;
  excerpt: string;
};

export type SyncReport = {
  filesScanned: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRemoved: number;
  documents: number;
  rebuilt: boolean;
  elapsedMs: number;
};

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id        INTEGER PRIMARY KEY,
      kind      TEXT NOT NULL,
      ref       TEXT NOT NULL,
      locator   TEXT NOT NULL DEFAULT '',
      title     TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL,
      UNIQUE(kind, ref, locator)
    );

    CREATE INDEX IF NOT EXISTS documents_file ON documents(file_path);
    CREATE INDEX IF NOT EXISTS documents_kind ON documents(kind);

    -- Tracks the identity of each source file so a sync can tell what changed
    -- without reparsing everything. Identity is mtime AND size: mtime alone can
    -- be preserved by a tool that rewrites a file in place.
    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path  TEXT PRIMARY KEY,
      mtime_ms   REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );

    -- rowid is kept equal to documents.id so the two join without a mapping table.
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
      USING fts5(title, body, tokenize='porter unicode61');
  `);
}

function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * Open the index, creating it if absent and rebuilding it if its schema is stale.
 *
 * WAL is off deliberately. This database has exactly one writer and lives beside
 * the install, so the extra files WAL brings buy nothing here; the read-only WAL
 * handling elsewhere in this tool exists for a database somebody else writes.
 */
export function openIndex(indexPath: string): Database.Database {
  ensureParentDir(indexPath);
  let db = new Database(indexPath);
  db.pragma("journal_mode = TRUNCATE");
  db.pragma("synchronous = NORMAL");
  applySchema(db);

  const found = readMeta(db, "schema_version");
  if (found !== null && Number(found) !== SCHEMA_VERSION) {
    // Rebuild rather than migrate. Nothing here is authoritative, so throwing it
    // away costs one re-read and removes a whole class of migration bugs.
    db.close();
    fs.rmSync(indexPath, { force: true });
    db = new Database(indexPath);
    db.pragma("journal_mode = TRUNCATE");
    applySchema(db);
  }
  writeMeta(db, "schema_version", String(SCHEMA_VERSION));
  return db;
}

/**
 * A handle that survives its own file being deleted.
 *
 * This exists because of what the disposability promise actually invites: if the
 * operator is told they may delete this cache at any time, then deleting it while
 * the server is running has to work. SQLite notices when an open database has been
 * unlinked and refuses all further writes with SQLITE_READONLY_DBMOVED, so a bare
 * long-lived connection makes the promise true only while nothing is using it -
 * which is the opposite of useful. Every operation therefore goes through here,
 * and a vanished file is reopened and retried once rather than surfacing as a 500.
 */
export type IndexHandle = {
  run: <T>(operation: (db: Database.Database) => T) => T;
  close: () => void;
};

/** SQLite's signals that the file behind an open connection is gone. */
function isFileVanished(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? "";
  return (
    code === "SQLITE_READONLY_DBMOVED" ||
    code === "SQLITE_READONLY_DIRECTORY" ||
    code === "SQLITE_CANTOPEN" ||
    code === "SQLITE_NOTADB"
  );
}

export function createIndexHandle(indexPath: string): IndexHandle {
  let db: Database.Database | null = null;

  const handle = (): Database.Database => {
    if (!db) db = openIndex(indexPath);
    return db;
  };

  const discard = (): void => {
    try {
      db?.close();
    } catch {
      // A connection whose file is gone can fail to close cleanly; dropping the
      // reference is what matters, and the next call opens a fresh one.
    }
    db = null;
  };

  return {
    run: <T,>(operation: (database: Database.Database) => T): T => {
      try {
        return operation(handle());
      } catch (err) {
        if (!isFileVanished(err)) throw err;
        discard();
        return operation(handle());
      }
    },
    close: discard,
  };
}

type PendingDocument = {
  kind: IndexedKind;
  ref: string;
  locator: string;
  title: string;
  timestamp: string;
  filePath: string;
  body: string;
};

/**
 * The searchable text of one session.
 *
 * Only the operator's own prompts and the session title are indexed, not
 * assistant output. That is a deliberate recall-for-size trade: assistant text is
 * the overwhelming majority of a transcript's bytes, and indexing it would grow
 * this cache to the order of the corpus it summarises. Prompts are what the
 * operator remembers writing, so they are what a search for a half-remembered
 * session actually matches on. The limit is worth knowing: a phrase that appeared
 * only in a reply will not be found here.
 */
function sessionDocument(file: {
  filePath: string;
  sessionId: string;
  projectDir: string;
}): PendingDocument | null {
  let title = "";
  let firstPrompt = "";
  let firstTimestamp = "";
  const prompts: string[] = [];

  for (const line of streamTranscript(file.filePath)) {
    if (!line.ok) continue;
    const record = line.record;

    if (record.type === "ai-title") {
      const aiTitle = record.aiTitle;
      if (typeof aiTitle === "string" && aiTitle) title = aiTitle;
      continue;
    }
    if (record.type !== "user") continue;
    if (record.isMeta === true || record.isSidechain === true) continue;

    const timestamp = record.timestamp;
    if (typeof timestamp === "string" && !firstTimestamp) firstTimestamp = timestamp;

    const message = record.message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as { content?: unknown }).content;

    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => block.text)
        .join("\n");
    }
    // Escapes are noise wherever they land, so the searchable body loses them
    // too. Markdown markers and command envelopes are left in the body on
    // purpose: the body is what a query matches against, and a prompt the
    // operator wrote as a document should still be findable by its own words.
    text = stripAnsi(text);
    if (!text.trim()) continue;
    prompts.push(text);
    if (!firstPrompt) firstPrompt = operatorProse(text);
  }

  // A hit's title is a label, held to the same rule as a session title, or the
  // search results read as a wall of `# HANDOFF` and `<command-name>` fragments.
  // Indexability is decided by whether there is anything to search, not by
  // whether a label could be made: a session whose only prompts are command
  // envelopes still has a body worth matching, and falls back to its id the way
  // the session list does.
  const promptTitle = titleLine(firstPrompt);
  if (!title && prompts.length === 0) return null;
  return {
    kind: "session",
    ref: file.sessionId,
    locator: file.projectDir,
    title: (title || promptTitle || file.sessionId)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140),
    timestamp: firstTimestamp,
    filePath: file.filePath,
    body: prompts.join("\n\n"),
  };
}

/**
 * The vault, loaded once and keyed by file path.
 *
 * This map exists for a performance reason worth stating: the vault reader
 * re-reads every file in the vault on each call, by design, so that an edit on
 * disk is always visible. Calling it once per file during a sync therefore costs
 * the whole vault per file - quadratic, and ruinous at a few hundred entries. One
 * pass up front keeps the reader as the only thing that parses a thought while
 * making a sync linear.
 */
type SyncContext = { thoughtsByPath: Map<string, ReturnType<typeof getThought>> };

function loadThoughtsByPath(config: AppConfig): SyncContext["thoughtsByPath"] {
  const byPath = new Map<string, ReturnType<typeof getThought>>();
  try {
    // One pass over the vault. Asking for thoughts individually re-reads every
    // file per lookup, which at a few hundred entries costs more than the rest of
    // a sync put together.
    for (const thought of allThoughts(config.engramVaultPath)) {
      byPath.set(thought.path, thought);
    }
  } catch {
    // No vault on this machine; the map stays empty and no thought is indexed.
  }
  return byPath;
}

/** Every document a given source file currently contributes. */
function documentsForFile(
  config: AppConfig,
  context: SyncContext,
  kind: IndexedKind,
  filePath: string,
): PendingDocument[] {
  if (kind === "session") {
    const sessionId = path.basename(filePath, ".jsonl");
    const projectDir = path.basename(path.dirname(filePath));
    const doc = sessionDocument({ filePath, sessionId, projectDir });
    return doc ? [doc] : [];
  }

  if (kind === "thought") {
    const full = context.thoughtsByPath.get(filePath);
    if (!full) return [];
    return [
      {
        kind: "thought",
        ref: full.id,
        locator: "",
        title: full.title,
        timestamp: full.timestamp,
        filePath,
        body: [full.description, full.body].filter(Boolean).join("\n\n"),
      },
    ];
  }

  if (kind === "wrap") {
    const id = path.basename(filePath, ".md");
    const wrap = getWrap(config.wrapsDir, id);
    if (!wrap) return [];
    return [
      {
        kind: "wrap",
        ref: wrap.id,
        locator: "",
        title: wrap.title,
        timestamp: wrap.date,
        filePath,
        body: [wrap.description, wrap.body].filter(Boolean).join("\n\n"),
      },
    ];
  }

  // The friction log is one file holding many entries, so a single source file
  // maps to many documents. The entry's date and text form its identity, since
  // the log carries no ids of its own.
  const entries = readFrictionLog(filePath, config.frictionResolveWindowDays);
  return entries.map((entry, position) => ({
    kind: "friction" as const,
    ref: `${entry.date}#${position}`,
    locator: entry.type,
    title: `[${entry.type}] ${entry.text.slice(0, 100)}`,
    timestamp: entry.date,
    filePath,
    body: [entry.text, entry.supersedes ?? "", entry.resolvedBy?.text ?? ""]
      .filter(Boolean)
      .join("\n"),
  }));
}

/** Source files worth indexing, paired with the kind each produces. */
function indexableFiles(
  config: AppConfig,
  context: SyncContext,
): Array<{ kind: IndexedKind; filePath: string; mtimeMs: number; sizeBytes: number }> {
  const out: Array<{
    kind: IndexedKind;
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
  }> = [];

  const addFile = (kind: IndexedKind, filePath: string): void => {
    try {
      const stat = fs.statSync(filePath);
      out.push({ kind, filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    } catch {
      // Vanished between listing and stat: a live process rewrote it. Skipping is
      // correct; the next sync picks it up.
    }
  };

  // A missing source is not an error here. The index spans several pillars and
  // must build from whichever ones this machine actually has.
  try {
    for (const file of listTranscriptFiles(config.transcriptsDir)) {
      out.push({
        kind: "session",
        filePath: file.filePath,
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
      });
    }
  } catch {
    // No transcripts on this machine.
  }

  for (const thoughtPath of context.thoughtsByPath.keys()) {
    addFile("thought", thoughtPath);
  }

  try {
    for (const wrap of listWraps(config.wrapsDir)) addFile("wrap", wrap.path);
  } catch {
    // No wraps on this machine.
  }

  if (fs.existsSync(config.frictionLogPath)) addFile("friction", config.frictionLogPath);

  return out;
}

/**
 * Bring the index up to date with the files behind it.
 *
 * Incremental by file identity: a file whose mtime and size are unchanged is not
 * reparsed. A file that has disappeared has its documents removed, so a deleted
 * record cannot go on being findable - a search index that outlives its source is
 * a way to read something that no longer exists.
 */
export function syncIndex(db: Database.Database, config: AppConfig): SyncReport {
  const startedAt = Date.now();
  const context: SyncContext = { thoughtsByPath: loadThoughtsByPath(config) };
  const files = indexableFiles(config, context);
  const seen = new Set(files.map((file) => file.filePath));

  const knownRows = db
    .prepare("SELECT file_path, mtime_ms, size_bytes FROM indexed_files")
    .all() as Array<{ file_path: string; mtime_ms: number; size_bytes: number }>;
  const known = new Map(knownRows.map((row) => [row.file_path, row]));

  const deleteDocsForFile = db.prepare("DELETE FROM documents WHERE file_path = ?");
  const deleteFtsForDoc = db.prepare("DELETE FROM documents_fts WHERE rowid = ?");
  const selectDocIds = db.prepare("SELECT id FROM documents WHERE file_path = ?");
  const insertDoc = db.prepare(
    `INSERT INTO documents (kind, ref, locator, title, timestamp, file_path)
     VALUES (@kind, @ref, @locator, @title, @timestamp, @filePath)
     ON CONFLICT(kind, ref, locator) DO UPDATE SET
       title = excluded.title, timestamp = excluded.timestamp, file_path = excluded.file_path`,
  );
  const insertFts = db.prepare(
    "INSERT INTO documents_fts (rowid, title, body) VALUES (?, ?, ?)",
  );
  const upsertFile = db.prepare(
    `INSERT INTO indexed_files (file_path, mtime_ms, size_bytes, indexed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes,
       indexed_at = excluded.indexed_at`,
  );
  const deleteFile = db.prepare("DELETE FROM indexed_files WHERE file_path = ?");

  /** Drop a file's documents from both tables; FTS has no foreign keys. */
  const purgeFile = (filePath: string): void => {
    for (const row of selectDocIds.all(filePath) as Array<{ id: number }>) {
      deleteFtsForDoc.run(row.id);
    }
    deleteDocsForFile.run(filePath);
  };

  let filesIndexed = 0;
  let filesUnchanged = 0;
  let filesRemoved = 0;

  const run = db.transaction(() => {
    for (const file of files) {
      const previous = known.get(file.filePath);
      if (
        previous &&
        previous.mtime_ms === file.mtimeMs &&
        previous.size_bytes === file.sizeBytes
      ) {
        filesUnchanged++;
        continue;
      }

      purgeFile(file.filePath);
      let docs: PendingDocument[] = [];
      try {
        docs = documentsForFile(config, context, file.kind, file.filePath);
      } catch (err) {
        // One unreadable file must not abort a whole sync; it simply contributes
        // nothing and will be retried when it next changes.
        console.warn(`index: skipping ${file.filePath}:`, err);
      }

      for (const doc of docs) {
        const result = insertDoc.run(doc);
        const id =
          result.lastInsertRowid !== 0
            ? Number(result.lastInsertRowid)
            : (
                db
                  .prepare(
                    "SELECT id FROM documents WHERE kind = ? AND ref = ? AND locator = ?",
                  )
                  .get(doc.kind, doc.ref, doc.locator) as { id: number }
              ).id;
        deleteFtsForDoc.run(id);
        insertFts.run(id, doc.title, doc.body);
      }

      upsertFile.run(file.filePath, file.mtimeMs, file.sizeBytes, new Date().toISOString());
      filesIndexed++;
    }

    for (const filePath of known.keys()) {
      if (seen.has(filePath)) continue;
      purgeFile(filePath);
      deleteFile.run(filePath);
      filesRemoved++;
    }
  });
  run();

  const documents = (
    db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }
  ).n;
  writeMeta(db, "last_synced_at", new Date().toISOString());

  return {
    filesScanned: files.length,
    filesIndexed,
    filesUnchanged,
    filesRemoved,
    documents,
    rebuilt: knownRows.length === 0,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Escape a user query into a single FTS5 phrase-or-prefix expression.
 *
 * FTS5's MATCH argument is a query language, not a string: a bare quote, hyphen or
 * NEAR would be parsed as syntax and either error or mean something the reader did
 * not type. Each word is quoted and given a prefix wildcard, and the words are
 * ANDed, so "more words" keeps meaning "fewer results".
 */
export function toMatchExpression(query: string): string | null {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((word) => word.replace(/-+$/, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  // The inner escape is belt-and-braces: splitting on non-word characters has
  // already discarded any quote, so no term can contain one. It stays because the
  // safety of this function should not depend on reading the tokenizer above.
  return words.map((word) => `"${word.replace(/"/g, '""')}"*`).join(" AND ");
}

export type SearchOptions = { kind?: IndexedKind; limit?: number };

/** Full-text search across every indexed pillar, best match first. */
export function searchIndex(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const expression = toMatchExpression(query);
  if (!expression) return [];
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);

  const rows = db
    .prepare(
      `SELECT d.id, d.kind, d.ref, d.locator, d.title, d.timestamp,
              bm25(documents_fts, 4.0, 1.0) AS score,
              snippet(documents_fts, 1, '[', ']', '...', 14) AS excerpt
         FROM documents_fts
         JOIN documents d ON d.id = documents_fts.rowid
        WHERE documents_fts MATCH ?
          ${options.kind ? "AND d.kind = ?" : ""}
        ORDER BY score
        LIMIT ?`,
    )
    .all(
      ...(options.kind ? [expression, options.kind, limit] : [expression, limit]),
    ) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind as IndexedKind,
    ref: String(row.ref),
    locator: String(row.locator ?? ""),
    title: String(row.title),
    timestamp: String(row.timestamp ?? ""),
    score: Number(row.score),
    excerpt: String(row.excerpt ?? ""),
  }));
}

export type IndexStats = {
  path: string;
  exists: boolean;
  sizeBytes: number;
  documents: number;
  byKind: Record<string, number>;
  files: number;
  lastSyncedAt: string | null;
  schemaVersion: number;
};

export function indexStats(db: Database.Database, indexPath: string): IndexStats {
  const byKind: Record<string, number> = {};
  for (const row of db
    .prepare("SELECT kind, COUNT(*) AS n FROM documents GROUP BY kind")
    .all() as Array<{ kind: string; n: number }>) {
    byKind[row.kind] = row.n;
  }

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(indexPath).size;
  } catch {
    // A freshly opened index may not have been flushed to disk yet.
  }

  return {
    path: indexPath,
    exists: fs.existsSync(indexPath),
    sizeBytes,
    documents: (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n,
    byKind,
    files: (db.prepare("SELECT COUNT(*) AS n FROM indexed_files").get() as { n: number }).n,
    lastSyncedAt: readMeta(db, "last_synced_at"),
    schemaVersion: SCHEMA_VERSION,
  };
}
