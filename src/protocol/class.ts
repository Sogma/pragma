// A Class's rules, shared by the host that reads its notes and the
// view that shows them, so the two agree on which notes are its rows and how
// a value reads.
import { isNamed } from "./entryName.ts";
import { compareSortValues, orderByProperty, toSortValue } from "./folderSort.ts";
import { basenameOf, formatRootedPath, parseRootedPath, sameRoot } from "./rootedPath.ts";
import { isAgentsFile, isReadme } from "./scopes.ts";
import { isTagOrNested, sameTag, tagNameOf, tagsOf } from "./tags.ts";
import {
  type ClassFile,
  type ClassRule,
  type ClassView,
  FIELD_VALUE_TYPE_OPTIONS,
  type FieldValueType,
  fileKindForPath,
  isFlowFile,
  isMarkdownFile,
  newRowValue,
  normalizeHexColor,
  parseTimestamp,
  splitDocumentName,
  type TableColumn,
} from "./types.ts";

export type RowKind = "note" | "screenplay" | "image" | "video" | "pdf";

/** One row: a file, or a folder read through its `index.md`. */
export interface ClassRow {
  // The file's rooted path, the `index.md` for a folder row: what the row
  // opens, and the folder its values' references are read from.
  path: string;
  // The entry's own name, which name order compares.
  name: string;
  // The display title, by docs/protocol.md's Display titles section.
  title: string;
  // What the file is, which decides how its values are read.
  kind: RowKind;
  // Its size in bytes, and when it last changed as a canonical timestamp:
  // what its `file.` fields read.
  size: number;
  modified: string;
  // The folder its entry sits in, as Folder writes it from the Class's
  // scope: `.` for the scope's folder, `album/lyrics` below it, and from the
  // root, `/…`, outside it.
  folder: string;
  // Its own values: a note's frontmatter, a screenplay's title page keys
  // in lower case. A media file has none.
  properties: Record<string, unknown>;
  // Why its frontmatter doesn't parse, for a note whose block doesn't: its
  // row has no values, and nothing may set one.
  error?: string;
  // The tags a note writes in its text, which a `has` on `tags` counts with
  // its property's, as one list.
  inlineTags?: string[];
}

/** A Class's views, or for one that names none, every row as a list. */
export function classViews(file: Pick<ClassFile, "views">): ClassView[] {
  return file.views.length > 0 ? file.views : [{ name: "", layout: "list", filter: [] }];
}

/** A folder a Class reads its rows from, as a rooted path, and whether the
 * folders below it count too. */
export interface ReadFolder {
  folder: string;
  subfolders: boolean;
}

/** Whether a rule says which folders a Class's rows come from: one on Folder
 * that `is` or is `within` folders. */
export function isFolderRule(rule: ClassRule): boolean {
  return rule.property === "file.folder" && (rule.test === "is" || rule.test === "within");
}

/** A Class's Folder rule: the first of its own filter's that says which
 * folders its rows come from. With none, they come from its whole root. */
export function folderRule(filter: readonly ClassRule[]): ClassRule | undefined {
  return filter.find(isFolderRule);
}

/** The Folder value naming the Class's own folder, wherever the Class sits:
 * it follows a Class that moves, and each copy a template makes reads its
 * own folder. Written `./this.file.folder`, it is a folder's name. */
export const THIS_FOLDER = "this.file.folder";

export function isThisFolder(value: string): boolean {
  return value.trim() === THIS_FOLDER;
}

/** Where a Class sits, as rooted folders: its scope's, which its Folder
 * values are written from, and its own, which `this.file.folder` names. */
export interface ClassPlace {
  scope: string;
  folder: string;
}

const folderSteps = (path: string) => path.split("/").filter((step) => step !== "" && step !== ".");

/** The rooted folder a Folder value names from `scope`, the rooted folder of
 * the Class's scope: `.` that folder, a path below it, and from the root,
 * `/…`. A pattern names the folder before its first `*`, as `pattern` says. */
