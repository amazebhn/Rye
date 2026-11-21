#!/usr/bin/env bun
/**
 * Rye CLI — Production Support AI Agent
 */

import { program } from "commander";
import { chatCommand } from "./commands/chat.js";
import { sopCommand } from "./commands/sop.js";
import { configCommand } from "./commands/config.js";

program
  .name("rye")
  .description("Rye — Production Support AI Agent")
  .version("0.1.0");

program.addCommand(chatCommand);
program.addCommand(sopCommand);
program.addCommand(configCommand);

program.parse();
