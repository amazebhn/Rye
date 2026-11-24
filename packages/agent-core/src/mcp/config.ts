/**
 * MCP server configuration — reads ~/.config/rye/mcp.json using the same
 * `mcpServers` shape as VS Code and Claude Desktop, so existing configs can be
 * pasted across unchanged.
 *
 * Stdio:  { "command": "npx", "args": ["-y", "pkg"], "env": {}, "cwd": "..." }
 * Remote: { "url": "https://example.com/mcp", "headers": {}, "transport": "http" | "sse" }
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CONFIG_FILE } from "../config.js";

export const MCP_CONFIG_FILE = join(dirname(CONFIG_FILE), "mcp.json");

export interface McpServerConfig {
  name: string;
  disabled?: boolean;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // remote
  url?: string;
  headers?: Record<string, string>;
  transport?: "http" | "sse";
  auth?: "oauth";
  oauth?: {
    /** Override the local callback URL when Rye is exposed through another origin. */
    redirectUrl?: string;
    /** Space-delimited OAuth scopes. Discovery metadata is used when omitted. */
    scope?: string;
    /** Optional pre-registered client. Omit to use dynamic client registration. */
    clientId?: string;
    /** Must be an environment reference such as ${MCP_CLIENT_SECRET}. */
    clientSecret?: string;
    /** Optional HTTPS URL used as the client_id when SEP-991 is supported. */
    clientMetadataUrl?: string;
  };
}

export type McpServerDefinition = Omit<McpServerConfig, "name">;

interface McpConfigDocument extends Record<string, unknown> {
  mcpServers?: Record<string, McpServerDefinition>;
  servers?: Record<string, McpServerDefinition>;
}

export interface McpServerWrite {
  name: string;
  config: McpServerDefinition;
  replace?: boolean;
}

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_REFERENCE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const SENSITIVE_KEY_RE = /authorization|token|secret|password|api[_-]?key|private[_-]?key/i;

