import { Command } from "commander";
import { pragmaVersion } from "../server/version.ts";
import { registerDevCommand } from "./commands/dev.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerPassphraseCommand } from "./commands/passphrase.ts";
import { registerRunCommand } from "./commands/run.ts";
import { registerSpaceCommand } from "./commands/space.ts";
import { registerStartCommand } from "./commands/start.ts";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("pragma")
    .description("A protocol and local editor for AI-native workflows over a markdown/html/Fountain space.")
    .version(pragmaVersion);

  registerDevCommand(program);
  registerInitCommand(program);
  registerPassphraseCommand(program);
  registerRunCommand(program);
  registerSpaceCommand(program);
  registerStartCommand(program);

  return program;
}
