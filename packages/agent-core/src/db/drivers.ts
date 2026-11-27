/**
 * Read-only access to a SQL database, one implementation per engine.
 *
 * Every call opens its own connection and closes it: these run a query or two
 * per agent step, and a stale pooled connection to a production replica is a
 * worse failure than a slow connect.
 */

import type { Connection } from "mysql2/promise";
import type { DatabaseType } from "../config.js";
import type { DbConnection } from "./connections.js";

export type Row = Record<string, unknown>;

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  /** "PRI", "UNI", "MUL" on MySQL; "PK" on Postgres; "" otherwise. */
  key: string;
  default: string | null;
}

export interface IndexInfo {
  name: string;
  /** Key columns in order; an expression index lists its expressions. */
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** The index method when it isn't the engine's usual one (gin, gist, hash, fulltext…). */
  method?: string;
  /** A partial index's condition (Postgres). */
  where?: string;
}

export interface ForeignKeyInfo {
  name: string;
  /** This side's columns, in order. */
  columns: string[];
  /** The other table (schema.table when it isn't in the default schema). */
  table: string;
  /** The other table's columns, matching `columns`. */
  otherColumns: string[];
}

/** What a table's keys say about how to filter and join it. */
export interface TableKeys {
  indexes: IndexInfo[];
  /** This table's foreign keys: its columns → another table's. */
  foreignKeys: ForeignKeyInfo[];
  /** Other tables' foreign keys pointing at this one: their columns (`columns`) → this table's (`otherColumns`). */
  referencedBy: ForeignKeyInfo[];
}

/** A list from a driver row: Postgres JSON arrays may arrive parsed or as text. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return typeof value === "string" && value ? [value] : [];
}

export interface SqlDriver {
  /** Run one read-only statement. `database` overrides the connection's default. */
  query(conn: DbConnection, sql: string, database?: string): Promise<Row[]>;
  /** Table names; on Postgres, `schema.table` for anything outside `public`. */
  tables(conn: DbConnection, database?: string): Promise<string[]>;
  /** A table's columns, or null if there is no such table. */
  describe(conn: DbConnection, table: string, database?: string): Promise<ColumnInfo[] | null>;
  /** A table's indexes and foreign keys (both directions). Optional: a driver without it shows columns only. */
  keys?(conn: DbConnection, table: string, database?: string): Promise<TableKeys>;
  /** Databases (Postgres) or schemas (MySQL) this user can see on the server. */
  databases(conn: DbConnection): Promise<string[]>;
  /** Connect and disconnect, to check the settings. */
  ping(conn: DbConnection, timeoutMs?: number): Promise<void>;
}

// Under the agent loop's 60s tool timeout, so the cancel finishes before the loop stops waiting.
export const QUERY_TIMEOUT_MS = 55_000;

export class QueryTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    /** Whether the statement was stopped on the server. */
    readonly cancelled: boolean,
    /** How to find it on the server if it wasn't. */
    readonly hint: string,
  ) {
    super(`Query exceeded ${timeoutMs / 1000}s`);
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; errno?: unknown };
    // mysql2 puts ER_… in `code`; Bun's Postgres client puts the SQLSTATE in `errno` and a generic code in `code`.
    const code = typeof e.errno === "string" ? e.errno : typeof e.code === "string" && !e.code.startsWith("ERR_POSTGRES_SERVER") ? e.code : undefined;
    const detail = code ? `${e.message} (${code})` : e.message;
    return detail || e.constructor.name;
  }
  return String(err) || "unknown error";
}

/** Values as they should appear in a result table and survive JSON: no Date objects, BigInts or raw bytes. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return value;
}
const plainRows = (rows: Row[]): Row[] => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])));

// ---------------------------------------------------------------------------
// MySQL (mysql2)
// ---------------------------------------------------------------------------

async function mysqlConnect(conn: DbConnection, database?: string, connectTimeout?: number): Promise<Connection> {
  // Loaded on first use, so the module costs nothing when no MySQL connection is configured.
  const mysql = await import("mysql2/promise");
  // An explicit "" selects no default schema (needed for SHOW DATABASES).
  const db = database !== undefined ? database : conn.database;
  return mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: db || undefined,
    ...(conn.ssl ? { ssl: {} } : {}),
    ...(connectTimeout ? { connectTimeout } : {}),
    // Return DATE/DATETIME/TIMESTAMP as strings so zero-dates (0000-00-00)
    // don't become invalid JS Date objects and throw in toISOString().
    dateStrings: true,
  });
}

/** Close a connection without letting a hung teardown hold the caller. */
async function mysqlClose(c: Connection | undefined): Promise<void> {
  if (!c) return;
  // end() waits for any statement still running, so drop the connection if it doesn't close promptly.
  const ended = await Promise.race([c.end().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]).catch(() => false);
  if (!ended) c.destroy();
}

