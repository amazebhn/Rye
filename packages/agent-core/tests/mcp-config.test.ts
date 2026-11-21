import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  previewMcpServerWrite,
  validateMcpServerWrite,
  writeMcpServer,
  isSafeOAuthBrowserUrl,
  type McpServerWrite,
} from "../src/mcp/config.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = join(tmpdir(), `rye-mcp-config-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  file = join(dir, "mcp.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stdio(name = "filesystem"): McpServerWrite {
  return {
    name,
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  };
}

describe("MCP config writes", () => {
  test("atomically creates a standard mcpServers document", () => {
    writeMcpServer(stdio(), file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.mcpServers.filesystem.command).toBe("npx");
    expect(parsed.mcpServers.filesystem.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ]);
  });

  test("preserves unrelated fields and existing servers", () => {
    writeFileSync(file, JSON.stringify({ note: "keep", mcpServers: { old: { url: "https://old.example/mcp" } } }));
    writeMcpServer(stdio("new"), file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.note).toBe("keep");
    expect(parsed.mcpServers.old.url).toBe("https://old.example/mcp");
    expect(parsed.mcpServers.new.command).toBe("npx");
  });

  test("preserves VS Code's servers key", () => {
    writeFileSync(file, JSON.stringify({ servers: { remote: { url: "https://example.com/mcp" } } }));
    writeMcpServer(stdio(), file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.mcpServers).toBeUndefined();
    expect(parsed.servers.filesystem.command).toBe("npx");
  });

  test("rejects duplicates unless replacement is explicit", () => {
    writeMcpServer(stdio(), file);
    expect(() => previewMcpServerWrite(stdio(), file)).toThrow("already exists");

    const replacement = { ...stdio(), replace: true, config: { url: "https://example.com/mcp" } };
    expect(previewMcpServerWrite(replacement, file).replacing).toBe(true);
    writeMcpServer(replacement, file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.mcpServers.filesystem).toEqual({ url: "https://example.com/mcp" });
  });

  test("requires environment references for likely secrets", () => {
    const literal = validateMcpServerWrite({
      name: "remote",
      config: { url: "https://example.com/mcp", headers: { Authorization: "Bearer secret-value" } },
    });
    expect(literal.join(" ")).toContain("looks sensitive");

    const referenced = validateMcpServerWrite({
      name: "remote",
      config: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } },
    });
    expect(referenced).toEqual([]);
  });

  test("accepts OAuth for remote servers without storing credentials", () => {
    const write: McpServerWrite = {
      name: "github",
      config: {
        url: "https://mcp.example.com/mcp",
        auth: "oauth",
        oauth: { scope: "repo read:user", clientId: "rye-client", clientSecret: "${MCP_CLIENT_SECRET}" },
      },
    };
    expect(validateMcpServerWrite(write)).toEqual([]);
    writeMcpServer(write, file);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.mcpServers.github.oauth.clientSecret).toBe("${MCP_CLIENT_SECRET}");
  });

  test("rejects unsafe or incompatible OAuth configuration", () => {
    expect(validateMcpServerWrite({
      name: "local",
      config: { command: "node", auth: "oauth" },
    }).join(" ")).toContain("only supported for URL-based");
    expect(validateMcpServerWrite({
      name: "remote",
      config: { url: "https://example.com/mcp", auth: "oauth", oauth: { clientId: "id", clientSecret: "literal" } },
    }).join(" ")).toContain("environment reference");
    expect(validateMcpServerWrite({
      name: "remote",
      config: { url: "https://example.com/mcp", auth: "oauth", headers: { Authorization: "Bearer ${TOKEN}" } },
    }).join(" ")).toContain("together with OAuth");
    expect(validateMcpServerWrite({
      name: "remote",
      config: { url: "https://example.com/mcp", auth: "oauth", oauth: { redirectUrl: "http://example.com/callback" } },
    }).join(" ")).toContain("localhost/loopback");
  });

  test("allows secure and loopback OAuth browser URLs only", () => {
    expect(isSafeOAuthBrowserUrl("https://auth.example.com/authorize")).toBe(true);
    expect(isSafeOAuthBrowserUrl("http://localhost:7337/callback")).toBe(true);
    expect(isSafeOAuthBrowserUrl("http://127.0.0.1:7337/callback")).toBe(true);
    expect(isSafeOAuthBrowserUrl("http://auth.example.com/authorize")).toBe(false);
    expect(isSafeOAuthBrowserUrl("javascript:alert(1)")).toBe(false);
  });

  test("rejects ambiguous transports and namespace-breaking names", () => {
    expect(validateMcpServerWrite({ name: "bad__name", config: { command: "node" } }).length).toBeGreaterThan(0);
    expect(
      validateMcpServerWrite({
        name: "both",
        config: { command: "node", url: "https://example.com/mcp" },
      }).join(" ")
    ).toContain("exactly one");
  });

  test("does not clobber malformed existing JSON", () => {
    writeFileSync(file, "{not-json");
    expect(() => writeMcpServer(stdio(), file)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{not-json");
  });
});