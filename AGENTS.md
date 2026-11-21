# Rye Development Guide

Rye is a Bun + TypeScript monorepo managed with Turborepo.

## Workspace Layout

- `packages/agent-core/` — Backend Hono HTTP/SSE server (port `7337`), `pi-ai` agent loop, tool registry, SQLite/JSON stores, decision model router, MCP client, and embeddings/RAG engine.
- `packages/shared/` — Shared TypeScript types (`SSEEvent`, `PendingPrompt`, `SOP`, etc.) consumed by both `agent-core` and frontend apps.
- `apps/web/` — React 18 + Vite web UI (dev port `8080`, proxies API routes to `127.0.0.1:7337`).
- `apps/cli/` — Terminal CLI (`rye`) communicating with the agent-core server.

## Common Commands

```bash
bun install                                      # Install workspace dependencies
bun run dev                                      # Start agent-core + web + cli watchers via Turbo
bun run build                                    # Build all workspaces
bun run --cwd apps/web typecheck                 # Typecheck the React web app
bun run --cwd packages/agent-core build          # Bundle & verify agent-core
bun test packages/agent-core/tests               # Run agent-core unit tests (bun:test)
```

## Architecture & Conventions

### Backend (`packages/agent-core/src/`)

- **Entry & HTTP routes (`server.ts`)**: Hono app serving SSE streams (`POST /chat/`) and REST endpoints.
  - **Trailing slashes on sub-routers**: Mount sub-routers with a trailing slash (e.g. `app.route("/skill/", ...)`, `app.route("/agents/", ...)`, `app.route("/knowledge/", ...)`) so `r.get("/")` / `r.post("/")` answer at `/foo/` (matching `/sop/` and `/memory/`).
  - **Vite proxy parity**: Whenever you add a new top-level API route prefix in `server.ts`, add it to `server.proxy` in `apps/web/vite.config.ts` and never leave a compiled `apps/web/vite.config.js` beside it (Vite prefers `.js` over `.ts`).
- **Agent Loop (`agent/loop.ts`)**:
  - Runs `sopStore.search`, `knowledgeStore.search`, and tool-group selection in parallel before building the system prompt.
  - Supports custom `AgentDefinition` personas: injects agent instructions, pre-loads configured `tool_groups`, scopes `MemoryStore` + `KnowledgeStore`, and resolves inline `[[sop:id|title]]`, `[[skill:name]]`, and `[[knowledge:id|title]]` references pinned in agent instructions.
- **Tool Registration (`tools/index.ts`, `tools/groups.ts`)**:
  - Every new tool must be added to `TOOLS` + `executeTool` in `tools/index.ts` and assigned to a group in `STATIC_GROUPS` in `tools/groups.ts` (`core` is always loaded; other groups load via keyword/decision selector or `load_tools_tool`).
  - Run `bun test packages/agent-core/tests/tool-groups.test.ts` after adding or moving tools.
- **Embeddings & Hybrid RAG (`embeddings/index.ts`, `knowledge/store.ts`)**:
  - `embedBatch` / `embedText` tries Ollama first (`/api/embed` with `/api/embeddings` fallback), then GitHub Copilot `/embeddings` if configured, and returns `null` cleanly if unavailable.
  - `KnowledgeStore` (`knowledge.db`) chunks Markdown by heading and combines SQLite `FTS5` BM25 with float32 cosine similarity using Reciprocal Rank Fusion (RRF), degrading cleanly to keyword-only FTS5 when offline.
- **Memory (`memory/store.ts`)**:
  - `memory.db` holds always-in-prompt entries (`kind: "fact" | "acronym" | "term"`, optional `agent_id`). Acronyms and terms render as a dedicated **Glossary & Acronyms** table in the prompt; facts render grouped by category.
- **Custom Agents & Routing (`agents/store.ts`, `agents/router.ts`, `agents/settings.ts`)**:
  - `agents.db` stores custom agents (`id`, unique `slug`, `name`, `description`, `instructions`, `avatar`, `model`, `env`, `tool_groups`).
  - Dedicated agent chats set `agentId` on `ChatHistoryRecord` (`chats.json`) and are exempt from the 50-chat unfiled cap.
  - In generic chats, explicit `@slug` mentions route that turn directly; optional decision-model auto-routing (`autoRoute`) and agent-to-agent follow-up hops (`allowAgentReplies` + `chattiness`) are stored in `agent-settings.json` and stream follow-up replies via `agent_turn_start` SSE events.

### Persistent Data Locations

- Config: `~/.config/rye/config.toml` (override with `RYE_CONFIG_DIR`) + `.env`
- Runtime data (`~/.local/share/rye/`, override with `RYE_DATA_DIR`):
  - `chats.json`, `chat-folders.json`
  - `memory.db`, `knowledge.db`, `agents.db`, `sops.db`, `usage.db`
  - `skills/<name>/SKILL.md`
  - `model-settings.json`, `agent-settings.json`, `pricing.json`

### Frontend (`apps/web/src/`)

- **Shared Authoring Components (`components/authoring/`, `components/shared/`)**:
  - Use `CreateResourceModal` + `AiCreateChat` for create/edit modals (shared by SOPs, Skills, and Agents).
  - Use `AiEditorSheet` for slide-over AI Editor panels (shared by SOPs, Skills, and Agents).
  - Use `MarkdownEditor` for Markdown authoring (supports optional `mentions` for `@`/`#` reference tagging).
  - Use `AgentAvatar`, `AgentBanner` (static frame-0 canvas wash for images so GIFs don't animate in banners), `AgentHoverCard`, and `AgentMentionPill` / `AgentMentionText` for consistent agent identity.
- **Inline Mentions (`components/chat/MentionComposer.tsx`)**:
  - Chat input is a `contentEditable` rich mention composer that upgrades `@slug` into atomic inline pills displaying the agent's avatar and name while serializing back to `@slug` text.
- **Cross-Tab Sync (`utils/sync.ts`)**:
  - `publishApiMutations()` intercepts non-GET fetches and broadcasts topic updates over `BroadcastChannel`. Register new API prefixes in `MUTATION_TOPICS` so open tabs stay in sync automatically.
- **Styling (`styles/`)**:
  - Prefer existing CSS variables (`--main-bg`, `--main-surface`, `--main-border`, `--main-fg`, `--main-fg-muted`, `--main-fg-faint`, `--main-accent`, `--radius-*`) and shared classes in `styles/authoring.css` and `styles/chat.css`.

## Testing Guidelines

- Backend tests live in `packages/agent-core/tests/*.test.ts` and use `bun:test` with temporary directories (`mkdtempSync`) — never write to the user's real `~/.local/share/rye` during tests.
- Inject mock embedders / `decideFn` into `KnowledgeStore` and `router.ts` tests so tests run fast and deterministically offline.
- Always run `bun run --cwd apps/web typecheck`, `bun run --cwd packages/agent-core build`, and relevant `bun test` files after changes.

