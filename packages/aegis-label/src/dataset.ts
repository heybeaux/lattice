/**
 * [E] Dataset writer (scope §[E], label-spec §7).
 *
 * Appends frozen rows to a JSONL training store PLUS a SQLite index keyed on
 * `(signalDate, severity)` — the dimensions the nightly bake's walk-forward folds
 * slice on. Idempotent on `decisionEventId` — re-running the resolver must never
 * double-write. Every row carries `dataSource` ('real' | 'synthetic') and
 * `schemaVersion` (the honesty requirement, scope §7).
 *
 * The SQLite index uses Node's built-in `node:sqlite` (DatabaseSync) — no native
 * add-on dependency, so `pnpm install` stays clean. It is opt-in via
 * `DatasetStore`'s `sqliteIndexPath`; JSONL remains the source of truth and the
 * default in-memory index is always maintained for fast fold queries.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { FrozenRow } from './types.js';
import { SCHEMA_VERSION } from './types.js';

/**
 * Minimal local type for the `node:sqlite` built-in (Node >=22.5, experimental).
 * Typed locally to avoid a hard @types dependency on the experimental module;
 * the surface we use is tiny and stable.
 */
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}
interface DatabaseSyncCtor {
  new (path: string): DatabaseSync;
}

/**
 * Lazily load `node:sqlite` only when the opt-in SQLite index is requested.
 * This keeps the package's Node-20 floor honest for the JSONL-only path (the
 * source of truth); only the optional index requires Node >=22.5.
 */
function loadDatabaseSync(): DatabaseSyncCtor {
  const require = createRequire(import.meta.url);
  try {
    return (require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
  } catch (err) {
    throw new Error(
      'sqliteIndexPath was set but node:sqlite is unavailable (requires Node >=22.5). ' +
        'Omit sqliteIndexPath to use the JSONL store alone. Cause: ' +
        String(err),
    );
  }
}

/** Read the set of decisionEventIds already present in a JSONL store. */
export function readExistingIds(path: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(path)) return ids;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<FrozenRow>;
      if (typeof parsed.decisionEventId === 'string') {
        ids.add(parsed.decisionEventId);
      }
    } catch {
      // Skip malformed lines rather than corrupt the dedup set.
    }
  }
  return ids;
}

/** Stamp schemaVersion on a frozen row if missing (defensive). */
function withSchema(row: FrozenRow): FrozenRow {
  return row.schemaVersion === SCHEMA_VERSION
    ? row
    : { ...row, schemaVersion: SCHEMA_VERSION };
}

export interface AppendResult {
  /** Rows actually written (new decisionEventIds). */
  written: number;
  /** Rows skipped because their decisionEventId already existed. */
  skipped: number;
}

/**
 * Append frozen rows to the JSONL store at `path`, idempotent on
 * `decisionEventId`. Dedups against both existing file contents AND duplicates
 * within the input batch.
 */
export function appendRows(path: string, rows: FrozenRow[]): AppendResult {
  const existing = readExistingIds(path);
  const lines: string[] = [];
  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    if (existing.has(row.decisionEventId)) {
      skipped += 1;
      continue;
    }
    existing.add(row.decisionEventId);
    lines.push(JSON.stringify(withSchema(row)));
    written += 1;
  }

  if (lines.length > 0) {
    appendFileSync(path, lines.join('\n') + '\n', 'utf8');
  }

  return { written, skipped };
}

/** Serialize frozen rows to a JSONL string (for in-memory / non-fs callers). */
export function serializeRows(rows: FrozenRow[]): string {
  return rows.map((r) => JSON.stringify(withSchema(r))).join('\n') + '\n';
}

/** Composite key for the walk-forward index: (signalDate, severity). */
function indexKey(signalDate: string, severity: string): string {
  return `${signalDate}\u0000${severity}`;
}

/** Construction options for {@link DatasetStore}. */
export interface DatasetStoreOptions {
  /**
   * JSONL file path (the source of truth). When set, the store hydrates its
   * dedup set from the file on construction and appends to it on write. Omit for
   * a pure in-memory store (tests / non-fs callers).
   */
  path?: string;
  /**
   * SQLite index file path. When set, the `(signalDate, severity)` walk-forward
   * index is persisted to a SQLite DB (built-in `node:sqlite`) in addition to
   * the in-memory index — so the nightly bake can slice folds without replaying
   * the whole JSONL. Use `':memory:'` for an ephemeral SQLite index. Omit to
   * skip SQLite entirely.
   */
  sqliteIndexPath?: string;
}

/**
 * The training store (scope §[E], label-spec §7): a JSONL writer plus a
 * `(signalDate, severity)` index — the dimensions the nightly bake's walk-forward
 * folds slice on. The index is held in memory and, when `sqliteIndexPath` is set,
 * mirrored into a SQLite table (built-in `node:sqlite`, no native dep) for the
 * bake to query directly. Append is idempotent on `decisionEventId` (re-running
 * the resolver must never double-write), deduping against the existing JSONL file,
 * the SQLite index, AND prior in-session appends.
 */
