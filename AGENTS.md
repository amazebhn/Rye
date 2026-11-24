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
- **SQL databases (`db/connections.ts`, `db/drivers.ts`, `tools/sql.ts`)**:
  - Connections are named and per environment: `[databases.<name>]` (type `mysql` or `postgres`), changed or added to by `[environments.<env>.databases.<name>]` (`mergeDatabases`). The old `[mysql]` section is the connection named `mysql`. `listConnections` resolves them (URL, `password_env`, per-engine defaults) and sets misconfigured ones aside with a reason.
  - Three engine-neutral tools (`sql_query_tool`, `sql_schema_tool`, `sql_list_databases_tool`, group `sql`) take a `connection` name. The old `mysql_*` tool names and the old `mysql` group id are still answered (`LEGACY_MYSQL_TOOLS`, `GROUP_ALIASES`) because saved SOPs, skills and agents name them; don't offer them to the model again.
  - To add an engine: a `SqlDriver` in `db/drivers.ts`, its name in `DATABASE_TYPES`, and a read-only rule in `readOnlyViolation`. Postgres uses Bun's built-in client and runs every query in a server-enforced read-only transaction with a statement timeout; MySQL (mysql2) relies on the statement check and `KILL QUERY`.
  - The agent is told connection names, engines, default databases and descriptions (in the environment block of the system prompt), never hosts or credentials. Tests swap the driver (`DriverLookup`); never connect to a real database from tests.
- **Vector index (`embeddings/vector-index.ts`)**: the one place vectors are compared. `VectorIndex` packs normalised vectors at one byte per dimension into a single array and scans it in a tight loop; `standsOut` judges a similarity against the query's background level, since raw cosine values mean different things per model. `KnowledgeStore` and `ChatStore` each build theirs lazily and drop it whenever their rows change. Don't add per-row cosine loops elsewhere.
- **Embeddings & Hybrid RAG (`embeddings/index.ts`, `knowledge/store.ts`)**:
  - `embedBatch` / `embedText` tries Ollama first (`/api/embed` with `/api/embeddings` fallback), then GitHub Copilot `/embeddings` if configured, and returns `null` cleanly if unavailable.
  - `KnowledgeStore` (`knowledge.db`) chunks Markdown by heading and combines SQLite `FTS5` BM25 with float32 cosine similarity using Reciprocal Rank Fusion (RRF), degrading cleanly to keyword-only FTS5 when offline.
