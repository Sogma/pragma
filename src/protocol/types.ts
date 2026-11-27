// Only an editor-syntax signal — which CodeMirror mode, fountain or
// markdown — derived from the file extension (docs/protocol.md's "Text
// documents" section). Which buttons a document gets is a separate question,
// answered from the Classes holding it by src/server/resolveToolkits.ts,
// never by this.
import type { EffortLevel } from "./api.ts";
import { basenameOf } from "./rootedPath.ts";

export type DocumentType = "note" | "screenplay";

/** Whether a name is one of the document types, as a document kind's name in
 * a scope's settings is. */
export function isDocumentType(name: string): name is DocumentType {
  return name === "note" || name === "screenplay";
}

/** What an options call returns: the parsed candidates, the model that ran
 * and what went as context. One shared shape for both the text-document and
 * applet dispatch paths, since both funnel through the same options call. */
export interface ActionResult {
  options: string[];
  // The model that actually ran, after the button/field's own `model` and
  // the default are resolved — never the possibly-empty configured value.
  model: string;
  // The level it reasoned at, absent for the model's own default.
  effort?: EffortLevel;
  context?: ContextSent;
}

/** One file a generation's `context` pin sends with its call, by its path
 * from the root (`/…`), as much of it as went: the whole, or the section
 * under the heading `section`. */
export interface ContextFile {
  path: string;
  section?: string;
  content: string;
}

/** A sentence about what a context sent, in the order it happened, at the
 * Console's levels: `info` for a file cut, `warn` for what the model couldn't
 * have, such as a file left out, looking stopped short, no tools to look with. */
export interface ContextMessage {
  level: "info" | "warn";
  text: string;
}

/** What a generation's `context` pin sent, for the person who started the
 * run: the path it was wired, each file sent from the root in the order they
 * went, what the model searched for, and the messages about it. */
export interface ContextSent {
  path: string;
  files: string[];
  searches: string[];
  messages: ContextMessage[];
}

/** What the host's generation call returns, deliberately not an
 * ActionResult: a plain generation is closer to a deterministic tool call,
 * the one right output from these inputs, so it returns a single `reply`.
 * Candidates to browse, for a taste call such as rewriting a line, are
 * Generate Options' list. */
export interface GenerateResult {
  reply: string;
  model: string;
  effort?: EffortLevel;
  context?: ContextSent;
}

/** A single ranked result from Find in context.
 * `path` is always one of the markdown files actually scanned in the target
 * directory; the dispatch side drops any candidate whose path doesn't match,
 * since a hallucinated path here has nothing to open. */
export interface FindContextCandidate {
  path: string;
  score: number;
  reasoning: string[];
}

/** What Find in context's dispatch returns, with the prompt it sent and the
 * model that ran, for the console panel. */
export interface FindContextResult {
  candidates: FindContextCandidate[];
  prompt: string;
  model: string;
}

/** One key of a `<dl data-role="metadata">` block with its values, one per
 * `<dd>` (docs/protocol.md's Metadata section). A Table, Flow or
 * Class holds its block as a list of these, in file order. */
export interface MetadataEntry {
  key: string;
  values: string[];
  // The type its `<dt>` gives it, with that type's settings, as a column's
  // header gives a column one. Absent, the key is text.
  field?: FieldDefinition;
}

/** The typed-value vocabulary shared by a Table's columns and a Class's fields —
 * deliberately small, each "one typed value with a label," with no `image`
 * or generate type: those are generation concepts with no analogue in a data
 * field. Values round-trip as plain text; `color` and `timestamp` are read
 * leniently and written in one canonical form, by the helpers below. */
export const FIELD_VALUE_TYPES = [
  "checkbox",
  "color",
  "integer",
  "media",
  "path",
  "score",
  "select",
  "text",
  "timestamp",
] as const;
export type FieldValueType = (typeof FIELD_VALUE_TYPES)[number];

/** Reads a `data-type` attribute (a Table's or a Class's `<th>`) into the
 * vocabulary. Anything unrecognized or absent is "text", so a file from a
 * later format version degrades to plain text fields rather than failing to
 * load. One function for both readers, so they can't drift apart on what the
 * vocabulary is. */
export function parseFieldValueType(raw: string | null | undefined): FieldValueType {
  const known: readonly string[] = FIELD_VALUE_TYPES;
  return raw && known.includes(raw) ? (raw as FieldValueType) : "text";
}

/** A column's or field's type and the settings only some types have:
 * everything its values' rules read. */
export type FieldDefinition = Omit<TableColumn, "id" | "label">;

/** The settings one type owns, which a change of type drops. */
const FIELD_SETTINGS = ["options", "mediaFolder", "showName", "default", "max", "reject"] as const;
type FieldSetting = (typeof FIELD_SETTINGS)[number];

/** A score field's scale where it names none, and the most it may name. */
export const SCORE_MAX = 5;
export const SCORE_MAX_LIMIT = 10;

/** The top of a score field's scale. */
export function scoreMax(field: FieldDefinition): number {
  return field.max ?? SCORE_MAX;
}

/** Whether `max` can top a score field's scale. */
export function isScoreMax(max: number): boolean {
  return Number.isInteger(max) && max >= 1 && max <= SCORE_MAX_LIMIT;
}

/** A score value: its number of marks, 0 for none (blank or `0`), or -1 for
 * rejected where the field allows it. Undefined for anything else, which a
 * host shows as written and keeps. */
export function scoreOf(text: string, field: FieldDefinition): number | undefined {
  const written = text.trim();
  if (written === "") return 0;
  if (!/^-?\d+$/.test(written)) return undefined;
  const score = Number(written);
  if (score === -1) return field.reject ? -1 : undefined;
  return score >= 0 && score <= scoreMax(field) ? score : undefined;
}

