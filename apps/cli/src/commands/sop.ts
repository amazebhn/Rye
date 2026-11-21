import { Command } from "commander";
import chalk from "chalk";
import { getConfig } from "../config.js";
import { DEFAULT_AGENT_URL } from "@rye/shared";
import type { SOP } from "@rye/shared";

async function fetchSops(agentUrl: string, path: string): Promise<any> {
  const resp = await fetch(`${agentUrl}/sop${path}`);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

export const sopCommand = new Command("sop")
  .description("Manage Standard Operating Procedures (SOPs)");

sopCommand
  .command("list")
  .description("List all saved SOPs")
  .action(async () => {
    const config = getConfig();
    const agentUrl = config.get("agentUrl") ?? DEFAULT_AGENT_URL;
    try {
      const sops: SOP[] = await fetchSops(agentUrl, "/");
      if (sops.length === 0) {
        console.log(chalk.dim("\nNo SOPs saved yet. Use `rye chat` to describe an incident resolution.\n"));
        return;
      }
      console.log(chalk.bold(`\nSOPs (${sops.length})\n`));
      for (const sop of sops) {
        const tags = sop.tags.length ? chalk.dim(` [${sop.tags.join(", ")}]`) : "";
        console.log(`  ${chalk.cyan(sop.id.slice(0, 8))}  ${chalk.bold(sop.title)}${tags}`);
        if (sop.description) {
          console.log(`            ${chalk.dim(sop.description)}`);
        }
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Failed to fetch SOPs: ${err}`));
      process.exit(1);
    }
  });

sopCommand
  .command("view <id>")
  .description("View a SOP by ID (full or partial)")
  .action(async (id: string) => {
    const config = getConfig();
    const agentUrl = config.get("agentUrl") ?? DEFAULT_AGENT_URL;
    try {
      // Search for partial ID match
      const allSops: SOP[] = await fetchSops(agentUrl, "/");
      const match = allSops.find((s) => s.id.startsWith(id));
      if (!match) {
        console.error(chalk.red(`No SOP found matching: ${id}`));
        process.exit(1);
      }
      const sop: SOP = await fetchSops(agentUrl, `/${match.id}`);
      console.log(chalk.bold(`\n${sop.title}`));
      console.log(chalk.dim(`ID: ${sop.id} | v${sop.version} | Updated: ${sop.updated_at.slice(0, 10)}`));
      if (sop.tags.length) console.log(chalk.dim(`Tags: ${sop.tags.join(", ")}`));
      console.log();
      console.log(sop.content);
      if (sop.steps?.length) {
        console.log(chalk.bold("\nSteps:"));
        for (const step of sop.steps) {
          console.log(`  ${chalk.cyan(step.step_number + ".")} ${step.action}`);
          if (step.rationale) console.log(`     ${chalk.dim(step.rationale)}`);
        }
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Failed to fetch SOP: ${err}`));
      process.exit(1);
    }
  });

sopCommand
  .command("search <query>")
  .description("Semantic search for relevant SOPs")
  .action(async (query: string) => {
    const config = getConfig();
    const agentUrl = config.get("agentUrl") ?? DEFAULT_AGENT_URL;
    try {
      const results: (SOP & { similarity: number })[] = await fetchSops(
        agentUrl,
        `/search?q=${encodeURIComponent(query)}`
      );
      if (results.length === 0) {
        console.log(chalk.dim("\nNo relevant SOPs found.\n"));
        return;
      }
      console.log(chalk.bold(`\nSearch results for: "${query}"\n`));
      for (const sop of results) {
        const score = chalk.dim(`(${(sop.similarity * 100).toFixed(0)}% match)`);
        console.log(`  ${chalk.cyan(sop.id.slice(0, 8))}  ${chalk.bold(sop.title)} ${score}`);
        if (sop.description) console.log(`            ${chalk.dim(sop.description)}`);
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Failed to search SOPs: ${err}`));
      process.exit(1);
    }
  });

sopCommand
  .command("delete <id>")
  .description("Delete a SOP by ID")
  .action(async (id: string) => {
    const config = getConfig();
    const agentUrl = config.get("agentUrl") ?? DEFAULT_AGENT_URL;
    try {
      const allSops: SOP[] = await fetchSops(agentUrl, "/");
      const match = allSops.find((s) => s.id.startsWith(id));
      if (!match) {
        console.error(chalk.red(`No SOP found matching: ${id}`));
        process.exit(1);
      }
      const resp = await fetch(`${agentUrl}/sop/${match.id}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      console.log(chalk.green(`✓ Deleted SOP: ${match.title}`));
    } catch (err) {
      console.error(chalk.red(`Failed to delete SOP: ${err}`));
      process.exit(1);
    }
  });