- **Reranking (`embeddings/rerank.ts`)**: optional, chosen by `rerank.provider` (`[rerank]` in config, or Settings → Search): `decision` asks the decision model one yes/no question per note in a single request; `ollama` asks a chat model per note and scores the probability of "yes" on its first token (`logprobs`; Qwen3-Reranker builds get their own raw prompt); `server` posts to a `/v1/rerank` server. Ollama has no rerank endpoint and reports only the 20 likeliest tokens, so zerank (scored by one token's raw logit) and cross-encoders (bge-reranker) only work through `server` (`ollamaRerankProblem` says so in the UI). `KnowledgeStore.search` reorders a pool of `RERANK_POOL` candidates by it; `searchForContext` attaches only notes scoring `RELEVANT_SCORE` or more, in place of the similarity gate. Any failure or timeout returns `null` and search carries on unranked. Tests pass their own `rerank` function to `KnowledgeStore`; only the real knowledge base asks Ollama by default.
- **Changing the embedding model (`embeddings/models.ts`, Settings → Search)**: `PUT /models/settings {embedding_model}` first asks Ollama to embed one word with the model (`probeEmbeddingModel`; a model that can't load is refused, not saved), then reindexes in the background (`startReindex`, progress in `retrieval.embedding.reindex`). Vectors are only ever compared with a query embedded by the same model (`vectorIndex(dimensions, model)`). **The previous model's vectors are kept, one previous model at a time**: knowledge chunks in `knowledge_embedding_backup` keyed by model + hash of the embedded text (so `indexDoc` reuses any vector whose text and model are unchanged and restores from the backup instead of embedding), chat messages in `message_vectors_prev` (`ChatStore.useEmbeddingModel` swaps the two tables). Models that want an instruction before a query get it from `queryPrefix` (queries only, never documents), so embed queries with `embedQuery`/`embedQueryLocal`, not `embedText`.
- **Memory (`memory/store.ts`)**:
  - Entries are shown newest first up to `context.memory_budget_tokens`; the rest are listed by key only.
  - `memory.db` holds always-in-prompt entries (`kind: "fact" | "acronym" | "term"`, optional `agent_id`). Acronyms and terms render as a dedicated **Glossary & Acronyms** table in the prompt; facts render grouped by category.
- **Chat history (`chat/store.ts`)**:
  - `chats.db` (SQLite): one row per chat and one per message, so a save writes only the messages whose hash changed; message text is indexed with FTS5. **No chat is ever dropped for age** (there used to be a 50-chat cap, in the store and in the web app). Only `remove` deletes; `upsertMany` leaves chats it wasn't given alone.
  - The web app deletes on the server any chat missing from its in-memory list (`App.tsx` sync effect), so never filter or trim that list.
  - **Lazy loading.** The web app lists chats with `GET /chat/history?summary=1` (no messages) and fetches one chat's messages with `GET /chat/history/:id` when it is opened. A chat whose messages aren't loaded is `partial` (`utils/types.ts`). Three rules keep that from erasing history, and each has its own guard: a partial chat is saved without a `messages` key (`chatSaveBody`; the server's `upsert` then keeps its stored messages), it can't be sent into (`sendMessage`), and a run's messages are never written over it (`upsertChat`). A chat changed by another tab becomes partial again and is re-fetched if it is on screen.
  - `migrateLegacyChats` imports the old `chats.json` when the store opens: read-only on the file (it stays as a backup), one transaction, verified before commit, merge-only, remembered by file size + mtime. Don't weaken any of those.
  - `bun --watch` reloads the server on save, so a change to this store runs against the developer's real data directory immediately. Keep schema changes additive.
- **Message embeddings (`chat/store.ts`)**: `message_vectors` holds one vector per message (derived data, safe to delete). They are filled in the background a few seconds after saving goes quiet, **with the local model only** (`embedBatchLocal`; chat history is never sent to a hosted embedder), dropped by trigger when a message's text changes, and replaced wholesale when the embedding model changes. Tests must pass their own embedders as the third `ChatStore` argument; nothing but the real data directory's store embeds by default.
- **Conversation search (`chat/search.ts`, `tools/chats.ts`)**:
  - `ChatStore.search` is async and merges two searches: by words (below), then by meaning (messages whose vector stands out for the query; thresholds `RELATED_*` were tuned on `nomic-embed-text`). Chats containing the words always come first; chats found by meaning alone follow with `related: true`.
  - A chat needs most of the query's terms, not all (`requiredTerms`), with at least one non-filler term among those it has; what it lacks is returned in `missing`. Final order is: every term, then found by meaning, then partial. Messages under 30 characters are never offered as "related" (off-topic queries land closest to them).
  - Word search is fuzzy in two ways. Word forms: the FTS index stores word roots (`tokenize='porter unicode61'`) and `searchChats` compares a light `stem()`, so "lagging" and "lag" find each other. Typos: when a term matches nothing, `corrections()` looks in the `words` vocabulary for spellings within `typoBudget` edits and searches for those; a match reports the text it actually hit in `matched` so the UI can highlight it. Quoted phrases stay exact.
  - `rebuildSearchIndex` recreates the text index and vocabulary from the stored messages (read-only on chats and messages, one transaction). It runs when `meta.search_index` differs from `SEARCH_INDEX_VERSION`; bump that constant to change how text is indexed.
  - `ChatStore.search` uses the FTS index (word-start matching, with a `LIKE` scan only when a term matches nothing) to find chats containing every term, then `searchChats` ranks and excerpts the newest 300 of them (case-insensitive substring; quoted phrases stay whole). `GET /chat/search?q=` serves the search dialog; `search_chats_tool` and `read_chat_tool` (tool group `chats`, loaded when the user refers to an earlier conversation) serve the agent.
- **Custom Agents & Routing (`agents/store.ts`, `agents/router.ts`, `agents/settings.ts`)**:
  - `agents.db` stores custom agents (`id`, unique `slug`, `name`, `description`, `instructions`, `avatar`, `model`, `env`, `tool_groups`).
  - Profile images up to 400 KB are embedded in `avatar.value` as a data URI; larger ones (up to 8 MB) are uploaded with `POST /agents/avatars`, stored under `agent-avatars/` in the data dir, and referenced by URL (`agents/avatars.ts`).
  - Dedicated agent chats set `agentId` on `ChatHistoryRecord` (`chats.db`).
  - In generic chats, explicit `@slug` mentions route that turn directly; optional decision-model auto-routing (`autoRoute`) and agent-to-agent follow-up hops (`allowAgentReplies` + `chattiness`) are stored in `agent-settings.json` and stream follow-up replies via `agent_turn_start` SSE events.

### Persistent Data Locations

- Config: `~/.config/rye/config.toml` (override with `RYE_CONFIG_DIR`) + `.env`
- Runtime data (`~/.local/share/rye/`, override with `RYE_DATA_DIR`):
  - `chats.db` (plus `chats.json` from before the move to SQLite, kept as a backup), `chat-folders.json`
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
- **Settings (`components/settings/SettingsPanel.tsx`)**:
  - Pages: General (appearance, chat folders), Models (tiers, task routing, decision model), Search (`RetrievalSection`: embedding model with reindex/backup, reranker), Agents (routing between agents), Skills (`SkillPanel` with `embedded`; there is no Skills item in the app sidebar), MCP servers, and an Integrations placeholder.
  - Layout: a side list of pages (`PAGES`: General, Models, Agents, Skills, MCP servers, Integrations) and the chosen page beside it. Each long thing gets its own page; don't stack them on one. Pages must not move the layout when switched: `.settings-page` reserves its scrollbar (`scrollbar-gutter: stable`), and a page that loads data shows its first section heading from the start, not a bare "Loading…" line. To add a page: an entry in `PAGES` and a branch in `SettingsPage`. `App.tsx` holds the open page (`settingsTab`): `setSettingsTab("skills" | "mcp" | …)` then `setActivePanel("settings")` to send the user to one.
  - MCP servers are managed from their page (`McpServersSection`): add, edit, on/off, remove, with a server's tools shown when expanded. Backend: `GET/POST /mcp/servers`, `PUT/PATCH/DELETE /mcp/servers/:name` (all reconnect via `reloadMcp`), backed by `listMcpServerEntries`, `writeMcpServer`, `setMcpServerDisabled`, `removeMcpServer` in `mcp/config.ts`. The write routes accept only JSON bodies from a local origin (`refuseForeignMcpWrite`), because an MCP definition decides what commands run on this machine; keep that check on any route that changes it.
- **Search dialog (`components/shell/ChatSearch.tsx`, `searchSections.tsx`)**:
  - Cmd/Ctrl+K searches several kinds of thing; each kind is a `useXxxSection` hook in `searchSections.tsx` returning a `SearchSection` (label, `options` that open themselves, `render`). To add a kind, write its hook and add it to the `sections` array in `ChatSearch.tsx`; keyboard navigation, empty state and footer follow from that. Chats come from `GET /chat/search`; agents are matched in the browser.
- **Reply rendering (`components/chat/CodeBlock.tsx`, `ChartBlock.tsx`, `utils/chartSpec.ts`)**:
  - Fenced code blocks in replies go through `CodeBlock` (language label + copy). A block with the language `chart` holds one JSON spec and is drawn by `ChartBlock` with Recharts; the format is described to the model in `BASE_SYSTEM_PROMPT`, so change both together.
  - A block with the language `mermaid` is drawn by `DiagramBlock`; Mermaid is loaded on first use (dynamic import) and runs with `securityLevel: "strict"` because the source comes from a model.
  - Tools the Claude harness runs itself (WebSearch, WebFetch) reach the UI as ordinary `tool_start`/`tool_result` events: the adapter puts `HarnessToolEvent`s on the pi stream and `agent/loop.ts` forwards them.
  - `ResultDataGrid` is the one table viewer: stored results, reply tables opened full screen, and its **Chart** panel (`results/ResultChart.tsx`) all go through it. Markdown document previews render the same `CodeBlock`, so charts work in `md` artifacts too.
  - Chart series colors are the `--chart-1`…`--chart-8` tokens, used in fixed order. They were validated as a set for colorblind separation; don't add a ninth or reorder them.
- **Dictation (`utils/useDictation.ts`, backend `speech/`)**: the composer's mic button captures raw microphone samples (`utils/audioCapture.ts`, encoded as 16 kHz WAV rather than `MediaRecorder` output so any prefix is a valid file), shows a live waveform (`DictationWave`), and posts the audio to `POST /speech/transcribe`, every 1.5 s while recording for live words and once more on stop, which runs a local command (`speech.stt_command`, or an auto-detected `mlx_whisper`). When `GET /speech/` reports no transcriber, it falls back to the browser's own speech recognition, and the button is hidden if that is missing too. Inject `command`/`run` into `speechRoutes` in tests; never run a real transcriber from tests.
- **Long chats (`components/chat/MessageList.tsx`)**: only a window of messages is drawn (`WINDOW_MESSAGES`): the latest when a chat opens, growing upward as the reader nears the top with the scroll position held. A jump to an old message draws a window around it (`to` is then a message index instead of `null`), which grows downward and is left via "Jump to latest" or by sending. The view must never pin to the bottom while `to` is set, since that bottom isn't the end of the chat.
- **Chat search (`components/shell/ChatSearch.tsx`)**: a dialog mounted in `App.tsx` (the search icon in the sidebar's Chats header, or Cmd/Ctrl+K; arrow keys and Enter to pick) lists recent chats, then matching chats with message excerpts as you type; choosing an excerpt opens the chat and `MessageList` scrolls to that message via its `focusMessage` prop (rows carry `data-message-start`/`data-message-end`).
- **Cross-Tab Sync (`utils/sync.ts`)**:
  - `publishApiMutations()` intercepts non-GET fetches and broadcasts topic updates over `BroadcastChannel`. Register new API prefixes in `MUTATION_TOPICS` so open tabs stay in sync automatically.
- **Styling (`styles/`)**:
  - Prefer existing CSS variables (`--main-bg`, `--main-surface`, `--main-border`, `--main-fg`, `--main-fg-muted`, `--main-fg-faint`, `--main-accent`, `--radius-*`) and shared classes in `styles/authoring.css` and `styles/chat.css`.
- **Theming (`styles/tokens.css`, `utils/theme.ts`)**:
  - Every colour token is defined twice in `styles/tokens.css`: light on `:root`, dark on `:root[data-theme="dark"]`. `--color-*` is the sidebar family, `--main-*` the content area; shadows (`--shadow-*`), the modal backdrop (`--scrim`) and text on a solid danger fill (`--color-on-danger`) are tokens too.
  - Colours come from tokens: no hex/rgb values, `white`/`black`, or inline `style` colours in components. If a value is a new role, add a token with both a light and a dark value; for a one-off, put a `:root[data-theme="dark"]` override next to the rule. Dark text tiers are held to 4.5:1 (fg, muted) and 3:1 (faint, dim) against every surface they sit on, so check a new pair before adding it.
  - The preference (`system` / `light` / `dark`) is stored in `localStorage["rye-theme"]`. An inline script in `index.html` resolves it and sets `data-theme` on `<html>` before first paint; `initTheme()` (called in `main.tsx`) keeps it current when the OS setting or another tab changes it. The default when nothing is stored is the `data-theme-default` attribute on `<html>` in `index.html`.
  - **Accent colour.** The accent tokens (`--main-accent`, `--main-accent-alt`, `--color-accent`; focus rings and tints are mixed from them) point at a preset: `--accent-<name>` / `--accent-<name>-alt`, each with a light and a dark value in `tokens.css`. `data-accent` on `<html>` picks the preset (no attribute is blue, the default), stored in `localStorage["rye-accent"]` and set by the same inline script and by `utils/theme.ts` (`ACCENTS`, `useAccent`). To add one: the two tokens in both palettes, a `:root[data-accent="…"]` rule, a swatch rule in `settings.css`, an entry in `ACCENTS`, and the name in the inline script's list. Dark values must reach 4.5:1 on every surface and light ones must not be fainter than blue. Nothing puts text on a solid accent fill; add an on-accent token before doing so. Chart and status colours do not follow the accent.
  - `components/settings/ThemeSetting.tsx` is the control (theme and accent). Anything that bakes colours in at draw time instead of reading CSS variables (Mermaid in `DiagramBlock`) must take `useResolvedTheme()` and redraw when it changes.

## Testing Guidelines

- Backend tests live in `packages/agent-core/tests/*.test.ts` and use `bun:test` with temporary directories (`mkdtempSync`) — never write to the user's real `~/.local/share/rye` during tests.
- Inject mock embedders / `decideFn` into `KnowledgeStore` and `router.ts` tests so tests run fast and deterministically offline.
- Always run `bun run --cwd apps/web typecheck`, `bun run --cwd packages/agent-core build`, and relevant `bun test` files after changes.

