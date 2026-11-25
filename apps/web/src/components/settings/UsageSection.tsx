import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertCircle, BarChart3, Plus, RefreshCw, Trash2 } from "lucide-react";
import { formatModelName } from "../../utils/modelNames";
import { useSyncRefresh } from "../../utils/sync";

/**
 * Settings → Usage (/settings/usage): what the agent's model and tool calls cost over a time range
 * (GET /usage/summary), and the model price table that cost is estimated from (GET/PUT /usage/pricing,
 * DELETE /usage/pricing/:model). Loaded lazily by SettingsPanel, so recharts only loads here.
 */

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  cost: number;
  pricedCalls: number;
}

interface DayRow {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
}

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  calls: number;
}

interface ToolRow {
  tool: string;
  calls: number;
  errors: number;
  totalMs: number;
}

interface ContextPoint {
  ts: number;
  sessionId: string;
  model: string;
  contextPct: number;
  inputTokens: number;
  contextWindow: number;
}

interface Summary {
  days: number;
  totals: Totals;
  byDay: DayRow[];
  byModel: ModelRow[];
  byTool: ToolRow[];
  contextTimeline: ContextPoint[];
}

interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  updatedAt: number;
  source?: string;
}
type PricingTable = Record<string, ModelPrice>;

type SaveStatus = "idle" | "saving" | "saved";

const RANGES = [7, 30, 90];
/** The chart palette (tokens.css), in its fixed order. */
const SERIES = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The price entry a model's cost is taken from: its own, or the longest prefix match (as the server's estimateCost). */
function priceKeyFor(model: string, table: PricingTable): string | undefined {
  if (table[model]) return model;
  return Object.keys(table)
    .filter((k) => model.startsWith(k) || k.startsWith(model))
    .sort((a, b) => b.length - a.length)[0];
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="analytics-stat">
      <span className="analytics-stat-label">{label}</span>
      <span className="analytics-stat-value">{value}</span>
      {sub && <span className="analytics-stat-sub">{sub}</span>}
    </div>
  );
}

const AXIS = { stroke: "var(--color-fg-dim)", fontSize: 12 };
const LEGEND_STYLE = { fontSize: 12 };
const TOOLTIP_STYLE = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--color-fg)",
};

// Recharts widens formatter args to `ValueType | undefined`, so coerce here.
const tokenFormatter = (value: unknown, name: unknown): [string, string] => [
  formatTokens(Number(value) || 0),
  String(name ?? ""),
];

const costFormatter = (value: unknown): string => formatCost(Number(value) || 0);