export class DatasetStore {
  /** Decision ids already written (dedup set). */
  private readonly ids = new Set<string>();
  /** (signalDate, severity) → frozen rows, for walk-forward fold selection. */
  private readonly index = new Map<string, FrozenRow[]>();
  private readonly path: string | undefined;
  private readonly db: DatabaseSync | undefined;

  constructor(options: DatasetStoreOptions | string = {}) {
    // Back-compat: a bare string arg is the JSONL path (prior signature).
    const opts: DatasetStoreOptions =
      typeof options === 'string' ? { path: options } : options;
    this.path = opts.path;

    if (opts.sqliteIndexPath !== undefined) {
      const DatabaseSync = loadDatabaseSync();
      this.db = new DatabaseSync(opts.sqliteIndexPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dataset_index (
          decision_event_id TEXT PRIMARY KEY,
          signal_date       TEXT NOT NULL,
          severity          TEXT NOT NULL,
          data_source       TEXT NOT NULL,
          schema_version    INTEGER NOT NULL,
          row_json          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dataset_fold
          ON dataset_index(signal_date, severity);
      `);
      // Hydrate dedup + in-memory index from the persisted SQLite index.
      this.hydrateFromSqlite();
    }

    if (this.path !== undefined) {
      for (const id of readExistingIds(this.path)) this.ids.add(id);
    }
  }

  private hydrateFromSqlite(): void {
    if (this.db === undefined) return;
    const rows = this.db
      .prepare(`SELECT row_json FROM dataset_index`)
      .all() as Array<{ row_json: string }>;
    for (const r of rows) {
      const row = JSON.parse(r.row_json) as FrozenRow;
      this.ids.add(row.decisionEventId);
      this.indexInMemory(row);
    }
  }

  private indexInMemory(row: FrozenRow): void {
    const key = indexKey(row.signalDate, row.features.ruleSeverityMax);
    const bucket = this.index.get(key) ?? [];
    bucket.push(row);
    this.index.set(key, bucket);
  }

  /** True iff a row with this decisionEventId has already been stored. */
  has(decisionEventId: string): boolean {
    return this.ids.has(decisionEventId);
  }

  /**
   * Append frozen rows. Idempotent on `decisionEventId`: existing ids are
   * skipped. New rows are written to JSONL (when a path is set), inserted into
   * the SQLite index (when configured), AND added to the in-memory
   * `(signalDate, severity)` index.
   */
  append(rows: FrozenRow[]): AppendResult {
    const toWrite: FrozenRow[] = [];
    let skipped = 0;

    for (const row of rows) {
      if (this.ids.has(row.decisionEventId)) {
        skipped += 1;
        continue;
      }
      const stamped = withSchema(row);
      this.ids.add(stamped.decisionEventId);
      toWrite.push(stamped);
      this.indexInMemory(stamped);
    }

    if (this.path !== undefined && toWrite.length > 0) {
      appendFileSync(
        this.path,
        toWrite.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8',
      );
    }

    if (this.db !== undefined && toWrite.length > 0) {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO dataset_index (
           decision_event_id, signal_date, severity,
           data_source, schema_version, row_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of toWrite) {
        insert.run(
          r.decisionEventId,
          r.signalDate,
          r.features.ruleSeverityMax,
          r.dataSource,
          r.schemaVersion,
          JSON.stringify(r),
        );
      }
    }

    return { written: toWrite.length, skipped };
  }

  /**
   * Rows for a given walk-forward fold key `(signalDate, severity)`. Served from
   * the in-memory index (kept in lock-step with SQLite); call {@link queryDb} to
   * read straight from the persisted SQLite index instead.
   */
  query(signalDate: string, severity: string): FrozenRow[] {
    return [...(this.index.get(indexKey(signalDate, severity)) ?? [])];
  }

  /**
   * Read a `(signalDate, severity)` fold directly from the SQLite index. Returns
   * `[]` when SQLite is not configured. Used by the bake to slice folds without
   * loading the in-memory store.
   */
  queryDb(signalDate: string, severity: string): FrozenRow[] {
    if (this.db === undefined) return [];
    const rows = this.db
      .prepare(
        `SELECT row_json FROM dataset_index
         WHERE signal_date = ? AND severity = ?
         ORDER BY decision_event_id ASC`,
      )
      .all(signalDate, severity) as Array<{ row_json: string }>;
    return rows.map((r) => JSON.parse(r.row_json) as FrozenRow);
  }

  /** Total rows held in the index. */
  get size(): number {
    return this.ids.size;
  }

  /** Close the underlying SQLite index handle (no-op when not configured). */
  close(): void {
    this.db?.close();
  }
}
