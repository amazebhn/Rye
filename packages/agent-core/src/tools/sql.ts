/**
 * SQL tools: read-only queries and schema inspection against the databases
 * configured for the active environment (MySQL or PostgreSQL, any number).
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describeConnections, describeProblems, engineName, listConnections, pickConnection, LEGACY_MYSQL_NAME, type DbConnection } from "../db/connections.js";
import { QUERY_TIMEOUT_MS, QueryTimeoutError, driverFor, errorText, type SqlDriver, type TableKeys } from "../db/drivers.js";
import { storeOrInline } from "../results/query.js";

export const SQL_QUERY_TOOL = "sql_query_tool";
export const SQL_SCHEMA_TOOL = "sql_schema_tool";
export const SQL_LIST_DATABASES_TOOL = "sql_list_databases_tool";

/** Test seam: which driver serves a connection. */
export type DriverLookup = (conn: DbConnection) => SqlDriver;
const realDriver: DriverLookup = (conn) => driverFor(conn.type);

// Statements that only read. Postgres additionally runs everything in a read-only transaction,
// which the server enforces; for MySQL this check is the guard, so it stays strict.
const READ_ONLY_START: Record<DbConnection["type"], RegExp> = {
  mysql: /^\s*(?:\(\s*)*(select|show|describe|desc|explain|with)\b/i,
  postgres: /^\s*(?:\(\s*)*(select|show|explain|with|values|table)\b/i,
};
// A CTE can wrap a write (WITH x AS (DELETE … RETURNING …) SELECT …). Postgres refuses that in a
// read-only transaction; for MySQL it is refused here.
const WRITE_KEYWORD = /\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|rename|call|load|set|lock|handler)\b/i;

/** Why a statement may not run, or null if it may. */
export function readOnlyViolation(type: DbConnection["type"], query: string): string | null {
  const allowed = type === "mysql" ? "SELECT, WITH, SHOW, DESCRIBE, EXPLAIN" : "SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN";
  if (!READ_ONLY_START[type].test(query)) return `Only read-only statements (${allowed}) are permitted.`;
  // More than one statement would let a write ride behind a SELECT.
  const withoutStrings = query.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, "''");
  if (/;\s*\S/.test(withoutStrings.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ""))) return "Run one statement at a time.";
  if (type === "mysql" && /^\s*(?:\(\s*)*with\b/i.test(query) && WRITE_KEYWORD.test(withoutStrings)) {
    return `Only read-only statements (${allowed}) are permitted.`;
  }
  // MySQL's EXPLAIN ANALYZE runs the statement it explains, and it accepts UPDATE and DELETE (DESCRIBE and
  // DESC are EXPLAIN's synonyms). Postgres would refuse the write in its read-only transaction; MySQL wouldn't.
  if (type === "mysql" && /^\s*(?:\(\s*)*(explain|describe|desc)\b/i.test(query) && WRITE_KEYWORD.test(withoutStrings)) {
    return "EXPLAIN may only explain a read-only statement.";
  }
  return null;
}

const where = (conn: DbConnection) => `${engineName(conn.type)} "${conn.name}"`;

export async function sqlQuery(
  args: { query: string; connection?: string; database?: string },
  sessionId?: string,
  driver: DriverLookup = realDriver,
  source = SQL_QUERY_TOOL,
): Promise<string> {
  const conn = pickConnection(args.connection);
  if ("error" in conn) return `Error: ${conn.error}`;
  const query = String(args.query ?? "").trim();
  const violation = readOnlyViolation(conn.type, query);
  if (violation) return `Error: ${violation}`;
  try {
    const rows = await driver(conn).query(conn, query, args.database);
    if (rows.length === 0) return "(no rows)";
    return storeOrInline({ sessionId, source, label: query, columns: Object.keys(rows[0]), rows });
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      const seconds = err.timeoutMs / 1000;
      return err.cancelled
        ? `${where(conn)} error: the query ran longer than ${seconds}s and was cancelled on the server. ` +
            "Narrow it with a WHERE clause on an indexed column, add a LIMIT, or check it with EXPLAIN before retrying."
        : `${where(conn)} error: the query ran longer than ${seconds}s, and Rye could not cancel it, ` +
            `so it may still be running on the server (${err.hint}). Ask the user to check.`;
    }
    return `${where(conn)} error: ${errorText(err)}`;
  }
}

