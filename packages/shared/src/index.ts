/**
 * Shared types for Rye agent communication.
 */

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
}

export interface ChatSession {
  session_id: string;
  messages: ChatMessage[];
  created_at: string;
}

export type PromptType = "yesno" | "choice" | "text";

export interface PendingPrompt {
  id: string;
  type: PromptType;
  question: string;
  options?: string[];
  multiSelect?: boolean; // choice prompts only
}

export type SSEEvent = {
  type: "session" | "agent" | "agent_turn_start" | "token" | "iter_start" | "tool_start" | "tool_result" | "usage" | "done" | "pause" | "prompt" | "iter_summary" | "error" | "sop_draft" | "env_changed";
  session_id?: string;
  content?: string;
  error?: string;
  // agent fields
  agent_id?: string;
  slug?: string;
  // tool_start / tool_result fields
  name?: string;
  args?: Record<string, unknown>;
  // usage fields
  input_tokens?: number;
  output_tokens?: number;
  context_pct?: number;
  model?: string;
  provider?: string;
  cost_usd?: number | null;
  // prompt fields
  prompt_id?: string;
  prompt_type?: PromptType;
  question?: string;
  options?: string[];
  multi_select?: boolean;
  // pause fields: the tool-round limit that was reached
  rounds?: number;
  // sop_draft fields
  sop_id?: number;
  title?: string;
  proposed_content?: string;
  original_content?: string;
  // env_changed fields
  env_key?: string;
  env_name?: string;
};

export interface SOP {
  id: string;
  title: string;
  description: string;
  tags: string[];
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
  steps?: SOPStep[];
}

export interface SOPStep {
  id: string;
  sop_id: string;
  step_number: number;
  action: string;
  rationale?: string;
  tool_used?: string;
}

export interface AgentConfig {
  agentUrl: string;
  llmProvider: "ollama" | "copilot";
}

export const DEFAULT_AGENT_URL = "http://127.0.0.1:7337";