/** What a field type means wherever a column or field has it. */
interface FieldTypeRules {
  // Its name in the type pickers.
  label: string;
  // The port a field of the type takes in a Flow. A media or path field's
  // text is a path as a Flow names one, such as Generate Image's `path`.
  port: FlowPortType;
  // Whether its value is a path the document holds, read from the
  // document's folder and rewritten by a move.
  path: boolean;
  settings: readonly FieldSetting[];
  // Its value before anything is put in it.
  empty(field: FieldDefinition): string;
  // Whether a lone frontmatter value is one of the type's.
  fits(value: string | number | boolean, field: FieldDefinition): boolean;
  // Its value as frontmatter stores it, from its editor's trimmed text;
  // undefined clears the key.
  stored(text: string, field: FieldDefinition): unknown;
}

const isText = (value: unknown): boolean => typeof value === "string";
const textOrNone = (text: string): string | undefined => (text === "" ? undefined : text);

/** Every type's rules, keyed by the vocabulary, so a type added to it
 * without them fails to compile. */
export const FIELD_TYPES: { readonly [Type in FieldValueType]: FieldTypeRules } = {
  checkbox: {
    label: "Checkbox",
    port: "boolean",
    path: false,
    settings: [],
    empty: () => "false",
    fits: (value) => typeof value === "boolean",
    // Always true or false, never cleared.
    stored: (text) => text === "true",
  },
  color: {
    label: "Color",
    port: "text",
    path: false,
    settings: [],
    empty: () => "",
    fits: (value) => typeof value === "string" && normalizeHexColor(value) !== "",
    stored: (text) => (text === "" ? undefined : normalizeHexColor(text) || text),
  },
  integer: {
    label: "Integer",
    port: "number",
    path: false,
    settings: [],
    empty: () => "",
    fits: (value) => typeof value === "number" && Number.isInteger(value),
    stored: (text) => (/^[-+]?\d+$/.test(text) ? Number(text) : textOrNone(text)),
  },
  media: {
    label: "Media",
    port: "text",
    path: true,
    settings: ["mediaFolder", "showName"],
    empty: () => "",
    fits: isText,
    stored: textOrNone,
  },
  path: { label: "Path", port: "text", path: true, settings: [], empty: () => "", fits: isText, stored: textOrNone },
  score: {
    label: "Score",
    port: "number",
    path: false,
    settings: ["max", "reject"],
    empty: () => "",
    fits: (value, field) => typeof value === "number" && scoreOf(String(value), field) !== undefined,
    stored: (text) => (/^-?\d+$/.test(text) ? Number(text) : textOrNone(text)),
  },
  select: {
    label: "Select",
    port: "text",
    path: false,
    settings: ["options"],
    empty: (field) => field.options?.[0] ?? "",
    fits: (value, field) => (field.options ?? []).includes(String(value)),
    stored: textOrNone,
  },
  text: {
    label: "Text",
    port: "text",
    path: false,
    settings: [],
    empty: () => "",
    fits: () => true,
    stored: textOrNone,
  },
  timestamp: {
    label: "Timestamp",
    port: "text",
    path: false,
    settings: ["default"],
    empty: () => "",
    fits: (value) => typeof value === "string" && parseTimestamp(value) !== undefined,
    stored: textOrNone,
  },
};

/** The port a field takes in a Flow. */
export function fieldPortType(type: FieldValueType): FlowPortType {
  return FIELD_TYPES[type].port;
}

/** The vocabulary with display labels, for the "Add column"/"Add field"
 * type pickers, alphabetical by label as FIELD_VALUE_TYPES is, so a new type
 * has an obvious slot. */
export const FIELD_VALUE_TYPE_OPTIONS: { value: FieldValueType; label: string }[] = FIELD_VALUE_TYPES.map((value) => ({
  value,
  label: FIELD_TYPES[value].label,
}));

/** Changes a field's type, dropping the settings only its old type had, so
 * the file never carries options on a checkbox or a drop folder on text.
 * What this build couldn't read went with the old type too. */
export function retypeField(field: TableColumn, type: FieldValueType): void {
  field.type = type;
  const kept: readonly FieldSetting[] = FIELD_TYPES[type].settings;
  for (const setting of FIELD_SETTINGS) if (!kept.includes(setting)) delete field[setting];
  delete field.unknownType;
  delete field.unknownAttributes;
}

export interface TableColumn {
  id: string;
  type: FieldValueType;
  label: string;
  // Only meaningful (and required in practice) when type is "select" — a
  // flat list of allowed string values.
  options?: string[];
  // Only meaningful when type is "media": the folder a file dropped from
  // outside pragma is copied into, written the way the column's own values
  // are. Absent means the Table's own folder.
  mediaFolder?: string;
  // Only meaningful when type is "media": each value's file name shows
  // beside its picture. Absent, the picture shows alone.
  showName?: true;
  // Only meaningful when type is "timestamp": "now" fills a new row's cell
  // with the moment the row is added. Absent leaves it blank.
  default?: "now";
  // Only meaningful when type is "score": the top of its scale, a whole
  // number from 1 to SCORE_MAX_LIMIT, absent meaning SCORE_MAX; and whether
  // a value may be -1, rejected.
  max?: number;
  reject?: true;
  // A `data-type` this build doesn't know, which the column reads as text,
  // and the header's attributes it doesn't read, in file order: both written
  // back as found, so a later version's column survives this one's save.
  unknownType?: string;
  unknownAttributes?: [name: string, value: string][];
}

