// The space's templates: what the root's `_templates/` holds, and how a copy
// of one is named and filled in. The host makes the copy and the browser
// lists the templates for New, so both read them by these rules.
import {
  type ClockReading,
  dateFill,
  fillPlaceholders,
  PLACEHOLDER_SOURCE,
  type PlaceholderFill,
} from "./datePlaceholders.ts";
import { entryNameForTitle, illegalEntryNameReason, isNamed, spellingIn } from "./entryName.ts";
import {
  composeFrontmatter,
  editFrontmatterYaml,
  parseFrontmatterYaml,
  sameFrontmatter,
  splitFrontmatter,
} from "./frontmatter.ts";
import type { PragmaFileRole } from "./pragmaFiles.ts";
import { parseRootedPath } from "./rootedPath.ts";
import { isReadme } from "./scopes.ts";
import { isFountainFile, isMarkdownFile, splitDocumentName } from "./types.ts";

export const TEMPLATES_FOLDER = "_templates";

/** Whether `path` is the space's templates folder or anything in it, its
 * name in any case. A library's own `_templates/` is an ordinary folder. */
export function isTemplatePath(path: string): boolean {
  try {
    const rooted = parseRootedPath(path);
    return rooted.root === "space" && isNamed(rooted.path.split("/")[0], TEMPLATES_FOLDER);
  } catch {
    return false;
  }
}

/** A listed entry under `_templates/`, as the space's tree lists it. */
export interface TemplateSource {
  name: string;
  path: string;
  type: "file" | "directory";
  pragmaFile?: PragmaFileRole;
  children?: readonly TemplateSource[];
}

export type TemplateEntry =
  | { kind: "file" | "folder"; name: string; path: string }
  | { kind: "group"; name: string; path: string; entries: TemplateEntry[] };

/** What the entries of `_templates/` hold: a file is a file template, a
 * folder with a README a folder template, and a folder without one a group
 * of either, read the same way. A group holding no template is left out.
 *
 * The first README on the way down ends the walk, so a folder template's
 * README-less subfolders are part of it, never groups of their own. The
 * root's own README describes the folder and is no template, nor is a file
 * Pragma reads where it sits, such as a folder's manual order. */
export function readTemplates(listing: readonly TemplateSource[]): TemplateEntry[] {
  return readLevel(listing, true);
}

function readLevel(nodes: readonly TemplateSource[], atRoot: boolean): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      if (node.pragmaFile === undefined && (!atRoot || !isReadme(node.name))) {
        entries.push({ kind: "file", name: node.name, path: node.path });
      }
      continue;
    }
    const children = node.children ?? [];
    if (children.some((child) => child.type === "file" && isReadme(child.name))) {
      entries.push({ kind: "folder", name: node.name, path: node.path });
      continue;
    }
    const inner = readLevel(children, false);
    if (inner.length > 0) entries.push({ kind: "group", name: node.name, path: node.path, entries: inner });
  }
  return entries;
}

type Template = Extract<TemplateEntry, { kind: "file" | "folder" }>;

/** The file or folder template at `path`, named in any case as every path
 * is; never a group. */
export function findTemplate(entries: readonly TemplateEntry[], path: string): Template | undefined {
  const templates = templatesIn(entries);
  const spelled = spellingIn(
    templates.map((entry) => entry.path),
    path,
  );
  return templates.find((entry) => entry.path === spelled);
}

function templatesIn(entries: readonly TemplateEntry[]): Template[] {
  return entries.flatMap((entry) => (entry.kind === "group" ? templatesIn(entry.entries) : [entry]));
}

/** How many file and folder templates `entries` holds, groups' included. */
export function countTemplates(entries: readonly TemplateEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.kind === "group" ? countTemplates(entry.entries) : 1), 0);
}

/** What a copy's placeholders take: `title` the title typed for it, `date`
 * the moment it is made, the writer's. A placeholder with no value stays as
 * written. */
export interface TemplateValues {
  title?: string;
  date?: ClockReading;
}

// `{{$title}}` in any case, beside the date placeholders, all in the one
// pass, so a title holding `{{$date}}` keeps it.
function templateFill(values: TemplateValues): PlaceholderFill {
  const dates = values.date ? dateFill(values.date) : undefined;
  return (name, format) => {
    if (format === undefined && values.title !== undefined && name.toLowerCase() === "$title") return values.title;
    return dates?.(name, format);
  };
}

function replacePlaceholders(text: string, values: TemplateValues): string {
  return fillPlaceholders(text, templateFill(values));
}

/** Whether a file of this name has its placeholders filled in: Markdown and
 * Fountain, which need no escaping. Every other kind is copied as written. */
