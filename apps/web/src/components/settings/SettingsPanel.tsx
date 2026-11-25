import React, { useEffect, useRef, useState } from "react";
import { BarChart3, Blocks, Bot, Cpu, Plug, Plus, RotateCcw, ScanSearch, SlidersHorizontal, Wrench, Zap, type LucideIcon } from "lucide-react";
import RetrievalSection from "./RetrievalSection";
import ProviderLogo from "../shared/ProviderLogo";
import { formatModelName, groupModelsByProvider } from "../../utils/modelNames";
import type { ChatFolder, ChatRecord } from "../../utils/types";
import { folderApi, readSuggestFolders, writeSuggestFolders, type CategorizeResponse } from "../shell/useChatFolders";
import { useAgents, type AgentChattiness } from "../../contexts/AgentContext";
import SkillPanel from "../skills/SkillPanel";
import McpServersSection from "./McpServersSection";
import SettingsListHeader, { type SettingsListView } from "./SettingsListHeader";
import ThemeSetting from "./ThemeSetting";
import TableSetting from "./TableSetting";
import NotificationsSetting from "./NotificationsSetting";
import { saveUserName, useUserProfile } from "../../utils/profile";
import type { SettingsPageKey } from "../../utils/routes";
import ToolsSection, { type ToolFocus } from "./ToolsSection";
import SidebarButton from "../shell/SidebarButton";

// Lazy so recharts only loads when the Usage page is opened.
const UsageSection = React.lazy(() => import("./UsageSection"));

type Tier = "low" | "medium" | "high";
type Task = "chat" | "subagent" | "compaction" | "extraction" | "doc_review" | "labels";
type Source = "settings" | "config" | "auto" | "default";
type DecisionProvider = "off" | "ollama" | "clef" | "chat";

interface TierInfo {
  configured: string;
  effective: string;
  source: Source;
}

interface DecisionInfo {
  provider: DecisionProvider;
  model: string;
  effective_model: string;
  source: { provider: Source; model: Source };
  clef_models: string[];
  ollama_models: string[];
  clef_configured: boolean;
  clef_target: "self-hosted" | "cloudflare" | null;
}

interface ModelSettings {
  provider: string;
  available: string[];
  tiers: Record<Tier, TierInfo>;
  tasks: Record<Task, Tier>;
  decision: DecisionInfo;
  settings_file: string;
  config_file: string;
}

const TIERS: { key: Tier; name: string; tagline: string }[] = [
  { key: "low", name: "Low", tagline: "Fast and inexpensive. Best for short, structured work." },
  { key: "medium", name: "Medium", tagline: "Balanced quality and cost. The everyday default." },
  { key: "high", name: "High", tagline: "Most capable. Slower and more expensive." },
];

const TASKS: { key: Task; name: string; description: string }[] = [
  { key: "chat", name: "Chat", description: "Conversations, investigations and reports." },
  { key: "subagent", name: "Subagents", description: "Parallel research agents spawned during an investigation." },
  { key: "compaction", name: "Context compaction", description: "Summarizes long conversations to stay within the context window." },
  { key: "extraction", name: "SOP & Skill capture", description: "Turns a conversation into a saved SOP or Skill, and runs the AI create and edit chats for SOPs, Skills and Agents." },
  { key: "doc_review", name: "Document review", description: "Inline suggested edits while you write a document." },
  { key: "labels", name: "Titles & step labels", description: "Chat titles and one-line summaries of each step." },
];

const MODEL_TIERS_DESC =
  "Choose the model behind each cost tier. Leave a tier on Auto to use the best available model of that class.";

const SOURCE_LABEL: Record<Source, string> = {
  settings: "Set here",
  config: "config.toml",
  auto: "Auto",
  default: "Default",
};

const DECISION_PROVIDERS: { key: DecisionProvider; name: string }[] = [
  { key: "off", name: "Off" },
  { key: "ollama", name: "Ollama decision model (e.g. Clef)" },
  { key: "clef", name: "Clef API (Cloudflare or self-hosted)" },
  { key: "chat", name: "Chat model" },
];