/** One record, `<tr>` in the file. `values` are always strings — a
 * checkbox column's value is "true"/"false" text, not a JSON boolean, so
 * every column type round-trips through the same string map. Rows have no
 * id of their own; a table that needs one can add an ordinary column for
 * it. */
export interface TableRow {
  values: Record<string, string>;
}

/** How a host draws a Table's rows: the grid, or one card per row. The
 * file may name the one it opens in; a host's own switch between them is
 * the host's state and never writes the file. */
export type TableLayout = "list" | "cards";
export const TABLE_LAYOUTS: readonly { id: TableLayout; label: string }[] = [
  { id: "list", label: "List" },
  { id: "cards", label: "Cards" },
];

export function parseTableLayout(raw: string | null | undefined): TableLayout | undefined {
  return raw === "cards" ? "cards" : undefined;
}

/** Whether `value` names a layout, the list included: what a request or a
 * host's own record may hold, where the file only ever says cards. */
export function isTableLayout(value: unknown): value is TableLayout {
  return TABLE_LAYOUTS.some((layout) => layout.id === value);
}

/** Whether a field's value is a path the document holds: a `media` file to
 * show, or a `path` file or folder to name. Either is read from the
 * document's folder and rewritten by a move. */
export function holdsPath(type: FieldValueType): boolean {
  return FIELD_TYPES[type].path;
}

/** The parsed shape of a `.table.html` file — see docs/protocol.md's
 * "Tables" section. `version` is written back verbatim; a major this build
 * doesn't write locks the document against saving, never against reading. */
/** One tile of a row's card: a field at a span of the card's grid, or a
 * heading across it (docs/protocol.md's Table row cards section). A span left
 * out is the host's to size. */
export type CardTile = { field: string; columns?: number; rows?: number } | { heading: string };

/** One tile of the card a cards view draws (docs/protocol.md's Table small
 * cards section): a row card's tiles, or the card's title at its span. */
export type SmallCardTile = CardTile | { title: true; columns?: number; rows?: number };

export interface TableFile {
  version: string;
  name?: string;
  metadata?: MetadataEntry[];
  columns: TableColumn[];
  rows: TableRow[];
  /** Absent means the list, and is what every file written before the
   * attribute existed says. */
  layout?: TableLayout;
  /** The tiles of a row's card. Absent shows every column, in order. */
  card?: CardTile[];
  /** The tiles of the card a cards view draws. Absent composes it from the
   * parts rule. */
  smallCard?: SmallCardTile[];
}

/** A Table with no columns or rows, at the version this build writes: what
 * an empty file reads as, and what a new one starts from. */
export function emptyTable(): TableFile {
  return { version: "1.0", columns: [], rows: [] };
}

/** A `color` value is a CSS hex color: `#rgb` or `#rrggbb` in any case in,
 * lowercase `#rrggbb` out. Anything else — "" or a hand-written color name —
 * is "no color" and renders empty, but its raw text stays on disk until the
 * user actually picks a color, so a value this reader doesn't recognize is
 * never destroyed.
 *
 * Shared by the cell renderer and web/lib/colorPicker.ts so both agree on what a
 * valid value is. */
export function normalizeHexColor(raw: string): string {
  const value = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(value) ? value : "";
}

// ISO 8601 as RFC 3339 profiles it — a date, a time, then `Z` or an offset —
// with the seconds optional and a space allowed for the `T`. A time with no
// zone is refused: it names a different instant on every machine.
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;

/** A `timestamp` value's instant, to the second, or undefined for anything
 * else, "" included. An impossible date such as February 30 is refused
 * rather than rolled over into March, as `Date`'s own parser would. */
