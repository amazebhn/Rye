/**
 * MySQL tools — read-only query + schema inspection.
 * Uses mysql2/promise (CommonJS-compatible, works under Bun).
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Connection } from "mysql2/promise";
import { getEffectiveSettings } from "../config.js";
import { storeOrInline } from "../results/query.js";

// Under the agent loop's 60s tool timeout, so the kill finishes before the loop stops waiting.
const QUERY_TIMEOUT_MS = 55_000;

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

async function getConnection(database?: string) {
  // Dynamic import so the module is only loaded when the tool is actually called.
  const mysql = await import("mysql2/promise");
  const cfg = getEffectiveSettings().mysql;
  // An explicit "" selects no default schema (needed for SHOW DATABASES).
  const db = database !== undefined ? database : cfg.database;
  console.log("Connecting to MySQL at", cfg.host, "as", cfg.user, "database", db || "(none)");
  return mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: db || undefined,
    // Return DATE/DATETIME/TIMESTAMP as strings so zero-dates (0000-00-00)
    // don't become invalid JS Date objects and throw in toISOString().
    dateStrings: true,
  });
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function fmtError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Record<string, unknown>).code;
    const detail = code ? `${err.message} (${code})` : err.message;
    return detail || err.constructor.name;
  }
  const s = String(err);
  return s || "unknown error";
}

// ---------------------------------------------------------------------------
// Query timeout
// ---------------------------------------------------------------------------

export class QueryTimeoutError extends Error {
  constructor(readonly threadId: number, readonly killed: boolean, readonly timeoutMs: number) {
    super(`Query exceeded ${timeoutMs / 1000}s`);
  }
}

/**
 * Cancel the statement running on `threadId` from a second connection.
 * KILL QUERY stops only the statement and leaves the session alive. Returns
 * false when the kill couldn't be issued, e.g. the user lacks the privilege.
 */
async function killQuery(threadId: number, database?: string): Promise<boolean> {
  let killer: Connection | undefined;
  try {
    killer = await getConnection(database);
    await killer.query(`KILL QUERY ${Number(threadId)}`);
    return true;
  } catch (err) {
    console.error(`KILL QUERY ${threadId} failed:`, fmtError(err));
    return false;
  } finally {
    // Never let a failing teardown mask the result.
    await killer?.end().catch(() => killer?.destroy());
  }
}

