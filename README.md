# Rye

Rye is an evidence-driven production support AI agent and workspace for investigating incidents, querying infrastructure, building runbooks, and collaborating with specialized custom agents.

## Features

- **Custom Agents**: Create specialist agents with custom Markdown instructions, profile images or gradients, default models, pre-loaded tool groups, and pinned SOP/Skill/Knowledge references. Each agent has a dedicated 1:1 chat and can be `@` mentioned inline in any generic chat (with hover contact cards, optional decision-model auto-routing, and configurable agent-to-agent chattiness).
- **Two-Tier Memory & Hybrid RAG**:
  - **Facts & Glossary**: Compact, always-in-prompt table for ground-truth facts, acronyms, and custom domain terms.
  - **Knowledge Base (RAG)**: Markdown notes chunked and indexed with hybrid **SQLite FTS5 + vector embeddings** (Ollama or GitHub Copilot, combined via Reciprocal Rank Fusion), with an optional **reranker** that re-reads the candidates against the question. Both users and agents (`save_knowledge_tool`) can save durable system knowledge. Notes that clearly match a message are attached to it automatically, once per conversation; the agent searches for anything else itself. Choose the embedding model and reranker in **Settings → Search**; tune with the `[context]` section of `config.toml`.
- **Attachments & references**: The **+** button in the chat box attaches images, PDFs and text files (also by paste or drag-and-drop), or points a message at a specific **SOP** to follow or **tool** to use. Images go to models that can see; a local vision model describes them for later turns and for chat search; PDFs are read as text.
- **SOPs & Skills**: Author, import, and refine runbooks and reusable skills manually or with the built-in AI Editor.
- **Infrastructure & Code Connectors**: Built-in tools for AWS (CloudWatch, ECS, EC2, RDS, ALB, S3), SQL databases (any number of MySQL and PostgreSQL connections per environment, read-only), Jira, Git/Bitbucket, local code search (`ripgrep`), custom tools, and MCP servers with per-environment switching. **Settings → Tools** lists every tool with its full description and shows, for the environment you pick, which ones can work there and why (e.g. which database connections that environment has).
- **Web UI & CLI**: Local React web app (laid out for phones too) with usage analytics and model pricing (Settings → Usage), stored result tables, downloadable artifacts, and a companion CLI. Every page has its own address to bookmark or share, e.g. `/settings/tools`, `/settings/tools/sql_query_tool`, `/sops/12`, `/c/<chat id>`.

---

## Prerequisites