export function parseTimestamp(raw: string): Date | undefined {
  const match = TIMESTAMP.exec(raw.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [1, 2, 3, 4, 5, 6, 8, 9].map((group) =>
    Number(match[group] ?? 0),
  );
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const offset = (match[7] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  return new Date(date.getTime() + ((hour * 60 + minute - offset) * 60 + second) * 1000);
}

/** The canonical `timestamp` value: UTC to the second, `2026-10-07T12:32:05Z`.
 * One spelling per instant, whichever machine wrote it, so it sorts as text. */
export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** A field's value before anything is put in it: a select's first option, an
 * unticked checkbox, otherwise blank. What a column added to a Table gives
 * the rows already there. */
export function emptyFieldValue(field: FieldDefinition): string {
  return FIELD_TYPES[field.type].empty(field);
}

/** What a new row holds for `column`, however the row is added. A timestamp
 * column whose default is "now" takes `now`. Rows that were there before the
 * column or its default never get a time they weren't added at. */
export function newRowValue(column: TableColumn, now: Date): string {
  return column.type === "timestamp" && column.default === "now" ? formatTimestamp(now) : emptyFieldValue(column);
}

/** The document-format major this build writes. Bump it only for a breaking
 * change to a format pragma itself serializes (`.table.html`, `.class.html`,
 * `.flow.html`); an additive change bumps the minor instead, which readers
 * ignore. */
export const DOCUMENT_FORMAT_MAJOR = 1;

/** Whether a document's `data-format-version` names a major this build does
 * not write, so the caller locks it against saving: a Table, Class or Flow
 * is re-serialized whole, and saving over a newer file silently drops what
 * this build couldn't parse. Majors only; a non-number is never newer, so a
 * typo never locks a document (docs/protocol.md's "Reading and write protection"). */
export function isNewerFormatVersion(version: string): boolean {
  const major = Number.parseInt(version, 10);
  return Number.isInteger(major) && major > DOCUMENT_FORMAT_MAJOR;
}

// A kind's extension matches in any case, as entry names compare, so
// `Notes.MD` is a note on every platform. Every kind test goes through this.
function hasExtension(filePath: string, extension: string): boolean {
  return filePath.slice(-extension.length).toLowerCase() === extension;
}

export const TABLE_EXTENSION = ".table.html";

// .table.html is a compound suffix, so a plain path.extname() set membership
// check would only ever see ".html". Every caller that needs to know "is
// this a table document" (server dispatch, tree-visibility, the client tree
// icon) goes through this instead.
export function isTableFile(filePath: string): boolean {
  return hasExtension(filePath, TABLE_EXTENSION);
}

/** The tests a Class's filter applies to one of a row's values. */
export const FILTER_TESTS = ["has", "is", "contains", "empty", "not-empty"] as const;

/** One rule of a Class's filter. `test` is kept as written, so a test
 * a later format adds survives a save by this one; a test this build
 * doesn't know filters nothing. */
export interface ClassRule {
  property: string;
  test: string;
  values: string[];
}

/** One named way of showing a Class's rows. Its filter narrows the
 * Class's own; with no sort it keeps the order the rows come in. */
export interface ClassView {
  name: string;
  layout: TableLayout;
  sort?: { property: string; order: "asc" | "desc" };
  groupBy?: string;
  // The keys of the fields it shows, in order. Absent shows every field;
  // empty shows none, so the two are never conflated on a save.
  fields?: string[];
  filter: ClassRule[];
}

/** The parsed shape of a `.class.html` file: the filter that picks its
 * rows from its root, the fields their frontmatter is read as, and its
 * views. It holds no values; its notes do. */
export interface ClassFile {
  version: string;
  name?: string;
  metadata?: MetadataEntry[];
  // No rule keeps every row in the root; its Folder rule says which folders
  // they come from.
  filter: ClassRule[];
  fields: TableColumn[];
  views: ClassView[];
  // The files every row is linked to, each a path from the Class's own
  // folder or an address; what a link gives the rows follows from what it
  // names.
  links: string[];
  // The tiles of a row's card, as a Table's. Absent shows every field.
  card?: CardTile[];
  // The tiles of the card its cards views draw, as a Table's.
  smallCard?: SmallCardTile[];
}

/** A Class with no rules, fields, views or links, at the version this build
 * writes: what an empty file reads as, and what a new one starts from. */
export function emptyClass(): ClassFile {
  return { version: "1.0", filter: [], fields: [], views: [], links: [] };
}

export const CLASS_EXTENSION = ".class.html";

export function isClassFile(filePath: string): boolean {
  return hasExtension(filePath, CLASS_EXTENSION);
}

/** What a Flow node's run says of a path with nothing at it, and what an
 * editor shows before the run, in the same words: shared, so the two never
 * drift apart. `rootedPath` is spelled as the run resolves it. */
export function noFileAt(rootedPath: string): string {
  const noun = isTableFile(rootedPath) ? "table" : "file";
  return `No ${noun} at "${rootedPath}"`;
}

/** What Load Image's run says of a path that names no raster image, and
 * what its card shows before the run, shared as `noFileAt` is. */
export function notARasterImage(rootedPath: string): string {
  return vectorImageMediaTypeForPath(rootedPath)
    ? `"${rootedPath}" is a vector image, not a raster image`
    : `"${rootedPath}" is not a raster image`;
}

export const MARKDOWN_EXTENSION = ".md";

// A plain markdown note — also the extension src/server/routes/entries.ts
// gives a new file named without one.
//
// Flow's loadNote checks this at drop and at Run, deliberately narrower than
// `/api/sandbox/read`, which returns any non-table, non-image file as text
// (`.fountain`, `.applet.html`, …): a note-only contract is a crisper story
// for a graph author than "whatever bytes sit at this path."
export function isMarkdownFile(filePath: string): boolean {
  return hasExtension(filePath, MARKDOWN_EXTENSION);
}

export const FOUNTAIN_EXTENSION = ".fountain";

export function isFountainFile(filePath: string): boolean {
  return hasExtension(filePath, FOUNTAIN_EXTENSION);
}

/** A text file's document type, which its path alone decides. */
export function documentTypeFor(filePath: string): DocumentType {
  return isFountainFile(filePath) ? "screenplay" : "note";
}

export type FileKind =
  | "note"
  | "screenplay"
  | "table"
  | "class"
  | "flow"
  | "applet"
  | "image"
  | "video"
  | "pdf"
  | "lut";

/** A file's kind by its path, its extension in any case: text, one of
 * Pragma's own kinds, media or a LUT; undefined for a file of no kind. Every
 * surface that sorts files by kind narrows this one answer, so none reads an
 * extension its own way. */
export function fileKindForPath(filePath: string): FileKind | undefined {
  if (isMarkdownFile(filePath)) return "note";
  if (isFountainFile(filePath)) return "screenplay";
  if (isTableFile(filePath)) return "table";
  if (isClassFile(filePath)) return "class";
  if (isFlowFile(filePath)) return "flow";
  if (isAppletFile(filePath)) return "applet";
  if (imageMediaTypeForPath(filePath)) return "image";
  if (videoMediaTypeForPath(filePath)) return "video";
  if (pdfMediaTypeForPath(filePath)) return "pdf";
  return isLutFile(filePath) ? "lut" : undefined;
}

/** Whether a file is of a kind the protocol defines. Where a name is looked
 * up, a file of no kind never matches one, so listing it never makes a name
 * ambiguous. */
export function hasKnownKind(filePath: string): boolean {
  return fileKindForPath(filePath) !== undefined;
}

// The four raster image types, which every supported vision model accepts
// as a base64 image — a closed set, not arbitrary strings. The client
// allowlist-checks a dropped File's type against this before ever sending it.
export const RASTER_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type RasterImageMediaType = (typeof RASTER_IMAGE_MEDIA_TYPES)[number];

/** Whether `text` is base64, the only form an image's bytes travel in. */
export const isBase64 = (text: string): boolean => /^[A-Za-z0-9+/]*={0,2}$/.test(text);

/** Whether a media type and data make an image a port or a generation can
 * carry: one of the raster types, as base64. A URL in its place would be
 * fetched by whoever it was handed to, so it is refused, never passed on. */
export function isInlineImage(mediaType: unknown, data: unknown): boolean {
  return (
    typeof mediaType === "string" &&
    (RASTER_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) &&
    typeof data === "string" &&
    isBase64(data)
  );
}

// Space-tree image files (as opposed to the applet-picker upload case above),
// matched in any case as every kind's extension is: phone and camera exports
// are routinely `.JPG` and `.PNG`.
export const RASTER_IMAGE_EXTENSIONS: Record<string, RasterImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** A vector image is drawn from its instructions at any size, and is never
 * a raster image: it has no pixels to decode, so no pixel format, no
 * thumbnail, no vision input and nothing for Load Image, and a Flow reads it
 * as text. */
export type VectorImageMediaType = "image/svg+xml";

// Case-insensitive for the same reason RASTER_IMAGE_EXTENSIONS is.
export const VECTOR_IMAGE_EXTENSIONS: Record<string, VectorImageMediaType> = {
  ".svg": "image/svg+xml",
};

/** An image is a raster image or a vector image: what an `<img>` draws. */
export type ImageMediaType = RasterImageMediaType | VectorImageMediaType;

export const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  ...RASTER_IMAGE_EXTENSIONS,
  ...VECTOR_IMAGE_EXTENSIONS,
};

/** What a `<video>` element is pointed at — deliberately narrower than what a
 * camera writes: a format earns a place only if a browser decodes it, since a
 * listed file that opens onto a player that can't play it is worse than one
 * never listed.
 *
 * An extension promises only the container: a ProRes `.mov` or an HEVC `.mp4`
 * is listed and served and may still fail to decode, which is why the pane
 * has its own failure state. */
export type SpaceVideoMediaType = "video/mp4" | "video/webm" | "video/quicktime";

// Case-insensitive for the same reason RASTER_IMAGE_EXTENSIONS is: a camera writes
// `.MOV` and `.MP4` as often as not.
export const VIDEO_EXTENSIONS: Record<string, SpaceVideoMediaType> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export type SpacePdfMediaType = "application/pdf";

// Case-insensitive for the same reason RASTER_IMAGE_EXTENSIONS is.
export const PDF_EXTENSIONS: Record<string, SpacePdfMediaType> = {
  ".pdf": "application/pdf",
};

// Read from the file's own name, or a dotted directory name ("shots.v2/take")
// would be read as the file's own extension.
function extensionMediaType<T extends string>(map: Record<string, T>, filePath: string): T | undefined {
  const name = basenameOf(filePath);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? undefined : map[name.slice(dot).toLowerCase()];
}

// Single source of truth for "is this space path an image, and what's its media
// type", rather than each caller re-deriving and lowercasing an extension.
// Either kind serves a caller that only draws the file: the image view, the
// gallery, a Markdown embed, a media field, publishing.
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return extensionMediaType(IMAGE_EXTENSIONS, filePath);
}