/** Run a statement, killing it on the server if it outlives the timeout. */
export async function executeWithTimeout(
  conn: Connection,
  query: string,
  database: string | undefined,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<[Record<string, unknown>[], unknown]> {
  // Read before the query starts: the connection is busy afterwards.
  const threadId = conn.threadId;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void killQuery(threadId, database).then((killed) => reject(new QueryTimeoutError(threadId, killed, timeoutMs)));
    }, timeoutMs);
  });
  const run = conn.execute(query) as Promise<[Record<string, unknown>[], unknown]>;
  // After the kill the query rejects too; that late rejection must not go unhandled.
  run.catch(() => {});
  try {
    return await Promise.race([run, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function mysqlQuery(args: { query: string; database?: string }, sessionId?: string): Promise<string> {
  const { query, database } = args;
  const normalized = query.trim().toUpperCase();
  const allowed = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"];
  if (!allowed.some((kw) => normalized.startsWith(kw))) {
    return "Error: Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are permitted.";
  }

  let conn;
  try {
    conn = await getConnection(database);
    const [rows] = await executeWithTimeout(conn, query, database);
    if (rows.length === 0) return "(no rows)";
    const columns = Object.keys(rows[0]);
    return storeOrInline({ sessionId, source: "mysql_query_tool", label: query, columns, rows });
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      const seconds = err.timeoutMs / 1000;
      return err.killed
        ? `MySQL error: the query ran longer than ${seconds}s and was cancelled on the server (KILL QUERY ${err.threadId}). ` +
            "Narrow it with a WHERE clause on an indexed column, add a LIMIT, or check it with EXPLAIN before retrying."
        : `MySQL error: the query ran longer than ${seconds}s, and Rye could not cancel it (KILL QUERY ${err.threadId} failed), ` +
            "so it may still be running on the server. Ask the user to check SHOW PROCESSLIST.";
    }
    return `MySQL error: ${fmtError(err)}`;
  } finally {
    // end() waits for any statement still running, so drop the connection if it doesn't close promptly.
    if (conn) {
      const ended = await Promise.race([
        conn.end().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ]).catch(() => false);
      if (!ended) conn.destroy();
    }
  }
}

export async function mysqlSchema(args: { table?: string; database?: string }): Promise<string> {
  const { table, database } = args;
  let conn;
  try {
    conn = await getConnection(database);
    if (table) {
      const [rows] = await conn.execute(`DESCRIBE \`${table}\``) as [Record<string, unknown>[], unknown];
      if ((rows as unknown[]).length === 0) return `Table '${table}' not found or has no columns.`;
      const lines = [`Schema for table: ${table}`, ""];
      for (const row of rows) {
        const nullable = row["Null"] === "YES" ? "NULL" : "NOT NULL";
        const key = row["Key"] ? ` [${row["Key"]}]` : "";
        const def = row["Default"] != null ? ` DEFAULT ${row["Default"]}` : "";
        lines.push(`  ${row["Field"]}: ${row["Type"]} ${nullable}${key}${def}`);
      }
      return lines.join("\n");
    } else {
      const [rows] = await conn.execute("SHOW TABLES") as [Record<string, unknown>[], unknown];
      const tables = rows.map((r) => Object.values(r)[0] as string);
      if (tables.length === 0) return "No tables found in the database.";
      return "Tables in database:\n" + tables.map((t) => `  - ${t}`).join("\n");
    }
  } catch (err) {
    return `MySQL schema error: ${fmtError(err)}`;
  } finally {
    await conn?.end();
  }
}

export async function mysqlListDatabases(): Promise<string> {
  let conn;
  try {
    // Connect with no default schema so this works even if the configured
    // default database is missing or inaccessible.
    conn = await getConnection("");
    const [rows] = await conn.execute("SHOW DATABASES") as [Record<string, unknown>[], unknown];
    const dbs = rows.map((r) => Object.values(r)[0] as string);
    if (dbs.length === 0) return "No databases accessible to this user.";
    const defaultDb = getEffectiveSettings().mysql.database;
    const lines = dbs.map((d) => (d === defaultDb ? `  - ${d} (default)` : `  - ${d}`));
    return "Accessible databases:\n" + lines.join("\n");
  } catch (err) {
    return `MySQL error: ${fmtError(err)}`;
  } finally {
    await conn?.end();
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (pi-ai format)
// ---------------------------------------------------------------------------

export const mysqlTools: Tool[] = [
  {
    name: "mysql_query_tool",
    description:
      "Execute a read-only SQL query against a MySQL database. Only SELECT, SHOW, DESCRIBE, and EXPLAIN statements are permitted. " +
      "By default the query runs against the configured default database; pass 'database' to target a different one (use mysql_list_databases_tool to discover names).",
    parameters: Type.Object({
      query: Type.String({
        description: "SQL query to execute (SELECT, SHOW, DESCRIBE, EXPLAIN only).",
      }),
      database: Type.Optional(
        Type.String({ description: "Database/schema to run against. Omit to use the configured default." })
      ),
    }),
  },
  {
    name: "mysql_schema_tool",
    description:
      "Inspect a MySQL database schema. If a table name is provided, returns column definitions. Otherwise, lists all tables. " +
      "By default inspects the configured default database; pass 'database' to inspect a different one.",
    parameters: Type.Object({
      table: Type.Optional(
        Type.String({ description: "Table name to describe. Omit to list all tables." })
      ),
      database: Type.Optional(
        Type.String({ description: "Database/schema to inspect. Omit to use the configured default." })
      ),
    }),
  },
  {
    name: "mysql_list_databases_tool",
    description:
      "List all databases/schemas the configured MySQL user can access (SHOW DATABASES). " +
      "Use this to discover other databases before querying them with mysql_query_tool or mysql_schema_tool's 'database' argument.",
    parameters: Type.Object({}),
  },
];
