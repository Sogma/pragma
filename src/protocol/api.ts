// The HTTP wire contract between pragma's server and its web client: one
// named shape per route response and request body, imported by both
// `src/server/routes/*` (`c.json<XResponse>`) and `web/core/apiClient.ts`
// (`satisfies`), so a field added on one side only fails to compile.
//
// Responses first, then request bodies, each grouped by route family in
// mount order. Only what crosses the wire belongs here — a server-internal
// or client-only shape stays with its owner.

import type { BookmarkChange } from "./bookmarks.ts";
import type { ClassRow } from "./class.ts";
import type { FlowAction } from "./flowActions.ts";
import type { AffixMode, FrameKind } from "./flowNodes.ts";
import type { SortChoice, SortValue } from "./folderSort.ts";
import type { FolderLayout } from "./localSort.ts";
import type { PragmaFileRole } from "./pragmaFiles.ts";
import type { LutEntry, PresetChange, PresetKind } from "./presets.ts";
import type { SetupNeed } from "./setupNeed.ts";
import type { TagChange, TagDefinition } from "./tags.ts";
import type { TemplateEntry } from "./templates.ts";
import type {
  ActionResult,
  AppletManifest,
  CardTile,
  ClassFile,
  DocumentType,
  FindContextResult,
  FlowCapabilityDeclaration,
  FlowGraph,
  GenerateResult,
  MetadataEntry,
  SmallCardTile,
  TableColumn,
  TableLayout,
  TableRow,
} from "./types.ts";

export type { FindContextCandidate } from "./types.ts";

// ---- /api/space: identity, switching, tree, sites, libraries, layout

// The served space's `name`, `label` and `path`, as SpaceRef defines them —
// shown as `label || name`, like every other place a space is named. Unlike
// SpaceRef's, `path` is absent where no local disk is behind the engine.
export interface SpaceInfoResponse {
  name: string;
  label?: string;
  path?: string;
}

export interface SpaceRef {
  // The registry id (config.spaces). Absent only for a space this process is
  // serving that was never registered — a path passed straight to the CLI on
  // a config that could not be written, say.
  id?: string;
  path: string;
  // The folder's own basename: the display fallback when no label is set.
  name: string;
  // The user-editable display name, set from Manage Spaces. Renaming edits
  // this and never the id, so approvals keyed by the id survive it.
  label?: string;
  // True when the registered path no longer exists on disk — the row renders
  // as unavailable and offers Locate. Absent for the space being served,
  // which exists by definition.
  missing?: boolean;
  // The space's recorded trust — absent until the person has been asked.
  trusted?: boolean;
}

/** A registered space as the desktop app's welcome window lists it: under its
 * name, the folder that holds it. */
export interface ListedSpace extends SpaceRef {
  parent: string;
}

/** One agent-API token, as the Settings panel sees it. Never carries the
 * token itself: that is shown once at creation and only its hash is stored. */
export interface ApiTokenRow {
  id: string;
  label: string;
  createdAt: string;
  access: Access;
  /** The space this token may reach, by display name — the panel shows which
   * space a token belongs to, not the opaque id it keys off. */
  spaceLabel: string;
}

export interface ApiSettingsResponse {
  enabled: boolean;
  port: number;
  /** The port the endpoint is actually listening on, when it is. Differs from
   * `port` until pragma restarts, which is how the panel knows to say so. */
  runningPort?: number;
  tokens: ApiTokenRow[];
}

export interface ApiSettingsRequestBody {
  enabled?: boolean;
  port?: number;
}

export interface CreateApiTokenRequestBody {
  label: string;
  access: Access;
}

/** The one time the token itself is returned. */
export interface CreateApiTokenResponse {
  token: ApiTokenRow;
  secret: string;
}

/** One Console entry the server produced, rather than the browser.
 *
 * Shaped as the console renders it — level, kind, label, content — so a
 * polled entry needs no translation on arrival. `seq` is the cursor: the
 * client passes the newest one it has seen back as `since`. */
export interface ActivityEntry {
  seq: number;
  level: "info" | "warn" | "error";
  kind: string;
  label: string;
  content: string;
}

export interface ActivityResponse {
  /** The newest sequence number the server holds. Pass it back as `since` on
   * the next poll. A first poll (no `since`) returns this and no entries:
   * the Console shows what happens while it is open, never a backlog. */
  cursor: number;
  entries: ActivityEntry[];
}

export interface SpaceLabelRequestBody {
  id: string;
  label: string;
}

export interface SpaceIdRequestBody {
  id: string;
}

export interface SpaceTrustRequestBody {
  id: string;
  trusted: boolean;
}

export interface SpaceListResponse {
  current: SpaceRef;
  // Every registered space, ordered by display name. What the management
  // surfaces list: a space that has aged out of `recent` still holds
  // approvals keyed to its id, so it must stay reachable here.
  spaces: SpaceRef[];
  // The switcher dropdown's short list, most-recently-opened first and
  // capped. A subset of `spaces`, never a different set.
  recent: SpaceRef[];
}

// GET /api/space/changes: each tree's version. Equal versions mean nothing
// the tree lists changed in between. `library` answers only when one is
// named. A tree read, the space's or a library's, sends its version in an
// X-Pragma-Changes header, read before the walk, so a change made during it
// still shows as one.
//
// Each `file` query names a rooted path, and `files` answers its revision
// now, as a read would: null when nothing is there, left out when its root
// can't be read.
export interface SpaceChangesResponse {
  space: string;
  library?: string;
  files?: Record<string, string | null>;
}

export const CHANGES_HEADER = "X-Pragma-Changes";

// The entries a request wrote into a space or library, rooted, which the page
// tells its views to read again: a JSON list, URI-encoded so any name
// survives a header. The space's top folder is "", which a list keeps.
export const WRITTEN_HEADER = "X-Pragma-Written";

export function formatWrittenPaths(paths: readonly string[]): string {
  return encodeURIComponent(JSON.stringify(paths));
}

/** The rooted paths a response names as written; none for a missing or
 * unreadable header. */
export function readWrittenPaths(header: string | null): string[] {
  if (!header) return [];
  try {
    const paths: unknown = JSON.parse(decodeURIComponent(header));
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

// GET /api/space/paths and /api/space/libraries/:id/paths: every file and
// folder the root holds, shown in its tree or not, with dot-entries and links
// left out, and the folders a scope opens over. What a written path is read
// against, so a link's target never depends on which files the tree shows. A
// library is one scope, so it lists none. Sends its version as a tree read does.
export interface RootPathsResponse {
  files: string[];
  folders: string[];
  scopes: string[];
  // Each scope's settings (docs/protocol.md, Scopes): its `pragma` value
  // where that is a map, by the folder it opens over, "" for the space's own.
  // Absent from a library's listing, whose AGENTS.md opens no scope.
  settings?: Record<string, Record<string, unknown>>;
}

export interface SpaceTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  // Absent on a directory means not listed — a shallow library read stopped
  // above it — never empty.
  children?: SpaceTreeNode[];
  // Only ever set on directories: whether this directory's own order is
  // manual — it has its own `_structure.json` and no `sort` rule overriding it.
  sortable?: boolean;
  // Only ever set on directories: the rule this directory's own `sort` names,
  // when it has one.
  sort?: SortChoice;
  // Only ever set on the children of a directory shown by a property, and
  // only when they have a value for it.
  sortValue?: SortValue;
  // The entry's description (docs/protocol.md's Descriptions), for a model
  // handed the tree: set only where the parent directory has a
  // `_structure.json`, so a tree read never parses every file for one.
  description?: string;
  // Only ever set on directories: this directory's own `_site.json`, marking
  // it as a published site's root. Drives the tree's site badge and its
  // name-as-tooltip. `assetsFolder` is where an image pasted into a
  // document under this site lands, site-relative.
  site?: { name: string; assetsFolder?: string };
  // Only ever set, and only true, on a space's `AGENTS.md` whose frontmatter
  // opens a scope over its folder. Its icon is then Pragma's mark.
  opensScope?: boolean;
  // Only ever set, and only true, on a space folder a scope's World setting
  // names (docs/protocol.md, World names). Its icon is then the world's.
  world?: boolean;
  // Only ever set on a space's file that Pragma itself reads where it sits:
  // the job it does there. Its icon is then the braces in Pragma's colours.
  pragmaFile?: PragmaFileRole;
}

// GET /api/space/folder?path=<rooted folder> — that folder's own entries, by
// the tree's visibility rules, for the gallery. `path` is rooted, as asked;
// `modified` an ISO timestamp; `size` means nothing for a directory.
//
// `version` is opaque and changes whenever the file may have; a thumbnail
// upload names it back. `thumbnail` says the host holds one made from this
// version, so a client never asks for one it would have to make.
//
// With a thumbnail come what its maker decoded, the file's displayed width
// and height and a video's duration in seconds, and what the host read of
// its header, `clip` or `picture`. A clip the browser couldn't decode has
// them with no thumbnail, its size and length read from the header.
export interface FolderEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modified: string;
  version: string;
  thumbnail: boolean;
  width?: number;
  height?: number;
  duration?: number;
  clip?: ClipDetails;
  picture?: PictureDetails;
  // Its description (docs/protocol.md's Descriptions), for its card: listed
  // only while the folder shows cards, so a tile listing parses no file.
  description?: string;
  // A note's opening, for its card where it has no description: plain text,
  // a line per paragraph, heading or list item. Listed likewise.
  excerpt?: string;
}

