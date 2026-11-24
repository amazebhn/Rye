import { describe, expect, test } from "bun:test";
import { getSettings, mergeDatabases, type Settings } from "../src/config.js";
import { describeConnections, listConnections, pickConnection } from "../src/db/connections.js";
import { QueryTimeoutError, type SqlDriver } from "../src/db/drivers.js";
import { readOnlyViolation } from "../src/tools/sql.js";
import { GROUP_ALIASES, SQL_GROUP, buildToolGroups, resolveGroupNames } from "../src/tools/groups.js";
import { TOOLS } from "../src/tools/index.js";

const base = getSettings();
const withDatabases = (databases: Settings["databases"], mysql: Partial<Settings["mysql"]> = {}): Settings => ({
  ...base,
  databases,
  mysql: { host: "localhost", port: 3306, user: "root", password: "", database: "", ...mysql },
});

describe("database connections", () => {
  test("several connections of different engines, with ports and users defaulted per engine", () => {
    const settings = withDatabases({
      orders: { type: "postgres", host: "pg.internal", database: "orders", ssl: true, description: "Orders service" },
      legacy: { type: "mysql", host: "my.internal", user: "ro", password: "pw", database: "app" },
    });
    const { connections, problems } = listConnections(settings, {});
    expect(problems).toEqual([]);
    expect(connections).toEqual([
      { name: "orders", type: "postgres", host: "pg.internal", port: 5432, user: "", password: "", database: "orders", ssl: true, description: "Orders service" },
      { name: "legacy", type: "mysql", host: "my.internal", port: 3306, user: "ro", password: "pw", database: "app", ssl: false, description: "" },
    ]);
    // The first is the default; names are matched whatever their case.
    expect(pickConnection(undefined, settings, {})).toMatchObject({ name: "orders" });
    expect(pickConnection("LEGACY", settings, {})).toMatchObject({ name: "legacy", type: "mysql" });
    expect(pickConnection("nope", settings, {})).toEqual({ error: 'No connection named "nope". Available: orders, legacy.' });
    // What the agent is told never includes a host, user or password.
    const told = describeConnections(connections);
    expect(told).toBe("- orders (default): PostgreSQL; default database orders; Orders service\n- legacy: MySQL; default database app");
    expect(told).not.toMatch(/internal|pw/);
  });

  test("a connection URL fills in the fields, and separate fields win over it", () => {
    const settings = withDatabases({
      a: { type: "postgres", url: "postgresql://reader:s%40cret@db.example.com:6543/shop?sslmode=require" },
      b: { type: "postgres", url: "postgres://reader:x@db.example.com/shop", host: "replica.example.com", database: "reports" },
      c: { type: "mysql", url: "mysql://app@my.example.com/app" },
    });
    const { connections } = listConnections(settings, {});
    expect(connections[0]).toMatchObject({ host: "db.example.com", port: 6543, user: "reader", password: "s@cret", database: "shop", ssl: true });
    expect(connections[1]).toMatchObject({ host: "replica.example.com", port: 5432, database: "reports", ssl: false });
    expect(connections[2]).toMatchObject({ type: "mysql", host: "my.example.com", port: 3306, user: "app", database: "app" });
  });

  test("a password can come from an environment variable, and a missing one is reported, not guessed", () => {
    const settings = withDatabases({ orders: { type: "postgres", host: "pg", password: "in-file", password_env: "ORDERS_PW" } });
    expect(listConnections(settings, { ORDERS_PW: "from-env" }).connections[0].password).toBe("from-env");
    const missing = listConnections(settings, {});
    expect(missing.connections).toEqual([]);
    expect(missing.problems).toEqual([{ name: "orders", problem: "password_env names ORDERS_PW, which is not set" }]);
    expect(pickConnection("orders", settings, {})).toEqual({ error: 'Connection "orders" is misconfigured: password_env names ORDERS_PW, which is not set.' });
  });

  test("misconfigured connections are set aside with a reason", () => {
    const settings = withDatabases({
      nohost: { type: "postgres" },
      mismatch: { type: "mysql", url: "postgres://x@h/db" },
      badurl: { type: "postgres", url: "sqlite:///tmp/x.db" },
      fine: { type: "postgres", host: "pg" },
    });
    const { connections, problems } = listConnections(settings, {});
    expect(connections.map((c) => c.name)).toEqual(["fine"]);
    expect(problems.map((p) => p.name)).toEqual(["nohost", "mismatch", "badurl"]);
    expect(problems[1].problem).toBe('type is "mysql" but the url is for postgres');
  });

  test("the old [mysql] section is still a connection, named mysql", () => {
    // On its own (how every existing setup looks), even with no database named.
    expect(listConnections(withDatabases({}), {}).connections).toEqual([
      { name: "mysql", type: "mysql", host: "localhost", port: 3306, user: "root", password: "", database: "", ssl: false, description: "" },
    ]);
    // Beside named connections, only when it actually points at a database.
    const named = { orders: { type: "postgres" as const, host: "pg" } };
    expect(listConnections(withDatabases(named), {}).connections.map((c) => c.name)).toEqual(["orders"]);
    expect(listConnections(withDatabases(named, { database: "appdb", host: "my" }), {}).connections.map((c) => c.name)).toEqual(["orders", "mysql"]);
    // A named connection called "mysql" replaces it.
    expect(listConnections(withDatabases({ mysql: { type: "mysql", host: "new" } }, { database: "appdb" }), {}).connections).toHaveLength(1);
  });

  test("an environment changes fields of a connection and can add its own", () => {
    const merged = mergeDatabases(
      { orders: { type: "postgres", host: "staging-pg", database: "orders", user: "ro" } },
      { orders: { host: "prod-pg", ssl: true }, analytics: { type: "postgres", host: "warehouse" }, broken: { host: "no-type" } },
    );
    expect(merged.orders).toEqual({ type: "postgres", host: "prod-pg", database: "orders", user: "ro", ssl: true });
    expect(merged.analytics).toEqual({ type: "postgres", host: "warehouse" });
    // Nothing to inherit a type from, so it can't be a connection.
    expect(merged.broken).toBeUndefined();
    expect(mergeDatabases({ a: { type: "mysql" } }, undefined)).toEqual({ a: { type: "mysql" } });
  });
});

