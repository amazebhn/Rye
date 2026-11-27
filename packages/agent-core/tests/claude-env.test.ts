import { afterEach, describe, expect, test } from "bun:test";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { claudeAgentSdkApi, closeClaudeSessions } from "../src/harness/claude-sdk.js";
import { CLAUDE_CLIENT_APP, claudeEnv } from "../src/harness/env.js";

/** What Rye's process might hold after loading its .env: Rye settings and other services' secrets. */
const SECRETS: Record<string, string> = {
  RYE_DATA_DIR: "/tmp/rye-data",
  RYE_CONFIG_DIR: "/tmp/rye-config",
  RYE_HARNESS: "claude",
  MYSQL_PASSWORD: "db-secret",
  PGPASSWORD: "pg-secret",
  PROD_DB_PASSWORD: "prod-secret",
  JIRA_API_TOKEN: "jira-secret",
  JIRA_EMAIL: "me@example.com",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AWS_SESSION_TOKEN: "aws-session",
  AWS_PROFILE: "prod",
  GITHUB_TOKEN: "ghp_secret",
  GH_TOKEN: "gh-secret",
  COPILOT_GITHUB_TOKEN: "copilot-secret",
  OPENAI_API_KEY: "sk-openai",
  BITBUCKET_TOKEN: "bb-secret",
  NODE_OPTIONS: "--require /tmp/evil.js",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
};

/** What Claude Code needs to start, find its login and reach its model. */
const NEEDED: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/Users/someone",
  USER: "someone",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  TMPDIR: "/tmp/",
  TERM: "xterm-256color",
  ANTHROPIC_API_KEY: "sk-ant-key",
  ANTHROPIC_BASE_URL: "https://gateway.example.com",
  ANTHROPIC_MODEL: "sonnet",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  CLAUDE_CONFIG_DIR: "/Users/someone/.claude",
  HTTPS_PROXY: "http://proxy:8080",
  NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
};

describe("claudeEnv", () => {
  test("keeps what Claude Code needs and drops every secret", () => {
    const env = claudeEnv({ source: { ...SECRETS, ...NEEDED } });
    for (const [name, value] of Object.entries(NEEDED)) expect(env[name]).toBe(value);
    for (const name of Object.keys(SECRETS)) expect(env[name]).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(CLAUDE_CLIENT_APP);
    expect(Object.keys(env).sort()).toEqual([...Object.keys(NEEDED), "CLAUDE_AGENT_SDK_CLIENT_APP"].sort());
  });

  test("passes AWS credentials only when Claude Code uses Bedrock", () => {
    const bedrock = claudeEnv({ source: { ...SECRETS, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" } });
    expect(bedrock).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_PROFILE: "prod",
    });
    expect(bedrock.JIRA_API_TOKEN).toBeUndefined();
    expect(bedrock.RYE_DATA_DIR).toBeUndefined();

    for (const off of ["0", "false", ""]) {
      const env = claudeEnv({ source: { ...SECRETS, CLAUDE_CODE_USE_BEDROCK: off, AWS_REGION: "us-east-1" } });
      expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(env.AWS_REGION).toBeUndefined();
    }
  });

  test("passes Google credentials only when Claude Code uses Vertex", () => {
    const vertex = claudeEnv({ source: { ...SECRETS, CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: "us-east5", VERTEX_REGION_CLAUDE_SONNET: "europe-west1" } });
    expect(vertex).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      CLOUD_ML_REGION: "us-east5",
      VERTEX_REGION_CLAUDE_SONNET: "europe-west1",
    });
    expect(vertex.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(claudeEnv({ source: SECRETS }).GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  test("overrides are added on top, but the client id stays Rye's", () => {
    const env = claudeEnv({
      source: NEEDED,
      overrides: { TMPDIR: "/data/code/s1/tmp", XDG_CACHE_HOME: "/data/code/s1/cache", CLAUDE_AGENT_SDK_CLIENT_APP: "other" },
    });
    expect(env.TMPDIR).toBe("/data/code/s1/tmp");
    expect(env.XDG_CACHE_HOME).toBe("/data/code/s1/cache");
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(CLAUDE_CLIENT_APP);
  });
});

describe("chat harness", () => {
  const MODEL = { id: "sonnet", name: "Claude", api: "claude-agent-sdk", provider: "claude" } as unknown as Model<Api>;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    closeClaudeSessions();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  test("starts Claude Code with the scrubbed env, not process.env", async () => {
    for (const name of ["RYE_TEST_SECRET", "JIRA_API_TOKEN", "MYSQL_PASSWORD"]) {
      saved.set(name, process.env[name]);
      process.env[name] = "leaked";
    }
    let env: Record<string, string | undefined> | undefined;
    // Stands in for the SDK's query(): records the options and answers one turn. Never starts Claude Code.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = ({ prompt, options }: any) => {
      env = options.env;
      const input = prompt[Symbol.asyncIterator]();
      const gen = (async function* () {
        if ((await input.next()).done) return;
        const e = (event: object) => ({ type: "stream_event", parent_tool_use_id: null, event });
        yield e({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1 } } });
        yield e({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        yield e({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
        yield e({ type: "content_block_stop", index: 0 });
        yield e({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        yield e({ type: "message_stop" });
        yield { type: "result", subtype: "success", is_error: false, result: "ok" };
      })();
      return Object.assign(gen, { close: () => void gen.return(undefined) });
    };

    const api = claudeAgentSdkApi({ query });
    const message = await api.stream(MODEL, normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] })).result();
    expect(message.stopReason).toBe("stop");

    expect(env).toBeDefined();
    expect(env!.RYE_TEST_SECRET).toBeUndefined();
    expect(env!.JIRA_API_TOKEN).toBeUndefined();
    expect(env!.MYSQL_PASSWORD).toBeUndefined();
    expect(env!.PATH).toBe(process.env.PATH);
    expect(env!.CLAUDE_AGENT_SDK_CLIENT_APP).toBe(CLAUDE_CLIENT_APP);
    expect(env).toEqual(claudeEnv());
  });
});
