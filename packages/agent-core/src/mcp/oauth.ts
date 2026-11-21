/** Persistent OAuth 2.1/PKCE state for remote MCP servers. */

import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { DATA_DIR, getSettings } from "../config.js";
import { isSafeOAuthBrowserUrl, type McpServerConfig } from "./config.js";

interface StoredOAuthCredentials {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  authorizationUrl?: string;
  authorizationStartedAt?: number;
  discoveryState?: OAuthDiscoveryState;
}

export interface McpOAuthPending {
  server: string;
  authorizationUrl: string;
  startUrl: string;
}

export const MCP_OAUTH_DIR = join(DATA_DIR, "mcp-oauth");
export const MCP_OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;

function serverFileName(server: string): string {
  return `${Buffer.from(server, "utf8").toString("base64url")}.json`;
}

function defaultRedirectUrl(): string {
  const { host, port } = getSettings();
  const callbackHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${callbackHost}:${port}/mcp/oauth/callback`;
}

export class McpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  private readonly filePath: string;

  constructor(
    private readonly server: McpServerConfig,
    credentialsDir = MCP_OAUTH_DIR,
    private readonly now: () => number = Date.now
  ) {
    this.filePath = join(credentialsDir, serverFileName(server.name));
    this.clientMetadataUrl = server.oauth?.clientMetadataUrl;
  }

  get redirectUrl(): string {
    return this.server.oauth?.redirectUrl ?? defaultRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Rye MCP Client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.server.oauth?.clientSecret ? "client_secret_post" : "none",
      ...(this.server.oauth?.scope ? { scope: this.server.oauth.scope } : {}),
    };
  }

  private read(): StoredOAuthCredentials {
    try {
      if (!existsSync(this.filePath)) return {};
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as StoredOAuthCredentials
        : {};
    } catch {
      return {};
    }
  }

  private write(update: Partial<StoredOAuthCredentials>, remove: Array<keyof StoredOAuthCredentials> = []): void {
    const next = { ...this.read(), ...update };
    for (const key of remove) delete next[key];
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.filePath);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
  }

  state(): string {
    const state = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
    this.write({ state, authorizationStartedAt: this.now() }, ["authorizationUrl"]);
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.server.oauth?.clientId) {
      return {
        client_id: this.server.oauth.clientId,
        ...(this.server.oauth.clientSecret ? { client_secret: this.server.oauth.clientSecret } : {}),
      };
    }
    return this.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.write({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens }, ["state", "authorizationUrl", "authorizationStartedAt", "codeVerifier"]);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!isSafeOAuthBrowserUrl(authorizationUrl.toString())) {
      throw new Error("OAuth authorization URL must use HTTPS, or HTTP on localhost/loopback.");
    }
    const state = authorizationUrl.searchParams.get("state");
    if (!state || !this.matchesState(state)) {
      throw new Error("OAuth authorization URL is missing the expected state value.");
    }
    this.write({ authorizationUrl: authorizationUrl.toString() });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) throw new Error(`No OAuth PKCE verifier is pending for MCP server '${this.server.name}'.`);
    return verifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.write({ discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read().discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") {
      this.write({}, ["clientInformation", "tokens", "codeVerifier", "state", "authorizationUrl", "authorizationStartedAt", "discoveryState"]);
    } else if (scope === "client") {
      this.write({}, ["clientInformation"]);
    } else if (scope === "tokens") {
      this.write({}, ["tokens"]);
    } else if (scope === "verifier") {
      this.write({}, ["codeVerifier", "state", "authorizationUrl", "authorizationStartedAt"]);
    } else {
      this.write({}, ["discoveryState"]);
    }
  }

  pendingAuthorization(): McpOAuthPending | null {
    const stored = this.read();
    if (!this.isPending(stored) || !stored.authorizationUrl || !isSafeOAuthBrowserUrl(stored.authorizationUrl)) {
      // A verifier without state means the callback already consumed state and
      // is exchanging its code. Status polling must not disrupt that exchange.
      if (stored.state || stored.authorizationUrl) this.clearPendingAuthorization();
      return null;
    }
    const callback = new URL(this.redirectUrl);
    return {
      server: this.server.name,
      authorizationUrl: stored.authorizationUrl,
      startUrl: `${callback.origin}/mcp/oauth/start/${encodeURIComponent(this.server.name)}`,
    };
  }

  matchesState(state: string): boolean {
    const stored = this.read();
    if (!this.isPending(stored)) return false;
    const expected = stored.state;
    if (!expected || expected.length !== state.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(state));
  }

  /** Consume state before exchanging the code so a callback cannot be replayed. */
  consumeState(state: string): boolean {
    // open(..., "wx") is an atomic cross-process claim. The state hash keeps
    // abandoned claim files from blocking a later authorization attempt.
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const stateHash = createHash("sha256").update(state).digest("hex");
    const claimPath = `${this.filePath}.${stateHash}.claim`;
    let claim: number;
    try {
      claim = openSync(claimPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }

    try {
      if (!this.matchesState(state)) return false;
      this.write({}, ["state", "authorizationUrl", "authorizationStartedAt"]);
      return true;
    } finally {
      closeSync(claim);
      rmSync(claimPath, { force: true });
    }
  }

  private isPending(stored: StoredOAuthCredentials): boolean {
    const now = this.now();
    return Boolean(
      stored.state &&
      stored.authorizationStartedAt &&
      now - stored.authorizationStartedAt >= 0 &&
      now - stored.authorizationStartedAt <= MCP_OAUTH_PENDING_TTL_MS
    );
  }

  clearPendingAuthorization(): void {
    this.write({}, ["codeVerifier", "state", "authorizationUrl", "authorizationStartedAt"]);
  }
}