/** For the callers that need pixels: Load Image, vision input, a thumbnail,
 * a pixel format. */
export function rasterImageMediaTypeForPath(filePath: string): RasterImageMediaType | undefined {
  return extensionMediaType(RASTER_IMAGE_EXTENSIONS, filePath);
}

export function vectorImageMediaTypeForPath(filePath: string): VectorImageMediaType | undefined {
  return extensionMediaType(VECTOR_IMAGE_EXTENSIONS, filePath);
}

export function videoMediaTypeForPath(filePath: string): SpaceVideoMediaType | undefined {
  return extensionMediaType(VIDEO_EXTENSIONS, filePath);
}

const MEDIA_EXTENSIONS: Record<string, string> = { ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS };

/** The extension a file of `mediaType` is written with, without its dot: the
 * first one `table` lists for it, every image and video table above unless
 * given one, so `jpg` and `mp4` rather than `jpeg` and `m4v`; undefined for a
 * type the table doesn't name. */
export function extensionForMediaType(
  mediaType: string,
  table: Record<string, string> = MEDIA_EXTENSIONS,
): string | undefined {
  return Object.keys(table)
    .find((key) => table[key] === mediaType)
    ?.slice(1);
}

export function notAVideo(rootedPath: string): string {
  return `"${rootedPath}" is not a video clip: an MP4, M4V, MOV or WebM file`;
}

export function pdfMediaTypeForPath(filePath: string): SpacePdfMediaType | undefined {
  return extensionMediaType(PDF_EXTENSIONS, filePath);
}

export type SpaceMediaType = ImageMediaType | SpaceVideoMediaType | SpacePdfMediaType;

/** Any kind of media, for the callers that serve, list or refuse every
 * kind — the raw-file route, the tree walks, the desktop drop.
 *
 * Not a replacement for the narrower lookups above. A caller that means a
 * raster image — vision input, Load Image — or any image — a markdown embed,
 * drop-to-attach — asks exactly that, or a video or a PDF becomes a
 * candidate wherever an image is expected. */
