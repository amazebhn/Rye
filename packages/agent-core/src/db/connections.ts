/**
 * The SQL connections available in the active environment.
 *
 * They come from `[databases.<name>]` in config.toml (any number, MySQL or
 * Postgres), with `[environments.<env>.databases.<name>]` changing or adding
 * to them per environment. The older single `[mysql]` section still works: it
 * appears as a connection named "mysql".
 */

import { getEffectiveSettings, type DatabaseConfig, type DatabaseType, type Settings } from "../config.js";

export const LEGACY_MYSQL_NAME = "mysql";
const DEFAULT_PORT: Record<DatabaseType, number> = { mysql: 3306, postgres: 5432 };

/** A connection with every field filled in, ready for a driver. */
export interface DbConnection {
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  user: string;
  password: string;
  /** Default database (Postgres) or schema (MySQL); "" when none is set. */
  database: string;
  ssl: boolean;
  description: string;
}

/** A connection that is configured but can't be used, and why. */
export interface DbConnectionProblem {
  name: string;
  problem: string;
}

/** Fields from a `postgres://user:pass@host:port/db?sslmode=require` or `mysql://…` URL. */
function fromUrl(raw: string): Partial<DbConnection> {
  const url = new URL(raw);
  const protocol = url.protocol.replace(/:$/, "");
  const type: DatabaseType | undefined = protocol === "postgres" || protocol === "postgresql" ? "postgres" : protocol === "mysql" ? "mysql" : undefined;
  if (!type) throw new Error(`"${protocol}" URLs are not supported (use postgres:// or mysql://)`);
  const sslmode = url.searchParams.get("sslmode") ?? url.searchParams.get("ssl-mode") ?? "";
  const ssl = url.searchParams.get("ssl") === "true" || /^(require|verify-ca|verify-full|required|verify_ca|verify_identity)$/i.test(sslmode);
  return {
    type,
    host: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname.length > 1 ? { database: decodeURIComponent(url.pathname.slice(1)) } : {}),
    ...(ssl ? { ssl } : {}),
  };
}

function resolve(name: string, cfg: DatabaseConfig, env: NodeJS.ProcessEnv): DbConnection | DbConnectionProblem {
  let parsed: Partial<DbConnection> = {};
  if (cfg.url) {
    try {
      parsed = fromUrl(cfg.url);
    } catch (err) {
      return { name, problem: `url: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (parsed.type !== cfg.type) return { name, problem: `type is "${cfg.type}" but the url is for ${parsed.type}` };
  }
  let password = cfg.password ?? parsed.password ?? "";
  if (cfg.password_env) {
    const fromEnv = env[cfg.password_env];
    if (fromEnv === undefined) return { name, problem: `password_env names ${cfg.password_env}, which is not set` };
    password = fromEnv;
  }
  const host = cfg.host ?? parsed.host ?? "";
  if (!host) return { name, problem: "no host (set host or url)" };
  return {
    name,
    type: cfg.type,
    host,
    port: cfg.port ?? parsed.port ?? DEFAULT_PORT[cfg.type],
    // Postgres falls back to the OS user when none is given; MySQL's old default here was root.
    user: cfg.user ?? parsed.user ?? (cfg.type === "mysql" ? "root" : ""),
    password,
    database: cfg.database ?? parsed.database ?? "",
    ssl: cfg.ssl ?? parsed.ssl ?? false,
    description: cfg.description ?? "",
  };
}

/**
 * Every connection in the active environment, usable ones and broken ones.
 * The first usable one is the default when a tool call doesn't name a connection.
 */
export function listConnections(
  settings: Settings = getEffectiveSettings(),
  env: NodeJS.ProcessEnv = process.env,
): { connections: DbConnection[]; problems: DbConnectionProblem[] } {
  const connections: DbConnection[] = [];
  const problems: DbConnectionProblem[] = [];
  const named = Object.entries(settings.databases);
  for (const [name, cfg] of named) {
    const resolved = resolve(name, cfg, env);
    if ("problem" in resolved) problems.push(resolved);
    else connections.push(resolved);
  }
  // The old [mysql] section: kept when it names a database, or when it is all there is
  // (so a setup that relied on its defaults behaves as before).
  const legacy = settings.mysql;
  if (!(LEGACY_MYSQL_NAME in settings.databases) && (legacy.database || named.length === 0)) {
    connections.push({
      name: LEGACY_MYSQL_NAME,
      type: "mysql",
      host: legacy.host,
      port: legacy.port,
      user: legacy.user,
      password: legacy.password,
      database: legacy.database,
      ssl: false,
      description: "",
    });
  }
  return { connections, problems };
}

/** The connection a tool call means: the named one, or the default when none is named. */
export function pickConnection(name: string | undefined, settings?: Settings, env?: NodeJS.ProcessEnv): DbConnection | { error: string } {
  const { connections, problems } = listConnections(settings, env);
  const wanted = name?.trim();
  if (!wanted) {
    if (connections.length > 0) return connections[0];
    return { error: problems.length ? `No usable database connection. ${describeProblems(problems)}` : "No database connection is configured for this environment." };
  }
  const found = connections.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found;
  const broken = problems.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (broken) return { error: `Connection "${broken.name}" is misconfigured: ${broken.problem}.` };
  const names = connections.map((c) => c.name).join(", ");
  return { error: `No connection named "${wanted}".${names ? ` Available: ${names}.` : " None are configured for this environment."}` };
}

export function describeProblems(problems: DbConnectionProblem[]): string {
  return problems.map((p) => `"${p.name}": ${p.problem}`).join("; ");
}

const ENGINE: Record<DatabaseType, string> = { mysql: "MySQL", postgres: "PostgreSQL" };
export const engineName = (type: DatabaseType): string => ENGINE[type];

/** One line per connection for the agent: name, engine, default database, what it holds. Never credentials. */
export function describeConnections(connections: DbConnection[]): string {
  return connections
    .map((c, i) => {
      const parts = [engineName(c.type), c.database ? `default database ${c.database}` : "", c.description].filter(Boolean);
      return `- ${c.name}${i === 0 && connections.length > 1 ? " (default)" : ""}: ${parts.join("; ")}`;
    })
    .join("\n");
}
