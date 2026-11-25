import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  findSpaceId,
  loadGlobalConfig,
  registerSpace,
  relocateSpace,
  saveGlobalConfig,
  spaceLabel,
} from "../../config/loadConfig.ts";
import { NO_SPACES_YET } from "../hostSpace.ts";

// What the desktop app's Open folder as space and Locate do with a folder
// picker, for a host with no desktop app. A typed path is the human choice
// that may assign identity, so these write the entries a service never mints
// itself (docs/architecture.md's Space identity and state ownership section).
export function registerSpaceCommand(program: Command): void {
  const space = program
    .command("space")
    .description("Add a folder to your spaces, point a space at a folder it moved to, or list them");

  space
    .command("add <folder>")
    .description("Add a folder you already have to your spaces, as it is")
    .action((folder: string) => {
      const target = path.resolve(folder);
      if (!isDirectory(target)) {
        refuse(`${target} is not a directory.`);
        return;
      }

      const config = loadGlobalConfig();
      const known = findSpaceId(config, target);
      if (known !== undefined) {
        console.log(`${target} is already in your spaces, as ${known}.`);
        return;
      }

      const added = registerSpace(config, target);
      saveGlobalConfig(added);
      console.log(`Added ${target} to your spaces, as ${findSpaceId(added, target)}.`);
    });

  space
    .command("locate <id> <folder>")
    .description("Point a space at the folder it moved to, keeping its approvals and API tokens")
    .action((id: string, folder: string) => {
      const target = path.resolve(folder);
      const config = loadGlobalConfig();
      if (!config.spaces?.[id]) {
        refuse(`No space has the id "${id}". Run pragma space list to see them.`);
        return;
      }
      if (!isDirectory(target)) {
        refuse(`${target} is not a directory.`);
        return;
      }

      const relocated = relocateSpace(config, id, target);
      if ("refused" in relocated) {
        refuse(`${relocated.refused}.`);
        return;
      }

      saveGlobalConfig(relocated.config);
      console.log(`${id} now points to ${target}, keeping its approvals and API tokens.`);
      console.log("If Pragma is serving this space, restart it to serve the new folder.");
    });

  space
    .command("list")
    .description("List your spaces, with each one's id and folder")
    .action(() => {
      // In the order Manage Spaces lists them: by the name a row shows.
      const rows = Object.entries(loadGlobalConfig().spaces ?? {})
        .map(([id, record]) => ({
          id,
          name: spaceLabel(record),
          folder: record.path,
          missing: !existsSync(record.path),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (rows.length === 0) {
        console.log(NO_SPACES_YET);
        return;
      }

      const idWidth = Math.max("ID".length, ...rows.map((row) => row.id.length));
      const nameWidth = Math.max("NAME".length, ...rows.map((row) => row.name.length));
      console.log(`${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}  FOLDER`);
      for (const row of rows) {
        const missing = row.missing ? "  (folder not found)" : "";
        console.log(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.folder}${missing}`);
      }
    });
}

function isDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory();
}

function refuse(message: string): void {
  console.error(message);
  process.exitCode = 1;
}
