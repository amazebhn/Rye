# Rye — Production Support AI Agent

# ── Setup ──────────────────────────────────────────────────────────────────────

# Install all dependencies (Bun)
install:
    bun install

# ── Development ────────────────────────────────────────────────────────────────

# Start the agent backend (Bun / Hono)
dev-agent:
    bun run --cwd packages/agent-core dev

# Start the CLI in watch mode
dev-cli:
    bun run --cwd apps/cli dev

# Start the web UI in dev mode
dev-web:
    bun run --cwd apps/web dev

# Start everything (agent + CLI)
dev:
    just dev-agent & just dev-cli

# ── Build ──────────────────────────────────────────────────────────────────────

# Build all TypeScript packages
build:
    bun run build

# Build CLI binary
build-cli:
    bun run --cwd apps/cli build

# ── Agent ──────────────────────────────────────────────────────────────────────

# Run agent server (production)
agent:
    bun run --cwd packages/agent-core src/server.ts

# ── Quality ────────────────────────────────────────────────────────────────────

# Run all linters
lint:
    bun run lint

# Format all code
fmt:
    bun run --cwd apps/cli prettier --write src/

# Type check
typecheck:
    bun run typecheck

# Run all tests
test:
    bun test

# ── Utilities ──────────────────────────────────────────────────────────────────

# Clean build artifacts
clean:
    bun run clean

# Show all available commands
help:
    just --list