const CLEF_TARGET_LABEL = { cloudflare: "Cloudflare Workers AI", "self-hosted": "self-hosted server" } as const;

async function request(method: "GET" | "PUT" | "DELETE", body?: unknown): Promise<ModelSettings> {
  const res = await fetch("/models/settings", {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as ModelSettings & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** A Settings page; each has its own address (`settingsPath` in utils/routes.ts). */
export type SettingsTab = SettingsPageKey;
type SaveStatus = "idle" | "saving" | "saved";

/**
 * The pages of Settings, in the order listed in its side navigation. Each is a page of its own
 * because several of them (skills, MCP servers) grow long. To add one: an entry here and a branch
 * in `SettingsPage` below (a list or table page wraps itself in `settings-body settings-body--wide`).
 */
const PAGES: { key: SettingsTab; name: string; icon: LucideIcon; soon?: boolean }[] = [
  { key: "general", name: "General", icon: SlidersHorizontal },
  { key: "models", name: "Models", icon: Cpu },
  { key: "search", name: "Search", icon: ScanSearch },
  { key: "agents", name: "Agents", icon: Bot },
  { key: "skills", name: "Skills", icon: Zap },
  { key: "mcp", name: "MCP servers", icon: Plug },
  { key: "tools", name: "Tools", icon: Wrench },
  { key: "usage", name: "Usage", icon: BarChart3 },
  { key: "integrations", name: "Integrations", icon: Blocks, soon: true },
];

interface Props extends FolderProps {
  /** The page on show. The owner holds it so links from elsewhere can land on a page; left out, the panel keeps its own. */
  tab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
  /** Changes when settings were saved somewhere else (another browser tab): Models reloads, other pages keep their state. */
  reloadKey?: number;
  /** On the Tools page, the tool to scroll to and highlight (/settings/tools/<name>). */
  focusTool?: ToolFocus | null;
}

export default function SettingsPanel({ tab: tabProp, onTabChange, reloadKey = 0, focusTool = null, ...folderProps }: Props) {
  const [ownTab, setOwnTab] = useState<SettingsTab>("general");
  const [status, setStatus] = useState<SaveStatus>("idle");
  const requested = tabProp ?? ownTab;
  // A page name remembered from an older build may no longer exist.
  const tab = PAGES.some((p) => p.key === requested) ? requested : "general";
  const navRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  function selectTab(next: SettingsTab) {
    setOwnTab(next);
    onTabChange?.(next);
  }

  // Up/down moves through the pages, as in any vertical list.
  function onNavKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = PAGES.findIndex((p) => p.key === tab);
    const next = PAGES[(index + (event.key === "ArrowDown" ? 1 : -1) + PAGES.length) % PAGES.length].key;
    selectTab(next);
    navRefs.current[next]?.focus();
  }

  return (
    <div className="sop-panel settings-panel">
      <div className="sop-panel-header">
        <SidebarButton />
        <h2 className="sop-panel-title">Settings</h2>
        <div className="sop-panel-toolbar">
          {status !== "idle" && (
            <span className="settings-status" role="status">{status === "saving" ? "Saving…" : "Saved"}</span>
          )}
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections" onKeyDown={onNavKeyDown}>
          {PAGES.map((page) => (
            <button
              key={page.key}
              ref={(el) => { navRefs.current[page.key] = el; }}
              type="button"
              className={`settings-nav-item${tab === page.key ? " active" : ""}`}
              aria-current={tab === page.key ? "page" : undefined}
              onClick={() => selectTab(page.key)}
            >
              <page.icon size={15} aria-hidden="true" />
              <span className="settings-nav-name">{page.name}</span>
              {page.soon && <span className="settings-nav-soon">Soon</span>}
            </button>
          ))}
        </nav>

        <div className="sop-panel-body settings-page" key={tab}>
          <SettingsPage tab={tab} reloadKey={reloadKey} onStatus={setStatus} folderProps={folderProps} focusTool={focusTool} />
        </div>
      </div>
    </div>
  );
}

function SettingsPage({
  tab,
  reloadKey,
  onStatus,
  folderProps,
  focusTool,
}: {
  tab: SettingsTab;
  reloadKey: number;
  onStatus: (status: SaveStatus) => void;
  folderProps: FolderProps;
  focusTool: ToolFocus | null;
}) {
  switch (tab) {
    case "tools":
      return <div className="settings-body settings-body--wide"><ToolsSection focus={focusTool} /></div>;
    case "models":
      return <ModelsPage key={reloadKey} onStatus={onStatus} />;
    case "agents":
      return <div className="settings-body"><AgentsSection /></div>;
    case "skills":
      return <div className="settings-body settings-body--wide"><SkillPanel embedded /></div>;
    case "mcp":
      return <div className="settings-body settings-body--wide"><McpServersSection /></div>;
    case "search":
      return <div className="settings-body"><RetrievalSection /></div>;
    case "usage":
      return (
        <div className="settings-body settings-body--wide">
          <React.Suspense
            fallback={
              <section className="settings-section" aria-labelledby="settings-usage-title">
                <div className="settings-section-head">
                  <h3 className="settings-section-title" id="settings-usage-title">Usage</h3>
                </div>
                <p className="settings-placeholder">Loading usage…</p>
              </section>
            }
          >
            <UsageSection onStatus={onStatus} />
          </React.Suspense>
        </div>
      );
    case "integrations":
      return (
        <div className="settings-body settings-body--wide"><IntegrationsSection /></div>
      );
    default:
      return (
        <div className="settings-body">
          <ProfileSection onStatus={onStatus} />
          <section className="settings-section" aria-labelledby="settings-appearance-title">
            <div className="settings-section-head">
              <h3 className="settings-section-title" id="settings-appearance-title">Appearance</h3>
            </div>
            <ThemeSetting />
            <TableSetting />
          </section>
          <NotificationsSetting />
          <FoldersSection {...folderProps} />
        </div>
      );
  }
}

/**
 * Nothing to manage yet: the same header and toolbar as Skills and MCP servers, switched off, so the
 * three pages read as one family and the controls don't move when switching between them.
 */
function IntegrationsSection() {
  const [view, setView] = useState<SettingsListView>("list");
  return (
    <section className="settings-section" aria-labelledby="settings-integrations-title">
      <SettingsListHeader
        id="settings-integrations-title"
        title="Integrations"
        description="Connections to the apps and services you use, managed in one place."
        query=""
        onQueryChange={() => {}}
        searchPlaceholder="Search integrations…"
        searchLabel="Search integrations"
        view={view}
        onViewChange={setView}
        disabled
        primary={{ label: "Coming soon", icon: Plus, disabled: true, title: "Integrations aren't available yet" }}
      />
      <div className="sop-panel-zero settings-list-zero">
        <Blocks size={32} className="sop-panel-zero-icon" aria-hidden="true" />
        <p>Integrations are on the way.</p>
        <p className="sop-panel-zero-sub">
          You'll connect the apps and services you use here. There's nothing to set up yet; until then, MCP servers
          are the way to give Rye new tools.
        </p>
      </div>
    </section>
  );
}

function ModelsPage({ onStatus }: { onStatus: (status: SaveStatus) => void }) {
  const [data, setData] = useState<ModelSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    request("GET").then(setData).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [status]);

  // The panel header shows the save status; clear it when this tab goes away.
  useEffect(() => { onStatus(status); }, [status, onStatus]);
  useEffect(() => () => onStatus("idle"), [onStatus]);

  async function save(method: "PUT" | "DELETE", body?: unknown) {
    setStatus("saving");
    setError(null);
    try {
      setData(await request(method, body));
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("idle");
    }
  }

  return (
      <>
        {error && <div className="settings-error" role="alert">{error}</div>}

          <div className="settings-body">
            {/* While loading, the first heading is already in its place so the page doesn't jump when the data lands. */}
            {!data && !error && (
              <section className="settings-section" aria-busy="true">
                <div className="settings-section-head">
                  <h3 className="settings-section-title">Model tiers</h3>
                  <p className="settings-section-desc">{MODEL_TIERS_DESC}</p>
                </div>
                <p className="settings-placeholder settings-loading">Loading settings…</p>
              </section>
            )}

            {data && (
            <>
            <section className="settings-section" aria-labelledby="settings-models-title">
              <div className="settings-section-head">
                <h3 className="settings-section-title" id="settings-models-title">Model tiers</h3>
                <p className="settings-section-desc">{MODEL_TIERS_DESC}</p>
              </div>
              <div className="settings-tiers">
                {TIERS.map((tier, index) => {
                  const info = data.tiers[tier.key];
                  const options = info.configured && !data.available.includes(info.configured)
                    ? [info.configured, ...data.available]
                    : data.available;
                  return (
                    <div className="settings-tier" key={tier.key}>
                      <div className="settings-tier-head">
                        <span className="settings-tier-level" aria-hidden="true">
                          {[0, 1, 2].map((i) => <i key={i} className={i <= index ? "is-on" : ""} />)}
                        </span>
                        <span className="settings-tier-name">{tier.name}</span>
                        <span className={`settings-source settings-source--${info.source}`}>{SOURCE_LABEL[info.source]}</span>
                      </div>
                      <p className="settings-tier-tagline">{tier.tagline}</p>
                      <select
                        className="settings-select"
                        value={info.configured}
                        onChange={(e) => void save("PUT", { [tier.key]: e.target.value })}
                        aria-label={`${tier.name} tier model`}
                      >
                        <option value="">{info.configured ? "Auto" : `Auto · ${formatModelName(info.effective)}`}</option>
                        {groupModelsByProvider(options).map((group) => (
                          <optgroup key={group.provider.id} label={group.provider.name}>
                            {group.models.map((m) => <option key={m} value={m}>{formatModelName(m)}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="settings-section" aria-labelledby="settings-tasks-title">
              <div className="settings-section-head">
                <h3 className="settings-section-title" id="settings-tasks-title">Task routing</h3>
                <p className="settings-section-desc">Pick which tier each kind of work uses.</p>
              </div>
              <div className="settings-task-list">
                {TASKS.map((task) => {
                  const tier = data.tasks[task.key];
                  return (
                    <div className="settings-task" key={task.key}>
                      <div className="settings-task-text">
                        <span className="settings-task-name">{task.name}</span>
                        <span className="settings-task-desc">{task.description}</span>
                      </div>
                      <div className="settings-task-control">
                        <div className="sop-diff-tabs" role="radiogroup" aria-label={`${task.name} tier`}>
                          {TIERS.map((t) => (
                            <button
                              key={t.key}
                              type="button"
                              role="radio"
                              aria-checked={tier === t.key}
                              className={`sop-diff-tab${tier === t.key ? " active" : ""}`}
                              onClick={() => tier !== t.key && void save("PUT", { tasks: { [task.key]: t.key } })}
                            >
                              {t.name}
                            </button>
                          ))}
                        </div>
                        <span className="settings-task-model" title={data.tiers[tier].effective}>
                          <ProviderLogo model={data.tiers[tier].effective} size={12} />
                          {formatModelName(data.tiers[tier].effective)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <DecisionSection
              decision={data.decision}
              available={data.available}
              onChange={(patch) => void save("PUT", { decision: patch })}
            />

            <footer className="settings-foot">
              <p>
                Changes save automatically to <code>{data.settings_file}</code> and take precedence over{" "}
                <code>{data.config_file}</code>.
              </p>
              <button type="button" className="settings-reset" onClick={() => void save("DELETE")}>
                <RotateCcw size={13} /> Reset to config.toml
              </button>
            </footer>
            </>
            )}
          </div>
      </>
  );
}

function DecisionSection({
  decision,
  available,
  onChange,
}: {
  decision: DecisionInfo;
  available: string[];
  onChange: (patch: { provider?: DecisionProvider; model?: string | null }) => void;
}) {
  const chatModel = decision.clef_models.includes(decision.model) || decision.ollama_models.includes(decision.model) ? "" : decision.model;
  const chatOptions = chatModel && !available.includes(chatModel) ? [chatModel, ...available] : available;

  return (
    <section className="settings-section" aria-labelledby="settings-decision-title">
      <div className="settings-section-head">
        <h3 className="settings-section-title" id="settings-decision-title">Decision model</h3>
        <p className="settings-section-desc">
          Picks which tool groups each message needs, so fewer tool definitions are sent. Keyword matching always
          applies too, and is used on its own if the decision model fails or is slow.
        </p>
      </div>
      <div className="settings-task-list">
        <div className="settings-task">
          <div className="settings-task-text">
            <span className="settings-task-name">Provider</span>
          </div>
          <div className="settings-decision-control">
            <span className={`settings-source settings-source--${decision.source.provider}`}>
              {SOURCE_LABEL[decision.source.provider]}
            </span>
            <select
              className="settings-select"
              value={decision.provider}
              onChange={(e) => onChange({ provider: e.target.value as DecisionProvider, model: null })}
              aria-label="Decision model provider"
            >
              {DECISION_PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
        </div>

        {decision.provider === "ollama" && (
          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Model</span>
              {decision.ollama_models.length > 0 ? (
                <span className="settings-task-desc">Decision models installed in Ollama. Kept loaded between messages.</span>
              ) : (
                <span className="settings-decision-status is-missing" role="status">
                  No decision models found in Ollama. Install one with <code>ollama pull clef-flash</code>.
                </span>
              )}
            </div>
            <div className="settings-decision-control">
              <select
                className="settings-select"
                value={decision.ollama_models.includes(decision.model) ? decision.model : ""}
                onChange={(e) => onChange({ model: e.target.value || null })}
                aria-label="Ollama decision model"
                disabled={decision.ollama_models.length === 0}
              >
                <option value="">
                  {decision.effective_model ? `Auto · ${decision.effective_model}` : "Auto"}
                </option>
                {decision.ollama_models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}

        {decision.provider === "chat" && (
          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Model</span>
              <span className="settings-task-desc">Any Copilot or Ollama model. A small, fast one works best.</span>
            </div>
            <div className="settings-decision-control">
              <select
                className="settings-select"
                value={chatModel}
                onChange={(e) => onChange({ model: e.target.value })}
                aria-label="Decision chat model"
              >
                <option value="">{chatModel ? "Low tier" : `Low tier · ${formatModelName(decision.effective_model)}`}</option>
                {groupModelsByProvider(chatOptions).map((group) => (
                  <optgroup key={group.provider.id} label={group.provider.name}>
                    {group.models.map((m) => <option key={m} value={m}>{formatModelName(m)}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        )}

        {decision.provider === "clef" && (
          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Model</span>
              <span
                className={`settings-decision-status${decision.clef_configured ? " is-ok" : " is-missing"}`}
                role="status"
              >
                {decision.clef_target ? (
                  <>Credentials configured ({CLEF_TARGET_LABEL[decision.clef_target]}).</>
                ) : (
                  <>
                    Not configured. In config.toml set <code>[decision.clef]</code> <code>account_id</code> and{" "}
                    <code>api_token</code> for Cloudflare, or <code>base_url</code> for a self-hosted server.
                  </>
                )}
              </span>
            </div>
            <div className="settings-decision-control">
              <select
                className="settings-select"
                value={decision.effective_model}
                onChange={(e) => onChange({ model: e.target.value })}
                aria-label="Clef model"
              >
                {decision.clef_models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const AGENT_CHATTINESS_OPTIONS: { key: AgentChattiness; label: string; hint: string }[] = [
  { key: "low", label: "Low", hint: "Up to 1 follow-up reply, high relevance bar." },
  { key: "medium", label: "Medium", hint: "Up to 2 follow-up replies when complementary expertise helps." },
  { key: "high", label: "High", hint: "Up to 4 collaborative back-and-forth replies." },
];

function AgentsSection() {
  const { settings, updateSettings } = useAgents();
  const activeHint =
    AGENT_CHATTINESS_OPTIONS.find((o) => o.key === settings.chattiness)?.hint ??
    "Controls how eagerly and how many times agents can reply to each other.";

  return (
    <section className="settings-section" aria-labelledby="settings-agents-title">
      <div className="settings-section-head">
        <h3 className="settings-section-title" id="settings-agents-title">Agents</h3>
        <p className="settings-section-desc">
          Control how custom agents participate in generic chats. Explicit <code>@handle</code> mentions always work.
          Automatic routing and agent-to-agent replies require the Decision model above to be enabled.
        </p>
      </div>
      <div className="settings-task-list">
        <div className="settings-task">
          <label className="settings-task-text" htmlFor="settings-agent-autoroute">
            <span className="settings-task-name">Auto-route generic chats</span>
            <span className="settings-task-desc">
              Use the decision model to check the latest messages and hand off untagged turns to a matching specialist agent.
            </span>
          </label>
          <input
            id="settings-agent-autoroute"
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={settings.autoRoute}
            onChange={(e) => void updateSettings({ autoRoute: e.target.checked })}
          />
        </div>

        <div className="settings-task">
          <label className="settings-task-text" htmlFor="settings-agent-replies">
            <span className="settings-task-name">Allow agents to reply to each other</span>
            <span className="settings-task-desc">
              After an agent finishes a turn in a generic chat, let other relevant agents chime in with corrections or follow-ups.
            </span>
          </label>
          <input
            id="settings-agent-replies"
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={settings.allowAgentReplies}
            onChange={(e) => void updateSettings({ allowAgentReplies: e.target.checked })}
          />
        </div>

        {settings.allowAgentReplies && (
          <div className="settings-task">
            <div className="settings-task-text">
              <span className="settings-task-name">Agent chattiness</span>
              <span className="settings-task-desc">{activeHint}</span>
            </div>
            <div className="settings-task-control">
              <div className="sop-diff-tabs" role="radiogroup" aria-label="Agent chattiness">
                {AGENT_CHATTINESS_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    role="radio"
                    aria-checked={settings.chattiness === opt.key}
                    className={`sop-diff-tab${settings.chattiness === opt.key ? " active" : ""}`}
                    onClick={() => settings.chattiness !== opt.key && void updateSettings({ chattiness: opt.key })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

interface FolderProps {
  folders: ChatFolder[];
  chats: ChatRecord[];
  onCreateFolder: (name: string) => Promise<ChatFolder>;
  onMoveChats: (ids: string[], folderId: string | null) => Promise<void>;
}

interface ReviewRow {
  chatId: string;
  title: string;
  folderName: string;
  // Unset for a proposed folder that is created on apply.
  folderId?: string;
  selected: boolean;
}

// Matches the server's per-request cap.
const CATEGORIZE_BATCH = 25;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const USER_NAME_MAX = 60;

/** The user's name; saves when the field loses focus or on Enter, with the status in the panel header. */
function ProfileSection({ onStatus }: { onStatus: (status: SaveStatus) => void }) {
  const profile = useUserProfile();
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? profile.name;

  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [status]);
  useEffect(() => { onStatus(status); }, [status, onStatus]);
  useEffect(() => () => onStatus("idle"), [onStatus]);

  async function save() {
    if (draft === null) return;
    if (draft.trim() === profile.name) return setDraft(null);
    setStatus("saving");
    setError(null);
    try {
      await saveUserName(draft);
      setDraft(null);
      setStatus("saved");
    } catch (err) {
      setError(errorText(err));
      setStatus("idle");
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-profile-title">
      <div className="settings-section-head">
        <h3 className="settings-section-title" id="settings-profile-title">Profile</h3>
      </div>
      <div className="settings-task-list">
        <form
          className="settings-task settings-profile"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <label className="settings-task-text" htmlFor="settings-user-name">
            <span className="settings-task-name">Your name</span>
            <span className="settings-task-desc">Rye uses it to greet you and to know who it's talking to.</span>
          </label>
          <input
            id="settings-user-name"
            className="form-input"
            value={value}
            maxLength={USER_NAME_MAX}
            placeholder={profile.loaded ? "Add your name" : "Loading…"}
            disabled={!profile.loaded}
            autoComplete="name"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "settings-user-name-error" : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => { if (e.key === "Escape" && draft !== null) { setDraft(null); setError(null); } }}
          />
        </form>
      </div>
      {error && <p className="settings-decision-status is-missing" id="settings-user-name-error" role="alert">{error}</p>}
    </section>
  );
}

function FoldersSection({ folders, chats, onCreateFolder, onMoveChats }: FolderProps) {
  const [suggest, setSuggest] = useState(readSuggestFolders);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [review, setReview] = useState<ReviewRow[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Chats the user unfiled by hand or dismissed a suggestion for are left alone.
  const unfiled = chats.filter((c) => !c.folderId && !c.folderSuggestionDismissed);

  async function categorize() {
    const controller = new AbortController();
    abortRef.current = controller;
    const ids = unfiled.map((c) => c.id);
    const titles = new Map(unfiled.map((c) => [c.id, c.title]));
    const propose = folders.length === 0;
    const rows: ReviewRow[] = [];
    let proposed: string[] = [];
    let failed = 0;
    let stopped: string | null = null;
    setNote(null);
    setReview(null);
    setProgress({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i += CATEGORIZE_BATCH) {
        const batch = ids.slice(i, i + CATEGORIZE_BATCH);
        const res = await folderApi<CategorizeResponse>(
          "/chat/categorize",
          "POST",
          propose ? { chat_ids: batch, propose, proposed } : { chat_ids: batch },
          controller.signal,
        );
        if (res.failed) failed += 1;
        if (propose && Array.isArray(res.new_folders)) proposed = res.new_folders;
        for (const s of res.suggestions ?? []) {
          const folder = s.folder_id ? folders.find((f) => f.id === s.folder_id) : undefined;
          const name = folder?.name ?? (s.folder_name && proposed.includes(s.folder_name) ? s.folder_name : undefined);
          const title = titles.get(s.chat_id);
          if (name && title !== undefined) rows.push({ chatId: s.chat_id, title, folderName: name, folderId: folder?.id, selected: true });
        }
        setProgress({ done: Math.min(i + CATEGORIZE_BATCH, ids.length), total: ids.length });
      }
    } catch (err) {
      if (controller.signal.aborted) return setProgress(null);
      stopped = `Categorizing stopped: ${errorText(err)}`;
    }
    setProgress(null);
    const notes: string[] = [];
    if (stopped) notes.push(stopped);
    else if (failed) notes.push(`The model didn't answer for ${failed} of ${Math.ceil(ids.length / CATEGORIZE_BATCH)} batches.`);
    const left = ids.length - rows.length;
    if (rows.length && left && !stopped) notes.push(`${left} ${left === 1 ? "chat doesn't" : "chats don't"} fit a folder and will stay unfiled.`);
    if (rows.length) setReview(rows);
    else if (!failed && !stopped) notes.push("No chats clearly fit a folder. They stay unfiled.");
    setNote(notes.join(" ") || null);
  }

  async function apply() {
    if (!review) return;
    const chosen = review.filter((r) => r.selected);
    setApplying(true);
    setNote(null);
    try {
      const idByName = new Map(folders.map((f) => [f.name.toLocaleLowerCase(), f.id]));
      const groups = new Map<string, string[]>();
      for (const row of chosen) {
        const key = row.folderName.toLocaleLowerCase();
        let id = row.folderId ?? idByName.get(key);
        if (!id) {
          id = (await onCreateFolder(row.folderName)).id;
          idByName.set(key, id);
        }
        groups.set(id, [...(groups.get(id) ?? []), row.chatId]);
      }
      for (const [id, ids] of groups) await onMoveChats(ids, id);
      setReview(null);
      setNote(`Moved ${chosen.length} ${chosen.length === 1 ? "chat" : "chats"}.`);
    } catch (err) {
      setNote(`Couldn't apply: ${errorText(err)}`);
    } finally {
      setApplying(false);
    }
  }

  const selectedCount = review?.filter((r) => r.selected).length ?? 0;
  const existingNames = new Set(folders.map((f) => f.name.toLocaleLowerCase()));

  return (
    <section className="settings-section" aria-labelledby="settings-folders-title">
      <div className="settings-section-head">
        <h3 className="settings-section-title" id="settings-folders-title">Chat folders</h3>
        <p className="settings-section-desc">
          Uses the titles model to sort chats into your folders. Only chat titles and the first messages are sent.
        </p>
      </div>
      <div className="settings-task-list">
        <div className="settings-task">
          <label className="settings-task-text" htmlFor="settings-suggest-folders">
            <span className="settings-task-name">Suggest folders for new chats</span>
            <span className="settings-task-desc">
              After a new chat's first reply, offer to move it into a matching folder. It moves unless you dismiss it.
            </span>
          </label>
          <input
            id="settings-suggest-folders"
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={suggest}
            onChange={(e) => {
              setSuggest(e.target.checked);
              writeSuggestFolders(e.target.checked);
            }}
          />
        </div>
        <div className="settings-task">
          <div className="settings-task-text">
            <span className="settings-task-name">Categorize unfiled chats</span>
            <span className="settings-task-desc">
              {folders.length
                ? `Suggests folders for ${unfiled.length} unfiled ${unfiled.length === 1 ? "chat" : "chats"}. Chats that don't clearly fit stay unfiled. You review before anything moves.`
                : `No folders yet, so up to 8 new folders are proposed for ${unfiled.length} unfiled ${unfiled.length === 1 ? "chat" : "chats"}. One-off chats stay unfiled. Nothing is created until you apply.`}
            </span>
          </div>
          {progress ? (
            <button type="button" className="settings-reset" onClick={() => abortRef.current?.abort()}>Cancel</button>
          ) : (
            <button
              type="button"
              className="settings-reset"
              disabled={unfiled.length === 0 || applying || review !== null}
              onClick={() => void categorize()}
            >
              Categorize
            </button>
          )}
        </div>
      </div>

      <div className="settings-folders-live" role="status" aria-live="polite">
        {progress && (
          <div className="settings-folders-progress">
            <progress value={progress.done} max={progress.total} aria-label="Categorizing chats" />
            <span>Categorizing {progress.done} of {progress.total}…</span>
          </div>
        )}
        {note && <p className="settings-folders-note">{note}</p>}
      </div>

      {review && (
        <div className="settings-folders-review">
          <ul className="settings-task-list settings-folders-list" aria-label="Suggested moves">
            {review.map((row, i) => (
              <li className="settings-task" key={row.chatId}>
                <label className="settings-folders-row">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    onChange={(e) => setReview((prev) => prev && prev.map((r, j) => (j === i ? { ...r, selected: e.target.checked } : r)))}
                  />
                  <span className="settings-folders-chat">{row.title}</span>
                  <span className="settings-folders-arrow" aria-hidden="true">→</span>
                  <span className="settings-sr-only">to</span>
                  <span className="settings-folders-target">
                    {row.folderName}
                    {!row.folderId && !existingNames.has(row.folderName.toLocaleLowerCase()) && (
                      <span className="settings-source">New</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="settings-folders-actions">
            <button type="button" className="btn btn--ghost btn--sm" disabled={applying} onClick={() => setReview(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={applying || selectedCount === 0}
              onClick={() => void apply()}
            >
              {applying ? "Applying…" : `Apply selected (${selectedCount})`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
