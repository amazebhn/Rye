import type { PendingPrompt } from "@rye/shared";

export interface StarterPrompt {
  title: string;
  prompt: string;
}

export interface PromptGroup {
  id: "triage" | "logs" | "infra" | "runbooks";
  label: string;
  prompts: StarterPrompt[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface AgentTurn {
  thinking: string;
  toolCalls: ToolCall[];
  summary?: string; // LLM-generated one-line summary of what this iteration did
}

export interface RenderMessage {
  role: "user" | "assistant";
  content: string;
  id?: string; // user turns only; matches the server session's turnId
  toolCalls?: ToolCall[];
  turns?: AgentTurn[];
  paused?: boolean; // waiting at the tool-round limit; cleared once the user replies
  pause?: { rounds: number }; // this reply stopped at the tool-round limit (kept after it is resumed)
  // User turns shown inline in the reply, not as a bubble: answers to permission / ask_user prompts, and Continue.
  kind?: "approval" | "answer" | "continue";
  agentId?: string; // assistant turns answered by a specific custom agent (dedicated chat or @mention)
  meta?: MessageMeta; // assistant turns only
}

// Run details for an assistant turn, shown in the message info card.
export interface MessageMeta {
  startedAt: number;
  firstTokenAt?: number;
  finishedAt?: number;
  model?: string;
  provider?: string;
  env?: string;
  inputTokens?: number;
  outputTokens?: number;
  llmCalls?: number;
  costUsd?: number; // summed price of the model calls that have pricing
  unpricedCalls?: number; // model calls with no pricing entry, so costUsd undercounts
  status?: "done" | "stopped" | "error";
  error?: string; // why the run failed, when status is "error"
}

export interface ArtifactVersion {
  version: number;
  createdAt: number;
  size: number;
}

// A file the agent saved for the user (GET /artifact/:id).
export interface Artifact {
  id: string;
  filename: string;
  title: string;
  format: "md" | "csv" | "txt" | "json" | "docx" | "html";
  createdAt: number;
  updatedAt: number;
  versions: ArtifactVersion[]; // ascending; last is latest
}

export interface ChatRecord {
  id: string;
  title: string;
  sessionId: string;
  messages: RenderMessage[];
  updatedAt: number;
  model?: string;
  pendingPrompt?: PendingPrompt;
  env?: string; // "default" or an environment key
  unread?: boolean; // a run finished while this chat was off screen
  folderId?: string; // server-owned; changed only via /chat/folders/*
  folderSuggestionDismissed?: boolean;
  agentId?: string; // dedicated 1:1 chat for a custom agent
}

export interface AgentAvatar {
  kind: "gradient" | "image";
  value: string;
}

export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  avatar: AgentAvatar;
  model: string | null;
  env: string | null;
  tool_groups: string[];
  skip_base_prompt: boolean;
  chat_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatFolder {
  id: string;
  name: string;
  createdAt: number;
  order?: number;
}
