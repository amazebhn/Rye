/**
 * GitHub Copilot auth — reads the local OAuth token stored by VS Code,
 * exchanges it for an ephemeral Bearer token, and caches until expiry.
 *
 * No API key required: uses the token installed by your existing Copilot
 * subscription (same method as CopilotChat.nvim / copilot_api_wrapper).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// OAuth token discovery
// ---------------------------------------------------------------------------

function copilotConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "github-copilot");
  return join(homedir(), ".config", "github-copilot");
}

function* candidateTokens(): Generator<string> {
  const dir = copilotConfigDir();

  // Newer VS Code Copilot writes here: { "https://github.com/login/oauth": [{ accessToken, ... }] }
  try {
    const raw = readFileSync(join(dir, "oauth.json"), "utf-8");
    const data = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>;
    for (const entries of Object.values(data)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const tok = entry?.["accessToken"];
        if (typeof tok === "string" && tok) yield tok;
      }
    }
  } catch {
    // file missing or unreadable — fall through to legacy locations
  }

  // Legacy locations: { "<host>": { oauth_token, ... } }
  for (const filename of ["hosts.json", "apps.json"]) {
    try {
      const raw = readFileSync(join(dir, filename), "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [host, value] of Object.entries(data)) {
        if (
          host.includes("github") &&
          typeof value === "object" &&
          value !== null &&
          "oauth_token" in value &&
          typeof (value as Record<string, unknown>).oauth_token === "string"
        ) {
          yield (value as Record<string, string>).oauth_token;
        }
      }
    } catch {
      // try next file
    }
  }
}

// ---------------------------------------------------------------------------
// Token exchange + cache
// ---------------------------------------------------------------------------

interface CachedToken {
  bearer: string;
  expiresAt: number; // unix seconds
}

let cache: CachedToken | null = null;

/**
 * Drop the cached bearer so the next getCopilotBearerToken() re-exchanges.
 * Call this when the Copilot API rejects the current bearer (401/403) — the
 * upstream OAuth session may have been rotated by VS Code mid-process, which
 * invalidates a previously-issued bearer before its stated expiry.
 */
export function invalidateCopilotToken(): void {
  cache = null;
}

/** Returns a fresh (or cached) ephemeral Bearer token for api.githubcopilot.com */
export async function getCopilotBearerToken(forceRefresh = false): Promise<string> {
  const nowSec = Date.now() / 1000;
  if (!forceRefresh && cache && cache.expiresAt > nowSec + 60) {
    return cache.bearer;
  }
  cache = null;

  const tried: string[] = [];
  let lastErr = "";
  for (const oauth of candidateTokens()) {
    tried.push(`${oauth.slice(0, 8)}…`);
    const resp = await fetch(
      "https://api.github.com/copilot_internal/v2/token",
      {
        headers: {
          Authorization: `Token ${oauth}`,
          "User-Agent": "rye-agent/1.0",
        },
      }
    );
    if (resp.ok) {
      const body = (await resp.json()) as { token: string; expires_at: number };
      cache = { bearer: body.token, expiresAt: body.expires_at };
      return body.token;
    }
    lastErr = `${resp.status}: ${await resp.text()}`;
  }

  if (tried.length === 0) {
    throw new Error(
      "GitHub Copilot OAuth token not found.\n" +
        `Checked: ${copilotConfigDir()}/{oauth,hosts,apps}.json\n` +
        "Make sure you have an active Copilot subscription and VS Code (or GitHub CLI) has authenticated."
    );
  }
  throw new Error(
    `Failed to exchange any Copilot OAuth token (tried ${tried.length}: ${tried.join(", ")}). Last error: ${lastErr}`
  );
}

/** Extra headers that Copilot's endpoint requires / recommends */
export function copilotHeaders(bearerToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearerToken}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": "vscode/1.90.0",
    "Editor-Plugin-Version": "copilot-chat/0.1.0",
  };
}
