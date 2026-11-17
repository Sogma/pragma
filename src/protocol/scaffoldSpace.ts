import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";
import { isNamed } from "./entryName.ts";
import { serializeTagsFile } from "./tags.ts";

// The template space is content, not source, so it sits at the repo root,
// outside src/: electron-builder.yml and scripts/pack-npm.mjs each list it
// on its own. Drop either entry and that build scaffolds an empty space
// while dev and the unit suite stay green.
const TEMPLATE_DIR = path.join(PACKAGE_ROOT, "templates/space");

// The worked examples are the folders in the template's projects/. A space
// made without them keeps the rest, minus what only they used: the README's
// lines linking into them, and the starter tags their Classes gather by.
const EXAMPLES_DIR = "projects";
const LINKS_INTO_EXAMPLES = /\]\((?:\.\/)?projects\//;

// fs.cp/copyFile need a real file descriptor on the source side, which
// doesn't exist for files packed inside an Electron app.asar archive — so
// the template space is copied by hand via readFile/readdir, which Electron
// does patch to read transparently out of asar.
async function copyDir(src: string, dest: string, skip: (src: string) => boolean): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (skip(srcPath)) continue;
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, skip);
    } else {
      await writeFile(destPath, await readFile(srcPath));
    }
  }
}

export interface ScaffoldOptions {
  /** The worked examples in projects/. On unless turned off. */
  examples?: boolean;
}

/** Scaffolds a brand-new space at `target` from `templates/space/`. The one
 * implementation behind `pragma init`, the Manage Spaces modal, and
 * Electron's create-space flow, so none can drift on what a new space looks
 * like. Throws if `target` already has a `README.md`, its name in any case. */
export async function scaffoldSpace(target: string, { examples = true }: ScaffoldOptions = {}): Promise<void> {
  const readme = (existsSync(target) ? readdirSync(target) : []).find((name) => isNamed(name, "README.md"));
  if (readme !== undefined) {
    throw new Error(`${path.join(target, readme)} already exists. Nothing to do.`);
  }

  const examplesDir = path.join(TEMPLATE_DIR, EXAMPLES_DIR);
  await copyDir(TEMPLATE_DIR, target, (src) => !examples && path.dirname(src) === examplesDir);
  await mkdir(path.join(target, EXAMPLES_DIR), { recursive: true });
  if (examples) return;

  const readmePath = path.join(target, "README.md");
  const lines = (await readFile(readmePath, "utf8")).split("\n");
  await writeFile(readmePath, lines.filter((line) => !LINKS_INTO_EXAMPLES.test(line)).join("\n"));
  const tagsPath = path.join(target, "_tags.json");
  const tags = JSON.parse(await readFile(tagsPath, "utf8")) as Record<string, unknown>;
  await writeFile(tagsPath, serializeTagsFile({ ...tags, tags: [] }));
}