const contextFormatter = (value: unknown, _name: unknown, entry: unknown): [string, string] => {
  const point = (entry as { payload?: ContextPoint } | undefined)?.payload;
  return [
    `${Number(value) || 0}% (${formatTokens(point?.inputTokens ?? 0)} tokens)`,
    point?.model ? formatModelName(point.model) : "context",
  ];
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** A price is a number of dollars, zero or more. */
function parsePrice(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function UsageSection({ onStatus }: { onStatus?: (status: SaveStatus) => void }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [pricing, setPricing] = useState<PricingTable | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const daysRef = useRef(days);
  daysRef.current = days;
  const pricingRef = useRef<HTMLElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  const [newModel, setNewModel] = useState("");
  const [newInput, setNewInput] = useState("");
  const [newOutput, setNewOutput] = useState("");

  const load = useCallback(async (range = daysRef.current) => {
    setLoading(true);
    try {
      const [summary, prices] = await Promise.all([
        fetch(`/usage/summary?days=${range}`).then((r) => jsonOrThrow<Summary>(r)),
        fetch("/usage/pricing").then((r) => jsonOrThrow<PricingTable>(r)),
      ]);
      // A slower answer for a range the user has since left is dropped.
      if (range !== daysRef.current) return;
      setData(summary);
      setPricing(prices);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(days); }, [days, load]);
  useSyncRefresh("usage", () => void load());

  const dayChart = useMemo(
    () => (data?.byDay ?? []).map((d) => ({ ...d, label: formatDay(d.date) })),
    [data]
  );

  const contextChart = useMemo(
    () =>
      (data?.contextTimeline ?? []).map((p, i) => ({
        ...p,
        idx: i,
        time: new Date(p.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      })),
    [data]
  );

  const unpricedModels = useMemo(
    () => (data && pricing ? data.byModel.filter((m) => !priceKeyFor(m.model, pricing)).map((m) => m.model) : []),
    [data, pricing]
  );

  const hasData = (data?.totals.calls ?? 0) > 0;
  const unpriced = data ? data.totals.calls - data.totals.pricedCalls : 0;
  const costModels = (data?.byModel ?? []).filter((m) => m.cost > 0);

  async function savePrice(model: string, input: number, output: number) {
    onStatus?.("saving");
    try {
      const res = await fetch("/usage/pricing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: [{ model, input_per_mtok: input, output_per_mtok: output, source: "settings" }] }),
      });
      const body = await jsonOrThrow<{ saved: string[]; skipped: string[] }>(res);
      if (body.saved.length === 0) throw new Error(`Couldn't save the price for ${model}.`);
      await load();
      onStatus?.("saved");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onStatus?.("idle");
      return false;
    }
  }

  async function removePrice(model: string) {
    onStatus?.("saving");
    try {
      await jsonOrThrow(await fetch(`/usage/pricing/${encodeURIComponent(model)}`, { method: "DELETE" }));
      await load();
      onStatus?.("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onStatus?.("idle");
    }
  }

  async function addPrice(e: React.FormEvent) {
    e.preventDefault();
    const model = newModel.trim();
    const input = parsePrice(newInput);
    const output = parsePrice(newOutput);
    if (!model || input === null || output === null) return;
    if (await savePrice(model, input, output)) {
      setNewModel("");
      setNewInput("");
      setNewOutput("");
    }
  }

  function startPriceFor(model: string) {
    setNewModel(model);
    pricingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.requestAnimationFrame(() => newInputRef.current?.focus({ preventScroll: true }));
  }

  const canAdd = newModel.trim() !== "" && parsePrice(newInput) !== null && parsePrice(newOutput) !== null;
  const priceRows = Object.entries(pricing ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      {error && <div className="settings-error" role="alert">{error}</div>}

      <section className="settings-section" aria-labelledby="settings-usage-title">
        <div className="settings-section-head">
          <h3 className="settings-section-title" id="settings-usage-title">Usage</h3>
          <p className="settings-section-desc">Model calls, tokens and tool use over the last {days} days, with the cost estimated from the prices below.</p>
        </div>
        <div className="usage-toolbar">
          <div className="analytics-range" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={`analytics-range-btn${days === r ? " active" : ""}`}
                aria-pressed={days === r}
                onClick={() => setDays(r)}
              >
                {r}d
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn faint usage-refresh" onClick={() => void load()} title="Refresh" aria-label="Refresh usage">
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
        </div>

        {!data && loading && <p className="settings-placeholder">Loading usage…</p>}

        {data && !hasData && (
          <div className="sop-panel-zero settings-list-zero">
            <BarChart3 size={32} className="sop-panel-zero-icon" aria-hidden="true" />
            <p>No usage recorded yet.</p>
            <p className="sop-panel-zero-sub">Token usage is tracked automatically as you chat. Come back after a few conversations.</p>
          </div>
        )}

        {data && hasData && (
          <div className="analytics-body">
            <div className="analytics-stats">
              <StatCard label="LLM calls" value={String(data.totals.calls)} />
              <StatCard label="Input tokens" value={formatTokens(data.totals.inputTokens)} />
              <StatCard label="Output tokens" value={formatTokens(data.totals.outputTokens)} />
              <StatCard label="Tool calls" value={String(data.totals.toolCalls)} />
              <StatCard
                label="Est. cost"
                value={formatCost(data.totals.cost)}
                sub={unpriced > 0 ? `${unpriced} call(s) unpriced` : undefined}
              />
            </div>

            {unpriced > 0 && (
              <div className="analytics-note">
                <AlertCircle size={14} aria-hidden="true" />
                <span>
                  {data.totals.pricedCalls === 0
                    ? "No model has a price yet, so cost shows $0."
                    : "Some calls have no price, so cost is understated."}{" "}
                  <button
                    type="button"
                    className="usage-link"
                    onClick={() => pricingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    Set prices in Model pricing
                  </button>
                  , or paste a pricing table into a chat and ask the agent to save it.
                </span>
              </div>
            )}

            <section className="analytics-section">
              <h4 className="analytics-section-title">Tokens over time</h4>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={dayChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="label" {...AXIS} tickLine={false} />
                  <YAxis {...AXIS} tickLine={false} tickFormatter={formatTokens} width={48} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenFormatter} />
                  <Legend wrapperStyle={LEGEND_STYLE} />
                  <Area type="monotone" dataKey="inputTokens" name="Input" stackId="1" stroke={SERIES[0]} fill={SERIES[0]} fillOpacity={0.25} />
                  <Area type="monotone" dataKey="outputTokens" name="Output" stackId="1" stroke={SERIES[1]} fill={SERIES[1]} fillOpacity={0.25} />
                </AreaChart>
              </ResponsiveContainer>
            </section>

            <div className="analytics-grid">
              <section className="analytics-section">
                <h4 className="analytics-section-title">Tokens by model</h4>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.byModel} layout="vertical" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
                    <XAxis type="number" {...AXIS} tickLine={false} tickFormatter={formatTokens} />
                    <YAxis type="category" dataKey="model" {...AXIS} tickLine={false} width={130} tickFormatter={formatModelName} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tokenFormatter} />
                    <Legend wrapperStyle={LEGEND_STYLE} />
                    <Bar dataKey="inputTokens" name="Input" stackId="1" fill={SERIES[0]} />
                    <Bar dataKey="outputTokens" name="Output" stackId="1" fill={SERIES[1]} />
                  </BarChart>
                </ResponsiveContainer>
              </section>

              <section className="analytics-section">
                <h4 className="analytics-section-title">Cost by model</h4>
                {data.totals.cost > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={costModels.map((m) => ({ ...m, label: formatModelName(m.model) }))}
                        dataKey="cost"
                        nameKey="label"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={2}
                      >
                        {costModels.map((m, i) => (
                          <Cell key={m.model} fill={SERIES[i % SERIES.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={costFormatter} />
                      <Legend wrapperStyle={LEGEND_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="settings-placeholder">Set a price for a model below to see the cost breakdown.</p>
                )}
              </section>
            </div>

            <section className="analytics-section">
              <h4 className="analytics-section-title">Context window usage</h4>
              <p className="analytics-section-sub">Each point is one LLM call. Compaction kicks in around 72%.</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={contextChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" {...AXIS} tickLine={false} minTickGap={40} />
                  <YAxis {...AXIS} tickLine={false} domain={[0, 100]} width={40} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={contextFormatter} />
                  <Line type="monotone" dataKey="contextPct" name="Context used" stroke={SERIES[2]} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </section>

            {data.byTool.length > 0 && (
              <section className="analytics-section">
                <h4 className="analytics-section-title">Most-used tools</h4>
                <table className="sop-table">
                  <tbody>
                    {data.byTool.slice(0, 15).map((t) => (
                      <tr key={t.tool} className="sop-table-row">
                        <td className="sop-table-td" style={{ fontWeight: 600 }}>{t.tool}</td>
                        <td className="sop-table-td" style={{ width: 90 }}>{t.calls} call{t.calls !== 1 ? "s" : ""}</td>
                        <td className="sop-table-td" style={{ width: 110 }}>
                          {(t.totalMs / Math.max(t.calls, 1) / 1000).toFixed(1)}s avg
                        </td>
                        <td className={`sop-table-td usage-tool-errors${t.errors > 0 ? " has-errors" : ""}`} style={{ width: 90 }}>
                          {t.errors > 0 ? `${t.errors} error${t.errors !== 1 ? "s" : ""}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </div>
        )}
      </section>

      <section className="settings-section usage-pricing" aria-labelledby="settings-pricing-title" ref={pricingRef}>
        <div className="settings-section-head">
          <h3 className="settings-section-title" id="settings-pricing-title">Model pricing</h3>
          <p className="settings-section-desc">
            US dollars per million tokens. A price also covers longer model ids that start with its name (a dated version).
            The agent can save these too: paste a provider's pricing page into a chat and ask it to.
          </p>
        </div>

        {unpricedModels.length > 0 && (
          <div className="usage-unpriced" role="group" aria-label="Models without a price">
            <span className="usage-unpriced-label">No price in this range:</span>
            {unpricedModels.map((model) => (
              <button key={model} type="button" className="usage-unpriced-chip" onClick={() => startPriceFor(model)} title={`Add a price for ${model}`}>
                <Plus size={12} aria-hidden="true" />
                <span>{model}</span>
              </button>
            ))}
          </div>
        )}

        <div className="settings-task-list usage-price-list">
          <div className="usage-price-row usage-price-head" aria-hidden="true">
            <span>Model</span>
            <span>Input / 1M</span>
            <span>Output / 1M</span>
            <span />
          </div>
          {pricing === null && <p className="settings-placeholder usage-price-empty">Loading prices…</p>}
          {pricing !== null && priceRows.length === 0 && (
            <p className="usage-price-empty">No prices yet. Add one below{unpricedModels.length > 0 ? ", or pick a model above" : ""}.</p>
          )}
          {priceRows.map(([model, price]) => (
            <PriceRow key={model} model={model} price={price} onSave={savePrice} onRemove={removePrice} />
          ))}
          <form className="usage-price-row usage-price-new" onSubmit={(e) => void addPrice(e)}>
            <input
              className="form-input"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="Model id, e.g. claude-sonnet-4-5"
              aria-label="Model id"
              list="usage-model-ids"
              spellCheck={false}
              autoCapitalize="off"
            />
            <datalist id="usage-model-ids">
              {unpricedModels.map((m) => <option key={m} value={m} />)}
            </datalist>
            <PriceInput ref={newInputRef} value={newInput} onChange={setNewInput} label="Input price per million tokens" />
            <PriceInput value={newOutput} onChange={setNewOutput} label="Output price per million tokens" />
            <button type="submit" className="btn btn--primary btn--sm usage-price-action" disabled={!canAdd}>
              <Plus size={13} aria-hidden="true" /> Add
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

const PriceInput = React.forwardRef<HTMLInputElement, { value: string; onChange: (value: string) => void; label: string }>(
  function PriceInput({ value, onChange, label }, ref) {
    return (
      <span className="usage-price-input">
        <span aria-hidden="true">$</span>
        <input
          ref={ref}
          className="form-input"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          aria-label={label}
        />
      </span>
    );
  }
);

/** One saved price: edit the two numbers in place (Save, or Enter), or remove the row. */
function PriceRow({
  model,
  price,
  onSave,
  onRemove,
}: {
  model: string;
  price: ModelPrice;
  onSave: (model: string, input: number, output: number) => Promise<boolean>;
  onRemove: (model: string) => Promise<void>;
}) {
  const [input, setInput] = useState(String(price.input_per_mtok));
  const [output, setOutput] = useState(String(price.output_per_mtok));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setInput(String(price.input_per_mtok));
    setOutput(String(price.output_per_mtok));
  }, [price.input_per_mtok, price.output_per_mtok]);

  const inputValue = parsePrice(input);
  const outputValue = parsePrice(output);
  const valid = inputValue !== null && outputValue !== null;
  const dirty = inputValue !== price.input_per_mtok || outputValue !== price.output_per_mtok;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !dirty || busy) return;
    setBusy(true);
    await onSave(model, inputValue, outputValue);
    setBusy(false);
  }

  return (
    <form className="usage-price-row" onSubmit={(e) => void save(e)}>
      <span className="usage-price-model" title={price.source ? `${model} · from ${price.source}` : model}>
        {formatModelName(model)}
        {formatModelName(model) !== model && <code>{model}</code>}
      </span>
      <PriceInput value={input} onChange={setInput} label={`Input price per million tokens for ${model}`} />
      <PriceInput value={output} onChange={setOutput} label={`Output price per million tokens for ${model}`} />
      <span className="usage-price-action">
        {dirty ? (
          <button type="submit" className="btn btn--primary btn--sm" disabled={!valid || busy}>Save</button>
        ) : (
          <button
            type="button"
            className="icon-btn faint usage-price-remove"
            onClick={async () => { setBusy(true); await onRemove(model); setBusy(false); }}
            disabled={busy}
            title={`Remove the price for ${model}`}
            aria-label={`Remove the price for ${model}`}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </span>
    </form>
  );
}
