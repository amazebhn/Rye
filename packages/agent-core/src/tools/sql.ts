/**
 * SQL tools: read-only queries and schema inspection against the databases
 * configured for the active environment (MySQL or PostgreSQL, any number).
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describeConnections, describeProblems, engineName, listConnections, pickConnection, LEGACY_MYSQL_NAME, type DbConnection } from "../db/connections.js";
import { QUERY_TIMEOUT_MS, QueryTimeoutError, driverFor, errorText, type SqlDriver } from "../db/drivers.js";
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
      "Pass 'database' to run against another database on the same server than the connection's default.",
    parameters: Type.Object({
      query: Type.String({ description: "The SQL statement, in the dialect of the connection's engine." }),
      connection: CONNECTION_ARG,
      database: Type.Optional(Type.String({ description: "Database (PostgreSQL) or schema (MySQL) to run against. Omit to use the connection's default." })),
    }),
  },
  {
    name: SQL_SCHEMA_TOOL,
    description:
      "Inspect a database's schema. With a table name, returns its columns (type, nullability, key, default); without, lists the tables. " +
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