/** OAuth browser URLs must be HTTPS, except loopback URLs used for local development. */
export function isSafeOAuthBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Substitute ${VAR} from the environment so secrets stay out of the file. */
function interpolate(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

function interpolateRecord(rec?: Record<string, string>): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, interpolate(String(v))]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDocument(filePath: string): McpConfigDocument {
  if (!existsSync(filePath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error("MCP config must contain a JSON object at the top level.");
  return parsed as McpConfigDocument;
}

function validateStringRecord(
  label: string,
  value: Record<string, string> | undefined,
  errors: string[]
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object of string values.`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      errors.push(`${label}.${key} must be a string.`);
    } else if (SENSITIVE_KEY_RE.test(key) && entry.length > 0 && !ENV_REFERENCE_RE.test(entry)) {
      errors.push(
        `${label}.${key} looks sensitive. Store the secret in the environment and use a reference such as \${MY_TOKEN}.`
      );
    }
  }
}

/** Validate the persisted (uninterpolated) server definition. */
export function validateMcpServerWrite(write: McpServerWrite): string[] {
  const errors: string[] = [];
  const { name, config } = write;

  if (!SERVER_NAME_RE.test(name) || name.includes("__")) {
    errors.push(
      "Server name must start with a letter or number, contain only letters, numbers, dots, dashes, or underscores, and must not contain '__'."
    );
  }
  if (!isRecord(config)) return [...errors, "Server config must be an object."];

  const hasCommand = typeof config.command === "string" && config.command.trim().length > 0;
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  if (hasCommand === hasUrl) errors.push("Provide exactly one of command (stdio) or url (remote). ");

  if (config.command !== undefined && !hasCommand) errors.push("command must be a non-empty string.");
  if (config.url !== undefined && !hasUrl) errors.push("url must be a non-empty string.");
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((v) => typeof v !== "string"))) {
    errors.push("args must be an array of strings.");
  }
  if (config.cwd !== undefined && (typeof config.cwd !== "string" || !config.cwd.trim())) {
    errors.push("cwd must be a non-empty string.");
  }
  if (config.transport !== undefined && config.transport !== "http" && config.transport !== "sse") {
    errors.push("transport must be 'http' or 'sse'.");
  }
  if (hasCommand && config.transport !== undefined) errors.push("transport is only valid for URL-based servers.");
  if (config.auth !== undefined && config.auth !== "oauth") errors.push("auth must be 'oauth'.");
  if (config.auth === "oauth" && !hasUrl) errors.push("OAuth is only supported for URL-based MCP servers.");
  if (config.oauth !== undefined && config.auth !== "oauth") errors.push("oauth options require auth='oauth'.");
  if (config.auth === "oauth" && config.headers?.Authorization) {
    errors.push("Do not configure an Authorization header together with OAuth; the OAuth provider manages it.");
  }
  if (hasUrl) {
    try {
      const url = new URL(config.url!);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push("url must use http or https.");
      }
    } catch {
      errors.push("url must be a valid absolute URL.");
    }
  }
  if (config.oauth !== undefined) {
    if (!isRecord(config.oauth)) {
      errors.push("oauth must be an object.");
    } else {
      const oauth = config.oauth;
      if (oauth.redirectUrl !== undefined) {
        if (!isSafeOAuthBrowserUrl(oauth.redirectUrl)) {
          errors.push("oauth.redirectUrl must use HTTPS, or HTTP on localhost/loopback.");
        }
      }
      if (oauth.scope !== undefined && (typeof oauth.scope !== "string" || !oauth.scope.trim())) {
        errors.push("oauth.scope must be a non-empty, space-delimited string.");
      }
      if (oauth.clientId !== undefined && (typeof oauth.clientId !== "string" || !oauth.clientId.trim())) {
        errors.push("oauth.clientId must be a non-empty string.");
      }
      if (oauth.clientSecret !== undefined) {
        if (!oauth.clientId) errors.push("oauth.clientSecret requires oauth.clientId.");
        if (typeof oauth.clientSecret !== "string" || !ENV_REFERENCE_RE.test(oauth.clientSecret)) {
          errors.push("oauth.clientSecret must use an environment reference such as ${MCP_CLIENT_SECRET}.");
        }
      }
      if (oauth.clientMetadataUrl !== undefined) {
        try {
          const metadataUrl = new URL(oauth.clientMetadataUrl);
          if (metadataUrl.protocol !== "https:" || metadataUrl.pathname === "/") {
            errors.push("oauth.clientMetadataUrl must be an HTTPS URL with a non-root path.");
          }
        } catch {
          errors.push("oauth.clientMetadataUrl must be a valid HTTPS URL.");
        }
      }
    }
  }
  validateStringRecord("env", config.env, errors);
  validateStringRecord("headers", config.headers, errors);
  return errors;
}

function serverCollection(document: McpConfigDocument): {
  key: "mcpServers" | "servers";
  servers: Record<string, McpServerDefinition>;
} {
  const key = Object.prototype.hasOwnProperty.call(document, "mcpServers")
    ? "mcpServers"
    : Object.prototype.hasOwnProperty.call(document, "servers")
      ? "servers"
      : "mcpServers";
  const value = document[key] ?? {};
  if (!isRecord(value)) throw new Error(`MCP config field '${key}' must be a JSON object.`);
  return { key, servers: value as Record<string, McpServerDefinition> };
}

/** Validate a proposed addition against the current file without changing it. */
export function previewMcpServerWrite(
  write: McpServerWrite,
  filePath = MCP_CONFIG_FILE
): { replacing: boolean; configFile: string } {
  const errors = validateMcpServerWrite(write);
  if (errors.length > 0) throw new Error(errors.join(" "));
  const { servers } = serverCollection(readDocument(filePath));
  const replacing = Object.prototype.hasOwnProperty.call(servers, write.name);
  if (replacing && !write.replace) {
    throw new Error(`MCP server '${write.name}' already exists. Set replace=true to explicitly replace it.`);
  }
  return { replacing, configFile: filePath };
}

/** Atomically add or replace one server while preserving the rest of the document. */
export function writeMcpServer(
  write: McpServerWrite,
  filePath = MCP_CONFIG_FILE
): { replacing: boolean; configFile: string } {
  const preview = previewMcpServerWrite(write, filePath);
  const document = readDocument(filePath);
  const { key, servers } = serverCollection(document);
  const config: McpServerDefinition = {
    ...(write.config.command !== undefined ? { command: write.config.command } : {}),
    ...(write.config.args !== undefined ? { args: [...write.config.args] } : {}),
    ...(write.config.env !== undefined ? { env: { ...write.config.env } } : {}),
    ...(write.config.cwd !== undefined ? { cwd: write.config.cwd } : {}),
    ...(write.config.url !== undefined ? { url: write.config.url } : {}),
    ...(write.config.headers !== undefined ? { headers: { ...write.config.headers } } : {}),
    ...(write.config.transport !== undefined ? { transport: write.config.transport } : {}),
    ...(write.config.auth !== undefined ? { auth: write.config.auth } : {}),
    ...(write.config.oauth !== undefined ? { oauth: { ...write.config.oauth } } : {}),
    ...(write.config.disabled !== undefined ? { disabled: write.config.disabled } : {}),
  };
  document[key] = { ...servers, [write.name]: config };
  saveDocument(document, filePath);
  return preview;
}

/** Write the whole config through a temp file and a rename, so a crash never leaves it half-written. */
function saveDocument(document: McpConfigDocument, filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

/** One entry of the config file as it is written there: nothing interpolated, disabled and invalid ones included. */
export interface McpServerEntry {
  name: string;
  config: McpServerDefinition;
  disabled: boolean;
  /** Why this entry can't be used, when it can't. */
  problems: string[];
}

/** Every server in the config file, in file order, for managing them (the client only loads usable ones). */
export function listMcpServerEntries(filePath = MCP_CONFIG_FILE): McpServerEntry[] {
  const { servers } = serverCollection(readDocument(filePath));
  return Object.entries(servers).map(([name, raw]) => {
    if (!isRecord(raw)) return { name, config: {}, disabled: false, problems: ["The definition must be a JSON object."] };
    const config = raw as McpServerDefinition;
    return { name, config, disabled: config.disabled === true, problems: validateMcpServerWrite({ name, config }) };
  });
}

/** Remove one server, leaving the rest of the document as it was. Returns false if there was no such server. */
export function removeMcpServer(name: string, filePath = MCP_CONFIG_FILE): boolean {
  const document = readDocument(filePath);
  const { key, servers } = serverCollection(document);
  if (!Object.prototype.hasOwnProperty.call(servers, name)) return false;
  const { [name]: _removed, ...rest } = servers;
  document[key] = rest;
  saveDocument(document, filePath);
  return true;
}

/** Turn one server off or on without touching the rest of its definition. Returns false if there was no such server. */
export function setMcpServerDisabled(name: string, disabled: boolean, filePath = MCP_CONFIG_FILE): boolean {
  const document = readDocument(filePath);
  const { key, servers } = serverCollection(document);
  const current = servers[name];
  if (!Object.prototype.hasOwnProperty.call(servers, name) || !isRecord(current)) return false;
  const { disabled: _was, ...definition } = current as McpServerDefinition;
  // "disabled: false" is just noise in the file, so an enabled server carries no flag.
  document[key] = { ...servers, [name]: disabled ? { ...definition, disabled: true } : definition };
  saveDocument(document, filePath);
  return true;
}

export function loadMcpConfig(): McpServerConfig[] {
  try {
    if (!existsSync(MCP_CONFIG_FILE)) return [];
    const parsed = readDocument(MCP_CONFIG_FILE);
    // VS Code writes "servers", Claude Desktop writes "mcpServers".
    const entries = parsed.mcpServers ?? parsed.servers ?? {};

    return Object.entries(entries)
      .flatMap(([name, cfg]) => {
        if (!isRecord(cfg)) {
          console.error(`[mcp] ignoring invalid server "${name}": definition must be an object`);
          return [];
        }
        if (cfg.disabled) return [];
        const errors = validateMcpServerWrite({ name, config: cfg as McpServerDefinition });
        if (errors.length > 0) {
          console.error(`[mcp] ignoring invalid server "${name}": ${errors.join(" ")}`);
          return [];
        }
        return [{
        ...cfg,
        name,
        command: cfg.command ? expandHome(interpolate(cfg.command)) : undefined,
        args: cfg.args?.map((a) => interpolate(String(a))),
        cwd: cfg.cwd ? expandHome(interpolate(cfg.cwd)) : undefined,
        url: cfg.url ? interpolate(cfg.url) : undefined,
        env: interpolateRecord(cfg.env),
        headers: interpolateRecord(cfg.headers),
        oauth: cfg.oauth
          ? {
              ...cfg.oauth,
              redirectUrl: cfg.oauth.redirectUrl ? interpolate(cfg.oauth.redirectUrl) : undefined,
              clientId: cfg.oauth.clientId ? interpolate(cfg.oauth.clientId) : undefined,
              clientSecret: cfg.oauth.clientSecret ? interpolate(cfg.oauth.clientSecret) : undefined,
              clientMetadataUrl: cfg.oauth.clientMetadataUrl ? interpolate(cfg.oauth.clientMetadataUrl) : undefined,
            }
          : undefined,
        } as McpServerConfig];
      })
      .filter((cfg) => cfg.command || cfg.url);
  } catch (err) {
    console.error(`[mcp] failed to read ${MCP_CONFIG_FILE}:`, err instanceof Error ? err.message : err);
    return [];
  }
}
