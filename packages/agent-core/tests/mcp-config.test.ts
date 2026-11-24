import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listMcpServerEntries,
  previewMcpServerWrite,
  removeMcpServer,
  setMcpServerDisabled,
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

describe("managing MCP servers", () => {
  test("lists every entry as written, including disabled and unusable ones", () => {
    expect(listMcpServerEntries(file)).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["server"], env: { TOKEN: "${FILES_TOKEN}" } },
          off: { url: "https://example.com/mcp", disabled: true },
          broken: { transport: "sse" },
          junk: "not an object",
        },
      }),
    );
    const entries = listMcpServerEntries(file);
    expect(entries.map((e) => [e.name, e.disabled, e.problems.length > 0])).toEqual([
      ["files", false, false],
      ["off", true, false],
      ["broken", false, true],
      ["junk", false, true],
    ]);
    // Nothing is interpolated: the editor shows the reference, not the secret.
    expect(entries[0].config.env).toEqual({ TOKEN: "${FILES_TOKEN}" });
  });

  test("disabling keeps the definition, enabling removes the flag, and neither touches other entries", () => {
    writeFileSync(file, JSON.stringify({ note: "keep", mcpServers: { a: { command: "x", args: ["1"] }, b: { url: "https://b.example/mcp" } } }));
    expect(setMcpServerDisabled("a", true, file)).toBe(true);
    let parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.mcpServers.a).toEqual({ command: "x", args: ["1"], disabled: true });
    expect(parsed.mcpServers.b).toEqual({ url: "https://b.example/mcp" });
    expect(parsed.note).toBe("keep");

    expect(setMcpServerDisabled("a", false, file)).toBe(true);
    parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.mcpServers.a).toEqual({ command: "x", args: ["1"] });
    expect(setMcpServerDisabled("nope", true, file)).toBe(false);
  });

  test("removing deletes one entry and reports a missing one", () => {
    writeFileSync(file, JSON.stringify({ servers: { a: { command: "x" }, b: { command: "y" } } }));
    expect(removeMcpServer("a", file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // The file keeps the key it was written with.
    expect(parsed).toEqual({ servers: { b: { command: "y" } } });
    expect(removeMcpServer("a", file)).toBe(false);
    expect(listMcpServerEntries(file).map((e) => e.name)).toEqual(["b"]);
  });

  test("editing replaces a definition only when asked to", () => {
    writeMcpServer(stdio(), file);
    expect(() => writeMcpServer({ name: "filesystem", config: { url: "https://new.example/mcp" } }, file)).toThrow(/already exists/);
    writeMcpServer({ name: "filesystem", config: { url: "https://new.example/mcp" }, replace: true }, file);
    expect(listMcpServerEntries(file)[0].config).toEqual({ url: "https://new.example/mcp" });
  });
});