describe("read-only guard", () => {
  test("reading statements pass, per engine", () => {
    for (const q of ["SELECT 1", "  select * from t", "(SELECT 1) UNION (SELECT 2)", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN SELECT 1", "SHOW TABLES"]) {
      expect(readOnlyViolation("mysql", q)).toBeNull();
      expect(readOnlyViolation("postgres", q)).toBeNull();
    }
    expect(readOnlyViolation("mysql", "DESCRIBE orders")).toBeNull();
    expect(readOnlyViolation("postgres", "TABLE orders")).toBeNull();
    expect(readOnlyViolation("postgres", "VALUES (1), (2)")).toBeNull();
    // A trailing semicolon or a semicolon inside a string is not a second statement.
    expect(readOnlyViolation("postgres", "SELECT 'a;b' AS x;")).toBeNull();
    expect(readOnlyViolation("mysql", "SELECT 1; -- done")).toBeNull();
  });

  test("writes, and writes hidden behind a read, are refused", () => {
    for (const q of ["DELETE FROM t", "update t set a = 1", "DROP TABLE t", "INSERT INTO t VALUES (1)", "TRUNCATE t", "CALL p()", "SET x = 1", ""]) {
      expect(readOnlyViolation("mysql", q)).toContain("Only read-only statements");
      expect(readOnlyViolation("postgres", q)).toContain("Only read-only statements");
    }
    expect(readOnlyViolation("mysql", "SELECT 1; DROP TABLE t")).toBe("Run one statement at a time.");
    expect(readOnlyViolation("postgres", "SELECT 1;\nDELETE FROM t")).toBe("Run one statement at a time.");
    // MySQL has no read-only transaction behind this check, so a writing CTE is refused by it.
    expect(readOnlyViolation("mysql", "WITH gone AS (DELETE FROM t) SELECT 1")).toContain("Only read-only statements");
    // A column that merely contains a keyword is fine.
    expect(readOnlyViolation("mysql", "WITH x AS (SELECT updated_at, 'delete me' AS note FROM t) SELECT * FROM x")).toBeNull();
  });
});

describe("SQL tool registration", () => {
  test("three generic tools replace the MySQL-only ones, in one group that old names still resolve to", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["sql_query_tool", "sql_schema_tool", "sql_list_databases_tool"]));
    expect(names.some((n) => n.startsWith("mysql_"))).toBe(false);
    const groups = buildToolGroups(TOOLS);
    expect(groups.find((g) => g.id === SQL_GROUP)?.tools.map((t) => t.name)).toEqual(["sql_query_tool", "sql_schema_tool", "sql_list_databases_tool"]);
    // An agent saved with the old group name, or naming an old tool, still gets the group.
    expect(GROUP_ALIASES.mysql).toBe(SQL_GROUP);
    expect(resolveGroupNames(groups, ["mysql"])).toEqual({ enabled: [SQL_GROUP], unknown: [] });
    expect(resolveGroupNames(groups, ["MySQL", "sql_query_tool"])).toEqual({ enabled: [SQL_GROUP], unknown: [] });
  });

  test("a timeout error says whether the statement was stopped", () => {
    const stopped = new QueryTimeoutError(55_000, true, "");
    expect(stopped.message).toBe("Query exceeded 55s");
    expect(stopped.cancelled).toBe(true);
    // Drivers are swappable, which is how the tools are exercised without a server.
    const fake: Partial<SqlDriver> = { databases: async () => ["a"] };
    expect(typeof fake.databases).toBe("function");
  });
});