export function mediaTypeForPath(filePath: string): SpaceMediaType | undefined {
  return imageMediaTypeForPath(filePath) ?? videoMediaTypeForPath(filePath) ?? pdfMediaTypeForPath(filePath);
}

/** A LUT, a color lookup table (docs/protocol.md's LUTs section), is neither
 * a document nor media. Its bytes are text that only a LUT reader reads, so
 * it is served as plain text and never read as a document. */
export type LutMediaType = "text/plain";

// Case-insensitive for the same reason RASTER_IMAGE_EXTENSIONS is.
export const LUT_EXTENSIONS: Record<string, LutMediaType> = {
  ".cube": "text/plain",
};

export function isLutFile(filePath: string): boolean {
  return extensionMediaType(LUT_EXTENSIONS, filePath) !== undefined;
}

/** What the raw-file route serves a file as: media or a LUT, the files a
 * pane reads as bytes, never as a document's text. They are also the files
 * a drop copies in through the upload route. */
export function rawFileTypeForPath(filePath: string): SpaceMediaType | LutMediaType | undefined {
  return mediaTypeForPath(filePath) ?? extensionMediaType(LUT_EXTENSIONS, filePath);
}

/** A thumbnail's longest edge, in pixels: what the client renders to and
 * the most the thumbnail route stores. One size for every tile, so one
 * cached file serves any tile size up to twice its CSS pixels. */
export const THUMBNAIL_MAX_EDGE = 512;

/** Which files get a thumbnail, and from what: a raster image's pixels, a
 * video's frame. A vector image draws at any size as it is, and a PDF gets
 * none. */
export function thumbnailKindForPath(filePath: string): "image" | "video" | undefined {
  if (rasterImageMediaTypeForPath(filePath)) return "image";
  return videoMediaTypeForPath(filePath) ? "video" : undefined;
}

/** One image input to a generation call — base64 bytes plus their media
 * type, keyed by the caller's own field id. */
export interface GenerateImageInput {
  mediaType: RasterImageMediaType;
  data: string;
}

/** The display-identity block an applet manifest embeds under `meta` —
 * informational only, with no compliance rule (unlike the manifest's
 * top-level `version`). A key of its own, not the kind's name, so a generic
 * reader finds it without branching on kind. */
export interface ManifestInfo {
  name?: string;
  version?: string;
  description?: string;
}

/** The on-disk shape of an `.applet.html` file's embedded manifest, read
 * inertly, never executed. `style` is opt-in host styling
 * (docs/protocol.md's "Standard style" section) — a plain string rather than
 * a `"default"` literal, so a second named look costs nothing. */
export interface AppletManifest {
  version: string;
  meta?: ManifestInfo;
  style?: string;
  imports?: AppletImport[];
  ports?: AppletPorts;
  // Set when the manifest lists capabilities, which no Applet has: such a
  // file is refused rather than run with calls that fail (appletRefusal).
  declaresCapabilities?: boolean;
}

/** Why an Applet can't run at all, or undefined when it can. */
export function appletRefusal(manifest: AppletManifest): string | undefined {
  if (!manifest.declaresCapabilities) return undefined;
  return "This Applet declares capabilities, which Applets don't have: a Flow's built-in nodes do its reads, model calls and writes. Rebuild it as a Flow.";
}

/** What an Applet takes and gives as a Flow node, over the Flow port types,
 * from the manifest's `ports`. A port id is a wire identifier for every Flow
 * that uses the Applet. */
export interface AppletPorts {
  inputs: FlowPort[];
  outputs: FlowPort[];
}

/** A module the Applet imports by `specifier`, read from `path` — a bare
 * filename beside the Applet, a path with a `/` from the space root. One
 * self-contained ES module per file, or a `.glb` model imported as its bytes:
 * the frame resolves no relative import, so an import reaches another only by
 * its bare specifier. */
export interface AppletImport {
  specifier: string;
  path: string;
}

export const APPLET_EXTENSION = ".applet.html";

// A compound suffix, so every caller that needs "is this an applet document"
// goes through this rather than a bare path.extname() check.
export function isAppletFile(filePath: string): boolean {
  return hasExtension(filePath, APPLET_EXTENSION);
}

/** What a generation request sends: a plain instruction string with
 * `{{key}}` substituted against `values`, plus any `images`. Result is
 * GenerateResult (reply/model). */
export interface GenerateEnvelope {
  instruction: string;
  values: Record<string, string>;
  images: Record<string, GenerateImageInput>;
  context?: ContextFile[];
}

/** What an options request sends — a handful of candidates instead of one
 * reply. Not merged into GenerateEnvelope with an optional `numOptions`: that
 * field picks the system prompt and parsing path, and requiring it on its own
 * type keeps the choice visible at the call site. Result is ActionResult
 * (options/model). */
export interface GenerateOptionsEnvelope {
  instruction: string;
  values: Record<string, string>;
  images: Record<string, GenerateImageInput>;
  context?: ContextFile[];
  numOptions: number;
}

/** A Flow port's type — see docs/protocol.md's "Ports and types" section.
 * `object` and `number` carry real runtime values, never pre-stringified
 * text. Edges match types exactly, with no coercion: converting is a node's
 * job, visible in the graph, never an implicit edge behavior. */
export type FlowPortType = "text" | "image" | "boolean" | "object" | "number" | "video";

// The one place "can this pin connect to that one" is decided by type, for
// the editor's drag validation. Exact match, no coercion (see FlowPortType
// above); a named function rather than an inline `===` so a conversion rule
// has one place to land.
export function flowPortTypesCompatible(sourceType: FlowPortType, targetType: FlowPortType): boolean {
  return sourceType === targetType;
}