export function folderNamed(scope: string, value: string): { folder: string; pattern: boolean } {
  const { root, path } = parseRootedPath(scope);
  const written = value.trim();
  const steps = folderSteps(written);
  const star = steps.indexOf("*");
  const fixed = star === -1 ? steps : steps.slice(0, star);
  const base = written.startsWith("/") ? [] : folderSteps(path);
  return { folder: formatRootedPath({ root, path: [...base, ...fixed].join("/") }), pattern: star !== -1 };
}

function valueFolder(place: ClassPlace, value: string): { folder: string; pattern: boolean } {
  return isThisFolder(value) ? { folder: place.folder, pattern: false } : folderNamed(place.scope, value);
}

/** The folders a Class at `place` reads: each its Folder rule names, with
 * the folders below it when the rule is `within` or the value a pattern,
 * else its whole root. A folder named twice is read once, with its
 * subfolders if either names them. */
export function classFolders(place: ClassPlace, filter: readonly ClassRule[]): ReadFolder[] {
  const rule = folderRule(filter);
  const root = formatRootedPath({ root: parseRootedPath(place.scope).root, path: "" });
  if (!rule || rule.values.length === 0) return [{ folder: root, subfolders: true }];
  const folders: ReadFolder[] = [];
  for (const value of rule.values) {
    const { folder, pattern } = valueFolder(place, value);
    const subfolders = rule.test === "within" || pattern;
    const listed = folders.find((each) => sameFolder(each.folder, folder));
    if (listed) listed.subfolders ||= subfolders;
    else folders.push({ folder, subfolders });
  }
  return folders;
}

/** Where a note made from a Class at `place` goes: the first folder its
 * Folder rule names, a pattern's before its first `*`, else its own folder. */
export function noteFolderOf(place: ClassPlace, filter: readonly ClassRule[]): string {
  const [first] = folderRule(filter)?.values ?? [];
  return first === undefined ? place.folder : valueFolder(place, first).folder;
}

// Two rooted folders as one, compared as entry names are.
function sameFolder(a: string, b: string): boolean {
  const one = parseRootedPath(a);
  const other = parseRootedPath(b);
  const steps = folderSteps(one.path);
  const others = folderSteps(other.path);
  return (
    sameRoot(one.root, other.root) &&
    steps.length === others.length &&
    steps.every((name, at) => isNamed(name, others[at]))
  );
}

/** What a Class's link gives its rows, by the path it names from the root:
 * a Flow its buttons in each row's toolkit, a Markdown file in a folder the
 * space lists for templates the start New note copies, and anything else a
 * place in each row's Links tab. */
export type ClassLinkUse = "toolkit" | "template" | "reference";

export function classLinkUse(path: string, isTemplate: (path: string) => boolean): ClassLinkUse {
  if (isFlowFile(path)) return "toolkit";
  return isMarkdownFile(path) && isTemplate(path) ? "template" : "reference";
}

/** Whether a Class reading `source` lists `folder`'s entries: that very
 * folder, or one below it while it reads its subfolders. Names match as
 * entry names do, and a folder in another root is never read. */
export function readsFolder(source: ReadFolder, folder: string): boolean {
  const top = parseRootedPath(source.folder);
  const held = parseRootedPath(folder);
  if (!sameRoot(top.root, held.root)) return false;
  const steps = (path: string) => path.split("/").filter(Boolean);
  const want = steps(top.path);
  const have = steps(held.path);
  if (have.length < want.length || !want.every((name, at) => isNamed(name, have[at]))) return false;
  return have.length === want.length || source.subfolders;
}

/** The fields a view shows, in its order: every field when it lists none.
 * A key naming no field is skipped, so a field deleted from the Class
 * leaves no column behind. */
export function viewFields(fields: readonly TableColumn[], view: Pick<ClassView, "fields">): TableColumn[] {
  if (!view.fields) return [...fields];
  return [...new Set(view.fields)].flatMap((key) => fields.find((field) => field.id === key) ?? []);
}

/** A folder's file as a row: a note, a screenplay or a media file,
 * else undefined. The folder's own `index.md` and `README.md` describe it,
 * and its `AGENTS.md` instructs agents, rather than belong to it; a Table,
 * Flow, Applet or Class is never a row. */
