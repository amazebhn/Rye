/**
 * The code engine registry (docs/design/code-sessions.md §2.3): which `CodeEngine`s exist, whether
 * each can be used here, and what the engine picker shows (`GET /code/engines`).
 *
 * The interface itself is in `code/types.ts`. Engines: `claude` (`engines/claude.ts`) and
 * `acp:copilot` (`engines/copilot.ts` on the generic `engines/acp.ts`); `pi` and more `acp:<cli>`
 * agents later, each registered the same way.
 */

import type { CodeEnginesResponse } from "@rye/shared";
import { getSettings } from "../config.js";
import { claudeCodeEngine } from "./engines/claude.js";
import { copilotCodeEngine } from "./engines/copilot.js";
import type { CodeEngine, CodeEngineAvailability, CodeEngineCapabilities, CodeEngineId } from "./types.js";

/** Names people see for each engine. */
const ENGINE_TITLES: Record<string, string> = {
  claude: "Claude",
  pi: "Rye",
  "acp:copilot": "GitHub Copilot",
  "acp:opencode": "opencode",
  "acp:claude": "Claude (ACP)",
};

/** "Claude", "GitHub Copilot"; an unknown `acp:<cli>` engine is shown by its CLI's name. */
export function engineTitle(id: CodeEngineId): string {
  return ENGINE_TITLES[id] ?? (id.startsWith("acp:") ? id.slice(4) : id);
}

/** One engine with what it can do and whether it can run here. */
export interface EngineListing {
  id: CodeEngineId;
  title: string;
  capabilities: CodeEngineCapabilities;
  availability: CodeEngineAvailability;
  /** Empty when the engine isn't available. */
  models: string[];
}

export class CodeEngineRegistry {
  private readonly engines = new Map<CodeEngineId, CodeEngine>();

  constructor(engines: CodeEngine[] = []) {
    for (const engine of engines) this.register(engine);
  }

  /** Add an engine, replacing one with the same id. */
  register(engine: CodeEngine): void {
    this.engines.set(engine.id, engine);
  }

  get(id: CodeEngineId): CodeEngine | undefined {
    return this.engines.get(id);
  }

  /** The engine, or an error naming the ones that exist. */
  require(id: CodeEngineId): CodeEngine {
    const engine = this.engines.get(id);
    if (!engine) throw new Error(`Unknown code engine "${id}". Known engines: ${this.ids().join(", ") || "none"}.`);
    return engine;
  }

  ids(): CodeEngineId[] {
    return [...this.engines.keys()];
  }

  /** Every engine with its availability, and its models when it is available. Never throws. */
  async list(): Promise<EngineListing[]> {
    return Promise.all(
      [...this.engines.values()].map(async (engine) => {
        const availability = await engine.availability().catch(
          (err): CodeEngineAvailability => ({ available: false, reason: err instanceof Error ? err.message : String(err) }),
        );
        const models = availability.available ? await engine.models().catch(() => [] as string[]) : [];
        return { id: engine.id, title: engineTitle(engine.id), capabilities: engine.capabilities, availability, models };
      }),
    );
  }

  /** `GET /code/engines`. `defaultModels`: the model used when none is picked, per engine (`[code] model`, `claude.model`). */
  async describe(defaultEngine: CodeEngineId, defaultModels: Partial<Record<CodeEngineId, string>> = {}): Promise<CodeEnginesResponse> {
    const listings = await this.list();
    return {
      engines: listings.map((l) => {
        const defaultModel = defaultModels[l.id]?.trim();
        return { ...l, ...(defaultModel ? { defaultModel } : {}) };
      }),
      defaultEngine,
    };
  }
}

let registry: CodeEngineRegistry | null = null;

/** The process's engines: `claude` and `acp:copilot` (the Copilot CLI, whole process in the sandbox). */
export function codeEngines(): CodeEngineRegistry {
  registry ??= new CodeEngineRegistry([claudeCodeEngine(), copilotCodeEngine({ configuredPath: () => getSettings().code.copilot_path })]);
  return registry;
}

/** The registered engine with this id, if any. */
export function getEngine(id: CodeEngineId): CodeEngine | undefined {
  return codeEngines().get(id);
}

/** Every registered engine with its availability and models. */
export function listEngines(): Promise<EngineListing[]> {
  return codeEngines().list();
}
