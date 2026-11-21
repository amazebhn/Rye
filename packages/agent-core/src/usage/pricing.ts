/**
 * Model pricing table used to estimate cost from recorded token counts.
 *
 * Deliberately starts empty — prices change often and vary by account, so the
 * table is populated by the user (or by set_model_pricing_tool, which lets the
 * agent parse a pasted pricing page into structured entries).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";

const PRICING_FILE = join(DATA_DIR, "model-pricing.json");

export interface ModelPrice {
  /** USD per million input tokens. */
  input_per_mtok: number;
  /** USD per million output tokens. */
  output_per_mtok: number;
  updatedAt: number;
  source?: string;
}

export type PricingTable = Record<string, ModelPrice>;

export function readPricing(): PricingTable {
  try {
    if (!existsSync(PRICING_FILE)) return {};
    const parsed = JSON.parse(readFileSync(PRICING_FILE, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as PricingTable;
  } catch {
    return {};
  }
}

function writePricing(table: PricingTable): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PRICING_FILE, JSON.stringify(table, null, 2), "utf8");
}

export interface PriceInput {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  source?: string;
}

/** Merge entries into the table, overwriting models that already exist. */
export function upsertPricing(entries: PriceInput[]): { saved: string[]; skipped: string[] } {
  const table = readPricing();
  const saved: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const model = entry.model?.trim();
    const input = Number(entry.input_per_mtok);
    const output = Number(entry.output_per_mtok);
    if (!model || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      skipped.push(entry.model ?? "(unnamed)");
      continue;
    }
    table[model] = {
      input_per_mtok: input,
      output_per_mtok: output,
      updatedAt: Date.now(),
      source: entry.source,
    };
    saved.push(model);
  }

  if (saved.length > 0) writePricing(table);
  return { saved, skipped };
}

export function removePricing(model: string): boolean {
  const table = readPricing();
  if (!(model in table)) return false;
  delete table[model];
  writePricing(table);
  return true;
}

/**
 * Cost in USD for a token count. Falls back to the closest prefix match so
 * versioned ids (e.g. "claude-sonnet-4.5-20250101") hit a base entry.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const table = readPricing();
  let price = table[model];

  if (!price) {
    const match = Object.keys(table)
      .filter((k) => model.startsWith(k) || k.startsWith(model))
      .sort((a, b) => b.length - a.length)[0];
    if (match) price = table[match];
  }

  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input_per_mtok + (outputTokens / 1_000_000) * price.output_per_mtok;
}