/** A table's keys as the schema tool shows them: indexes, then joins out, then joins in. */
export function formatKeys(keys: TableKeys): string[] {
  const list = (cols: string[]) => cols.join(", ");
  const lines = ["Indexes:"];
  if (keys.indexes.length === 0) lines.push("  (none)");
  for (const ix of keys.indexes) {
    const kind = ix.primary ? "PRIMARY KEY " : ix.unique ? "UNIQUE " : "";
    const method = ix.method ? ` USING ${ix.method}` : "";
    const where = ix.where ? ` WHERE ${ix.where}` : "";
    lines.push(`  - ${ix.name}: ${kind}(${list(ix.columns)})${method}${where}`);
  }
  if (keys.foreignKeys.length > 0) {
    lines.push("Foreign keys (join to):");
    for (const fk of keys.foreignKeys) lines.push(`  - (${list(fk.columns)}) → ${fk.table} (${list(fk.otherColumns)})  [${fk.name}]`);
  }
  if (keys.referencedBy.length > 0) {
    lines.push("Referenced by (joins from):");
    for (const fk of keys.referencedBy) lines.push(`  - ${fk.table} (${list(fk.columns)}) → (${list(fk.otherColumns)})  [${fk.name}]`);
  }
  if (keys.foreignKeys.length === 0 && keys.referencedBy.length === 0) {
    lines.push("Foreign keys: none declared (joins, if any, are by convention: look for matching *_id columns).");
  }
  return lines;
}

export async function sqlSchema(args: { table?: string; connection?: string; database?: string }, driver: DriverLookup = realDriver): Promise<string> {
  const conn = pickConnection(args.connection);
  if ("error" in conn) return `Error: ${conn.error}`;
  try {
    if (args.table) {
      const columns = await driver(conn).describe(conn, args.table, args.database);
      if (!columns) return `Table '${args.table}' not found on ${where(conn)}.`;
      const lines = [`Schema for table: ${args.table} (${where(conn)})`, ""];
      for (const col of columns) {
        lines.push(`  ${col.name}: ${col.type} ${col.nullable ? "NULL" : "NOT NULL"}${col.key ? ` [${col.key}]` : ""}${col.default != null ? ` DEFAULT ${col.default}` : ""}`);
      }
      const keysFn = driver(conn).keys;
      if (keysFn) {
        try {
          lines.push("", ...formatKeys(await keysFn.call(driver(conn), conn, args.table, args.database)));
        } catch (err) {
          // Columns are still useful; say why the keys are missing rather than failing the whole call.
          lines.push("", `(Indexes and foreign keys unavailable: ${errorText(err)})`);
        }
      }
      return lines.join("\n");
    }
    const tables = await driver(conn).tables(conn, args.database);
    if (tables.length === 0) return `No tables found on ${where(conn)}.`;
    return `Tables on ${where(conn)}${args.database ? `, database ${args.database}` : ""}:\n${tables.map((t) => `  - ${t}`).join("\n")}`;
  } catch (err) {
    return `${where(conn)} schema error: ${errorText(err)}`;
  }
}

/** The connections of this environment, and the databases on one of them. */
export async function sqlListDatabases(args: { connection?: string } = {}, driver: DriverLookup = realDriver): Promise<string> {
  const { connections, problems } = listConnections();
  const header = connections.length
    ? `Connections in this environment:\n${describeConnections(connections)}`
    : "No database connection is configured for this environment.";
  const broken = problems.length ? `\nMisconfigured (unusable): ${describeProblems(problems)}` : "";
  if (connections.length === 0) return header + broken;

  const conn = pickConnection(args.connection);
  if ("error" in conn) return `Error: ${conn.error}\n\n${header}${broken}`;
  try {
    const names = await driver(conn).databases(conn);
    const listed = names.length
      ? names.map((d) => (d === conn.database ? `  - ${d} (default)` : `  - ${d}`)).join("\n")
      : "  (none accessible to this user)";
    return `${header}${broken}\n\nDatabases on ${where(conn)}:\n${listed}`;
  } catch (err) {
    return `${header}${broken}\n\n${where(conn)} error: ${errorText(err)}`;
  }
}