// `entries` come in the order shown: the folder's own, or this install's
// sort while it shows the folder another way. `layout` is absent while the
// folder shows tiles.
export interface FolderListingResponse {
  entries: FolderEntry[];
  order: FolderOrder;
  layout?: "cards";
}

export interface FolderOrder {
  default: SortChoice;
  local?: SortChoice;
}

// GET /api/space/class?path=<rooted Class> — the notes the
// Class holds, each with its frontmatter and title, in the order a view
// with no sort of its own keeps. ?dir=<rooted folder> instead gives the
// rows a Class with no source in that folder would hold.
export interface ClassRowsResponse {
  rows: ClassRow[];
}

// One `_site.json` in the space, for the Websites panel's list. `path` is
// the site's own root directory, space-relative with forward slashes.
export interface SpaceSiteEntry {
  id: string;
  slug: string;
  name: string;
  domain?: string;
  primaryDomain: string | null;
  publisherId?: string;
  path: string;
}

/** What pragma may do inside a library's folder, or an agent-API token in
 * its space. A newly registered library is read-only; read-write is chosen
 * per entry, by a person. */
export type Access = "read-only" | "read-write";

// A library the space declares (its `_libraries.json`), as this host finds
// it: the folder its space's registry entry keeps, and what Pragma may do
// there.
export interface LibraryEntry {
  id: string;
  label: string;
  description?: string;
  path: string;
  access: Access;
}

// One row of GET /api/space/libraries, for every library the space declares.
// `path` is absent until this host locates the library, and `missing` holds
// then and whenever its folder can't be reached: computed per request, never
// stored, since the declaration travels with the space and the folder
// doesn't. Same row-over-record split as ApiTokenRow.
export interface LibraryRow extends Omit<LibraryEntry, "path"> {
  path?: string;
  missing: boolean;
}

// A folder this computer located for another space's library: what adding a
// library offers besides a picker, desktop app only. Picking one names it
// back by `space` and `id`, never by its path, so a folder still reaches a
// space only from the main process.
export interface LibraryOffer {
  space: string;
  id: string;
  label: string;
  description?: string;
  path: string;
}

// GET /api/space/libraries. `problem` says why a `_libraries.json` that
// exists declares none.
export interface SpaceLibrariesResponse {
  libraries: LibraryRow[];
  problem?: string;
}

// POST /api/space/libraries/:id/access
export interface LibraryAccessRequestBody {
  access: Access;
}

// POST /api/space/libraries/:id/label. Blank means the folder's own name.
export interface LibraryLabelRequestBody {
  label: string;
}

// POST /api/space/libraries/:id/description. Blank takes it away.
export interface LibraryDescriptionRequestBody {
  description: string;
}

// The persisted projection of an open tab (the space's saved layout) — just
// enough to reopen it fresh on the next load. Never carries editor state.
// "corkboard" is read, never written: a saved layout may still name one,
// and it reopens as a gallery.
export interface LayoutTab {
  kind:
    | "document"
    | "corkboard"
    | "gallery"
    | "image"
    | "video"
    | "pdf"
    | "lut"
    | "table"
    | "class"
    | "flow"
    | "applet"
    | "applet-source"
    | "empty";
  path?: string;
  /** A document's, once it has shown. */
  place?: TabPlace;
  /** A Flow's, once its canvas has moved. */
  viewport?: TabViewport;
}

/** Where a document tab was left: the file line at the top of the surface
 * showing it, 12.5 halfway down line 12, and the editor's caret. Lines, not
 * pixels, so a text size changed since still lands on the same text. */
export interface TabPlace {
  line: number;
  caret?: { line: number; column: number };
}

/** `value` as a TabPlace, or undefined when it isn't one. */
export function readTabPlace(value: unknown): TabPlace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { line, caret } = value as { line?: unknown; caret?: unknown };
  if (typeof line !== "number" || !Number.isFinite(line) || line < 0) return undefined;
  if (caret === undefined) return { line };
  if (!caret || typeof caret !== "object") return undefined;
  const { line: caretLine, column } = caret as { line?: unknown; column?: unknown };
  if (typeof caretLine !== "number" || !Number.isInteger(caretLine) || caretLine < 1) return undefined;
  if (typeof column !== "number" || !Number.isInteger(column) || column < 0) return undefined;
  return { line, caret: { line: caretLine, column } };
}

/** Where a Flow tab left its canvas, in the graph's own `viewport` shape.
 * The tab opens there over the file's `viewport`, which a pan or zoom never
 * writes (docs/protocol.md, Graph shape). */
export interface TabViewport {
  x: number;
  y: number;
  zoom: number;
}

/** `value` as a TabViewport, or undefined when it isn't one. */
export function readTabViewport(value: unknown): TabViewport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, zoom } = value as { x?: unknown; y?: unknown; zoom?: unknown };
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined;
  if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0) return undefined;
  return { x, y, zoom };
}

// One editor group's tabs, in strip order, which of them shows, and whether
// the group is in reading view or Source mode. A group without `readingView`
// opens editing; one without `sourceMode` shows its notes formatted.
export interface LayoutGroup {
  tabs: LayoutTab[];
  activeTabIndex: number;
  readingView?: boolean;
  sourceMode?: boolean;
}

// Each root records only its exceptions: a space folder starts open, so
// `collapsedFolders` holds space paths; a library folder starts collapsed, so
// `expandedFolders` holds `lib:<id>/…` paths. A space whose folds were never
// saved answers with every folder below its top level folded. `groups` run
// left to right, and `focusedGroup` indexes into them.
export interface LayoutResponse {
  collapsedFolders: string[];
  expandedFolders: string[];
  groups: LayoutGroup[];
  focusedGroup: number;
}

// ---- /api/space/search: the Search view

/** One match. A text file matches by line — 1-based, counting the whole
 * file, frontmatter included. A Table, Class or Flow matches by value, named
 * by what holds it (a column, a field, a node), since its lines are markup. */
export type SpaceSearchHit = { line: number; text: string } | { label: string; text: string };

/** One file's matches, files in the order the space tree lists them. */
export interface SpaceSearchFile {
  path: string;
  matches: SpaceSearchHit[];
}

export interface SpaceSearchResponse {
  files: SpaceSearchFile[];
  /** The match cap cut the scan short: there are more than shown. */
  truncated: boolean;
}

// ---- /api/space: entries (create, duplicate, move, delete, folder properties)

export interface CreateEntryResponse {
  path: string;
  type: "file" | "directory";
}

/** What `/api/space/upload` actually wrote. The requested name is a request,
 * not a promise: the server sanitizes it and steps around an existing file
 * rather than overwriting one, so the caller has to be told the name it ended
 * up with before it can link to it. */
export interface UploadEntryResponse {
  path: string;
  name: string;
}

export interface MoveEntryResponse {
  path: string;
  /** Space paths whose references the move rewrote (docs/architecture.md's
   * Moves and references). A client holding one of these open must reload it
   * before its next save, or the stale buffer overwrites the rewrite. */
  rewritten?: string[];
  /** What the move broke and the rewrite could not repair — shown to the
   * user, never a reason to fail the move. */
  warnings?: string[];
}

export interface DeleteEntryResponse {
  path: string;
  // How many already-published deleted documents couldn't be unpublished
  // immediately (no publisher key, Unpublish not live, a network error) and
  // remain queued in that site's `_queue.json` — see docs/publishing.md's
  // Pending queue section. The delete itself succeeds regardless.
  pendingUnpublish: number;
}

// GET /api/space/trash: the top level of the space's `.trash/`, in tree order.
export interface TrashEntry {
  name: string;
  type: "file" | "directory";
}

export interface TrashResponse {
  entries: TrashEntry[];
}

// GET /api/space/sort-keys: the frontmatter keys that hold a sortable value
// in at least one of the directory's entries, most widely used first.
export interface SortKeysResponse {
  keys: string[];
}

// ---- /api/space/bookmarks: the space's bookmarks

// One bookmark, and what it names on disk as it was read. A path naming
// nothing has no `type`: it is kept, and shown as missing.
export interface SpaceBookmark {
  path: string;
  type?: "file" | "directory";
}

// The bookmarks `.pragma/bookmarks.json` holds, in its order. `problem`
// says why a file that exists can't be read: it then holds none, and a
// change is refused until the file is fixed.
export interface SpaceBookmarksResponse {
  bookmarks: SpaceBookmark[];
  problem?: string;
}