/**
 * Cancel the statement running on `threadId` from a second connection.
 * KILL QUERY stops only the statement and leaves the session alive. Returns
 * false when the kill couldn't be issued, e.g. the user lacks the privilege.
 */
async function mysqlKill(conn: DbConnection, threadId: number, database?: string): Promise<boolean> {
  let killer: Connection | undefined;
  try {
    killer = await mysqlConnect(conn, database);
    await killer.query(`KILL QUERY ${Number(threadId)}`);
    return true;
  } catch (err) {
    console.error(`KILL QUERY ${threadId} failed:`, errorText(err));
    return false;
  } finally {
    // Never let a failing teardown mask the result.
    await killer?.end().catch(() => killer?.destroy());
  }
}

const mysqlDriver: SqlDriver = {
  async query(conn, sql, database) {
    const c = await mysqlConnect(conn, database);
    try {
      // Read before the query starts: the connection is busy afterwards.
      const threadId = c.threadId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void mysqlKill(conn, threadId, database).then((killed) =>
            reject(new QueryTimeoutError(QUERY_TIMEOUT_MS, killed, `thread ${threadId}; see SHOW PROCESSLIST`)),
          );
        }, QUERY_TIMEOUT_MS);
      });
      const run = c.execute(sql) as Promise<[Row[], unknown]>;
      // After the kill the query rejects too; that late rejection must not go unhandled.
      run.catch(() => {});
      try {
        const [rows] = await Promise.race([run, timedOut]);
        return plainRows(Array.isArray(rows) ? rows : []);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await mysqlClose(c);
    }
  },

  async tables(conn, database) {
    const c = await mysqlConnect(conn, database);
    try {
      const [rows] = (await c.execute("SHOW TABLES")) as [Row[], unknown];
      return rows.map((r) => String(Object.values(r)[0]));
    } finally {
      await mysqlClose(c);
    }
  },

  async describe(conn, table, database) {
    const c = await mysqlConnect(conn, database);
    try {
      // Identifier quoting: a backtick inside the name is doubled.
      const [rows] = (await c.execute(`DESCRIBE \`${table.replace(/`/g, "``")}\``)) as [Row[], unknown];
      if (rows.length === 0) return null;
      return rows.map((row) => ({
        name: String(row["Field"]),
        type: String(row["Type"]),
        nullable: row["Null"] === "YES",
        key: row["Key"] ? String(row["Key"]) : "",
        default: row["Default"] != null ? String(row["Default"]) : null,
      }));
    } catch (err) {
      if ((err as { code?: string }).code === "ER_NO_SUCH_TABLE") return null;
      throw err;
    } finally {
      await mysqlClose(c);
    }
  },

  async keys(conn, table, database) {
    const c = await mysqlConnect(conn, database);
    try {
      // "schema.table" names another schema; a bare name is in the connection's current one (DATABASE()).
      const { schema, name } = splitTable(table.replace(/`/g, ""));
      const where = "TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?";
      const [indexRows] = (await c.execute(
        `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE FROM information_schema.STATISTICS
         WHERE ${where} ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
        [schema, name],
      )) as [Row[], unknown];
      const indexes = new Map<string, IndexInfo>();
      for (const row of indexRows) {
        const indexName = String(row["INDEX_NAME"]);
        const type = String(row["INDEX_TYPE"] ?? "").toLowerCase();
        const index = indexes.get(indexName) ?? {
          name: indexName,
          columns: [],
          unique: Number(row["NON_UNIQUE"]) === 0,
          primary: indexName === "PRIMARY",
          ...(type && type !== "btree" ? { method: type } : {}),
        };
        index.columns.push(String(row["COLUMN_NAME"] ?? "(expression)"));
        indexes.set(indexName, index);
      }
      // Tables in the current schema are named bare, others schema.table.
      const [[current]] = (await c.execute("SELECT DATABASE() AS db")) as [Row[], unknown];
      const here = schema ?? String(current?.["db"] ?? "");
      const named = (s: unknown, t: unknown) => (String(s) === here ? String(t) : `${String(s)}.${String(t)}`);
      const fkRows = async (side: "out" | "in") => {
        const [rows] = (await c.execute(
          `SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME,
                  REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE ${side === "out" ? where + " AND REFERENCED_TABLE_NAME IS NOT NULL" : "REFERENCED_TABLE_SCHEMA = COALESCE(?, DATABASE()) AND REFERENCED_TABLE_NAME = ?"}
           ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
          [schema, name],
        )) as [Row[], unknown];
        const keys = new Map<string, ForeignKeyInfo>();
        for (const row of rows) {
          const other = side === "out" ? named(row["REFERENCED_TABLE_SCHEMA"], row["REFERENCED_TABLE_NAME"]) : named(row["TABLE_SCHEMA"], row["TABLE_NAME"]);
          const id = `${other}|${String(row["CONSTRAINT_NAME"])}`;
          const key = keys.get(id) ?? { name: String(row["CONSTRAINT_NAME"]), columns: [], table: other, otherColumns: [] };
          // A row is always referencing column → referenced column: out, ours → theirs; in, theirs → ours.
          key.columns.push(String(row["COLUMN_NAME"]));
          key.otherColumns.push(String(row["REFERENCED_COLUMN_NAME"]));
          keys.set(id, key);
        }
        return [...keys.values()];
      };
      return { indexes: [...indexes.values()], foreignKeys: await fkRows("out"), referencedBy: await fkRows("in") };
    } finally {
      await mysqlClose(c);
    }
  },

  async databases(conn) {
    // No default schema, so this works even if the configured one is missing or inaccessible.
    const c = await mysqlConnect(conn, "");
    try {
      const [rows] = (await c.execute("SHOW DATABASES")) as [Row[], unknown];
      return rows.map((r) => String(Object.values(r)[0]));
    } finally {
      await mysqlClose(c);
    }
  },

  async ping(conn, timeoutMs = 4000) {
    const c = await mysqlConnect(conn, undefined, timeoutMs);
    try {
      await c.ping();
    } finally {
      await mysqlClose(c);
    }
  },
};

// ---------------------------------------------------------------------------
// PostgreSQL (Bun's built-in client)
// ---------------------------------------------------------------------------

/** Run `fn` on a fresh single connection, always closing it. */
async function withPostgres<T>(conn: DbConnection, database: string | undefined, connectSeconds: number, fn: (sql: import("bun").SQL) => Promise<T>): Promise<T> {
  const { SQL } = await import("bun");
  const sql = new SQL({
    hostname: conn.host,
    port: conn.port,
    username: conn.user || undefined,
    password: conn.password || undefined,
    // Postgres always connects to a database; "postgres" exists on every server.
    database: database || conn.database || "postgres",
    ...(conn.ssl ? { tls: true } : {}),
    max: 1,
    idleTimeout: 5,
    connectionTimeout: connectSeconds,
  });
  try {
    return await fn(sql);
  } finally {
    await Promise.race([sql.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
  }
}

/** "billing.invoices" → schema and table; a bare name is looked up in any schema the user can see. */
function splitTable(table: string): { schema: string | null; name: string } {
  const unquoted = table.replace(/"/g, "");
  const dot = unquoted.indexOf(".");
  return dot === -1 ? { schema: null, name: unquoted } : { schema: unquoted.slice(0, dot), name: unquoted.slice(dot + 1) };
}

const postgresDriver: SqlDriver = {
  async query(conn, statement, database) {
    return withPostgres(conn, database, 10, async (sql) => {
      try {
        // A read-only transaction is enforced by the server, whatever the statement says, and the
        // server itself cancels a statement that runs too long.
        const rows = (await sql.begin("read only", async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
          return tx.unsafe(statement);
        })) as Row[];
        return plainRows(Array.isArray(rows) ? [...rows] : []);
      } catch (err) {
        // 57014 = query_canceled, which here means the statement timeout fired.
        if ((err as { errno?: string }).errno === "57014") throw new QueryTimeoutError(QUERY_TIMEOUT_MS, true, "");
        throw err;
      }
    });
  },

  async tables(conn, database) {
    return withPostgres(conn, database, 10, async (sql) => {
      const rows = (await sql.unsafe(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%'
         ORDER BY (table_schema <> 'public'), table_schema, table_name`,
      )) as Array<{ table_schema: string; table_name: string }>;
      return rows.map((r) => (r.table_schema === "public" ? r.table_name : `${r.table_schema}.${r.table_name}`));
    });
  },

  async describe(conn, table, database) {
    const { schema, name } = splitTable(table);
    return withPostgres(conn, database, 10, async (sql) => {
      // From the system catalogs rather than information_schema: that hides constraints (so primary
      // keys) from a user who can only SELECT, which is exactly the user this should be run as.
      const kinds = "('r', 'p', 'v', 'm', 'f')"; // tables, partitioned tables, views, materialized views, foreign tables
      const rows = (await sql.unsafe(
        `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS column_default, (i.indexrelid IS NOT NULL) AS is_pk
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
         LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)
         WHERE c.relname = $1 AND c.relkind IN ${kinds} AND n.nspname = COALESCE($2, (
           SELECT n2.nspname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
           WHERE c2.relname = $1 AND c2.relkind IN ${kinds} AND n2.nspname NOT IN ('pg_catalog', 'information_schema')
           ORDER BY (n2.nspname <> 'public'), n2.nspname LIMIT 1))
         ORDER BY a.attnum`,
        [name, schema],
      )) as Array<{ column_name: string; type: string; nullable: boolean; column_default: string | null; is_pk: boolean }>;
      if (rows.length === 0) return null;
      return rows.map((r) => ({ name: r.column_name, type: r.type, nullable: r.nullable, key: r.is_pk ? "PK" : "", default: r.column_default }));
    });
  },

  async keys(conn, table, database) {
    const { schema, name } = splitTable(table);
    return withPostgres(conn, database, 10, async (sql) => {
      // The table as describe() finds it: the named schema, else public first, then any other.
      const tbl = `tbl AS (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND ($2::text IS NULL OR n.nspname = $2)
        ORDER BY (n.nspname <> 'public'), n.nspname LIMIT 1)`;
      const indexRows = (await sql.unsafe(
        `WITH ${tbl}
         SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary, am.amname AS method,
                pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
                array_to_json(array(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_series(1, ix.indnkeyatts) AS k ORDER BY k)) AS columns
         FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
         WHERE ix.indrelid = (SELECT oid FROM tbl)
         ORDER BY ix.indisprimary DESC, i.relname`,
        [name, schema],
      )) as Array<{ name: string; is_unique: boolean; is_primary: boolean; method: string; predicate: string | null; columns: unknown }>;
      // Column names of a constraint's key, in key order, for the table on either side.
      const cols = (attnums: string, rel: string) =>
        `array_to_json(array(SELECT a.attname FROM unnest(${attnums}) WITH ORDINALITY AS u(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = u.attnum ORDER BY u.ord))`;
      const fkRows = async (side: "out" | "in") =>
        (await sql.unsafe(
          `WITH ${tbl}
           SELECT con.conname AS name,
                  ${side === "out" ? "con.confrelid" : "con.conrelid"}::regclass::text AS other_table,
                  ${cols("con.conkey", "con.conrelid")} AS columns,
                  ${cols("con.confkey", "con.confrelid")} AS other_columns
           FROM pg_constraint con
           WHERE con.contype = 'f' AND ${side === "out" ? "con.conrelid" : "con.confrelid"} = (SELECT oid FROM tbl)
           ORDER BY 2, 1`,
          [name, schema],
        )) as Array<{ name: string; other_table: string; columns: unknown; other_columns: unknown }>;
      const toKey = (r: { name: string; other_table: string; columns: unknown; other_columns: unknown }): ForeignKeyInfo => ({
        name: r.name,
        table: r.other_table,
        // A row is always referencing columns (conkey) → referenced columns (confkey).
        columns: stringList(r.columns),
        otherColumns: stringList(r.other_columns),
      });
      return {
        indexes: indexRows.map((r) => ({
          name: r.name,
          columns: stringList(r.columns),
          unique: r.is_unique,
          primary: r.is_primary,
          ...(r.method && r.method !== "btree" ? { method: r.method } : {}),
          ...(r.predicate ? { where: r.predicate } : {}),
        })),
        foreignKeys: (await fkRows("out")).map(toKey),
        referencedBy: (await fkRows("in")).map(toKey),
      };
    });
  },

  async databases(conn) {
    return withPostgres(conn, undefined, 10, async (sql) => {
      const rows = (await sql.unsafe(
        "SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
      )) as Array<{ datname: string }>;
      return rows.map((r) => r.datname);
    });
  },

  async ping(conn, timeoutMs = 4000) {
    await withPostgres(conn, undefined, Math.max(1, Math.round(timeoutMs / 1000)), async (sql) => {
      await sql.unsafe("SELECT 1");
    });
  },
};

const DRIVERS: Record<DatabaseType, SqlDriver> = { mysql: mysqlDriver, postgres: postgresDriver };
export const driverFor = (type: DatabaseType): SqlDriver => DRIVERS[type];
