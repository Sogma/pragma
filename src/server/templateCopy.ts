// A new file or folder made from one of the space's templates: the host's
// half of the rules src/protocol/templates.ts states.

import { readdirSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";
import type { CreateEntryResponse, CreateFromTemplateRequestBody } from "../protocol/api.ts";
import { type ClockReading, clockDay, parseClock, readClock } from "../protocol/datePlaceholders.ts";
import { isHiddenName, isNamed, spellingIn } from "../protocol/entryName.ts";
import { withoutBom, withoutPublishState } from "../protocol/frontmatter.ts";
import { QUEUE_FILENAME, SITE_FILENAME } from "../protocol/pragmaFiles.ts";
import { parseRootedPath } from "../protocol/rootedPath.ts";
import {
  fillsTitle,
  fillTemplate,
  findTemplate,
  isTemplatePath,
  readTemplates,
  startingName,
  TEMPLATES_FOLDER,
  type TemplateEntry,
  templateEntryName,
  writesDate,
  writesTitle,
} from "../protocol/templates.ts";
import { isMarkdownFile } from "../protocol/types.ts";
import { formatWithinRoot, isSpaceTarget, resolveRootedPath } from "./rootedFiles.ts";
import type { Incoming } from "./routes/shared.ts";
import { resolveSiteForPath } from "./sites.ts";
import { findNameCollision } from "./spaceFiles.ts";
import { buildTree, spaceListing } from "./tree.ts";

export type TemplateCopyResult = { created: CreateEntryResponse } | Refusal;

interface CopiedFile {
  // Within the copy, `/`-separated; empty for a file template, which is the
  // copy itself.
  relative: string;
  bytes: Buffer;
}

interface CopiedTree {
  folders: string[];
  files: CopiedFile[];
}

const TAKEN: TemplateCopyResult = { status: 409, message: "Already exists" };

// Pragma's own templates, beside the space scaffold rather than under src/,
// so a packaged build has them only through their own entry in
// electron-builder.yml and scripts/pack-npm.mjs.
const PRAGMA_TEMPLATES = path.join(PACKAGE_ROOT, "templates/builtin");

/** The space's templates, read from `_templates/` as the tree lists it: a
 * folder listed under that name in any case, never a link. */
export async function listSpaceTemplates(spaceRoot: string): Promise<TemplateEntry[]> {
  const folders = readdirSync(spaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const listed = spellingIn(
    folders.map((entry) => entry.name),
    TEMPLATES_FOLDER,
  );
  return listed ? readTemplates(await buildTree(path.join(spaceRoot, listed), spaceRoot, "space", spaceListing())) : [];
}

/** Pragma's own templates, read by the same rule, each path relative to
 * where Pragma keeps them. */
export async function listPragmaTemplates(): Promise<TemplateEntry[]> {
  if (!statSync(PRAGMA_TEMPLATES, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readTemplates(await buildTree(PRAGMA_TEMPLATES, PRAGMA_TEMPLATES));
}

type Refusal = { status: 400 | 404 | 409; message: string };

interface OpenedTemplate {
  template: Extract<TemplateEntry, { kind: "file" | "folder" }>;
  copied: CopiedTree;
  // What its Markdown and Fountain files write anywhere in them.
  writes: { title: boolean; date: boolean };
  now: ClockReading;
}

// The template a request names, the space's or with `source` "pragma" one of
// Pragma's own, read whole, and the moment its date placeholders take: the
// writer's, sent with the request because the host may keep another time
// zone, else the host's own.
async function openTemplate(
  spaceRoot: string,
  request: { template?: unknown; source?: unknown; now?: unknown },
): Promise<OpenedTemplate | Refusal> {
  if (request.source !== undefined && request.source !== "space" && request.source !== "pragma") {
    return { status: 400, message: 'source must be "space" or "pragma"' };
  }
  const sent = typeof request.now === "string" ? parseClock(request.now) : undefined;
  if (request.now !== undefined && !sent) {
    return { status: 400, message: "now must be a local time with its offset, as 2026-11-09T14:30:05+01:00" };
  }
  const pragma = request.source === "pragma";
  const templatePath = typeof request.template === "string" ? spacePathOf(request.template) : undefined;
  if (templatePath === undefined || (!pragma && !isTemplatePath(templatePath))) {
    return { status: 400, message: "Not a template" };
  }
  const listing = pragma ? await listPragmaTemplates() : await listSpaceTemplates(spaceRoot);
  const template = findTemplate(listing, templatePath);
  if (!template) return { status: 404, message: `No template at ${templatePath}` };

  const source = path.join(pragma ? PRAGMA_TEMPLATES : spaceRoot, ...template.path.split("/"));
  const copied: CopiedTree =
    template.kind === "file"
      ? { folders: [], files: [{ relative: "", bytes: await readFile(source) }] }
      : await readFolder(source);
  const texts = copied.files.flatMap((file) => {
    const name = nameIn(template, file);
    return fillsTitle(name) ? [{ name, text: file.bytes.toString("utf8") }] : [];
  });
  const writes = {
    title: texts.some(({ name, text }) => writesTitle(name, text)),
    date: texts.some(({ name, text }) => writesDate(name, text)),
  };
  return { template, copied, writes, now: sent ?? readClock(new Date()) };
}

function nameIn(template: OpenedTemplate["template"], file: CopiedFile): string {
  return file.relative ? path.posix.basename(file.relative) : template.name;
}

/** The name a copy of the template `request` names starts with, before its
 * writer types one. */
export async function templateStartingName(
  spaceRoot: string,
  request: { template?: unknown; source?: unknown; now?: unknown },
): Promise<{ name: string } | Refusal> {
  const opened = await openTemplate(spaceRoot, request);
  return "status" in opened ? opened : { name: startingName(opened.writes, clockDay(opened.now)) };
}

/** Copies the template `body.template` names into `body.parentPath` under the
 * name typed for it, filling in its placeholders. A refusal comes back as a
 * status and its message; a path the resolver refuses throws. */
export async function copyTemplate(
  spaceRoot: string,
  body: Incoming<CreateFromTemplateRequestBody>,
): Promise<TemplateCopyResult> {
  const opened = await openTemplate(spaceRoot, body);
  if ("status" in opened) return opened;
  const { template, copied, writes, now } = opened;

  const parent = resolveRootedPath(spaceRoot, typeof body.parentPath === "string" ? body.parentPath : "", "write");
  if (!isSpaceTarget(parent)) return { status: 400, message: "A template can't be used in a library" };
  const parentPath = formatWithinRoot(parent, parent.filePath);
  // A copy made here would fill in its own placeholders and stop being one.
  if (isTemplatePath(parentPath)) return { status: 400, message: "A template can't be used inside _templates" };
  if (!statSync(parent.filePath, { throwIfNoEntry: false })?.isDirectory()) {
    return { status: 404, message: `No folder at ${parentPath || "the space root"}` };
  }

  const named = templateEntryName(
    typeof body.name === "string" ? body.name : "",
    { name: template.name, type: template.kind === "file" ? "file" : "directory" },
    writes.title,
  );
  if ("refused" in named) return { status: 400, message: named.refused };
  if (findNameCollision(parent.filePath, named.name)) return TAKEN;

  const target = path.join(parent.filePath, named.name);
  const targetPath = formatWithinRoot(parent, target);
  // Judged where the copy lands: a site there would publish a kept `id` as
  // an update to the page it came from.
  const inSite = resolveSiteForPath(spaceRoot, template.kind === "file" ? targetPath : `${targetPath}/x`) !== undefined;
  const contentOf = (file: CopiedFile): Buffer | string => {
    const name = nameIn(template, file);
    if (!fillsTitle(name)) return file.bytes;
    const text = fillTemplate(name, file.bytes.toString("utf8"), { title: named.title, date: now });
    if (!isMarkdownFile(name)) return text;
    const note = withoutBom(text);
    return inSite ? (withoutPublishState(note) ?? note) : note;
  };

  if (template.kind === "file") {
    await writeFile(target, contentOf(copied.files[0]), { flag: "wx" });
    return { created: { path: targetPath, type: "file" } };
  }
  if (!(await writeFolder(parent.filePath, named.name, copied, contentOf))) return TAKEN;
  return { created: { path: targetPath, type: "directory" } };
}

function spacePathOf(input: string): string | undefined {
  try {
    const rooted = parseRootedPath(input);
    return rooted.root === "space" ? rooted.path : undefined;
  } catch {
    return undefined;
  }
}

// Read and written file by file, never copied whole, so a template packed
// inside the desktop app's archive copies too: its files read, but a
// filesystem copy can't open them.
//
// No dot entry or link, as no listing has one, and no site binding or queue:
// a copy carrying `_site.json` would publish a second folder to one site.
async function readFolder(dir: string, relative = ""): Promise<CopiedTree> {
  const tree: CopiedTree = { folders: [], files: [] };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (isHiddenName(entry.name) || entry.isSymbolicLink()) continue;
    if (isNamed(entry.name, SITE_FILENAME) || isNamed(entry.name, QUEUE_FILENAME)) continue;
    const inner = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const below = await readFolder(path.join(dir, entry.name), inner);
      tree.folders.push(inner, ...below.folders);
      tree.files.push(...below.files);
    } else if (entry.isFile()) {
      tree.files.push({ relative: inner, bytes: await readFile(path.join(dir, entry.name)) });
    }
  }
  return tree;
}

// Built under a dot name beside the target, which no listing shows, then
// renamed into place whole, so a copy cut off partway leaves nothing a tree
// would draw. False when the name was taken meanwhile.
async function writeFolder(
  parentDir: string,
  name: string,
  copied: CopiedTree,
  contentOf: (file: CopiedFile) => Buffer | string,
): Promise<boolean> {
  const staging = path.join(parentDir, `.${name}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    await mkdir(staging);
    for (const folder of copied.folders) await mkdir(path.join(staging, ...folder.split("/")), { recursive: true });
    for (const file of copied.files) await writeFile(path.join(staging, ...file.relative.split("/")), contentOf(file));
    if (findNameCollision(parentDir, name)) return false;
    await rename(staging, path.join(parentDir, name));
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
