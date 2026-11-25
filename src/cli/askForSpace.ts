import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { cancel, confirm, intro, isCancel, log, outro, select, text } from "@clack/prompts";
import {
  loadGlobalConfig,
  type PragmaGlobalConfig,
  registerSpace,
  relocateSpace,
  saveGlobalConfig,
  spaceLabel,
} from "../config/loadConfig.ts";
import { scaffoldSpace } from "../protocol/scaffoldSpace.ts";
import { newSpaceFolderIn } from "../server/rootedFiles.ts";

interface Streams {
  input?: Readable;
  output?: Writable;
}

/** Where the questions go, and the folder a relative answer is read from. */
export interface Terminal extends Streams {
  cwd?: string;
}

interface MissingSpace {
  id: string;
  name: string;
  folder: string;
}

type Choice = "locate" | "create" | "open";

/** Whether a person is there to answer. A question nobody answers waits
 * forever, so a service, a pipe, a CI job (which may still attach a
 * pseudo-terminal) and a dumb terminal (which can't redraw one) get none. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== "dumb" && !("CI" in process.env);
}

/** First-run setup for a local host with no space to open: asks the person
 * to create a space, open a folder as one, or point a moved space at its
 * folder, and saves the answer as `pragma init`, `space add` and
 * `space locate` do. The folder to serve, or undefined if they cancel. */
export async function askForSpace({ input, output, cwd = process.cwd() }: Terminal = {}): Promise<string | undefined> {
  const io = { input, output };
  const registered = Object.entries(loadGlobalConfig().spaces ?? {});
  const missing = registered
    .filter(([, record]) => !isDirectory(record.path))
    .map(([id, record]) => ({ id, name: spaceLabel(record), folder: record.path }));

  intro("Pragma", io);
  if (missing.length > 0) {
    const width = Math.max(...missing.map((space) => space.name.length));
    const rows = missing.map((space) => `${space.name.padEnd(width)}  ${space.folder}`);
    log.warn(["None of your spaces' folders was found:", ...rows].join("\n"), io);
  }

  const options: { value: Choice; label: string; hint: string }[] = [
    { value: "create", label: "Create new space", hint: "Starts a space in a new folder" },
    { value: "open", label: "Open folder as space", hint: "Choose an existing folder on this computer" },
  ];
  if (missing.length > 0) {
    options.unshift({
      value: "locate",
      label: "Locate a moved space",
      hint: "Points a space at the folder it moved to",
    });
  }
  const choice = await select({
    ...io,
    message: missing.length > 0 ? "What would you like to do?" : "No space yet. What would you like to do?",
    options,
  });
  if (isCancel(choice)) return cancelled(io);
  if (choice === "create") return createSpace(io, cwd, registered.length === 0);
  if (choice === "open") return openFolder(io, cwd);
  return locateSpace(io, cwd, missing);
}

async function createSpace(io: Streams, cwd: string, firstSpace: boolean): Promise<string | undefined> {
  const answer = await text({
    ...io,
    message: "Where should the new space go?",
    placeholder: "A folder name, or a path such as ~/Documents/Notes",
    validate: (value) => refusal(newSpaceFolder(value ?? "", cwd)),
  });
  if (isCancel(answer)) return cancelled(io);

  // On for a first space, off once there are others, as the desktop's
  // Example projects switch starts.
  const examples = await confirm({
    ...io,
    message: "Add the example projects, Getting started and Translation?",
    initialValue: firstSpace,
  });
  if (isCancel(examples)) return cancelled(io);

  // Checked again: a folder of that name may have appeared while the last
  // question waited, and a new space never moves into one.
  const placed = newSpaceFolder(answer, cwd);
  if ("refused" in placed) return failed(sentence(placed.refused), io);
  try {
    await scaffoldSpace(placed.folder, { examples });
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), io);
  }
  saveGlobalConfig(registerSpace(loadGlobalConfig(), placed.folder));
  outro(`Created ${placed.folder} and added it to your spaces.`, io);
  return placed.folder;
}

async function openFolder(io: Streams, cwd: string): Promise<string | undefined> {
  const answer = await text({
    ...io,
    message: "Which folder should Pragma open as a space?",
    placeholder: cwd,
    defaultValue: cwd,
    validate: (value) => folderProblem(typedPath(value ?? "", cwd)),
  });
  if (isCancel(answer)) return cancelled(io);

  const folder = typedPath(answer, cwd);
  saveGlobalConfig(registerSpace(loadGlobalConfig(), folder));
  outro(`Added ${folder} to your spaces.`, io);
  return folder;
}

// Opening the moved folder as a new space would detach the approvals and API
// tokens keyed to the old entry's id, so a lost space is offered this first.
async function locateSpace(io: Streams, cwd: string, missing: MissingSpace[]): Promise<string | undefined> {
  const space =
    missing.length === 1
      ? missing[0]
      : await select({
          ...io,
          message: "Which space moved?",
          options: missing.map((entry) => ({ value: entry, label: entry.name, hint: entry.folder })),
        });
  if (isCancel(space)) return cancelled(io);

  const answer = await text({
    ...io,
    message: `Where is ${space.name} now?`,
    placeholder: cwd,
    defaultValue: cwd,
    validate: (value) => {
      const folder = typedPath(value ?? "", cwd);
      return folderProblem(folder) ?? refusal(relocateSpace(loadGlobalConfig(), space.id, folder));
    },
  });
  if (isCancel(answer)) return cancelled(io);

  const folder = typedPath(answer, cwd);
  const moved = relocateSpace(loadGlobalConfig(), space.id, folder);
  if ("refused" in moved) return failed(sentence(moved.refused), io);
  saveGlobalConfig(moved.config);
  outro(`${space.name} now points to ${folder}, keeping its approvals and API tokens.`, io);
  return folder;
}

/** The folder a typed answer names, read from `cwd`. `~` is the home folder,
 * and the quotes or backslash escapes a terminal adds to a folder dropped
 * onto it come off. On Windows the backslashes stay: they're its separators. */
export function typedPath(answer: string, cwd: string): string {
  let typed = answer.trim();
  const quoted = /^(["'])(.*)\1$/s.exec(typed);
  if (quoted) typed = quoted[2] ?? "";
  else if (process.platform !== "win32") typed = typed.replace(/\\(.)/g, "$1");
  if (typed === "~" || /^~[\\/]/.test(typed)) typed = path.join(homedir(), typed.slice(1));
  return path.resolve(cwd, typed);
}

// A missing parent is refused, not made: a typo in it would leave a trail of
// new folders behind.
function newSpaceFolder(answer: string, cwd: string): { folder: string } | { refused: string } {
  if (!answer.trim()) return { refused: "Type a name for the new folder, or a path." };
  const target = typedPath(answer, cwd);
  const parent = path.dirname(target);
  if (!isDirectory(parent)) return { refused: `${parent} is not a directory.` };
  return newSpaceFolderIn(parent, path.basename(target));
}

function folderProblem(folder: string): string | undefined {
  return isDirectory(folder) ? undefined : `${folder} is not a directory.`;
}

function refusal(
  result: { refused: string } | { folder: string } | { config: PragmaGlobalConfig },
): string | undefined {
  return "refused" in result ? sentence(result.refused) : undefined;
}

// The shared refusals are written for the desktop, some as phrases.
function sentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function isDirectory(target: string): boolean {
  return existsSync(target) && statSync(target).isDirectory();
}

function cancelled(io: Streams): undefined {
  return failed("Cancelled, so nothing changed.", io);
}

function failed(message: string, io: Streams): undefined {
  cancel(message, io);
  return undefined;
}
