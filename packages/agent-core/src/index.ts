/**
 * @rye/agent-core — package entry point.
 * Exports the public API surface used by other packages and the server.
 */

// Config
export { settings, getSettings, CONFIG_DIR, DATA_DIR, CONFIG_FILE } from "./config.js";
export type { Settings, CodeSearchConfig, RepoEntry } from "./config.js";

// Copilot auth
export { getCopilotBearerToken } from "./copilot-auth.js";

// Agent loop
export { runAgent, getSession, clearSession } from "./agent/loop.js";
export type { AgentEvent } from "./agent/loop.js";

// SOP store
export { SOPStore } from "./sop/store.js";
export type { SOP } from "./sop/store.js";

// SOP extractor
export { extractSopFromChat } from "./sop/extractor.js";
export type { ExtractedSOP } from "./sop/extractor.js";

// Tools (for external testing / extension)
export { TOOLS, executeTool } from "./tools/index.js";
