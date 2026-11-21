# Rye

Rye is an evidence-driven production support AI agent and workspace for investigating incidents, querying infrastructure, building runbooks, and collaborating with specialized custom agents.

## Features

- **Custom Agents**: Create specialist agents with custom Markdown instructions, profile images or gradients, default models, pre-loaded tool groups, and pinned SOP/Skill/Knowledge references. Each agent has a dedicated 1:1 chat and can be `@` mentioned inline in any generic chat (with hover contact cards, optional decision-model auto-routing, and configurable agent-to-agent chattiness).
- **Two-Tier Memory & Hybrid RAG**:
  - **Facts & Glossary**: Compact, always-in-prompt table for ground-truth facts, acronyms, and custom domain terms.
  - **Knowledge Base (RAG)**: Markdown notes chunked and indexed with hybrid **SQLite FTS5 + vector embeddings** (Ollama or GitHub Copilot, combined via Reciprocal Rank Fusion). Both users and agents (`save_knowledge_tool`) can save durable system knowledge.
- **SOPs & Skills**: Author, import, and refine runbooks and reusable skills manually or with the built-in AI Editor.
- **Infrastructure & Code Connectors**: Built-in tools for AWS (CloudWatch, ECS, EC2, RDS, ALB, S3), MySQL, Jira, Git/Bitbucket, local code search (`ripgrep`), custom tools, and MCP servers with per-environment switching.
- **Web UI & CLI**: Local React web app with usage analytics, stored result tables, downloadable artifacts, and a companion CLI.

---

## Prerequisites

- **[Bun](https://bun.sh/)** (`1.3+`)
- **Optional — [Ollama](https://ollama.com/)**: For local chat models, local embeddings (`nomic-embed-text`), or local decision models (`clef-flash`).
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

- **GitHub Copilot** (or both Copilot + Ollama):
  ```toml
  llm_provider = ["github", "ollama"]

  [copilot]
  # Uses your local Copilot auth or RYE_COPILOT_API_KEY
  model = "" # leave blank to auto-select the newest Sonnet
  ```

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
| `~/.local/share/rye/sops.db` | Runbooks (SOPs) with semantic embeddings |
| `~/.local/share/rye/skills/` | Rye-owned editable Skills (`SKILL.md`) |
| `~/.local/share/rye/chats.json` | Persisted chat history & dedicated agent chats |
| `~/.local/share/rye/model-settings.json` | UI overrides for model tiers, task routing, and decision model |

### Environment Variables

Any config setting can be overridden via environment variables (priority: shell env > `.env` > `config.toml` > defaults). Common overrides:

- `RYE_HOST`, `RYE_PORT` — Server bind host/port (default `127.0.0.1:7337`)
- `RYE_CONFIG_DIR`, `RYE_DATA_DIR` — Override config and data directories
- `RYE_LLM_PROVIDER` — Provider(s), e.g. `ollama` or `github,ollama`
- `RYE_OLLAMA_BASE_URL`, `RYE_OLLAMA_MODEL`, `RYE_OLLAMA_EMBEDDING_MODEL`
- `RYE_COPILOT_API_KEY`, `RYE_COPILOT_MODEL`
- `RYE_DECISION_PROVIDER`, `RYE_DECISION_MODEL`

See [`config.example.toml`](./config.example.toml) for the full reference of connectors (`[aws]`, `[mysql]`, `[jira]`, `[git]`, `[code_search]`, `[environments.*]`, and MCP).

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