- **[Bun](https://bun.sh/)** (`1.3+`)
- **Optional — [Ollama](https://ollama.com/)**: For local chat models, local embeddings (`nomic-embed-text`), local decision models (`clef-flash`), and a local vision model to describe attached images (any model Ollama lists with the `vision` capability).
- **Optional — [Poppler](https://poppler.freedesktop.org/)** (`brew install poppler`): `pdftotext` reads the text of attached PDFs.
- **Optional — [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)**: Recommended for fast local code search.

---

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Configure Rye

Copy the example configuration file to `~/.config/rye/config.toml`:

```bash
mkdir -p ~/.config/rye
cp config.example.toml ~/.config/rye/config.toml
```

Edit `~/.config/rye/config.toml` to configure your LLM provider and connectors. You can also place secrets in a `.env` file in the repository root or `~/.config/rye/.env` and reference them as `${VAR_NAME}` in `config.toml`.

#### LLM Provider Options

- **Ollama (local default)**:
  ```toml
  llm_provider = "ollama"

  [ollama]
  base_url = "http://localhost:11434"
  model = "llama3.1"
  embedding_model = "nomic-embed-text"
  ```
  Pull the chat and embedding models:
  ```bash
  ollama pull llama3.1
  ollama pull nomic-embed-text
  ```

  **Embedding model.** Any Ollama model with the `embedding` capability can be chosen in **Settings → Search**. Rye checks that Ollama can actually load it before switching, re-embeds the knowledge base, SOPs and chat messages in the background, and keeps the previous model's vectors so switching back is instant. Instruction-style embedders (F2LLM, Qwen3-Embedding) get their query prefix automatically. Some community GGUF builds use an architecture Ollama can't load; Rye shows Ollama's error and stays on the current model.

  **Reranker** (`[rerank]`, or Settings → Search):
  - `decision` — the decision model (e.g. `clef-flash`) judges every candidate in one request. Fast; the recommended choice if you run one.
  - `ollama` — a chat model in Ollama (e.g. `llama3.2`) answers yes/no per note; Qwen3-Reranker builds get their own prompt.
  - `server` — any `/v1/rerank` server, e.g. `llama-server --rerank -m zerank-2.gguf`. This is how **zerank** and cross-encoders such as **bge-reranker** run: Ollama has no rerank endpoint and can't score them.

- **GitHub Copilot** (or both Copilot + Ollama):
  ```toml
  llm_provider = ["github", "ollama"]

  [copilot]
  # Uses your local Copilot auth or RYE_COPILOT_API_KEY
  model = "" # leave blank to auto-select the newest Sonnet
  ```

- **Claude (via the Claude Agent SDK)**:
  ```toml
  harness = "claude"   # takes precedence over llm_provider for Claude models

  [claude]
  model = "sonnet"     # Claude Code alias or full model id
  ```
  Uses Claude Code's sign-in on this machine (run `claude` and `/login` once) or `ANTHROPIC_API_KEY`. Claude models and blank model tiers run through the Agent SDK; other models and embeddings still use `llm_provider`. Claude can also search and fetch the web with Claude Code's built-in tools (`[claude] web_tools`, on by default).

- **Decision Model (optional, for fast tool-group selection, auto-routing, and agent-to-agent replies)**:
  Configure `[decision]` in `config.toml` or directly from the **Settings** tab in the web app (`ollama`, `clef`, or `chat`).

### 3. Start the dev servers

```bash
bun run dev
```

This runs Turborepo across the monorepo:
- **Web UI**: `http://localhost:8080`
- **Agent server**: `http://127.0.0.1:7337`

### 4. Verify health

```bash
curl http://127.0.0.1:7337/health
```

---

## Configuration & Storage

| Path | Purpose |
|---|---|
| `~/.config/rye/config.toml` | Main configuration (override directory with `RYE_CONFIG_DIR`) |
| `~/.local/share/rye/` | Local data directory (override with `RYE_DATA_DIR`) |
| `~/.local/share/rye/memory.db` | Facts & Glossary (always injected into prompts) |
| `~/.local/share/rye/knowledge.db` | Hybrid RAG Knowledge Base (chunks, FTS5 index, embeddings) |
| `~/.local/share/rye/agents.db` | Custom agent definitions |
| `~/.local/share/rye/agent-settings.json` | Auto-routing & agent-to-agent chattiness settings |
| `~/.local/share/rye/user-profile.json` | Your name (Settings → General), used in the greeting and the system prompt |
| `~/.local/share/rye/sops.db` | Runbooks (SOPs) with semantic embeddings |
| `~/.local/share/rye/skills/` | Rye-owned editable Skills (`SKILL.md`) |
| `~/.local/share/rye/chats.db` | Chat history & dedicated agent chats (searchable; nothing is dropped for age) |
| `~/.local/share/rye/chats.json` | Chat history from before the move to SQLite. Imported once on start and left in place as a backup |
| `~/.local/share/rye/model-settings.json` | UI overrides for model tiers, task routing, decision model, embedding model and reranker |
| `~/.local/share/rye/attachments/` | Files attached to messages, with `attachments.db` (PDF text, image descriptions). Unused uploads are removed after a day |

### Environment Variables

Any config setting can be overridden via environment variables (priority: shell env > `.env` > `config.toml` > defaults). Common overrides:

- `RYE_HOST`, `RYE_PORT` — Server bind host/port (default `127.0.0.1:7337`)
- `RYE_CONFIG_DIR`, `RYE_DATA_DIR` — Override config and data directories
- `RYE_LLM_PROVIDER` — Provider(s), e.g. `ollama` or `github,ollama`
- `RYE_HARNESS`, `RYE_CLAUDE_MODEL` — Harness (`pi` or `claude`) and its Claude model
- `RYE_OLLAMA_BASE_URL`, `RYE_OLLAMA_MODEL`, `RYE_OLLAMA_EMBEDDING_MODEL`
- `RYE_COPILOT_API_KEY`, `RYE_COPILOT_MODEL`
- `RYE_DECISION_PROVIDER`, `RYE_DECISION_MODEL`
- `RYE_RERANK_PROVIDER`, `RYE_RERANK_MODEL`, `RYE_RERANK_URL` — Reranker (`off`, `decision`, `ollama`, `server`)
- `RYE_VISION_MODEL` — Ollama model that describes attached images (blank: auto, `off`: none)

See [`config.example.toml`](./config.example.toml) for the full reference of connectors (`[aws]`, `[databases.*]`, `[mysql]`, `[jira]`, `[git]`, `[code_search]`, `[environments.*]`, and MCP).

---

## Fonts

Font binaries are not distributed in this repository:

- **UI**: `Allo` is installed via the `allo-font` npm dependency, with `Inter` and `Lato` loaded from Google Fonts (falling back to system sans-serif offline).
- **Chat Markdown & code**: `Ledger`, `Instrument Serif`, and `Fira Code` load from Google Fonts in [`apps/web/index.html`](./apps/web/index.html) (falling back cleanly to system serif / `Menlo` / `monospace` when offline).
- **Optional self-hosted / offline fonts**: `apps/web/assets/fonts/` is gitignored — if you prefer fully offline or custom local fonts, drop font files there or install them on your OS.

---

## Development Scripts

```bash
bun run dev                                      # Run all apps in watch mode
bun run build                                    # Build all packages and apps
bun run --cwd apps/web typecheck                 # Typecheck web UI
bun run --cwd packages/agent-core build          # Build backend bundle
bun test packages/agent-core/tests               # Run backend unit tests
bun run clean                                    # Clean build outputs
```

For architecture notes, conventions, and contributor guidelines, see [`AGENTS.md`](./AGENTS.md).