export function rowKindOf(name: string): RowKind | undefined {
  const kind = fileKindForPath(name);
  if (kind === "note") return isNamed(name, "index.md") || isReadme(name) || isAgentsFile(name) ? undefined : "note";
  return kind === "screenplay" || kind === "image" || kind === "video" || kind === "pdf" ? kind : undefined;
}

/** Whether a folder's entry is one of a Class's rows: a file of a row's
 * kind, or a folder holding an `index.md`, read as its note. */
export function isRowEntry(name: string, type: "file" | "directory", hasIndex: boolean): boolean {
  return type === "directory" ? hasIndex : rowKindOf(name) !== undefined;
}

/** The fields a file's own facts fill rather than its values: never set, and
 * typed as here whatever a Class's definition says. Its name as the tree
 * shows it, the folder it's in, its extension, its size in bytes, when it
 * last changed, and every tag it carries. */
export const FILE_FIELDS: readonly TableColumn[] = [
  { id: "file.name", type: "text", label: "Name" },
  { id: "file.folder", type: "text", label: "Folder" },
  { id: "file.ext", type: "text", label: "Extension" },
  { id: "file.size", type: "integer", label: "Size" },
  { id: "file.modified", type: "timestamp", label: "Modified" },
  // Not "Tags", which a chip or menu would show the same as the `tags` key.
  { id: "file.tags", type: "text", label: "All tags" },
];

export function isFileField(key: string): boolean {
  return key.startsWith("file.");
}

/** Whether a key's values are tags, matched in any case and filtered by what
 * they have: a note's `tags`, and `file.tags`. */
export function holdsTags(key: string): boolean {
  return key === "tags" || key === "file.tags";
}

/** A field as a Class reads it: one of a file's facts keeps its own type
 * and options, and only its label is the Class's. */
export function fieldAsRead(field: TableColumn): TableColumn {
  const fact = FILE_FIELDS.find((each) => each.id === field.id);
  return fact ? { ...fact, label: field.label } : field;
}

/** A row's value for `key`: a file field's from the file, a screenplay's
 * title page key in any case, else its own property. A folder's row is
 * named for the folder, though its other facts are its `index.md`'s. */
