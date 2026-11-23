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
  - Runs `knowledgeStore.searchForContext` and tool-group selection in parallel before building the prompt.
  - **Keep the system prompt stable between turns** so providers can reuse their cached prompt prefix and the Claude harness keeps its session. It may only change when the user changes something (environment, a saved memory, a new SOP). Anything that differs per turn (the time, knowledge notes found for this message, one-off results) goes in the `<rye_context>` block attached to the user message (`agent/turn-context.ts`), which is kept in history; use `stripTurnContext` wherever the user's typed text is needed.
  - Knowledge notes are attached only when they clearly match (`searchForContext`: standing out from the knowledge base's background similarity, or sharing enough keywords) and at most once per conversation. SOPs are not searched per turn; the prompt lists the full SOP index instead.
  - Supports custom `AgentDefinition` personas: injects agent instructions, pre-loads configured `tool_groups`, scopes `MemoryStore` + `KnowledgeStore`, and resolves inline `[[sop:id|title]]`, `[[skill:name]]`, and `[[knowledge:id|title]]` references pinned in agent instructions.
- **Harness (`harness/claude-sdk.ts`, `llm-provider.ts`)**:
  - The `harness` setting (`"pi"` default, `"claude"`) picks what runs the model and takes precedence over `llm_provider` for the models it serves: with `harness = "claude"`, Claude model ids and blank model tiers run through the Claude Agent SDK.
  - The Claude harness is a pi-ai `ProviderStreams` implementation, so `agent/loop.ts` is unchanged: Rye's tools are bridged to the SDK as an in-process MCP server, and a live SDK session is continued by the last assistant message's `responseId`. Add future harnesses (e.g. opencode, hermes) the same way: a value in `HARNESSES`, a `ProviderStreams` module under `harness/`, and a provider registered in `llm-provider.ts`.
  - Inject a fake `query` into `claudeAgentSdkApi` in tests; never start Claude Code from tests.
- **Tool Registration (`tools/index.ts`, `tools/groups.ts`)**:
  - Every new tool must be added to `TOOLS` + `executeTool` in `tools/index.ts` and assigned to a group in `STATIC_GROUPS` in `tools/groups.ts` (`core` is always loaded; other groups load via keyword/decision selector or `load_tools_tool`).
  - Run `bun test packages/agent-core/tests/tool-groups.test.ts` after adding or moving tools.
- **Embeddings & Hybrid RAG (`embeddings/index.ts`, `knowledge/store.ts`)**:
  - `embedBatch` / `embedText` tries Ollama first (`/api/embed` with `/api/embeddings` fallback), then GitHub Copilot `/embeddings` if configured, and returns `null` cleanly if unavailable.
  - `KnowledgeStore` (`knowledge.db`) chunks Markdown by heading and combines SQLite `FTS5` BM25 with float32 cosine similarity using Reciprocal Rank Fusion (RRF), degrading cleanly to keyword-only FTS5 when offline.
- **Memory (`memory/store.ts`)**:
  - Entries are shown newest first up to `context.memory_budget_tokens`; the rest are listed by key only.
  - `memory.db` holds always-in-prompt entries (`kind: "fact" | "acronym" | "term"`, optional `agent_id`). Acronyms and terms render as a dedicated **Glossary & Acronyms** table in the prompt; facts render grouped by category.
- **Custom Agents & Routing (`agents/store.ts`, `agents/router.ts`, `agents/settings.ts`)**:
  - `agents.db` stores custom agents (`id`, unique `slug`, `name`, `description`, `instructions`, `avatar`, `model`, `env`, `tool_groups`).
  - Profile images up to 400 KB are embedded in `avatar.value` as a data URI; larger ones (up to 8 MB) are uploaded with `POST /agents/avatars`, stored under `agent-avatars/` in the data dir, and referenced by URL (`agents/avatars.ts`).
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
- **Reply rendering (`components/chat/CodeBlock.tsx`, `ChartBlock.tsx`, `utils/chartSpec.ts`)**:
  - Fenced code blocks in replies go through `CodeBlock` (language label + copy). A block with the language `chart` holds one JSON spec and is drawn by `ChartBlock` with Recharts; the format is described to the model in `BASE_SYSTEM_PROMPT`, so change both together.
  - A block with the language `mermaid` is drawn by `DiagramBlock`; Mermaid is loaded on first use (dynamic import) and runs with `securityLevel: "strict"` because the source comes from a model.
  - Tools the Claude harness runs itself (WebSearch, WebFetch) reach the UI as ordinary `tool_start`/`tool_result` events: the adapter puts `HarnessToolEvent`s on the pi stream and `agent/loop.ts` forwards them.
  - `ResultDataGrid` is the one table viewer: stored results, reply tables opened full screen, and its **Chart** panel (`results/ResultChart.tsx`) all go through it. Markdown document previews render the same `CodeBlock`, so charts work in `md` artifacts too.
  - Chart series colors are the `--chart-1`…`--chart-8` tokens, used in fixed order. They were validated as a set for colorblind separation; don't add a ninth or reorder them.
- **Dictation (`utils/useDictation.ts`, backend `speech/`)**: the composer's mic button captures raw microphone samples (`utils/audioCapture.ts`, encoded as 16 kHz WAV rather than `MediaRecorder` output so any prefix is a valid file), shows a live waveform (`DictationWave`), and posts the audio to `POST /speech/transcribe`, every 1.5 s while recording for live words and once more on stop, which runs a local command (`speech.stt_command`, or an auto-detected `mlx_whisper`). When `GET /speech/` reports no transcriber, it falls back to the browser's own speech recognition, and the button is hidden if that is missing too. Inject `command`/`run` into `speechRoutes` in tests; never run a real transcriber from tests.
- **Cross-Tab Sync (`utils/sync.ts`)**:
  - `publishApiMutations()` intercepts non-GET fetches and broadcasts topic updates over `BroadcastChannel`. Register new API prefixes in `MUTATION_TOPICS` so open tabs stay in sync automatically.
- **Styling (`styles/`)**:
  - Prefer existing CSS variables (`--main-bg`, `--main-surface`, `--main-border`, `--main-fg`, `--main-fg-muted`, `--main-fg-faint`, `--main-accent`, `--radius-*`) and shared classes in `styles/authoring.css` and `styles/chat.css`.

## Testing Guidelines

- Backend tests live in `packages/agent-core/tests/*.test.ts` and use `bun:test` with temporary directories (`mkdtempSync`) — never write to the user's real `~/.local/share/rye` during tests.
- Inject mock embedders / `decideFn` into `KnowledgeStore` and `router.ts` tests so tests run fast and deterministically offline.
- Always run `bun run --cwd apps/web typecheck`, `bun run --cwd packages/agent-core build`, and relevant `bun test` files after changes.

