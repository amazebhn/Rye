import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpOAuthProvider, MCP_OAUTH_PENDING_TTL_MS } from "../src/mcp/oauth.js";
import type { McpServerConfig } from "../src/mcp/config.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

let credentialsDir: string;
let config: McpServerConfig;

beforeEach(() => {
  credentialsDir = join(tmpdir(), `rye-mcp-oauth-${crypto.randomUUID()}`);
  mkdirSync(credentialsDir, { recursive: true });
  config = {
    name: "secure-remote",
    url: "https://mcp.example.com/mcp",
    auth: "oauth",
    oauth: { redirectUrl: "http://127.0.0.1:7337/mcp/oauth/callback", scope: "read write" },
  };
});

afterEach(() => rmSync(credentialsDir, { recursive: true, force: true }));

describe("McpOAuthProvider", () => {
  test("persists PKCE, state, registration, discovery, and tokens per server", () => {
    const provider = new McpOAuthProvider(config, credentialsDir);
    const state = provider.state();
    provider.saveCodeVerifier("pkce-verifier");
    provider.saveClientInformation({ client_id: "dynamic-client" });
    provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.com" });
    provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`));

    const restored = new McpOAuthProvider(config, credentialsDir);
    expect(restored.matchesState(state)).toBe(true);
    expect(restored.matchesState(`${state.slice(0, -1)}x`)).toBe(false);
    expect(restored.codeVerifier()).toBe("pkce-verifier");
    expect(restored.clientInformation()?.client_id).toBe("dynamic-client");
    expect(restored.discoveryState()?.authorizationServerUrl).toBe("https://auth.example.com");
    expect(restored.pendingAuthorization()?.startUrl).toBe(
      "http://127.0.0.1:7337/mcp/oauth/start/secure-remote"
    );
    expect(restored.consumeState(state)).toBe(true);
    expect(new McpOAuthProvider(config, credentialsDir).consumeState(state)).toBe(false);
    expect(restored.pendingAuthorization()).toBeNull();
    expect(restored.codeVerifier()).toBe("pkce-verifier");

    restored.saveTokens({ access_token: "access", refresh_token: "refresh", token_type: "Bearer" });
    const authorized = new McpOAuthProvider(config, credentialsDir);
    expect(authorized.tokens()?.refresh_token).toBe("refresh");
    expect(authorized.pendingAuthorization()).toBeNull();
    expect(() => authorized.codeVerifier()).toThrow("No OAuth PKCE verifier");
  });

  test("uses configured public or confidential client information", () => {
    const publicProvider = new McpOAuthProvider({
      ...config,
      oauth: { ...config.oauth, clientId: "public-client" },
    }, credentialsDir);
    expect(publicProvider.clientInformation()).toEqual({ client_id: "public-client" });
    expect(publicProvider.clientMetadata.token_endpoint_auth_method).toBe("none");

    const confidentialProvider = new McpOAuthProvider({
      ...config,
      name: "confidential",
      oauth: { ...config.oauth, clientId: "private-client", clientSecret: "resolved-secret" },
    }, credentialsDir);
    expect(confidentialProvider.clientInformation()).toEqual({
      client_id: "private-client",
      client_secret: "resolved-secret",
    });
    expect(confidentialProvider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  test("clears invalidated credentials without affecting unrelated state", () => {
    const provider = new McpOAuthProvider(config, credentialsDir);
    provider.saveClientInformation({ client_id: "dynamic-client" });
    provider.saveTokens({ access_token: "access", token_type: "Bearer" });
    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe("dynamic-client");
    provider.invalidateCredentials("all");
    expect(provider.clientInformation()).toBeUndefined();
  });

  test("expires abandoned authorization attempts", () => {
    let now = 1_000_000;
    const provider = new McpOAuthProvider(config, credentialsDir, () => now);
    const state = provider.state();
    provider.saveCodeVerifier("verifier");
    provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`));
    now += MCP_OAUTH_PENDING_TTL_MS + 1;
    expect(provider.matchesState(state)).toBe(false);
    expect(provider.pendingAuthorization()).toBeNull();
    expect(() => provider.codeVerifier()).toThrow("No OAuth PKCE verifier");
  });

  test("rejects insecure non-loopback authorization redirects", () => {
    const provider = new McpOAuthProvider(config, credentialsDir);
    expect(() => provider.redirectToAuthorization(new URL("http://auth.example.com/authorize"))).toThrow("must use HTTPS");
  });

  test("completes authorization-code exchange and refresh through the MCP SDK", async () => {
    const provider = new McpOAuthProvider(config, credentialsDir);
    provider.saveClientInformation({ client_id: "registered-client" });
    provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      } as never,
    });

    const grants: string[] = [];
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (requestUrl !== "https://auth.example.com/token") {
        return new Response("not found", { status: 404 });
      }
      const body = new URLSearchParams(String(init?.body ?? ""));
      const grant = body.get("grant_type") ?? "";
      grants.push(grant);
      if (grant === "authorization_code") {
        expect(body.get("code")).toBe("authorization-code");
        expect(body.get("code_verifier")).toBeTruthy();
        return new Response(JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      expect(grant).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-1");
      return new Response(JSON.stringify({ access_token: "access-2", token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    expect(await auth(provider, { serverUrl: config.url!, fetchFn })).toBe("REDIRECT");
    const pending = provider.pendingAuthorization();
    expect(pending).not.toBeNull();
    const state = new URL(pending!.authorizationUrl).searchParams.get("state")!;
    expect(provider.consumeState(state)).toBe(true);

    expect(await auth(provider, {
      serverUrl: config.url!,
      authorizationCode: "authorization-code",
      fetchFn,
    })).toBe("AUTHORIZED");
    expect(provider.tokens()?.access_token).toBe("access-1");

    expect(await auth(provider, { serverUrl: config.url!, fetchFn })).toBe("AUTHORIZED");
    expect(provider.tokens()?.access_token).toBe("access-2");
    expect(provider.tokens()?.refresh_token).toBe("refresh-1");
    expect(grants).toEqual(["authorization_code", "refresh_token"]);
  });
});