export interface FlowPort {
  id: string;
  type: FlowPortType;
  label: string;
  // Absent means required. `false` marks a connect-only port optional
  // despite having no widget fallback (generate's image ports).
  // Presentation-only: the editor fades an optional port's unconnected pin,
  // and nothing reads this for execution validation.
  required?: boolean;
  // One line on what the pin carries, shown over it. Absent means none.
  description?: string;
}

/** A tile's span on App mode's grid, in whole cells. A hint: the host owns
 * the column count and clamps to it, and may ignore sizes altogether. */
export interface AppModeSize {
  columns: number;
  rows: number;
}

/** One placed instance of a built-in node type (see flowNodes.ts's
 * registry) — `type` is the registry key, `config` is whatever
 * node-type-specific fields that entry's config schema declares (e.g.
 * prompt's text, loadRow's target path). */
export interface FlowNodeInstance {
  id: string;
  type: string;
  // The node type's `version` when this instance was created or duplicated —
  // a frozen reference to the type, not a version of the instance. No
  // migration reads it; it gives a breaking change to a type's config/port
  // shape a marker to migrate saved instances from.
  typeVersion?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  // User-resized card dimensions — absent means "use the type's default
  // width and auto height" (every node before this field existed, and any
  // node never dragged by its resize handle).
  size?: { width: number; height: number };
  // Per-instance display label (right-click the title bar → Rename) —
  // absent means "show the type's own label" (flowNodes.ts's
  // FlowNodeTypeDefinition.label), same fallback every node had before
  // this field existed. Was "name" pre-2026-09-03 rename; no read-side
  // compat for the old key — alpha stage, clean-slate over migration.
  label?: string;
  // One line for the node's users: its caption on the canvas and its Tools
  // button's tooltip. Absent means none. Display only, like label, so the
  // capability digest leaves it out.
  comment?: string;
  // Per-instance title-bar background color (right-click the title bar →
  // Color), normalized "#rrggbb" — absent means the stylesheet's default
  // --bg-hover.
  color?: string;
  // Toggled by the title bar's dot; collapsed shows only the title. Edges
  // touching a collapsed node still render, converging on one point per
  // side instead of each port's own position.
  collapsed?: boolean;
  // The card's set-once settings, a Generate node's model and its settings,
  // folded to one summary line, where the wires into them meet.
  settingsFolded?: boolean;
  // The card hides each pin nothing flows through (docs/protocol.md, Graph
  // shape). Display only, like collapsed, so the capability digest leaves
  // it out.
  unusedPinsHidden?: boolean;
  // "disabled": a run leaves the node out, and every node it feeds
  // (docs/protocol.md, Execution). Absent, it runs. It changes what a run
  // does, so the capability digest covers it.
  mode?: "disabled";
  // The port ids, config keys and picker keys App mode's form shows — see
  // docs/protocol.md's "App mode" section. Never a connect-only socket's
  // port id: it has no value of its own to show.
  exposed?: string[];
  // This node's position among App mode's cards, lowest first and absent
  // last; ties fall back to `graph.nodes` order through a stable sort. Read only on exposed
  // nodes. A drag reorder renumbers every exposed node, and Run, to a fresh
  // 0-based sequence — not gap numbering, which App mode's handful of cards
  // never needs.
  appModeOrder?: number;
  // This node's App mode tile; absent means the host's default for it. Cells,
  // never pixels: `size` above is the canvas card's. Like appModeOrder, it
  // never reorders a run's inputs or results.
  appModeSize?: AppModeSize;
}

