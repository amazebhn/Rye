import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";

// Pages with an address of their own (src/utils/routes.ts) whose path is also an API prefix.
// A page load of one (a reload, a pasted link) gets the app; the app's own fetch calls, which
// are never page loads, still reach the backend.
const PAGE_ON_API_PATH = /^\/(?:memory|agents)$/;
function pageLoad(req: IncomingMessage): string | undefined {
  const path = (req.url ?? "").split("?")[0];
  const navigating = req.headers["sec-fetch-mode"] === "navigate" || (req.headers.accept ?? "").includes("text/html");
  return navigating && PAGE_ON_API_PATH.test(path) ? "/index.html" : undefined;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const host = env.RYE_HOST ?? "127.0.0.1";
  const port = env.RYE_PORT ?? "7337";
  const agentUrl = env.VITE_AGENT_URL ?? `http://${host}:${port}`;

  return {
    plugins: [react()],
    publicDir: "assets",
    server: {
      port: 8080,
      // Keys are matched as prefixes unless they start with "^" (a regular expression).
      proxy: {
        "/chat": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/env": { target: agentUrl, changeOrigin: true },
        // A regular expression, so the SOPs page (/sops, /sops/<id>) isn't sent to the backend.
        "^/sop(?:/|\\?|$)": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/skill": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/memory": { target: agentUrl, changeOrigin: true, bypass: pageLoad },
        "/knowledge": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/agents": { target: agentUrl, changeOrigin: true, bypass: pageLoad },
        "/speech": { target: agentUrl, changeOrigin: true, timeout: 130000, proxyTimeout: 130000 },
        "/usage": { target: agentUrl, changeOrigin: true },
        "/result": { target: agentUrl, changeOrigin: true },
        "/artifact": { target: agentUrl, changeOrigin: true },
        "/link-preview": { target: agentUrl, changeOrigin: true },
        "/health": { target: agentUrl, changeOrigin: true },
        "/status": { target: agentUrl, changeOrigin: true },
        "/models": { target: agentUrl, changeOrigin: true },
        "/mcp": { target: agentUrl, changeOrigin: true },
        "/profile": { target: agentUrl, changeOrigin: true },
      },
    },
  };
});