// ---- /api/space/presets: the folders the space's `_presets.json` lists

// One listed folder, as this host finds it. `path` is the folder rooted and
// spelled as found, `library` the library holding one outside the space.
// `missing` says why it holds nothing here: its folder is gone, or its
// library isn't located on this computer. A templates folder answers its
// templates, a LUTs folder its LUTs, each path rooted.
export interface PresetFolderView {
  kind: PresetKind;
  written: string;
  path: string;
  library?: { id: string; label: string };
  missing?: "folder" | "library";
  templates?: TemplateEntry[];
  luts?: LutEntry[];
}

// Every listed folder, kind by kind, each kind's in file order. GET answers
// it; POST takes one PresetChange and answers it as it then stands.
// `problem` says why a file that exists can't be read: it then lists none,
// and a change is refused until the file is fixed.
export interface SpacePresetsResponse {
  folders: PresetFolderView[];
  problem?: string;
}

// ---- /api/space/tags: the declared tags

// The tags `_tags.json` declares, in its order. `problem` says why a file
// that exists can't be read: it then declares none, and a change is refused
// until the file is fixed. `used` holds the tags the space's documents carry
// that no entry declares, each once, spelled as most of them write it,
// in name order.
export interface SpaceTagsResponse {
  tags: TagDefinition[];
  used?: string[];
  problem?: string;
}

// ---- /api/space/graph

// What a graph node stands for: a file by its kind, a folder, a tag, or a
// path a document names where nothing is.
export type GraphNodeKind =
  | "note"
  | "screenplay"
  | "table"
  | "class"
  | "flow"
  | "applet"
  | "image"
  | "video"
  | "pdf"
  | "file"
  | "folder"
  | "tag"
  | "missing";

// How one entry reaches another: a note's link or embedded image, a Class's
// row or link, a path a Table, Flow or Applet holds, a tag a document
// carries, or a folder holding an entry.
export type GraphEdgeKind =
  | "link"
  | "embed"
  | "member"
  | "classLink"
  | "tablePath"
  | "flowRead"
  | "flowWrite"
  | "flowApplet"
  | "appletImport"
  | "tag"
  | "contains";

// A scope nodes sit in: "" for the space's own, a folder an AGENTS.md opens
// one over, or `lib:<id>` for a library, which is one scope.
export interface GraphScope {
  id: string;
  name: string;
  parent: string | null;
  library?: true;
}

// `id` is the entry's rooted path, a folder's ending in `/`; a tag's is `#`
// and its folded name, a missing target's `?` and the path as read. `scope`
// is a GraphScope's id, null for a tag. `opensScope` marks the AGENTS.md
// opening its scope, `preset` an entry in a listed preset folder; `color` is
// a tag's, from `_tags.json`.
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  scope: string | null;
  opensScope?: true;
  preset?: true;
  library?: true;
  color?: string;
}

// `from` and `to` index the response's nodes. `crosses` marks a path written
// across a scope's edge; `weight` counts how often one entry reaches the
// other that way, when more than once.
export interface GraphEdge {
  from: number;
  to: number;
  kind: GraphEdgeKind;
  crosses?: true;
  weight?: number;
}