export interface FlowEdgeInstance {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

/** The canonical, library-independent graph shape `.flow.html` embeds —
 * never `@xyflow/system`'s own node/edge shape, which stays confined to
 * web/flow/xyflowAdapter.ts. */
export interface FlowGraph {
  nodes: FlowNodeInstance[];
  edges: FlowEdgeInstance[];
  viewport?: { x: number; y: number; zoom: number };
  // Where Run's card sits among App mode's exposed-node cards — a node's
  // appModeOrder, graph-scoped since Run isn't a node. Absent sorts Run after
  // every exposed card: fill in the fields, then Run.
  runAppModeOrder?: number;
  // Run's App mode tile — a node's appModeSize, graph-scoped like
  // runAppModeOrder.
  runAppModeSize?: AppModeSize;
  // Whether the flow opens in App mode. With `viewport`, its default view,
  // written only when someone sets it (docs/protocol.md, Graph shape): a
  // switch of view is the host's state, never the file's.
  appModeActive?: boolean;
}

export const CHART_TYPES = ["bar", "line"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** What a Chart node draws, read from its config: Pragma's own description,
 * never a chart library's options, so a host draws it with any library and a
 * library upgrade touches no saved Flow. `x` and `y` name columns of the rows
 * wired into it. */
export interface ChartSpec {
  type: ChartType;
  x: string;
  y: string;
}

export function chartSpecFrom(config: Record<string, unknown>): ChartSpec {
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  const type = CHART_TYPES.find((candidate) => candidate === config.chartType) ?? "bar";
  return { type, x: text("x"), y: text("y") };
}

/** Declares intent to read one document, or every child of a folder, or a
 * raster image in a registered library by its `lib:<id>/…` address. Never
 * hand-authored: derived from a node's configured path (see flowNodes.ts).
 * `wired` marks a request for a path a wire brought at run time rather than
 * one the graph holds; it changes the prompt's wording, never the key. */
export interface FlowReadFileCapability {
  type: "readFile";
  path: string;
  wired?: true;
}

/** Declares intent to run a generation call — derived from a `generateText`
 * or `generateOptions` node's presence. No external network, no secret
 * custody: the provider key never leaves the server. */
export interface FlowGenerateTextCapability {
  type: "generateText";
}

/** Declares intent to write one specific space-relative document — derived
 * the same way FlowReadFileCapability is, from a Write Note or Add Row node's
 * configured path. */
export interface FlowWriteDocumentCapability {
  type: "writeDocument";
  path: string;
  wired?: true;
}

/** Declares intent to read the document the flow was run from — derived from
 * a `currentDocument` node's presence. Document-scoped: no path, since which
 * document is decided by where the run was started, never by the graph. */
export interface FlowReadCurrentDocumentCapability {
  type: "readCurrentDocument";
}

/** Asks to let a generation's model search the scope a wired path sits in,
 * named by its folder's address, and send it the files of that folder its
 * context holds or it reads. Never derived from config: a `context` pin's
 * wire is what asks, per scope (docs/protocol.md, Context of a path). */
export interface FlowSearchContextCapability {
  type: "searchContext";
  path: string;
}

/** Declares intent to generate images into one folder: spending credits
 * and writing results there, in one consent. Derived from a
 * `generateImage` node's configured folder; it names no provider, because a
 * node's model can arrive on a wire. */
export interface FlowGenerateImageCapability {
  type: "generateImage";
  path: string;
}

/** The same consent for videos, kept apart because a clip costs many times
 * what an image does: allowing one never allows the other. Derived from a
 * `generateVideo` node's configured folder. */
export interface FlowGenerateVideoCapability {
  type: "generateVideo";
  path: string;
}

/** Declares intent to read every file one column of a Table names, whatever
 * its value, rows added later included: derived from a For Each zone whose
 * rows come from a Load Table, where a Get Field on the zone's item hands a
 * column straight to a node's path (docs/protocol.md, For Each zones).
 * `path` is the Table's, `column` the column's id. */
export interface FlowReadColumnCapability {
  type: "readColumn";
  path: string;
  column: string;
  // The column as the Table names it, which a prompt shows; never the key.
  shown?: ColumnShown;
}

/** The same grant for writing every file one column of a Table names. */
export interface FlowWriteColumnCapability {
  type: "writeColumn";
  path: string;
  column: string;
  shown?: ColumnShown;
}

/** A column's label and type, as a prompt draws a column grant. */
export interface ColumnShown {
  label: string;
  type: FieldValueType;
}

export type FlowCapabilityDeclaration =
  | FlowReadFileCapability
  | FlowGenerateTextCapability
  | FlowWriteDocumentCapability
  | FlowReadCurrentDocumentCapability
  | FlowSearchContextCapability
  | FlowGenerateImageCapability
  | FlowGenerateVideoCapability
  | FlowReadColumnCapability
  | FlowWriteColumnCapability;

/** Whether a capability grants a Table column's files. */
export function isColumnCapability(
  capability: FlowCapabilityDeclaration,
): capability is FlowReadColumnCapability | FlowWriteColumnCapability {
  return capability.type === "readColumn" || capability.type === "writeColumn";
}

/** The parsed shape of a `.flow.html` file — see docs/protocol.md's "Flows"
 * section. Lives here, unlike the applet parse result, because a reader
 * and a writer share it, as with TableFile. No manifest: capabilities are
 * derived from the graph. `html` is the raw text, but unlike an applet's it
 * is never hashed — a Flow's grants pin a capability digest instead. */
export interface FlowFile {
  version: string;
  name?: string;
  metadata?: MetadataEntry[];
  graph: FlowGraph;
  html: string;
}

// The key a capability is granted and checked under (src/server/grants.ts):
// its type, then any path as the address it resolves to from the Flow's
// folder (flowNodes.ts), so every spelling of one path is one key and two
// files need two grants. Shared by client and server so neither derives a
// differently-shaped key.
//
// Two colons, one split: the key's own separator is the first, so the
// address after it keeps its `space:` or `lib:` scheme.
//
// A column's key ends `#<column id>` after the Table's address. An id never
// holds `#`, so a key splits at its last one even when a file name has one.
export function flowCapabilityKey(capability: FlowCapabilityDeclaration): string {
  if (capability.type === "readCurrentDocument" || capability.type === "generateText") return capability.type;
  if (isColumnCapability(capability)) return `${capability.type}:${capability.path}#${capability.column}`;
  return `${capability.type}:${capability.path}`;
}

export const FLOW_EXTENSION = ".flow.html";

// A compound suffix, so every caller that needs "is this a flow document"
// goes through this rather than a bare path.extname() check.
export function isFlowFile(filePath: string): boolean {
  return hasExtension(filePath, FLOW_EXTENSION);
}

// Longest-lived halves of a filename, in one place because there are only
// two ways to get this wrong and both of them are silent: split on the last
// dot and a table's stem keeps a stranded ".table", or match a kind suffix
// that isn't the whole suffix and the rebuilt name stops being a table at
// all.
const COMPOUND_EXTENSIONS = [TABLE_EXTENSION, CLASS_EXTENSION, APPLET_EXTENSION, FLOW_EXTENSION];

/** Splits a filename into the part that names a document and the part that
 * says its kind: `inventory.table.html` is `inventory` + `.table.html`, never
 * `inventory.table` + `.html`, so a name rebuilt from the halves (a trashed
 * copy's " 2", an extension-hidden rename) keeps its kind. A dotfile
 * (".gitignore") or a dotless name is all stem. */
export function splitDocumentName(name: string): { stem: string; extension: string } {
  const compound = COMPOUND_EXTENSIONS.find((extension) => hasExtension(name, extension));
  if (compound) return { stem: name.slice(0, -compound.length), extension: name.slice(-compound.length) };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}
