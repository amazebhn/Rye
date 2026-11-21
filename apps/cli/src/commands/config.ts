import { Command } from "commander";
import chalk from "chalk";
import {
  getConfig,
  getEffectiveAgentUrl,
  getEffectiveLlmProvider,
  RYE_CONFIG_FILE,
} from "../config.js";

export const configCommand = new Command("config")
  .description("Manage Rye CLI configuration");

configCommand
  .command("show")
  .description("Show current configuration")
  .action(() => {
    const config = getConfig();
    console.log(chalk.bold("\nRye Configuration\n"));
    console.log(`  agentUrl:    ${chalk.cyan(getEffectiveAgentUrl())}`);
    console.log(`  llmProvider: ${chalk.cyan(getEffectiveLlmProvider())}`);
    console.log(`\n  CLI config file: ${chalk.dim(config.path)}`);
    console.log(`  Rye TOML file:   ${chalk.dim(RYE_CONFIG_FILE)}\n`);
  });

configCommand
  .command("set <key> <value>")
  .description("Set a configuration value (agentUrl, llmProvider)")
  .action((key: string, value: string) => {
    const config = getConfig();
    const validKeys = ["agentUrl", "llmProvider"];
    if (!validKeys.includes(key)) {
      console.error(chalk.red(`Unknown config key: ${key}`));
      console.error(chalk.dim(`Valid keys: ${validKeys.join(", ")}`));
      process.exit(1);
    }
    config.set(key as any, value);
    console.log(chalk.green(`✓ Set ${key} = ${value}`));
  });

configCommand
  .command("reset")
  .description("Reset configuration to defaults")
  .action(() => {
    const config = getConfig();
    config.clear();
    console.log(chalk.green("✓ Configuration reset to defaults"));
  });