export function rowValue(row: ClassRow, key: string): unknown {
  switch (key) {
    case "file.name":
      return basenameOf(row.path) === row.name ? splitDocumentName(row.name).stem : row.name;
    case "file.folder":
      return row.folder;
    case "file.ext":
      return splitDocumentName(basenameOf(row.path)).extension.slice(1).toLowerCase();
    case "file.size":
      return row.size;
    case "file.modified":
      return row.modified;
    case "file.tags":
      return fileTags(row);
  }
  if (isFileField(key)) return undefined;
  return row.properties[row.kind === "screenplay" ? key.toLowerCase() : key];
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// What a test compares: a lone value's text, or a list's items'.
function texts(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.filter(isScalar).map((item) => String(item).trim());
}

// Every tag a row carries: the ones a `has` on `tags` counts, each once, as
// first spelled.
function fileTags(row: ClassRow): string[] {
  const tags: string[] = [];
  for (const tag of [...tagsOf(row.properties.tags), ...(row.inlineTags ?? [])]) {
    if (tag !== "" && !tags.some((each) => sameTag(each, tag))) tags.push(tag);
  }
  return tags;
}

function sameValue(property: string, written: string, text: string): boolean {
  if (holdsTags(property)) {
    const wanted = tagNameOf(written);
    return wanted !== undefined && isTagOrNested(text, wanted);
  }
  if (property === "file.ext") return isNamed(written.replace(/^\./, ""), text);
  return written === text;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/** `folder` as Folder writes it from `scope`, the scope's own folder, both
 * rooted folders in one root: `.` for the scope's folder, a path down from it
 * for a folder inside, and from the root, `/…`, for one outside. A scope
 * travels with its folder, so neither moving a Class within it nor moving
 * the whole scope changes what Folder says. */
export function folderInScope(scope: string, folder: string): string {
  const top = parseRootedPath(scope).path.split("/").filter(Boolean);
  const held = parseRootedPath(folder).path.split("/").filter(Boolean);
  const inside = top.length <= held.length && top.every((name, at) => isNamed(name, held[at]));
  if (!inside) return `/${held.join("/")}`;
  return held.length > top.length ? held.slice(top.length).join("/") : ".";
}

/** `folder` as a Folder value written from `scope`: as Folder writes it, but
 * a folder named `this.file.folder` behind `./`, so it isn't read as the
 * Class's own. */
export function folderValueOf(scope: string, folder: string): string {
  const written = folderInScope(scope, folder);
  return isThisFolder(written) ? `./${written}` : written;
}

// A pattern names folders as Folder's value does, `*` standing for any one
// folder name, which no entry name can hold, and a leading `/` for a folder
// outside the scope. Names match in any case. `below` takes the folders
// under a match too, as `within` does.
function folderMatches(pattern: string, folder: string, below: boolean): boolean {
  const wanted = pattern.trim();
  if (wanted.startsWith("/") !== folder.startsWith("/")) return false;
  const want = folderSteps(wanted);
  const held = folderSteps(folder);
  if (below ? held.length < want.length : held.length !== want.length) return false;
  return want.every((step, at) => step === "*" || isNamed(step, held[at]));
}

// A Folder test on a row. With the Class's place known, a value that is no
// pattern compares as the folder it names, so `/music` is `.` in a scope at
// `music`, and an ancestor of the scope holds the scope's rows. A pattern,
// or a value tested with no place, compares as written, and then
// `this.file.folder` names no folder at all.
function folderHolds(value: string, row: ClassRow, below: boolean, place: ClassPlace | undefined): boolean {
  if (place === undefined) return !isThisFolder(value) && folderMatches(value, row.folder, below);
  if (value.includes("*")) return folderMatches(value, row.folder, below);
  const wanted = parseRootedPath(valueFolder(place, value).folder);
  const held = parseRootedPath(folderNamed(place.scope, row.folder).folder);
  return sameRoot(wanted.root, held.root) && folderMatches(`/${wanted.path}`, `/${held.path}`, below);
}

/** Whether a row passes every rule. `has` finds one of the values in a
 * list, or as a lone value; `is` takes a lone value only, and on Folder a
 * pattern; `within`, on Folder alone, takes a folder or any below it;
 * `contains` finds one inside the text or a list's item, in any case. A test
 * this build doesn't know passes, so a later format's rule hides nothing.
 *
 * On `tags` and `file.tags`, a test reads the tags the value names, and a
 * tag matches in any case, as does one nested under it. A `has` on `tags`
 * counts the tags a note writes in its text, which `file.tags` holds already.
 *
 * On `file.ext`, an extension matches in any case, its dot written or not.
 * `place`, where the Class sits, is what Folder values are read from. */
export function matchesRules(row: ClassRow, rules: readonly ClassRule[], place?: ClassPlace): boolean {
  return rules.every((rule) => {
    const value = rowValue(row, rule.property);
    const items = holdsTags(rule.property) ? tagsOf(value) : texts(value);
    const listed = (text: string) => rule.values.some((each) => sameValue(rule.property, each, text));
    switch (rule.test) {
      case "has":
        return [...items, ...(rule.property === "tags" ? (row.inlineTags ?? []) : [])].some(listed);
      case "is":
        if (rule.property === "file.folder") {
          return rule.values.some((each) => folderHolds(each, row, false, place));
        }
        return !Array.isArray(value) && items.some(listed);
      case "within":
        return rule.property !== "file.folder" || rule.values.some((each) => folderHolds(each, row, true, place));
      case "contains": {
        const wanted = rule.values.map((each) => each.toLowerCase());
        return items.some((text) => wanted.some((each) => text.toLowerCase().includes(each)));
      }
      case "empty":
        return isEmpty(holdsTags(rule.property) ? items : value);
      case "not-empty":
        return !isEmpty(holdsTags(rule.property) ? items : value);
      default:
        return true;
    }
  });
}

/** Name order across rows: natural, ignoring case, as folder order's is. */
export function compareRowNames(a: ClassRow, b: ClassRow): number {
  return compareSortValues(a.name, b.name) || a.path.localeCompare(b.path);
}

/** A view's rows: the ones its filter keeps, sorted by its property as
 * folder order sorts one when it names one, else in the order given. */
export function viewRows(rows: readonly ClassRow[], view: ClassView, place?: ClassPlace): ClassRow[] {
  const kept = rows.filter((row) => matchesRules(row, view.filter, place));
  const sort = view.sort;
  if (!sort) return kept;
  return orderByProperty([...kept].sort(compareRowNames), sort, (row) => toSortValue(rowValue(row, sort.property)));
}

export interface RowGroup {
  // The value the group's rows share as text, "" for the rows with none.
  value: string;
  rows: ClassRow[];
}

/** Rows grouped by one property's value, each group keeping the rows'
 * order: a select field's options in their order, then any other values in
 * natural order, then the rows with none. A list groups by all its items. */
export function groupRows(rows: readonly ClassRow[], property: string, field?: TableColumn): RowGroup[] {
  const groups = new Map<string, ClassRow[]>();
  for (const row of rows) {
    const value = rowValue(row, property);
    const key = isEmpty(value) ? "" : texts(value).join(", ");
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const read = fieldAsRead(field ?? { id: property, type: "text", label: property });
  const options = read.type === "select" ? (read.options ?? []) : [];
  const rank = (key: string) => (key === "" ? 2 : options.includes(key) ? 0 : 1);
  return [...groups.keys()]
    .sort(
      (a, b) =>
        rank(a) - rank(b) || (rank(a) === 0 ? options.indexOf(a) - options.indexOf(b) : compareSortValues(a, b)),
    )
    .map((value) => ({ value, rows: groups.get(value) ?? [] }));
}

/** How a field's value reads in a cell. `fits` is false for a value that
 * isn't one of the field's type — a list in a text field, `wip` in a select
 * — which then shows as the text it is and is never rewritten until the
 * field is set. A list's items come as `items`, to show as pills. */
export interface CellValue {
  text: string;
  fits: boolean;
  items?: string[];
}

/** The types a Class's field may take: a Table column's but `path`. A
 * move rewrites the paths a space document holds, and a note's frontmatter
 * is no place it reads one, so a path there would break on the first move. */
export const CLASS_FIELD_TYPE_OPTIONS = FIELD_VALUE_TYPE_OPTIONS.filter(({ value }) => value !== "path");

/** Whether `key` can be a field's: a view lists keys comma-separated, and
 * `file.` names a file's own facts, never a property. */
export function canBeFieldKey(key: string): boolean {
  return key !== "" && !key.includes(",") && !key.startsWith("file.");
}

/** A new field's label: its key, capitalized. */
export function fieldLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The fields a Class made in a folder starts with: every key its notes
 * use, the most used first, each typed by all the values it holds.
 * A screenplay's title page names the screenplay rather than giving it
 * values, and a note whose frontmatter doesn't parse holds none. */
export function suggestedFields(rows: readonly ClassRow[]): TableColumn[] {
  const found = new Map<string, unknown[]>();
  for (const row of rows) {
    if (row.kind !== "note") continue;
    for (const [key, value] of Object.entries(row.properties)) {
      if (!canBeFieldKey(key)) continue;
      const values = found.get(key);
      if (values) values.push(value);
      else found.set(key, [value]);
    }
  }
  return [...found]
    .sort(([a, held], [b, other]) => other.length - held.length || compareSortValues(a, b))
    .map(([key, values]) => ({ id: key, type: suggestedType(values), label: fieldLabel(key) }));
}

// Booleans make a checkbox, whole numbers an integer and instants a
// timestamp; anything else, a mix included, is text. A day with no time
// isn't an instant, so it stays text rather than shift by a time zone.
function suggestedType(values: readonly unknown[]): FieldValueType {
  const set = values.filter((value) => !isEmpty(value));
  if (set.length === 0) return "text";
  if (set.every((value) => typeof value === "boolean")) return "checkbox";
  if (set.every((value) => typeof value === "number" && Number.isInteger(value))) return "integer";
  if (set.every((value) => typeof value === "string" && parseTimestamp(value) !== undefined)) return "timestamp";
  return "text";
}

export function cellValue(field: TableColumn, value: unknown): CellValue {
  if (value === undefined || value === null) return { text: "", fits: true };
  if (Array.isArray(value)) {
    const items = value.map((item) => (isScalar(item) ? String(item) : JSON.stringify(item)));
    return { text: items.join(", "), fits: false, items };
  }
  if (!isScalar(value)) return { text: JSON.stringify(value), fits: false };
  const text = String(value);
  switch (field.type) {
    case "checkbox":
      return { text, fits: typeof value === "boolean" };
    case "integer":
      return { text, fits: typeof value === "number" && Number.isInteger(value) };
    case "select":
      return { text, fits: (field.options ?? []).includes(text) };
    case "color":
      return { text, fits: typeof value === "string" && normalizeHexColor(value) !== "" };
    case "timestamp":
      return { text, fits: typeof value === "string" && parseTimestamp(value) !== undefined };
    case "media":
    case "path":
      return { text, fits: typeof value === "string" };
    default:
      return { text, fits: true };
  }
}

/** A field's value as a note's frontmatter stores it, from the text its
 * editor gives: a checkbox's a boolean, an integer's a number, a color in
 * its canonical form, anything else the string. Blank text is undefined,
 * which clears the key. */
export function frontmatterValue(field: TableColumn, text: string): unknown {
  const trimmed = text.trim();
  if (field.type === "checkbox") return trimmed === "true";
  if (trimmed === "") return undefined;
  if (field.type === "integer") return /^[-+]?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
  if (field.type === "color") return normalizeHexColor(trimmed) || trimmed;
  return trimmed;
}

/** What a new note holds so it lands in the view it was added from, over
 * `held`, a template's frontmatter: each field's starting value where it
 * isn't blank and `held` has none; a `has` rule's first value (on `file.tags`,
 * in its `tags`) and an `is` rule's only one, from the Class's filter and the
 * view's; then its group, `""` being none. No file's own fact is written. */
export function newNoteProperties(
  file: Pick<ClassFile, "fields" | "filter">,
  view: Pick<ClassView, "filter" | "groupBy">,
  group: string | undefined,
  now: Date,
  held: Record<string, unknown> = {},
): Record<string, unknown> {
  const typed = (property: string, text: string) => {
    const field = file.fields.find((each) => each.id === property);
    return field ? frontmatterValue(field, text) : text;
  };
  const properties: Record<string, unknown> = { ...held };
  for (const field of file.fields) {
    if (isFileField(field.id) || properties[field.id] !== undefined) continue;
    const value = frontmatterValue(field, newRowValue(field, now));
    if (value !== undefined) properties[field.id] = value;
  }
  for (const rule of [...file.filter, ...view.filter]) {
    const [first] = rule.values;
    const property = rule.property === "file.tags" && rule.test === "has" ? "tags" : rule.property;
    if (isFileField(property)) continue;
    if (rule.test === "has" && first !== undefined) {
      const held = properties[property];
      const list = Array.isArray(held) ? held : held === undefined ? [] : [held];
      // A note carrying the tag already, or one nested under it, lands in
      // the view as it is.
      const added = holdsTags(property) ? tagNameOf(first) : first;
      if (added === undefined) continue;
      const carried = holdsTags(property)
        ? tagsOf(list).some((tag) => isTagOrNested(tag, added))
        : list.map(String).includes(added);
      properties[property] = carried ? list : [...list, added];
    } else if (rule.test === "is" && rule.values.length === 1) {
      properties[rule.property] = typed(rule.property, first);
    }
  }
  if (view.groupBy && group !== undefined && !isFileField(view.groupBy)) {
    const value = group === "" ? undefined : typed(view.groupBy, group);
    if (value === undefined) delete properties[view.groupBy];
    else properties[view.groupBy] = value;
  }
  return properties;
}
