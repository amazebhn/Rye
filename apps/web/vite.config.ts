import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

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
      proxy: {
        "/chat": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/env": { target: agentUrl, changeOrigin: true },
        "/sop": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/skill": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/memory": { target: agentUrl, changeOrigin: true },
        "/knowledge": { target: agentUrl, changeOrigin: true, timeout: 60000, proxyTimeout: 60000 },
        "/agents": { target: agentUrl, changeOrigin: true },
        "/usage": { target: agentUrl, changeOrigin: true },
        "/result": { target: agentUrl, changeOrigin: true },
        "/artifact": { target: agentUrl, changeOrigin: true },
        "/link-preview": { target: agentUrl, changeOrigin: true },
        "/health": { target: agentUrl, changeOrigin: true },
        "/status": { target: agentUrl, changeOrigin: true },
        "/models": { target: agentUrl, changeOrigin: true },
        "/mcp": { target: agentUrl, changeOrigin: true },
      },
    },
  };
});
