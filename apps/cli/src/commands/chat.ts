import { Command } from "commander";
import chalk from "chalk";
import * as readline from "readline";
import { streamChat, checkAgentHealth } from "../agent.js";

export const chatCommand = new Command("chat")
  .description("Start an interactive chat session with the Rye agent")
  .option("-s, --session <id>", "Resume an existing session by ID")
  .action(async (opts) => {
    // Check agent is running
    const healthy = await checkAgentHealth();
    if (!healthy) {
      console.error(
        chalk.red("✗ Agent is not running.") +
          chalk.dim(" Start it with: ") +
          chalk.cyan("just dev-agent")
      );
      process.exit(1);
    }

    let sessionId: string | undefined = opts.session;

    console.log(chalk.bold.cyan("\nRye — Production Support Agent"));
    if (sessionId) {
      console.log(chalk.dim(`Resuming session: ${sessionId}`));
    }
    console.log(
      chalk.dim('Type your message and press Enter. Type "exit" or Ctrl+C to quit.\n')
    );
    console.log(chalk.dim("─".repeat(60)));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const prompt = () => {
      rl.question(chalk.bold.green("\nYou: "), async (input) => {
        const message = input.trim();
        if (!message) {
          prompt();
          return;
        }
        if (message.toLowerCase() === "exit" || message.toLowerCase() === "quit") {
          console.log(chalk.dim("\nGoodbye.\n"));
          rl.close();
          process.exit(0);
        }

        process.stdout.write(chalk.bold.blue("\nRye: "));
        let firstToken = true;

        try {
          for await (const event of streamChat(message, sessionId)) {
            if (event.type === "session" && event.session_id) {
              sessionId = event.session_id;
            } else if (event.type === "token" && event.content) {
              if (firstToken) firstToken = false;
              process.stdout.write(event.content);
            } else if (event.type === "tool_start" && event.name) {
              process.stdout.write(chalk.dim(`\n[tool] ${event.name}`));
            } else if (event.type === "tool_result" && event.name) {
              process.stdout.write(chalk.dim(` ✓\n`));
              if (firstToken) process.stdout.write(chalk.bold.blue("\nRye: "));
            } else if (event.type === "done") {
              process.stdout.write("\n");
            } else if (event.type === "error") {
              console.error(chalk.red(`\nError: ${event.error}`));
            }
          }
        } catch (err) {
          console.error(chalk.red(`\nConnection error: ${err}`));
        }

        console.log(chalk.dim("─".repeat(60)));
        prompt();
      });
    };

    // Handle Ctrl+C gracefully
    rl.on("SIGINT", () => {
      console.log(chalk.dim("\n\nSession ended."));
      if (sessionId) {
        console.log(chalk.dim(`Session ID: ${sessionId}`));
      }
      process.exit(0);
    });

    prompt();
  });