/** The old MySQL-only tool names, still answered so saved SOPs, skills and chats that mention them keep working. */
export const LEGACY_MYSQL_TOOLS: Record<string, string> = {
  mysql_query_tool: SQL_QUERY_TOOL,
  mysql_schema_tool: SQL_SCHEMA_TOOL,
  mysql_list_databases_tool: SQL_LIST_DATABASES_TOOL,
};

/** The connection an old mysql_* call meant: the [mysql] section if it is there, else the first MySQL connection. */
export function legacyMysqlConnection(): string | undefined {
  const mysql = listConnections().connections.filter((c) => c.type === "mysql");
  return (mysql.find((c) => c.name === LEGACY_MYSQL_NAME) ?? mysql[0])?.name;
}

export { QUERY_TIMEOUT_MS };

// ---------------------------------------------------------------------------
// Tool definitions (pi-ai format)
// ---------------------------------------------------------------------------

const CONNECTION_ARG = Type.Optional(
  Type.String({ description: "Name of the database connection to use. Omit for the environment's default (the first one listed)." }),
);

export const sqlTools: Tool[] = [
  {
    name: SQL_QUERY_TOOL,
    description:
      "Run one read-only SQL statement against a configured database (MySQL or PostgreSQL; the connection decides the dialect). " +
      "Only reading statements are permitted (SELECT, WITH, SHOW, EXPLAIN, and DESCRIBE on MySQL). " +
      "An environment can have several connections: pass 'connection' to choose one (see sql_list_databases_tool for their names and engines). " +
      "Pass 'database' to run against another database on the same server than the connection's default. " +
      "Join along the foreign keys sql_schema_tool lists, and filter on indexed columns. " +
      "Before a query that could be slow (a large table, no LIMIT, a filter or join on a column with no index, a function wrapped round an indexed column), " +
      "check its plan with plain EXPLAIN first (MySQL: EXPLAIN FORMAT=TREE), which shows the plan without running the query: " +
      "a full or sequential scan of a big table means rewrite it to use an index or narrow it. EXPLAIN ANALYZE runs the query, so only use it on one already known to be quick.",
    parameters: Type.Object({
      query: Type.String({ description: "The SQL statement, in the dialect of the connection's engine." }),
      connection: CONNECTION_ARG,
      database: Type.Optional(Type.String({ description: "Database (PostgreSQL) or schema (MySQL) to run against. Omit to use the connection's default." })),
    }),
  },
  {
    name: SQL_SCHEMA_TOOL,
    description:
      "Inspect a database's schema. With a table name, returns its columns (type, nullability, key, default), its indexes, " +
      "its foreign keys and the tables whose foreign keys point at it (how to join it); without, lists the tables. " +
      "On PostgreSQL, tables outside the public schema are named schema.table. Use 'connection' and 'database' as in sql_query_tool.",
    parameters: Type.Object({
      table: Type.Optional(Type.String({ description: "Table to describe (schema.table on PostgreSQL if not in public). Omit to list all tables." })),
      connection: CONNECTION_ARG,
      database: Type.Optional(Type.String({ description: "Database/schema to inspect. Omit to use the connection's default." })),
    }),
  },
  {
    name: SQL_LIST_DATABASES_TOOL,
    description:
      "List the database connections configured for the active environment (name, engine, default database, what each holds), " +
      "and the databases on one of them. Use it to find the right 'connection' and 'database' before querying.",
    parameters: Type.Object({
      connection: Type.Optional(Type.String({ description: "Connection whose databases to list. Omit for the default connection." })),
    }),
  },
];