// The space as a graph: every entry the tree shows, the tags, library files
// and missing targets its documents reach, and the scopes they sit in,
// parents before children.
export interface SpaceGraphResponse {
  scopes: GraphScope[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---- /api/file, /api/prompt/save

// One Flow resolved as a toolkit for a text document: the Classes holding
// it can link more than one (docs/protocol.md's Toolkit resolution), so this
// is an array on TextFileResponse. Only its buttons come down with the
// document; the graph is read fresh when one is clicked, as every Flow run
// reads it.
export interface TextToolkitInfo {
  // The Class that gave the document this toolkit, holding it as a row.
  classPath: string;
  path: string;
  // The flow's display name; empty falls back to its file name.
  name: string;
  actions: FlowAction[];
}

/** The files a Class holding the document as a row links it to that are
 * neither a Flow nor a template, for the document's Links tab. */
export interface ClassLinks {
  classPath: string;
  // The Class's title, else its file's name.
  name: string;
  // Rooted, each an existing file.
  paths: string[];
}

export interface TextFileResponse {
  kind: "text";
  path: string;
  // Opaque token for the exact bytes this response was read from — echo it
  // as PutFileRequestBody.baseRevision. Named apart from `version`, which a
  // Table, Class or Flow already uses for its format version.
  revision: string;
  content: string;
  documentType: DocumentType;
  toolkits: TextToolkitInfo[];
  classLinks: ClassLinks[];
  // The fields the Classes holding it give its properties, one per key.
  fields: TableColumn[];
}

// Why a Table, Class or Flow opens read-only: `newer-format` names a format
// major this build doesn't write, `unreadable` is non-blank markup it couldn't
// parse at all, sent as an empty document. Saving either back would drop
// what wasn't read (docs/protocol.md's "Reading and write protection").
export type DocumentLock = "newer-format" | "unreadable";

export interface TableFileResponse {
  kind: "table";
  path: string;
  revision: string;
  version: string;
  name?: string;
  metadata?: MetadataEntry[];
  columns: TableColumn[];
  rows: TableRow[];
  // What the file says it opens as; absent means the list.
  layout?: TableLayout;
  // The layout picked for it on this install, which it opens in over
  // `layout`; absent where none was.
  localLayout?: TableLayout;
  // A row card's tiles; absent shows every column.
  card?: CardTile[];
  // The tiles of the card a cards view draws; absent composes it.
  smallCard?: SmallCardTile[];
  // Set only when a host must not save over this file.
  locked?: DocumentLock;
  // Nothing is at the path. It still reads as a new, empty Table; a caller
  // that syncs from the columns must not take it for one whose columns went.
  missing?: true;
}

export interface AppletFileResponse {
  kind: "applet";
  path: string;
  revision: string;
  manifest: AppletManifest;
  // The raw file, what the frame runs and Source mode edits.
  html: string;
  // The file's and its imports' hash, which an Applet node records.
  contentHash: string;
  // The manifest's imports, read for the frame, in manifest order. When one
  // can't be, `importError` says why and the Applet doesn't run.
  imports: AppletImportSource[];
  importError?: string;
}

export interface AppletImportSource {
  specifier: string;
  // Space-relative, as resolved.
  path: string;
  // The module the frame imports: the file's own text, or for a model, a
  // module exporting its bytes.
  source: string;
}

export interface FlowFileResponse {
  kind: "flow";
  path: string;
  revision: string;
  version: string;
  name?: string;
  metadata?: MetadataEntry[];
  graph: FlowGraph;
  // Whether this install shows App mode, which it opens in over the graph's
  // `appModeActive`; absent where it was never switched here.
  localAppMode?: boolean;
  // Set only when a host must not save over this file.
  locked?: DocumentLock;

  // Derived from the graph on every read, never stored — see flowNodes.ts.
  capabilities: FlowCapabilityDeclaration[];
  // Scoped to the capability digest rather than the whole file, so a Flow's
  // grants survive edits that don't change what a run does.
  grantedCapabilities: string[];
  // Whether the agent API may run this Flow with nobody at the canvas.
  runsUnattended: boolean;
  // The last day that leave was given, `YYYY-MM-DD`, passed or not. Absent
  // for a leave given until revoked, and for none.
  unattendedUntil?: string;
}

// A Class's definition. Its rows are its notes', read apart (see
// ClassRowsResponse), since they change as the notes do.
export interface ClassFileResponse extends ClassFile {
  kind: "class";
  path: string;
  revision: string;
  // Set only when a host must not save over this file.
  locked?: DocumentLock;
}

export type FileResponse =
  | TextFileResponse
  | TableFileResponse
  | ClassFileResponse
  | AppletFileResponse
  | FlowFileResponse;

// GET /api/file/sha256 — the lowercase hex SHA-256 of any file's bytes, the
// whole file regardless of size. A folder is a 400.
export interface FileSha256Response {
  sha256: string;
}

// GET /api/file/description — any entry's description (docs/protocol.md's
// Descriptions), read from disk; absent where it has none.
export interface FileDescriptionResponse {
  description?: string;
}

/** Where a note links to a document: the line, counted from 1 over the whole
 * file, as written, and where on it the link's path starts and how long it
 * is. */
export interface BacklinkMention {
  line: number;
  text: string;
  at: number;
  length: number;
}

/** A note whose own text links to a document, by its rooted path. */
export interface Backlink {
  path: string;
  mentions: BacklinkMention[];
}

// GET /api/file/backlinks — the notes linking to a document, its Links tab's
// Backlinks. A library document's come from its library and the space.
export interface BacklinksResponse {
  backlinks: Backlink[];
}

// GET /api/file/info — what the filesystem says about any entry the tree
// lists, file or folder, whatever its kind; "" is the space's own folder.
// `modified` is an ISO timestamp; `size` is in bytes and means nothing for a
// directory.
//
// `name` is the entry's whole name, extension included, and `systemFolder`
// the folder holding it on disk, as the operating system spells it: absent
// where no local disk is behind the engine.
export interface FileInfoResponse {
  kind: "file" | "directory";
  name: string;
  size: number;
  modified: string;
  systemFolder?: string;
}

// GET /api/file/system-path: where a space or `lib:` path sits on disk, as
// the operating system spells it, whether or not anything is there. Copy
// path's "from system root", which a chip naming a missing file offers too.
export interface SystemPathResponse {
  systemPath: string;
}

// GET /api/file/pixel-format — a raster image's color model, read from its
// header. `bitDepth` is bits per channel, or per palette index for
// `indexed`. `alpha` is a true alpha channel only: a palette's transparent
// entry is not one. With it, the IPTC source type its XMP declares, as in
// PictureDetails. An SVG or a non-image is a 400, a header that doesn't parse a 422.
export interface PixelFormatResponse {
  colorModel: "grayscale" | "rgb" | "cmyk" | "indexed";
  alpha: boolean;
  bitDepth: number;
  sourceType: string | null;
}

/** A raster image's pixels as its header gives them: the pixel format
 * without the source type. */
export type PixelFormat = Omit<PixelFormatResponse, "sourceType">;

// GET /api/file/video-format — a clip's ClipHeaderResponse, read from the
// container's header; a non-video is a 400, a header that doesn't parse a
// 422. `codec` is a display name ("H.264", "ProRes 422 HQ"), or the
// container's own code when unnamed here. `frameRate` is exact for a constant
// rate, the average when `variableFrameRate`, null when the header doesn't say.
export interface VideoFormatResponse {
  codec: string | null;
  frameRate: number | null;
  variableFrameRate: boolean;
}

/** What the host reads of a clip's header for its folder entry: the codec
 * and frame rate, the picture's bits per sample, an HDR transfer (`pq`,
 * `hlg`; null is SDR), transparency, the first audio track, and the first
 * frame's timecode (`01:00:00:00`, a `;` before the frames when drop-frame). */
export interface ClipDetails extends VideoFormatResponse {
  bitDepth: number | null;
  hdr: "pq" | "hlg" | null;
  alpha: boolean;
  audio: { codec: string; channels: number | null } | null;
  startTimecode: string | null;
}

/** A clip's details with the displayed size and the length its header
 * gives, which stand in for the browser's where it can't decode the clip. */
export interface ClipHeaderResponse extends ClipDetails {
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** What the host reads of a picture's header for its folder entry: the IPTC
 * digital source type its XMP declares (`trainedAlgorithmicMedia`,
 * `digitalCapture`), or null where it names none, and its pixels, or null
 * where the header doesn't give them. */
export interface PictureDetails {
  sourceType: string | null;
  pixels: PixelFormat | null;
}

// POST /api/file/thumbnail-facts?path=&version= — for a clip the browser
// couldn't decode, its facts read from its header and kept in place of a
// thumbnail; a 409 when the file changed since `version`, a 422 when the
// header doesn't give its picture's size.
export interface ClipFactsResponse {
  width: number;
  height: number;
  duration?: number;
  clip: ClipDetails;
}

// GET /api/thumbnails — what the install's thumbnails take; POST
// /api/thumbnails/clear drops them all, to be made again as galleries show
// their files.
export interface ThumbnailUsageResponse {
  bytes: number;
  count: number;
}

// The `created`/`updated` bookkeeping dates a save stamps into a document
// eligible for them (a note, not private, inside a site — docs/publishing.md's
// Frontmatter fields section). The server wrote these into the file a moment
// after the client's own save, so the client folds them into its live
// working copy.
export interface SavedDocumentDates {
  created: string;
  updated: string;
}

// `/api/file`'s PUT reply. `revision` is the file's revision after the whole
// save, date stamping included — the base the next save must name.
export interface PutFileResponse {
  revision: string;
  dates?: SavedDocumentDates;
}

// ---- /api/sandbox/*: the broker

// Whose declarations and grants a sandbox request is checked against: a
// Flow's, the one kind whose documents declare capabilities.
export type SandboxKind = "flow";

/** A clip a granted read found, by reference: never its bytes, which can
 * run to gigabytes. `digest` is the SHA-256 of the bytes as hex; the rest is
 * what its header gives, null where it gives nothing, and `frameRate` is an
 * average where `variableFrameRate` says the rate varies. */
export interface ClipFacts {
  mediaType: string;
  digest: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  frameRate: number | null;
  variableFrameRate: boolean;
}

// What a granted read comes back as: a table or image already parsed —
// there is no table-HTML parser in the browser, and image bytes can't be read
// as text — a clip's facts, or any other file's text.
export type SandboxReadResult =
  | { kind: "table"; columns: TableColumn[]; rows: TableRow[] }
  | { kind: "image"; mediaType: string; data: string }
  | ({ kind: "video" } & ClipFacts)
  | { kind: "text"; content: string };

// A generation's reply is the dispatch result itself, unwrapped.
export type GenerateResponse = GenerateResult;
export type GenerateOptionsResponse = ActionResult;

// ---- /api/providers, /api/models

// `chatgpt` is a ChatGPT sign-in: requests run on the person's ChatGPT plan,
// never on a key. `vercel` is Vercel's AI Gateway, one key for many makers'
// models.
export type ProviderKind = "anthropic" | "openai" | "google" | "vercel" | "chatgpt";

// A `chatgpt` provider's sign-in. `planUsage` is whether the person let
// Pragma use their ChatGPT plan: signed in without it, no request is sent.
// `message` says why the last attempt failed; it lasts until the next one.
export interface ProviderSignInStatus {
  state: "signed-in" | "signed-out" | "pending";
  email?: string;
  planUsage?: boolean;
  message?: string;
}

// Where a person reviews what each app spends of their ChatGPT plan, and caps it.
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

// How a secret is held at rest — drives Settings' honest storage copy.
export interface CredentialStoreDescription {
  kind: "plain-files" | "safe-storage";
  encrypted: boolean;
  available: boolean;
}

// One resolved provider, with enough to render and edit its row — but never
// a key value, only whether and whence one resolves. `vendor` is set as on
// ModelProviderSummary below.
export interface ProviderRow {
  id: string;
  label: string;
  kind: ProviderKind;
  baseURL: string;
  vendor?: ProviderKind;
  textModels: string[];
  imageModels: string[];
  videoModels: string[];
  // Where the key comes from. "unreadable" is a key saved but not usable
  // here, with `keyProblem` saying why and what to do.
  keySource: "stored" | "env" | "none" | "unreadable";
  keyProblem?: string;
  // Set for a provider that signs in instead of taking a key.
  signIn?: ProviderSignInStatus;
}

export interface ProvidersResponse {
  providers: ProviderRow[];
  store: CredentialStoreDescription;
  // Whether this host can sign in: the sign-in page returns to a loopback
  // address, which only a browser on this machine reaches.
  signInAllowed: boolean;
}

// One enabled model across every configured provider, as a
// "<providerId>/<model>" ref.
export interface ModelOption {
  id: string;
  label: string;
}

// How much effort a model spends on a turn, least first: a slice of the AI
// SDK's provider-neutral reasoning scale, which each provider's package turns
// into its own setting. Its order is the one a pick moves along to the
// nearest level a model takes.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel);
}

/**
 * The level a call sends for `pick`: the model's own level nearest it, or
 * none when the pick is the default, isn't a level, or the model takes none.
 */
export function effortFor(
  pick: string | undefined,
  levels: readonly EffortLevel[] | undefined,
): EffortLevel | undefined {
  const wanted = EFFORT_LEVELS.indexOf(pick as EffortLevel);
  if (wanted < 0 || !levels?.length) return undefined;
  const distance = (level: EffortLevel) => Math.abs(EFFORT_LEVELS.indexOf(level) - wanted);
  return levels.reduce((nearest, level) => (distance(level) < distance(nearest) ? level : nearest));
}

// What the copilot may do in a turn. Viewing reads and answers; Suggesting
// shows every change for the writer to accept; Editing applies changes the
// moment they arrive, each with an Undo. The server enforces a mode through
// the tools it hands the model, never through the prompt alone.
export const CHAT_MODES = ["viewing", "suggesting", "editing"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

// A model as a picker groups it: under `provider`, by `model`, what that
// provider calls it (an MCP server names its models apart from their ids).
// `effortLevels` lists the levels it takes, least first, and is absent where
// Pragma can't tell what a level would do.
//
// `references` is how many of each kind it takes and `frames` which frames,
// from the host's model support file, each absent where unknown.
export interface GroupedModelOption extends ModelOption {
  provider: string;
  model: string;
  effortLevels?: EffortLevel[];
  references?: ReferenceCounts;
  frames?: FrameKind[];
  // A video model's sizes in its catalog's own names; empty for one that
  // takes no size.
  resolutions?: string[];
  settings?: ModelSetting[];
}

/** A setting a model takes beyond its node's own inputs, as its provider's
 * catalog describes it: a choice among `options`, an on/off switch, or a
 * number from `min` to `max`. Left unset, the provider's default applies. */
export interface ModelSetting {
  name: string;
  kind: "choice" | "switch" | "number";
  options?: Array<string | number>;
  min?: number;
  max?: number;
  default?: ModelSettingValue;
  required?: boolean;
  description?: string;
}

export type ModelSettingValue = string | number | boolean;

export interface ReferenceCounts {
  image?: number;
  video?: number;
  audio?: number;
}

// A provider, or a server switched on for Flows, as a picker heads its
// models. `vendor` is set only for an entry with no baseURL, the one that
// talks to its kind's own endpoint: an LM Studio entry is the `openai` kind
// too, and must not wear OpenAI's mark.
export interface ModelProviderSummary {
  id: string;
  label: string;
  vendor?: ProviderKind;
}

// `defaultModel` is config.json's `defaultTextModel`, the model a call that
// names none runs on; null is none, and such a call fails.
export interface ModelsResponse {
  models: GroupedModelOption[];
  providers: ModelProviderSummary[];
  defaultModel: string | null;
}

// Every image model the providers list and the Flows-enabled MCP servers
// offer, as "<providerId>/<model>" refs. A server whose list couldn't be read
// is named in `failures` instead of failing the whole list. `defaultModel` is
// config.json's `defaultImageModel`.
export interface ImageModelsResponse {
  models: GroupedModelOption[];
  providers: ModelProviderSummary[];
  defaultModel: string | null;
  failures: Array<{ server: string; message: string }>;
}

// The same listing for video models; `defaultModel` is `defaultVideoModel`.
export type VideoModelsResponse = ImageModelsResponse;

// Settings → AI Models' defaults, one route each: a ref from that kind's list,
// or "" for none.
export interface DefaultModelRequestBody {
  model: string;
}

// What a provider's endpoint serves, split by how Pragma calls a model:
// `imageModels` and `videoModels` are the ids its kind makes images and
// videos with, `textModels` the rest.
export interface DiscoverModelsResponse {
  textModels: string[];
  imageModels: string[];
  videoModels: string[];
}

// The JSON error body the provider, publisher, and publishing routes use.
// `need` is there when a setting fixes the refusal.
export interface ErrorBody {
  message: string;
  need?: SetupNeed;
}

// ---- /api/sharing

// The bucket Pragma shares files from when a provider fetches them by link:
// where it is and whose access key reads it, never the secret, only whether
// one is saved and usable.
export interface SharingRow {
  kind: "s3";
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  keySource: "stored" | "none" | "unreadable";
  keyProblem?: string;
}

export interface SharingResponse {
  sharing: SharingRow | null;
  store: CredentialStoreDescription;
}

// The fields replace what's saved. A `secretAccessKey` is kept only once a
// file has gone into the bucket, out by its link and been deleted again;
// left out, the saved secret stays.
export interface SaveSharingRequestBody {
  endpoint: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey?: string;
}

// ---- /api/mcp-servers

// A server's OAuth sign-in. `message` says why the last attempt failed, or
// that a sign-in expired; it lasts until the next attempt.
export type McpSignInState = "signed-in" | "signed-out" | "pending";

export interface McpSignInStatus {
  state: McpSignInState;
  message?: string;
}

// One configured MCP server, with enough to render and edit its row — never
// the token value, only whether one is stored.
export interface McpServerRow {
  id: string;
  label: string;
  url: string;
  keySource: "stored" | "none" | "unreadable";
  keyProblem?: string;
  // A sign-in is used ahead of a stored token.
  signIn: McpSignInStatus;
  copilot: boolean;
  // Whether pragma's own nodes may use the server; `flowsAvailable` says
  // whether any node can, which decides whether the switch is offered.
  flows: boolean;
  flowsAvailable: boolean;
}

export interface McpServersResponse {
  servers: McpServerRow[];
  store: CredentialStoreDescription;
  // Whether this host can sign in: the sign-in page returns to a loopback
  // address, which only a browser on this machine reaches.
  signInAllowed: boolean;
}

// What POST /api/mcp-servers/connect found. A server that refused for want of
// credentials has a sign-in started when it offers OAuth and this host can
// sign in; otherwise it needs a token.
export type McpServerConnectResponse =
  | { state: "connected"; tools: string[] }
  | { state: "sign-in"; authorizationUrl: string }
  | { state: "needs-token"; message: string };

// What POST /api/mcp-servers/sign-in answers: the page to approve the
// sign-in on, for the person's own browser.
export interface McpSignInStartResponse {
  authorizationUrl: string;
}

// ---- /api/publishers, /api/space/site, /api/space/publish

export type PublisherKind = "sogma";

export interface PublisherRow {
  id: string;
  label: string;
  kind: PublisherKind;
  baseURL: string;
  configured: boolean;
  keySource: "stored" | "none" | "unreadable";
  keyProblem?: string;
}

export interface PublishersResponse {
  publishers: PublisherRow[];
  store: CredentialStoreDescription;
}

export interface PublisherSaveResult {
  // Set when the verification call itself failed (network error) even though
  // the key was still accepted ("can't disprove it") — see publisher.ts.
  error?: string;
}

// A site as Sogma knows it. New Site's error body carries one back when the
// remote create succeeded but local scaffolding then failed and the automatic
// rollback couldn't confirm the site was gone — a retry sends it back so the
// route redoes only the local steps against that same site instead of
// minting a second one.
export interface ExistingSogmaSite {
  id: string;
  slug: string;
  name: string;
  domain?: string;
  primaryDomain: string | null;
}

export interface CreateSiteResponse {
  path: string;
  siteId: string;
  siteSlug: string;
}

export interface CreateSiteErrorBody extends ErrorBody {
  existingSite?: ExistingSogmaSite;
}

// ---- /api/space/site/settings

// One editable site setting, already resolved from the publisher's own
// settings schema (protocol/settingsSchema.ts) so the client never parses
// JSON Schema itself. `pointer` is the field's JSON Pointer into the
// service's settings object and doubles as the form control's id; `value`
// is what it currently holds.
interface SiteSettingsFieldBase {
  pointer: string;
  label: string;
  description?: string;
  placeholder?: string;
  group?: string;
}

// Text, "" for unset. An image field's value is the `public_id` of a file
// the site holds.
export interface SiteSettingsTextField extends SiteSettingsFieldBase {
  kind?: "image";
  value: string;
  // What an image field's current file looks like, when it holds one.
  preview?: SiteImagePreview;
}

// An on/off switch, which has no unset state to show.
export interface SiteSettingsToggleField extends SiteSettingsFieldBase {
  kind: "toggle";
  value: boolean;
}

export type SiteSettingsField = SiteSettingsTextField | SiteSettingsToggleField;

// A file the publisher holds, as the form shows it. `url` is null until the
// service has finished checking the file, or when it can't be read; `label`
// then says which.
export interface SiteImagePreview {
  url: string | null;
  label: string;
}

// Uploads one space image to a site's publisher, for an image setting. The
// setting itself changes only on Save, which sends the returned `publicId`.
export interface SiteImageUploadRequestBody {
  path: string;
  image: string;
}

export interface SiteImageUploadResponse {
  publicId: string;
  preview: SiteImagePreview;
}

export interface SiteSettingsResponse {
  // The site's name as the publisher holds it, or `_site.json`'s copy when
  // the publisher's couldn't be read. Titles the dialog and fills its Name.
  siteName: string;
  // Set when the read found `_site.json`'s copy of the name out of date and
  // rewrote it, so the views that show the copy can reload.
  siteNameUpdated?: boolean;
  // The label of the publisher this site is bound to, which only the server
  // can name: a `_site.json` without a `publisherId` resolves to the first
  // configured publisher, so the client can't derive it from the site alone.
  publisherLabel: string;
  fields: SiteSettingsField[];
  // How many settings the publisher declares that this pragma can't draw.
  // Surfaced rather than silently dropped, so nobody hunts for a setting
  // the service has and the form doesn't show.
  skipped: number;
  // The site's own assets folder from `_site.json`, "" when unset. Local
  // to the space, unlike `fields`, which the publisher holds.
  assetsFolder: string;
}

// What one Save changes, and nothing else. `edits` are the publisher's
// settings keyed by pointer, as a merge patch: anything absent stays
// untouched, which keeps a write from clobbering settings this pragma never
// rendered. `null` clears one; a toggle is sent as `true` or `false`.
// `name` and `assetsFolder` ("" clears it) are present only when changed.
export interface SiteSettingsChanges {
  edits: Record<string, string | boolean | null>;
  name?: string;
  assetsFolder?: string;
}

export interface SaveSiteSettingsRequestBody extends SiteSettingsChanges {
  path: string;
}

// What `_site.json` holds after a Save: the name the publisher stored,
// which it trims, and the assets folder as a site-relative path.
export interface SaveSiteSettingsResponse {
  siteName: string;
  assetsFolder: string;
}

// The keys a refusal blames General's two fields with. A setting is blamed
// by its `SiteSettingsField.pointer`, which always starts with "/".
export const SITE_NAME_FIELD = "name";
export const SITE_ASSETS_FOLDER_FIELD = "assetsFolder";

// A rejected Save names the control to blame where it can, so the dialog
// can point at it instead of at the whole form.
export interface SiteSettingsErrorBody extends ErrorBody {
  field?: string;
}

/** Something a publish did to the body that the file on disk does not show.
 * `warn` is an embed left as written, which is a broken image on the live
 * page; `info` is a choice worth knowing about that cost nothing, such as an
 * image sent from outside the site folder. */
export interface PublishNote {
  level: "info" | "warn";
  text: string;
}

export interface PublishDocumentResponse {
  id: string;
  url: string;
  pushed: string;
  /** The publication date a first push added to the frontmatter, when it
   * added one (docs/publishing.md's Publishing a document section). */
  date?: string;
  // Empty when a publish has nothing to report — see docs/publishing.md's
  // Images section.
  notes: PublishNote[];
  // Every file the publish wrote back into: each section `index.md` it
  // published first, then the document itself.
  writeBacks: PublishWriteBack[];
}

// One file a publish wrote `id`/`pushed` (and a first push's `date`) into.
// `revision` is the file's revision after that write: an editor holding the
// file open bases its next save on it, or that save is refused as stale.
export interface PublishWriteBack {
  path: string;
  revision: string;
  id: string;
  pushed: string;
  date?: string;
}

// ---- /api/find-context, /api/chat

export type FindContextResponse = FindContextResult;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The range the writer has selected in the editor, from one cursor
 * position to another. Lines are whole-file numbers, the ones the gutter
 * shows, which for a note count the frontmatter and lifted
 * heading its text area never displays. Both count from 1, and a column
 * counts UTF-16 code units, as the editor's own positions do. */
export interface SelectedRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

// A proposed rewrite of a whole file. `before` is the text the copilot based
// it on, so the client diffs exactly the change it meant to make, even when
// the file has moved on since.
export interface ProposedFileEdit {
  path: string;
  before: string;
  newContent: string;
  // The file's revision when `before` was read. A write nobody reviewed names
  // it as its base, so it refuses a file that has changed since.
  revision: string;
}

export interface ChatResponse {
  reply: string;
  // Set when the copilot proposes an edit to the document on screen. The
  // client draws it over the open document for the writer to accept or
  // reject; nothing is written until they do.
  currentDocumentEdit?: ProposedFileEdit;
  // Set when the copilot proposes creating a document. `content` is present
  // when the file should be born with text (a new applet, say) rather than
  // empty — the confirm card shows it as a diff before the writer accepts.
  proposedDocument?: {
    parentPath: string;
    name: string;
    type: "file" | "directory";
    content?: string;
  };
  // Set when the copilot proposes rewriting an existing space file that isn't
  // the one currently open. `before` is the file's current text, sent down so
  // the confirm card can render the diff without a second fetch.
  proposedEdit?: ProposedFileEdit;
  // The images the copilot looked at this turn, by space path: each one was
  // sent to the model, which the writer is told under the reply.
  lookedAt?: string[];
}

// ---- /api/git/*

export interface GitFileEntry {
  path: string;
  // Two-char git short-status code (index + working_dir), e.g. "M ", "??".
  statusCode: string;
}

export type GitStatus =
  | { isRepo: true; restricted?: false; branch: string | null; ahead: number; behind: number; files: GitFileEntry[] }
  // A repository was found but the space isn't trusted, so no git command ran.
  // `trust` says whether the person has been asked; `parentRepo` is the
  // repository's root when it sits above the space rather than at it.
  | { isRepo: true; restricted: true; trust: "undecided" | "declined"; parentRepo?: string }
  | { isRepo: false };

// What a git action did, for a client holding editor buffers over the same
// working tree. Only pull and sync rewrite files, so only they report
// `changedPaths`/`deletedPaths` — space-relative, spelled as GitFileEntry
// spells them, so a caller re-reads exactly what moved rather than reloading
// everything it has open.
export interface GitActionResponse {
  status: GitStatus;
  changedPaths?: string[];
  deletedPaths?: string[];
}

// ---- /api/applet/info, /api/updates/check

export interface AppletInfoResponse {
  version: string;
  /** The page that holds this version's release notes. Absent when the build
   * links none, and the Release notes link stays hidden. */
  releaseNotesUrl?: string;
}

// The full update lifecycle. A check that installs nothing (a browser tab's,
// the macOS desktop app's) reports only "checking", "available",
// "not-available" and "error"; the desktop app on Windows and Linux adds the
// download phases, and an unpackaged build answers "unsupported".
//
// `downloadUrl`: where to download a release the app can't install itself.
export type UpdateStatus =
  | { phase: "checking" }
  | { phase: "available"; version: string; downloadUrl?: string }
  | { phase: "not-available" }
  | { phase: "downloading"; percent: number }
  | { phase: "downloaded"; version: string }
  | { phase: "error"; message: string }
  | { phase: "unsupported" };

// The misspelled word a right-click in the desktop app landed on, as
// Chromium reports it, with its dictionary's suggestions.
export interface Misspelling {
  word: string;
  suggestions: string[];
}

// The languages the desktop app's spellchecker checks a word against, and
// every language it has a dictionary for.
export interface SpellcheckLanguages {
  chosen: string[];
  available: string[];
}

// What a Pragma link asks of the desktop app's window, once the space it
// names is open: an entry to open there ("" for the space itself), or why
// the link opens nothing.
export type LinkRequest = { open: { path: string; folder: boolean } } | { refusal: string };

// The desktop app's macOS menu bar as the page describes it, for the main
// process to draw. A pick of a command item comes back to the page as its
// command and argument; a role is one of macOS's own items, run by the
// system. A chord is in the keybinding grammar, canonical.
export type MenuBarRole =
  | "about"
  | "services"
  | "hide"
  | "hideOthers"
  | "unhide"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "pasteAndMatchStyle"
  | "delete"
  | "selectAll"
  | "close"
  | "togglefullscreen"
  | "toggleDevTools"
  | "minimize"
  | "zoom"
  | "front";

export type MenuBarItem =
  | { separator: true }
  // `chord` replaces the role's own shortcut.
  | { role: MenuBarRole; chord?: string }
  | { label: string; submenu: MenuBarItem[] }
  // Without a command, a line that only says something.
  | { label: string; command?: string; arg?: unknown; enabled: boolean; checked?: boolean; chord?: string };

export interface MenuBarMenu {
  label: string;
  // The Window or Help menu, which macOS adds its own items to.
  role?: "window" | "help";
  items: MenuBarItem[];
}

// ---- Request bodies. A handler that trusts its body reads it as the type;
// one that validates reads it as Partial<> (or with every field unknown, see
// routes/shared.ts) and narrows. No route reads a field these don't name.

// /api/space: switch, init, layout

export interface SwitchSpaceRequestBody {
  path: string;
}

// Each folder list and the groups may be sent alone; the server writes
// whichever are present.
export interface LayoutRequestBody {
  collapsedFolders?: string[];
  expandedFolders?: string[];
  groups?: LayoutGroup[];
  focusedGroup?: number;
}

// /api/space: entries, binder order, folder properties

export interface CreateEntryRequestBody {
  parentPath: string;
  name: string;
  type: "file" | "directory";
  // Optional seed text for a new file — the copilot's propose_create_document
  // sends this when it's scaffolding a file with content; the tree's own
  // "New note" button omits it and gets an empty file.
  content?: string;
}

// POST /api/space/create-from-template: a copy of the template at
// `template`, made in `parentPath` under the name typed for it. The path is
// rooted, in a folder the space's `_presets.json` lists for templates, or
// with `source` "pragma" one GET /api/templates lists. The reply is
// CreateEntryResponse.
//
// `now`, the writer's local time with its offset, as
// `2026-11-09T14:30:05+01:00`, is the moment its dates take; without it,
// the host's own.
export interface CreateFromTemplateRequestBody {
  template: string;
  parentPath: string;
  name: string;
  source?: "space" | "pragma";
  now?: string;
}

// GET /api/space/template-name?template=&source=&now=: the name a copy of
// that template starts with before its writer types one, "" for none.
export interface TemplateNameResponse {
  name: string;
}

// GET /api/templates: Pragma's own templates, which New ▸ Template offers
// after the space's.
export interface PragmaTemplatesResponse {
  templates: TemplateEntry[];
}

// POST /api/space/upload has no request-body shape to name: it carries the
// file's raw bytes, with `dir` and `name` as query parameters. The one write
// route that isn't a JSON envelope — base64 inside JSON would inflate every
// image by a third on the way to a local disk, and the bytes have no fields
// for a contract to pin. The reply is UploadEntryResponse.

export interface MoveEntryRequestBody {
  from: string;
  to: string;
}

// POST /api/space/duplicate — a file only. The copy's name is chosen by the
// server, so the reply is a CreateEntryResponse naming the path it made.
export interface DuplicateEntryRequestBody {
  path: string;
}

export interface DeleteEntryRequestBody {
  path: string;
  trash?: boolean;
}

// GET and POST /api/trash-settings: whether Delete offers to move to the
// trash, one answer for every browser on the host. It only picks what the
// confirmation offers: the delete request carries the choice that was
// confirmed, so a change made elsewhere meanwhile never turns a trash into a
// permanent delete.
export interface TrashSettings {
  moveToTrash: boolean;
}

// GET and POST /api/file-type-settings: whether the space lists every file,
// not only those Pragma opens, one answer for every browser on the host.
export interface FileTypeSettings {
  showAllFileTypes: boolean;
}

// /api/history/* — earlier versions of the space's files, kept as host state.

/** Who made the change that replaced a version's text: your own save, an
 * accepted copilot edit, a Flow's write or its accepted proposal, links
 * updated after a move, a publish stamp, a restore, or a change made outside
 * Pragma. */
export type HistorySource = "edit" | "copilot" | "flow" | "links" | "published" | "restored" | "outside";

export interface HistoryVersion {
  id: string;
  /** When it was kept, in milliseconds since the epoch. */
  time: number;
  source: HistorySource;
  /** The Flow that made the change, by its space path. */
  detail?: string;
}

export interface HistoryFile {
  path: string;
  /** When its newest version was kept. */
  latest: number;
}

export interface HistoryFilesResponse {
  files: HistoryFile[];
}

export interface HistoryVersionsResponse {
  versions: HistoryVersion[];
}

export interface HistoryVersionResponse {
  content: string;
  /** The text of the version kept next, which this version's change left;
   * absent for the newest version, whose change left `current`. */
  next?: string;
  /** The file's text now; absent once the file is gone. */
  current?: string;
}

export interface HistorySettings {
  keepHistory: boolean;
}

// POST /api/space/trash/delete — one entry of the trash by its bare name.
// Emptying the whole trash is its own route, POST /api/space/trash/empty, so
// no missing field can ever mean "everything".
export interface DeleteFromTrashRequestBody {
  name: string;
}

// POST /api/space/trash/move — one entry of the trash, by its bare name, into
// `dir`, a folder of the space ("" is its top level). The reply names where
// it landed: a name already taken there is stepped around.
export interface MoveFromTrashRequestBody {
  name: string;
  dir: string;
}

export interface MoveFromTrashResponse {
  path: string;
}

// POST /api/space/local-sort: how one folder, in any root, lists on this
// install. `sort: null` shows its own order. `arrangement` is a dragged
// order's entry names; null forgets the one kept, absent keeps it.
export interface LocalSortRequestBody {
  dir: string;
  sort: SortChoice | null;
  arrangement?: string[] | null;
}

// POST /api/space/folder-layout: how a gallery draws one folder, in any
// root, on this install.
export interface FolderLayoutRequestBody {
  dir: string;
  layout: FolderLayout;
}

// POST /api/space/table-layout: how one Table draws its rows, in any root,
// on this install. Its file's own layout keeps nothing.
export interface TableLayoutRequestBody {
  path: string;
  layout: TableLayout;
}

// POST /api/space/table-column-id: a Table column's id changed in the Flows
// that name it, before the Table's own save changes it there. Without
// `apply`, nothing is written, and `flows` lists what would be.
export interface TableColumnIdRequestBody {
  path: string;
  from: string;
  to: string;
  apply: boolean;
}

export interface TableColumnIdResponse {
  /** The Flows naming the column, as space paths. */
  flows: string[];
}

// POST /api/space/flow-app-mode: whether one Flow shows App mode, in any
// root, on this install. Its file's own `appModeActive` keeps nothing.
export interface FlowAppModeRequestBody {
  path: string;
  appMode: boolean;
}

// GET /api/space/frame-folder?clip=&context=: the folder a frame of that
// clip, seen in that context, saves to by default on this install. A rooted
// path, "" for the space's top folder. A context is the scope a surface's
// tab is seen in, its folder's rooted path, "" for the space's own.
export interface FrameFolderResponse {
  folder: string;
}

// POST /api/space/frame-folder: remembers the folder a frame seen in
// `context` was saved to, for every clip seen there.
export interface FrameFolderRequestBody {
  context: string;
  folder: string;
}

// GET /api/space/context-view?context=: the guides and look this install
// keeps for a context's media, each null where none was kept. They are the
// client's own shapes, which it reads as none where it doesn't know them.
export interface ContextViewResponse {
  guides: unknown;
  look: unknown;
}

// POST /api/space/context-view: keeps a context's guides, its look or both.
export interface ContextViewRequestBody {
  context: string;
  guides?: unknown;
  look?: unknown;
}

// POST /api/space/order
export interface SetOrderRequestBody {
  dir: string;
  order: string[];
}

// POST /api/space/sort: a folder's own order. Manual removes its `sort`;
// `order` is then its current entries in the order shown, written as its
// `_structure.json` if it has none, and an existing one is kept.
export interface SetSortRequestBody {
  dir: string;
  sort: SortChoice;
  order?: string[];
}

// POST /api/space/tags: one tag's change.
export type SpaceTagChangeRequestBody = TagChange;

// POST /api/space/bookmarks: one bookmark's change.
export type SpaceBookmarkChangeRequestBody = BookmarkChange;

// POST /api/space/presets: one listed folder's change, its folder rooted.
export type SpacePresetChangeRequestBody = PresetChange;

// /api/file (PUT), /api/prompt/save

export interface PutFileRequestBody {
  content: string;
  // The revision `content` was composed from. When the file on disk no
  // longer has it, the save is refused with a 409 and nothing is written.
  // Absent writes unconditionally.
  baseRevision?: string;
  // What wrote `content` when it wasn't the writer's own typing, which
  // History labels the change by. `flow` names the Flow whose proposal it
  // was, by its space path.
  source?: "copilot" | "restored" | "flow";
  flow?: string;
}

// /api/sandbox/*: every body names the document the request is about.

export interface PickedImagePayload {
  mediaType: string;
  data: string;
}

export interface SandboxRequestBody {
  kind: SandboxKind;
  path: string;
}

export interface SandboxReadRequestBody extends SandboxRequestBody {
  targetPath: string;
}

export interface SandboxWriteRequestBody extends SandboxRequestBody {
  targetPath: string;
  content: string;
}

// One row onto a Table the document declares a write of, its cells by column
// id. A column `values` leaves out gets what a new row gets.
export interface SandboxAddRowRequestBody extends SandboxRequestBody {
  targetPath: string;
  values: Record<string, string>;
}

// The Table's path from the space root, for whatever shows it to read again.
export interface AddRowResponse {
  path: string;
}

// A text onto a note the document declares a write of: at its end, or where
// its body starts.
export interface SandboxAddToNoteRequestBody extends SandboxRequestBody {
  targetPath: string;
  text: string;
  affixMode: AffixMode;
}

// grant and revoke
export interface SandboxGrantRequestBody extends SandboxRequestBody {
  capabilityKey: string;
}

// A Flow's unattended grant, set or withdrawn. `until` is the last day it
// holds, `YYYY-MM-DD`; without one it holds until revoked.
export interface SandboxUnattendedRequestBody extends SandboxRequestBody {
  allowed: boolean;
  until?: string;
}

// The generation envelope. A blank `model` runs on config.json's default.
// `context` is the address a `context` pin's wire brought, whose files go
// with the call once its scope is granted.
export interface GenerateRequestBody {
  instruction: string;
  values?: Record<string, string>;
  images?: Record<string, PickedImagePayload>;
  model?: string;
  context?: string;
  // The effort a node picked, run at the model's nearest level.
  effort?: EffortLevel;
}

export interface GenerateOptionsRequestBody extends GenerateRequestBody {
  numOptions: number;
}

export type SandboxGenerateRequestBody = SandboxRequestBody & GenerateRequestBody;

// A reference image as a Generate node sends it, with the pin it came in
// on, `image_<pin>`, which the prompt's mentions name.
export interface ReferenceImagePayload extends PickedImagePayload {
  pin: number;
}

// A clip wired into a Generate Video's `video_<pin>`, by reference: its
// address from the root and the digest its read gave. The host reads the
// bytes under the Flow's grants and refuses them if they no longer match.
export interface VideoReferencePayload {
  pin: number;
  path: string;
  digest: string;
}

// A generation that may start an async job, sent with an id of the caller's
// own for the start. The job carries it from the moment it is recorded, so
// the caller can tell its job from others' before the start answers.
export interface JobStartRequestBody {
  startId?: string;
}

// An image generation into `folder`, which must be the folder the document
// declares. `references` go in pin order, and the host spells the prompt's
// mentions of them for the model. `prefix` starts the result's file name.
//
// `seed` is part of the result's digest whether or not the model takes one;
// take N sends it plus N - 1, and a blank one sends none. `take` ends the
// name, blank for take 1; `newTake` asks for one past the highest take of
// these inputs instead.
export interface GenerateImageRequestBody extends JobStartRequestBody {
  folder: string;
  prompt: string;
  references: ReferenceImagePayload[];
  model?: string;
  aspectRatio?: string;
  seed?: string;
  take?: string;
  newTake?: boolean;
  prefix?: string;
  // The prefix as typed on the node, placeholders and all, when no wire
  // brought it: what a result already made is matched against.
  prefixTyped?: string;
}

export type SandboxGenerateImageRequestBody = SandboxRequestBody & GenerateImageRequestBody;

// What a call spent, in the provider's own unit ("credits").
export interface GenerationCost {
  amount: number;
  unit: string;
}

// The result, new or found already in the folder under the same inputs and
// take. `model` is the resolved ref; `cost` is absent on a reused result,
// which spent nothing, and when the provider names no price. `warnings` are
// about settings the request sent, for the node; `notes` are what the
// provider decided about the rest, for a record of the call.
export interface GenerateImageResponse {
  image: PickedImagePayload;
  path: string;
  model: string;
  take: number;
  reused: boolean;
  warnings: string[];
  notes?: string[];
  cost?: GenerationCost;
}

// A video generation into `folder`, the folder the document declares. The
// frames are the clip's first and last; `references` go as an image
// generation's do, and `videoReferences` beside them, never beside a frame. `resolution` is a size such as
// `720p`, `duration` whole seconds; `take` and `newTake` name the result as an
// image's do and never reach the model, and `prefix` starts its file name.
//
// `modelSettings` are the chosen model's own settings, by the names its
// catalog gives them (ModelSetting).
export interface GenerateVideoRequestBody extends JobStartRequestBody {
  folder: string;
  prompt: string;
  startFrame?: PickedImagePayload;
  endFrame?: PickedImagePayload;
  references?: ReferenceImagePayload[];
  videoReferences?: VideoReferencePayload[];
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  take?: string;
  newTake?: boolean;
  prefix?: string;
  prefixTyped?: string;
  modelSettings?: Record<string, ModelSettingValue>;
}

export type SandboxGenerateVideoRequestBody = SandboxRequestBody & GenerateVideoRequestBody;

// The clip, by its path only: it is too big to send back. `take` is as an
// image's. `resumed` is a job an earlier request started and stopped waiting
// on. `quote` is the price asked before the job, which the charge can differ
// from. `warnings` and `notes` split as an image's do.
export interface GenerateVideoResponse {
  path: string;
  model: string;
  take: number;
  reused: boolean;
  resumed: boolean;
  warnings: string[];
  notes?: string[];
  quote?: GenerationCost;
}

/** What a generation route answers when no result is there yet: the job
 * making it, which the run then waits on through /api/jobs, and the take it
 * makes. `resumed` is a job an earlier request started. */
export interface GenerationStarted {
  job: string;
  take: number;
  resumed: boolean;
}

export type GenerateVideoRouteResponse = GenerateVideoResponse | GenerationStarted;

// An image whose provider makes it as a job is answered as a clip is.
export type GenerateImageRouteResponse = GenerateImageResponse | GenerationStarted;

// /api/jobs, /api/jobs/shown

/** What a job makes: each setting as the provider took it, or as it was
 * sent when the provider says nothing, and left out when neither names it.
 * `resolution` is a size such as `720p`, `duration` seconds. */
export interface JobSettings {
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
}

/** One async job of the open document, for its Tools tab and the runs that
 * wait on it: still going, or ended and not yet shown. `file` is the saved
 * clip's path as a tab names it and `result` as the node hands it on;
 * `problem` is what keeps a live job from finishing, `delivered` an outcome
 * a waiting run had, `interrupted` a start the host closed in the middle of. */
export interface JobView {
  id: string;
  // The id its start was sent with, when the caller sent one.
  startId?: string;
  kind: "video" | "image";
  stage: "starting" | "running" | "saved" | "failed" | "cancelled";
  model: string;
  // The provider's name as Settings lists it.
  provider?: string;
  summary: string;
  settings?: JobSettings;
  folder: string;
  startedAt: number;
  endedAt?: number;
  quote?: GenerationCost;
  file?: string;
  result?: string;
  warnings?: string[];
  notes?: string[];
  error?: string;
  problem?: string;
  delivered?: boolean;
  interrupted?: boolean;
}

export interface JobsResponse {
  jobs: JobView[];
}

// The ended jobs a window has shown, and those whose outcome a run there
// took. The host forgets one a run had only once that run took it.
export interface JobsShownRequestBody {
  ids: string[];
  taken?: string[];
}

// A job the person cancelled: the host never saves its result.
export interface JobCancelRequestBody {
  id: string;
}

export type SandboxGenerateOptionsRequestBody = SandboxRequestBody & GenerateOptionsRequestBody;

// /api/providers (upsert), /api/providers/delete, /api/providers/discover

// An upsert: `id` names the row, every other field is merged over what's
// stored. A model list alone toggles that enabled list; `apiKey` alone
// rotates the key (verified against the endpoint before it is kept).
export interface SaveProviderRequestBody {
  id: string;
  kind?: ProviderKind;
  label?: string;
  baseURL?: string;
  textModels?: string[];
  imageModels?: string[];
  videoModels?: string[];
  apiKey?: string;
}

export interface ProviderIdRequestBody {
  id: string;
}

// /api/providers/sign-in: POST starts a sign-in and answers the page to
// approve it on; GET ?id= answers a ProviderSignInStatus. `planUsage` asks
// again for the permission to use the ChatGPT plan, after it was declined.
export interface ProviderSignInRequestBody {
  id: string;
  planUsage?: boolean;
}

export interface ProviderSignInStartResponse {
  authorizationUrl: string;
}

// /api/providers/sign-out. `revoked` is false when ChatGPT didn't confirm it
// ended the session: the person then disconnects Pragma in ChatGPT's settings.
export interface ProviderSignOutResponse {
  revoked: boolean;
}

// /api/publishers, /api/publishers/delete, /api/space/site, /api/space/publish

export interface SavePublisherRequestBody {
  id: string;
  kind?: PublisherKind;
  label?: string;
  baseURL?: string;
  apiKey?: string;
}

export interface PublisherIdRequestBody {
  id: string;
}

// /api/mcp-servers (upsert), /api/mcp-servers/delete, /api/mcp-servers/connect,
// /api/mcp-servers/sign-in

// An upsert: `id` names the row, every other field is merged over what's
// stored. `apiKey` alone rotates the bearer token, and revokes a sign-in.
export interface SaveMcpServerRequestBody {
  id: string;
  label?: string;
  url?: string;
  apiKey?: string;
  copilot?: boolean;
  flows?: boolean;
}

export interface McpServerIdRequestBody {
  id: string;
}

// A first attempt sends `name` (and `domain`); a retry after a failed local
// scaffold sends the `existingSite` the error body carried back instead.
// `publisherId` names which configured publisher the site is created on and
// bound to; omitted, the first configured one is used.
export interface CreateSiteRequestBody {
  parentPath: string;
  name?: string;
  domain?: string;
  publisherId?: string;
  existingSite?: ExistingSogmaSite;
}

// /api/space/publish: the document to send.
export interface PublishDocumentRequestBody {
  path: string;
}

// /api/find-context, /api/chat (the chat's view context, the other editor
// group's under a `beside` prefix, and what the writer has selected, a
// document's range or a Flow's node, travel as query parameters, not in the
// body)

/** The parameter naming the other editor group's tab: the focused tab's
 * own, prefixed, so `flowPath` becomes `besideFlowPath`. */
export function besideParam(name: string): string {
  return `beside${name[0].toUpperCase()}${name.slice(1)}`;
}

export interface FindContextRequestBody {
  query: string;
}

export interface ChatRequestBody {
  history: ChatMessage[];
  message: string;
  // The chat panel's own model pick, a "<providerId>/<model>" ref. Blank runs
  // on config.json's default, and with none set is a `no_model` error.
  model?: string;
  // One of the model's own effort levels; absent leaves the model at its own
  // default. A level the model doesn't take is refused, never dropped.
  effort?: EffortLevel;
  // Absent is "suggesting". An unknown mode is refused, never read as one
  // that grants more.
  mode?: ChatMode;
}

// /api/git/commit

export interface GitCommitRequestBody {
  message: string;
}