export function fillsTitle(fileName: string): boolean {
  return isMarkdownFile(fileName) || isFountainFile(fileName);
}

/** `content` with its placeholders set to `values`: a Fountain file
 * throughout, its title page included; a Markdown file's body, and its
 * frontmatter's values, written back as YAML needs them. */
export function fillTemplate(fileName: string, content: string, values: TemplateValues): string {
  if (!fillsTitle(fileName)) return content;
  if (!isMarkdownFile(fileName)) return replacePlaceholders(content, values);
  const split = splitFrontmatter(content);
  if (split === undefined) return replacePlaceholders(content, values);
  const body = replacePlaceholders(split.body, values);
  const yaml = fillFrontmatter(split.yaml, values);
  return yaml === undefined
    ? content.slice(0, content.length - split.body.length) + body
    : composeFrontmatter(yaml, body, split.gap);
}

/** Whether filling in `{{$title}}` would change `content`: the template has
 * somewhere to keep a title verbatim. */
export function writesTitle(fileName: string, content: string): boolean {
  return fillTemplate(fileName, content, { title: "" }) !== content;
}

// Any moment shows whether a template writes one: a filled placeholder never
// reads as its own text.
const PROBE: ClockReading = { year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 0 };

/** Whether filling in the date placeholders would change `content`. */
export function writesDate(fileName: string, content: string): boolean {
  return fillTemplate(fileName, content, { date: PROBE }) !== content;
}

/** The name a copy starts with, before its writer types one: the day, for a
 * template that writes a date and no `{{$title}}`, which has no title to ask
 * for. Otherwise none. */
export function startingName(writes: { title: boolean; date: boolean }, day: string): string {
  return writes.date && !writes.title ? day : "";
}

// Never as raw text: a colon in a title would break the block. Each value
// holding a placeholder is filled and written back by the frontmatter
// writer, which quotes what its value needs. Undefined leaves the block as
// written: nothing to fill, or YAML that doesn't parse.
//
// YAML reads a bare `{{$title}}` value as a nested map, so one alone on its
// line, after a key or a list's dash, is quoted before the block is read:
// only one that fills, so an untouched placeholder keeps its spelling. JSON's
// quoting, which YAML reads, since a format may hold a quote or a backslash.
const BARE_PLACEHOLDER = new RegExp(
  String.raw`^([ \t]*(?:-[ \t]+)?(?:\w[\w .-]*:[ \t]+)?(?:-[ \t]+)?)(${PLACEHOLDER_SOURCE})([ \t]*(?:#.*)?)$`,
  "gm",
);

function fillFrontmatter(yaml: string, values: TemplateValues): string | undefined {
  const fill = templateFill(values);
  const quoted = yaml.replace(
    BARE_PLACEHOLDER,
    (whole, lead: string, placeholder: string, name: string, format: string | undefined, rest: string) =>
      fill(name, format) === undefined ? whole : `${lead}${JSON.stringify(placeholder)}${rest}`,
  );
  try {
    const held = parseFrontmatterYaml(quoted);
    const filled = fillValue(held, fill) as Record<string, unknown>;
    return sameFrontmatter(held, filled) ? undefined : editFrontmatterYaml(quoted, filled);
  } catch {
    return undefined;
  }
}

function fillValue(value: unknown, fill: PlaceholderFill): unknown {
  if (typeof value === "string") return fillPlaceholders(value, fill);
  if (Array.isArray(value)) return value.map((item) => fillValue(item, fill));
  if (value instanceof Date || typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillValue(item, fill)]));
}

export type TemplateName = { name: string; title: string } | { refused: string };

/** The entry a copy of `template` is written as, and the title its
 * `{{$title}}` takes, from the text typed for it. A file keeps the template's
 * whole extension, not added twice when typed. A name no file can carry is a
 * title only where the template keeps one verbatim; with nowhere to keep
 * it, it is refused, as any typed name is. */
export function templateEntryName(
  typed: string,
  template: { name: string; type: "file" | "directory" },
  keepsTitle: boolean,
): TemplateName {
  const extension = template.type === "file" ? splitDocumentName(template.name).extension : "";
  let title = typed.trim();
  if (extension && title.length > extension.length && title.toLowerCase().endsWith(extension.toLowerCase())) {
    title = title.slice(0, -extension.length).trimEnd();
  }
  if (!title || title === "." || title === ".." || /[/\\]/.test(title)) return { refused: "Invalid name" };
  const illegal = illegalEntryNameReason(title);
  if (!illegal) return { name: `${title}${extension}`, title };
  const derived = keepsTitle ? entryNameForTitle(title) : "";
  return derived ? { name: `${derived}${extension}`, title } : { refused: illegal };
}
