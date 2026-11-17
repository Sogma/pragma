import path from "node:path";
import type { Command } from "commander";
import { loadGlobalConfig, registerSpace, saveGlobalConfig } from "../../config/loadConfig.ts";
import { scaffoldSpace } from "../../protocol/scaffoldSpace.ts";

export function registerInitCommand(program: Command): void {
  program
    .command("init [directory]")
    .description(
      "Scaffold a new Pragma space in the given directory (default: current directory) and add it to your spaces",
    )
    .action(async (directory: string | undefined) => {
      const target = path.resolve(directory ?? ".");

      // Read before anything is written, so a config that won't parse stops
      // the command rather than leaving a space no list knows. Read again to
      // save: a host running meanwhile may have changed the file.
      loadGlobalConfig();

      try {
        await scaffoldSpace(target);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }

      saveGlobalConfig(registerSpace(loadGlobalConfig(), target));
      console.log(`Created ${target} and added it to your spaces.`);
    });
}
