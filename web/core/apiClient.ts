// Every HTTP call the web client makes. Each wrapper builds its body with
// `satisfies` and casts its reply against the wire contract in
// src/protocol/api.ts, the same types the server's route handlers use.
//
// A pure leaf on purpose — types and `fetch` only, no DOM, no other web/
// module — so nothing in web/ can end up depending on it circularly.

import type { EditorState } from "@codemirror/state";
import type {
  Access,
  ActivityResponse,
  AddRowResponse,
  ApiSettingsRequestBody,
  ApiSettingsResponse,
  AppletInfoResponse,
  Backlink,
  BacklinksResponse,
  ChatMessage,
  ChatRequestBody,
  ChatResponse,
  ClassRowsResponse,
  ClipFactsResponse,
  ClipHeaderResponse,
  CreateApiTokenRequestBody,
  CreateApiTokenResponse,
  CreateEntryRequestBody,
  CreateEntryResponse,
  CreateFromTemplateRequestBody,
  CreateSiteErrorBody,
  CreateSiteRequestBody,
  CreateSiteResponse,
  DefaultModelRequestBody,
  DeleteEntryRequestBody,
  DeleteEntryResponse,
  DeleteFromTrashRequestBody,
  DiscoverModelsResponse,
  DuplicateEntryRequestBody,
  ExistingSogmaSite,
  FileDescriptionResponse,
  FileInfoResponse,
  FileResponse,
  FileSha256Response,
  FileTypeSettings,
  FindContextRequestBody,
  FindContextResponse,
  FlowAppModeRequestBody,
  FolderLayoutRequestBody,
  FolderListingResponse,
  GenerateImageRequestBody,
  GenerateImageRouteResponse,
  GenerateOptionsRequestBody,
  GenerateOptionsResponse,
  GenerateRequestBody,
  GenerateResponse,
  GenerateVideoRequestBody,
  GenerateVideoRouteResponse,
  GitActionResponse,
  GitCommitRequestBody,
  GitStatus,
  HistoryFile,
  HistoryFilesResponse,
  HistorySettings,
  HistoryVersion,
  HistoryVersionResponse,
  HistoryVersionsResponse,
  ImageModelsResponse,
  JobCancelRequestBody,
  JobsResponse,
  JobsShownRequestBody,
  LayoutGroup,
  LayoutRequestBody,
  LayoutResponse,
  LibraryAccessRequestBody,
  LibraryDescriptionRequestBody,
  LibraryEntry,
  LibraryLabelRequestBody,
  LibraryOffer,
  ListedSpace,
  LocalSortRequestBody,
  McpServerConnectResponse,
  McpServerIdRequestBody,
  McpServersResponse,
  McpSignInStartResponse,
  McpSignInStatus,
  MenuBarMenu,
  Misspelling,
  ModelsResponse,
  MoveEntryRequestBody,
  MoveEntryResponse,
  MoveFromTrashRequestBody,
  MoveFromTrashResponse,
  PixelFormatResponse,
  PragmaTemplatesResponse,
  ProviderIdRequestBody,
  ProviderSignInRequestBody,
  ProviderSignInStartResponse,
  ProviderSignInStatus,
  ProviderSignOutResponse,
  ProvidersResponse,
  PublishDocumentRequestBody,
  PublishDocumentResponse,
  PublisherIdRequestBody,
  PublisherSaveResult,
  PublishersResponse,
  PutFileRequestBody,
  PutFileResponse,
  RootPathsResponse,
  SandboxAddRowRequestBody,
  SandboxAddToNoteRequestBody,
  SandboxGenerateImageRequestBody,
  SandboxGenerateOptionsRequestBody,
  SandboxGenerateRequestBody,
  SandboxGenerateVideoRequestBody,
  SandboxGrantRequestBody,
  SandboxKind,
  SandboxReadRequestBody,
  SandboxReadResult,
  SandboxUnattendedRequestBody,
  SandboxWriteRequestBody,
  SaveMcpServerRequestBody,
  SaveProviderRequestBody,
  SavePublisherRequestBody,
  SaveSiteSettingsRequestBody,
  SaveSiteSettingsResponse,
  SelectedRange,
  SetOrderRequestBody,
  SetSortRequestBody,
  SiteImageUploadRequestBody,
  SiteImageUploadResponse,
  SiteSettingsChanges,
  SiteSettingsErrorBody,
  SiteSettingsResponse,
  SortKeysResponse,
  SpaceBookmarkChangeRequestBody,
  SpaceBookmarksResponse,
  SpaceChangesResponse,
  SpaceGraphResponse,
  SpaceIdRequestBody,
  SpaceInfoResponse,
  SpaceLabelRequestBody,
  SpaceLibrariesResponse,
  SpaceListResponse,
  SpacePresetChangeRequestBody,
  SpacePresetsResponse,
  SpaceSearchResponse,
  SpaceSiteEntry,
  SpaceTagChangeRequestBody,
  SpaceTagsResponse,
  SpaceTreeNode,
  SpaceTrustRequestBody,
  SpellcheckLanguages,
  SwitchSpaceRequestBody,
  TableLayoutRequestBody,
  TabPlace,
  TabViewport,
  TemplateNameResponse,
  ThumbnailUsageResponse,
  TrashEntry,
  TrashResponse,
  TrashSettings,
  UpdateStatus,
  UploadEntryResponse,
  VideoModelsResponse,
} from "../../src/protocol/api.ts";
import { besideParam, CHANGES_HEADER } from "../../src/protocol/api.ts";
import type { ClassRow } from "../../src/protocol/class.ts";
import { formatClock, readClock } from "../../src/protocol/datePlaceholders.ts";
import type { AffixMode } from "../../src/protocol/flowNodes.ts";
import { formatSelectedRange } from "../../src/protocol/selectedRange.ts";
import { withSetupNeed } from "../../src/protocol/setupNeed.ts";
import type { TemplateEntry } from "../../src/protocol/templates.ts";
import type { DocumentType } from "../../src/protocol/types.ts";

// The wire contract's shapes, re-exported so a caller imports a request or
// response type from the same module as the call that uses it.
export type * from "../../src/protocol/api.ts";

// Every call here goes through the shared request helpers, which turn a
// non-2xx into an error carrying the route's own message — a JSON
// ErrorBody's `message` or a `c.text` body ("Cannot forget the current space") —
// rather than just `response.status`, which would throw that message away.
// The caller's `fallback` covers a reply that carries neither.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // The parsed JSON body when the route sent one, undefined for a plain-
    // text reply.
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiRequestOptions {
  method?: string;
  // Serialized as the JSON body. A call that sends raw bytes builds its own
  // request instead.
  body?: unknown;
  // Names the call when the reply carries no message of its own; the status
  // is appended, so a bodyless 500 still reports what failed.
  fallback: string;
  // Builds the thrown error for a call whose failure carries more than a
  // message — a refused generate's prompt, a rejected setting's field.
  error?: (message: string, body: Record<string, unknown> | undefined, status: number) => Error;
  // Closes the request when the caller stops waiting. The server stops on
  // that close, so a model call a run gave up on isn't billed to the end.
  signal?: AbortSignal;
}

function readJsonBody(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readError(response: Response, options: ApiRequestOptions): Promise<Error> {
  const text = await response.text();
  // Parsed on shape, never on content-type: the `need`/`field` keys
  // the typed errors below are built from are load-bearing, and a reply that
  // omits the header would silently downgrade them to a bare ApiError.
  const body = readJsonBody(text);
  const message =
    (typeof body?.message === "string" ? body.message : text) || `${options.fallback}: ${response.status}`;
  // Whatever the call builds, a setting that fixes the refusal stays named on it.
  const error = options.error ? options.error(message, body, response.status) : undefined;
  return withSetupNeed(error ?? new ApiError(message, response.status, body), body?.need);
}

/** The raw reply, for a call that reads a 204 as a result rather than an
 * absence. Everything else wants the parsed-JSON helper. */
async function apiFetch(path: string, options: ApiRequestOptions): Promise<Response> {
  const response = await fetch(
    path,
    options.body === undefined
      ? { method: options.method, signal: options.signal }
      : {
          method: options.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body),
          signal: options.signal,
        },
  );
  if (!response.ok) throw await readError(response, options);
  return response;
}

async function request<T>(path: string, options: ApiRequestOptions): Promise<T> {
  const response = await apiFetch(path, options);
  return response.json() as Promise<T>;
}

async function requestVoid(path: string, options: ApiRequestOptions): Promise<void> {
  await apiFetch(path, options);
}

// A title bar's state: `text` is the document's own title, "" when there is
// none, and the bar then shows `placeholder` (the filename) greyed. A note's
// is its leading `# Heading`, lifted out of #editor-cm into the bar and
// snapshotted per tab like `properties`.
export interface ActiveTitle {
  text: string;
  placeholder: string;
}

// What's open in one tab, and what each kind caches. A "document" tab's
// `state` and scroll places stay unset until it is first switched away from,
// and a "flow" tab's viewport until its canvas first moves; the
// `{ kind, path }` kinds stay deliberately thin, re-derived on activation.
export type Tab = (
  | {
      kind: "document";
      path: string;
      documentType: DocumentType;
      // Restored from the layout and not yet shown: the tab has read no file
      // and holds no reference on a model, until it first shows.
      deferred?: true;
      // Where it was left, saved with the layout: put back the first time
      // it shows in a session, when it has no scroll place below to go by.
      place?: TabPlace;
      state?: EditorState;
      scrollTop?: number;
      // Reading view scrolls its own element, whose offsets don't map onto
      // the editor's, so its place is kept apart.
      readingScrollTop?: number;
    }
  // A folder's entries as tiles or cards, in the space or a library.
  | { kind: "gallery"; path: string }
  | { kind: "image"; path: string }
  | { kind: "video"; path: string }
  | { kind: "pdf"; path: string }
  // A LUT's facts and a test strip shown through it.
  | { kind: "lut"; path: string }
  | { kind: "table"; path: string }
  // A Class's notes, read-only, as rows.
  | { kind: "class"; path: string }
  // `viewport` is where the canvas was left, saved with the layout and shown
  // over the file's own on every render, since a pan or zoom never saves the
  // file (docs/protocol.md, Graph shape).
  | { kind: "flow"; path: string; viewport?: TabViewport }
  | { kind: "applet"; path: string }
  // A `.applet.html` being edited as raw code rather than run — the `⋮` menu's
  // "Edit code" ⇄ "Run" toggle (docs/architecture.md, Files and views). Caches its
  // CodeMirror state like a "document" tab; persists to the layout as
  // "applet" so a reload comes back running (applets default to run).
  | { kind: "applet-source"; path: string; state?: EditorState; scrollTop?: number }
  // One Find in context search's ranked answer for the directory at `path`,
  // carried on the tab: never persisted, so a reload drops it.
  | { kind: "find-context"; path: string; result: FindContextResponse }
  // A version History kept of the file at `path`, compared with its text now.
  // Carried on the tab and never persisted: a reload drops it, as a version
  // runs out in a week anyway.
  | { kind: "version"; path: string; version: HistoryVersion }
  | { kind: "empty" }
) & {
  // Back and Forward, for the session only. A blank tab may carry one too:
  // a tab whose file was deleted keeps its way back.
  history?: TabHistory;
};

/** A tab that shows something, which Back and Forward can return to. */
export type Place = Exclude<Tab, { kind: "empty" }>;

/** The places a tab showed before something replaced them in place, and the
 * ones Back has since left; the next step either way is the last. */
export interface TabHistory {
  readonly back: readonly Place[];
  readonly forward: readonly Place[];
}

/** The space's tree, and the change version it was read at: how a client
 * tells whether a change it hears of is one its copy already holds. */
export async function fetchTree(): Promise<{ tree: SpaceTreeNode[]; changes: string | undefined }> {
  const response = await apiFetch("/api/space/tree", { fallback: "Failed to load space tree" });
  return {
    tree: (await response.json()) as SpaceTreeNode[],
    changes: response.headers.get(CHANGES_HEADER) ?? undefined,
  };
}

/** Every file and folder the space holds, and its scopes: what a written
 * path is read against. */
export async function fetchSpacePaths(): Promise<RootPathsResponse> {
  return request<RootPathsResponse>("/api/space/paths", { fallback: "Failed to list the space" });
}

/** The same for one library. */
export async function fetchLibraryPaths(id: string): Promise<RootPathsResponse> {
  return request<RootPathsResponse>(`/api/space/libraries/${encodeURIComponent(id)}/paths`, {
    fallback: "Failed to list library",
  });
}

/** The space's change version, and with `library`, that library's too; with
 * `files`, each file's revision now. */
export async function fetchSpaceChanges(
  library?: string,
  files: readonly string[] = [],
): Promise<SpaceChangesResponse> {
  const params = new URLSearchParams();
  if (library !== undefined) params.set("library", library);
  for (const file of files) params.append("file", file);
  const query = params.toString();
  return request<SpaceChangesResponse>(`/api/space/changes${query ? `?${query}` : ""}`, {
    fallback: "Failed to check for changes",
  });
}

export async function fetchSpaceSearch(query: string, dir: string | undefined): Promise<SpaceSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (dir) params.set("dir", dir);
  return request<SpaceSearchResponse>(`/api/space/search?${params}`, { fallback: "Search failed" });
}

export async function fetchSites(): Promise<SpaceSiteEntry[]> {
  return request<SpaceSiteEntry[]>("/api/space/sites", { fallback: "Failed to load sites" });
}

export async function fetchLibraries(): Promise<SpaceLibrariesResponse> {
  return request<SpaceLibrariesResponse>("/api/space/libraries", { fallback: "Failed to load libraries" });
}

// A library's own contents, rooted at the library itself rather
// than the space — same SpaceTreeNode shape /api/space/tree returns, but
// `path` on each node is relative to the library's root, not spaceRoot.
export async function fetchFolder(path: string): Promise<FolderListingResponse> {
  return request<FolderListingResponse>(`/api/space/folder?path=${encodeURIComponent(path)}`, {
    fallback: "Failed to list folder",
  });
}

export async function fetchClassRows(path: string): Promise<ClassRow[]> {
  const body = await request<ClassRowsResponse>(`/api/space/class?path=${encodeURIComponent(path)}`, {
    fallback: "Failed to read the Class's notes",
  });
  return body.rows;
}

/** The rows a Class with no source in `dir` would hold. */
export async function fetchFolderRows(dir: string): Promise<ClassRow[]> {
  const body = await request<ClassRowsResponse>(`/api/space/class?dir=${encodeURIComponent(dir)}`, {
    fallback: "Failed to read the folder's notes",
  });
  return body.rows;
}

export async function fetchLibraryTree(id: string): Promise<SpaceTreeNode[]> {
  return request<SpaceTreeNode[]>(`/api/space/libraries/${encodeURIComponent(id)}/tree`, {
    fallback: "Failed to load library",
  });
}

/** One folder of a library's own entries, "" for its top level, and the
 * library's change version the listing was read at. */
export async function fetchLibraryFolder(
  id: string,
  dir: string,
): Promise<{ entries: SpaceTreeNode[]; changes: string | undefined }> {
  const params = new URLSearchParams({ depth: "1" });
  if (dir) params.set("dir", dir);
  const response = await apiFetch(`/api/space/libraries/${encodeURIComponent(id)}/tree?${params}`, {
    fallback: "Failed to load library",
  });
  return {
    entries: (await response.json()) as SpaceTreeNode[],
    changes: response.headers.get(CHANGES_HEADER) ?? undefined,
  };
}

// The library writes that name no path, so they are routes on every
// target rather than Electron channels, like the space registry's own label
// and forget routes.
export async function postLibraryAccess(id: string, access: Access): Promise<void> {
  await requestVoid(`/api/space/libraries/${encodeURIComponent(id)}/access`, {
    method: "POST",
    body: { access } satisfies LibraryAccessRequestBody,
    fallback: "Failed to change the library's access",
  });
}

export async function postLibraryLabel(id: string, label: string): Promise<void> {
  await requestVoid(`/api/space/libraries/${encodeURIComponent(id)}/label`, {
    method: "POST",
    body: { label } satisfies LibraryLabelRequestBody,
    fallback: "Failed to rename the library",
  });
}

export async function postLibraryDescription(id: string, description: string): Promise<void> {
  await requestVoid(`/api/space/libraries/${encodeURIComponent(id)}/description`, {
    method: "POST",
    body: { description } satisfies LibraryDescriptionRequestBody,
    fallback: "Failed to save the library's description",
  });
}

export async function deleteLibrary(id: string): Promise<void> {
  await requestVoid(`/api/space/libraries/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Failed to remove library",
  });
}

export async function fetchSpaceInfo(): Promise<SpaceInfoResponse> {
  return request<SpaceInfoResponse>("/api/space/info", { fallback: "Failed to load space info" });
}

// electron/preload.ts's contextBridge surface — present only inside the
// Electron shell, absent in a browser tab on `pragma start` or `pragma dev`,
// so a caller feature-detects `window.pragmaElectron` before offering an
// Electron-only row. Everything these methods do happens in the main
// process (electron/main.ts), never through the shared HTTP API.
export interface PragmaElectronBridge {
  // process.platform's value, verbatim — e.g. "darwin"/"win32"/"linux". Typed
  // as a plain string rather than importing Node's platform union — this
  // project doesn't otherwise pull @types/node into the browser-side tsconfig.
  platform: string;
  browseSpaceLocation(): Promise<string | undefined>;
  // `examples`: the template space's worked examples, or a space without them.
  createSpaceAt(name: string, parentDir: string, examples: boolean): Promise<void>;
  openSpaceFolder(): Promise<void>;
  // Repoints a moved space's registry entry, keeping the id its approvals are
  // keyed by. Native-picker only, so Electron-only — see
  // docs/architecture.md's Document writes and reference integrity section.
  relocateSpace(id: string): Promise<string | undefined>;
  // The welcome window's: every registered space, the app's version, and
  // opening a registered space by its id.
  listSpaces(): Promise<ListedSpace[]>;
  appVersion(): Promise<string>;
  openSpace(id: string): Promise<void>;
  // The Libraries panel's folder-naming actions: a library's folder is a
  // path outside the space, so adding or locating one happens in the main
  // process, from a native picker or, with `from`, the offer it names.
  // Permission, label and removal name no path and are HTTP routes instead.
  // Each resolves to undefined when the picker is cancelled.
  libraryOffers(): Promise<LibraryOffer[]>;
  addLibrary(from?: Pick<LibraryOffer, "space" | "id">): Promise<LibraryEntry | undefined>;
  relocateLibrary(id: string): Promise<string | undefined>;
  // The header's colours (CSS rgb()) and height in DIPs, for the window's own
  // controls that Electron draws over it on Windows and Linux.
  styleWindowControls(style: { background: string; foreground: string; height: number }): Promise<void>;
  // The theme picked in Settings, for Electron's own UI.
  setNativeTheme(theme: "system" | "light" | "dark"): Promise<void>;
  // The whole window's zoom, 1 for 100%, iframes included.
  setZoomFactor(factor: number): void;
  // Windows/Linux packaged builds only — resolves to { phase: "unsupported" }
  // on macOS and in unpackaged dev. onUpdateStatus streams the follow-on
  // states and returns an unsubscribe fn.
  checkForUpdates(): Promise<UpdateStatus>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  // Whether the launch check runs, held in the main process's config.json.
  getAutomaticUpdates(): Promise<boolean>;
  setAutomaticUpdates(on: boolean): Promise<void>;
  // A file Pragma can't open, by its space path: why it can't go to the
  // system's default app or null, then that open, which says why it didn't
  // happen or null, and the system's file manager showing it.
  defaultAppRefusal(path: string): Promise<string | null>;
  openInDefaultApp(path: string): Promise<string | null>;
  showInFolder(path: string): Promise<void>;
  // The text menu's spelling rows: the word a right-click left uncancelled
  // landed on, or null when it is spelled right or the wait runs out. Then
  // that word, where Chromium selected it, replaced or added to the
  // dictionary, which also clears its underline.
  misspellingAtMenu(): Promise<Misspelling | null>;
  replaceMisspelling(word: string): Promise<void>;
  addToDictionary(word: string): Promise<void>;
  // The words added that way, and one taken back out, which makes it a
  // misspelling again.
  addedWords(): Promise<string[]>;
  removeFromDictionary(word: string): Promise<void>;
  // The languages a word is checked against, passing if any knows it. Only
  // Windows and Linux take a choice: macOS's spellchecker detects the language.
  spellcheckLanguages(): Promise<SpellcheckLanguages>;
  setSpellcheckLanguages(codes: string[]): Promise<void>;
  // macOS's menu bar (view/menuBar.ts): the menus as they stand, sent again
  // whenever they change, and each pick, which arrives as the command and
  // argument its item named. The subscription returns its unsubscribe.
  setMenuBar(menus: MenuBarMenu[]): Promise<void>;
  onMenuCommand(callback: (command: string, arg: unknown) => void): () => void;
}

declare global {
  interface Window {
    pragmaElectron?: PragmaElectronBridge;
  }
}

export async function fetchSpaceList(): Promise<SpaceListResponse> {
  return request<SpaceListResponse>("/api/space/list", { fallback: "Failed to load spaces" });
}

export async function postSwitchSpace(spacePath: string): Promise<void> {
  await requestVoid("/api/space/switch", {
    method: "POST",
    body: { path: spacePath } satisfies SwitchSpaceRequestBody,
    fallback: "Failed to switch space",
  });
}

/** The Console's server-side entries since `since`, or just a cursor when
 * called without one. Polled only while the Console is open — see
 * src/server/activityLog.ts for what may be in here and why. */
export async function fetchActivity(since?: number): Promise<ActivityResponse> {
  const query = since === undefined ? "" : `?since=${since}`;
  return request<ActivityResponse>(`/api/activity${query}`, { fallback: "Failed to load activity" });
}

/** The open document's paid jobs: those still going, and those ended since a
 * window last showed them (src/server/routes/jobs.ts). `waiting` names the
 * jobs a run in this window waits on. */
export async function fetchJobs(path: string, waiting: readonly string[] = []): Promise<JobsResponse> {
  const query = `path=${encodeURIComponent(path)}${waiting.length ? `&waiting=${waiting.map(encodeURIComponent).join(",")}` : ""}`;
  return request<JobsResponse>(`/api/jobs?${query}`, { fallback: "Failed to load jobs" });
}

/** Tells the host which ended jobs this window showed, and which a run here
 * took, so it forgets them. */
export async function markJobsShown(ids: readonly string[], taken: readonly string[] = []): Promise<void> {
  await requestVoid("/api/jobs/shown", {
    method: "POST",
    body: { ids: [...ids], taken: [...taken] } satisfies JobsShownRequestBody,
    fallback: "Failed to mark jobs shown",
  });
}

/** Cancels a paid job: the host never saves its result. */
export async function cancelJob(id: string): Promise<void> {
  await requestVoid("/api/jobs/cancel", {
    method: "POST",
    body: { id } satisfies JobCancelRequestBody,
    fallback: "Couldn't cancel the job",
  });
}

export async function fetchApiSettings(): Promise<ApiSettingsResponse> {
  return request<ApiSettingsResponse>("/api/api-settings", { fallback: "Failed to load API settings" });
}

export async function postApiSettings(body: ApiSettingsRequestBody): Promise<void> {
  await requestVoid("/api/api-settings", {
    method: "POST",
    body: body satisfies ApiSettingsRequestBody,
    fallback: "Failed to save API settings",
  });
}

export async function postCreateApiToken(label: string, access: Access): Promise<CreateApiTokenResponse> {
  return request<CreateApiTokenResponse>("/api/api-tokens", {
    method: "POST",
    body: { label, access } satisfies CreateApiTokenRequestBody,
    fallback: "Failed to create token",
  });
}

export async function postDeleteApiToken(id: string): Promise<void> {
  await requestVoid("/api/api-tokens/delete", {
    method: "POST",
    body: { id } satisfies SpaceIdRequestBody,
    fallback: "Failed to delete token",
  });
}

export async function postSpaceLabel(id: string, label: string): Promise<void> {
  await requestVoid("/api/space/label", {
    method: "POST",
    body: { id, label } satisfies SpaceLabelRequestBody,
    fallback: "Failed to rename space",
  });
}

export async function postForgetSpace(id: string): Promise<void> {
  await requestVoid("/api/space/forget", {
    method: "POST",
    body: { id } satisfies SpaceIdRequestBody,
    fallback: "Failed to remove space",
  });
}

export async function postResetSpaceGrants(id: string): Promise<void> {
  await requestVoid("/api/space/grants/reset", {
    method: "POST",
    body: { id } satisfies SpaceIdRequestBody,
    fallback: "Failed to reset approvals",
  });
}

export async function postSpaceTrust(id: string, trusted: boolean): Promise<void> {
  await requestVoid("/api/space/trust", {
    method: "POST",
    body: { id, trusted } satisfies SpaceTrustRequestBody,
    fallback: "Failed to record the space's trust",
  });
}

export async function fetchAppletInfo(): Promise<AppletInfoResponse> {
  return request<AppletInfoResponse>("/api/applet/info", { fallback: "Failed to load version info" });
}

// Settings → General "Check for updates" outside the Windows/Linux Electron
// bridge — see the call site in main.ts and the route in src/server/routes.ts.
export async function fetchUpdateCheck(): Promise<UpdateStatus> {
  return request<UpdateStatus>("/api/updates/check", { fallback: "Failed to check for updates" });
}

export async function postCreateEntry(
  parentPath: string,
  name: string,
  type: "file" | "directory",
  content?: string,
): Promise<CreateEntryResponse> {
  return request<CreateEntryResponse>("/api/space/create", {
    method: "POST",
    body: { parentPath, name, type, content } satisfies CreateEntryRequestBody,
    fallback: "Create failed",
  });
}

// Raw bytes, not a JSON envelope: the Blob is the body and `dir`/`name` ride
// in the query string. `name` is only a request — the reply says what the
// file ended up called.
//
// Not fetch: it reports nothing about an upload in flight, and a take from a
// footage library is big enough that a silent wait reads as a failure and
// big enough to want stopping. Same-origin, so the session cookie still rides.
export function postUploadFile(
  dir: string,
  name: string,
  file: Blob,
  options: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<UploadEntryResponse> {
  const query = `dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/space/upload?${query}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as UploadEntryResponse);
        return;
      }
      // The same error every fetch-based call raises, read the same way.
      void readError(new Response(xhr.responseText, { status: xhr.status }), { fallback: "Upload failed" }).then(
        reject,
      );
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** A copy of the template at `template`, in a folder the space lists for
 * templates or with `source` "pragma" one of Pragma's own, in `parentPath`
 * under the name typed for it;
 * the reply says what it ended up called. The moment its dates take is this
 * browser's, since the host may keep another time zone. */
export async function postCreateFromTemplate(
  template: string,
  parentPath: string,
  name: string,
  source?: "pragma",
): Promise<CreateEntryResponse> {
  return request<CreateEntryResponse>("/api/space/create-from-template", {
    method: "POST",
    body: {
      template,
      parentPath,
      name,
      source,
      now: formatClock(readClock(new Date())),
    } satisfies CreateFromTemplateRequestBody,
    fallback: "Create failed",
  });
}

/** The name a copy of the template at `template` starts with, "" for none. */
export async function fetchTemplateStartingName(template: string, source?: "pragma"): Promise<string> {
  const query = new URLSearchParams({ template, now: formatClock(readClock(new Date())) });
  if (source) query.set("source", source);
  const body = await request<TemplateNameResponse>(`/api/space/template-name?${query}`, {
    fallback: "Failed to read the template",
  });
  return body.name;
}

/** Pragma's own templates, which New ▸ Template lists after the space's. */
export async function fetchPragmaTemplates(): Promise<TemplateEntry[]> {
  const body = await request<PragmaTemplatesResponse>("/api/templates", { fallback: "Failed to list templates" });
  return body.templates;
}

export async function postDuplicateEntry(path: string): Promise<CreateEntryResponse> {
  return request<CreateEntryResponse>("/api/space/duplicate", {
    method: "POST",
    body: { path } satisfies DuplicateEntryRequestBody,
    fallback: "Duplicate failed",
  });
}

export async function postMoveEntry(from: string, to: string): Promise<MoveEntryResponse> {
  return request<MoveEntryResponse>("/api/space/move", {
    method: "POST",
    body: { from, to } satisfies MoveEntryRequestBody,
    fallback: "Move failed",
  });
}

export async function postDeleteEntry(path: string, trash: boolean): Promise<DeleteEntryResponse> {
  return request<DeleteEntryResponse>("/api/space/delete", {
    method: "POST",
    body: { path, trash } satisfies DeleteEntryRequestBody,
    fallback: "Delete failed",
  });
}

export async function fetchTrash(): Promise<TrashEntry[]> {
  const body = await request<TrashResponse>("/api/space/trash", { fallback: "Failed to load the trash" });
  return body.entries;
}

export async function postDeleteFromTrash(name: string): Promise<void> {
  await requestVoid("/api/space/trash/delete", {
    method: "POST",
    body: { name } satisfies DeleteFromTrashRequestBody,
    fallback: "Delete failed",
  });
}

/** Resolves to where the entry landed, which steps around a taken name. */
export async function postMoveFromTrash(name: string, dir: string): Promise<string> {
  const body = await request<MoveFromTrashResponse>("/api/space/trash/move", {
    method: "POST",
    body: { name, dir } satisfies MoveFromTrashRequestBody,
    fallback: "Moving out of the trash failed",
  });
  return body.path;
}

export async function postEmptyTrash(): Promise<void> {
  await requestVoid("/api/space/trash/empty", { method: "POST", fallback: "Emptying the trash failed" });
}

export async function fetchTrashSettings(): Promise<TrashSettings> {
  return request<TrashSettings>("/api/trash-settings", { fallback: "Failed to load the trash setting" });
}

export async function postTrashSettings(moveToTrash: boolean): Promise<void> {
  await requestVoid("/api/trash-settings", {
    method: "POST",
    body: { moveToTrash } satisfies TrashSettings,
    fallback: "Couldn't save the trash setting",
  });
}

export async function fetchHistorySettings(): Promise<HistorySettings> {
  return request<HistorySettings>("/api/history/settings", { fallback: "Failed to load the history setting" });
}

export async function postHistorySettings(keepHistory: boolean): Promise<void> {
  await requestVoid("/api/history/settings", {
    method: "POST",
    body: { keepHistory } satisfies HistorySettings,
    fallback: "Couldn't save the history setting",
  });
}

export async function fetchHistoryFiles(): Promise<HistoryFile[]> {
  return (await request<HistoryFilesResponse>("/api/history", { fallback: "Couldn't read the history" })).files;
}

export async function fetchHistoryVersions(path: string): Promise<HistoryVersion[]> {
  const response = await request<HistoryVersionsResponse>(`/api/history/file?path=${encodeURIComponent(path)}`, {
    fallback: "Couldn't read the file's history",
  });
  return response.versions;
}

export async function fetchHistoryVersion(path: string, id: string): Promise<HistoryVersionResponse> {
  return request<HistoryVersionResponse>(
    `/api/history/version?path=${encodeURIComponent(path)}&id=${encodeURIComponent(id)}`,
    { fallback: "Couldn't read that version" },
  );
}

export async function postClearHistory(): Promise<void> {
  await requestVoid("/api/history/clear", { method: "POST", fallback: "Couldn't clear the history" });
}

export async function fetchFileTypeSettings(): Promise<FileTypeSettings> {
  return request<FileTypeSettings>("/api/file-type-settings", { fallback: "Failed to load the file types setting" });
}

export async function postFileTypeSettings(showAllFileTypes: boolean): Promise<void> {
  await requestVoid("/api/file-type-settings", {
    method: "POST",
    body: { showAllFileTypes } satisfies FileTypeSettings,
    fallback: "Couldn't save the file types setting",
  });
}

export async function postSetOrder(dir: string, order: string[]): Promise<void> {
  await requestVoid("/api/space/order", {
    method: "POST",
    body: { dir, order } satisfies SetOrderRequestBody,
    fallback: "Reorder failed",
  });
}

export async function postSetSort(dir: string, sort: SetSortRequestBody["sort"], order?: string[]): Promise<void> {
  await requestVoid("/api/space/sort", {
    method: "POST",
    body: { dir, sort, order } satisfies SetSortRequestBody,
    fallback: "Changing the sort order failed",
  });
}

export async function postLocalSort(
  dir: string,
  sort: LocalSortRequestBody["sort"],
  arrangement?: LocalSortRequestBody["arrangement"],
): Promise<void> {
  await requestVoid("/api/space/local-sort", {
    method: "POST",
    body: { dir, sort, arrangement } satisfies LocalSortRequestBody,
    fallback: "Changing the sort failed",
  });
}

export async function postFolderLayout(dir: string, layout: FolderLayoutRequestBody["layout"]): Promise<void> {
  await requestVoid("/api/space/folder-layout", {
    method: "POST",
    body: { dir, layout } satisfies FolderLayoutRequestBody,
    fallback: "Changing the layout failed",
  });
}

export async function postTableLayout(path: string, layout: TableLayoutRequestBody["layout"]): Promise<void> {
  await requestVoid("/api/space/table-layout", {
    method: "POST",
    body: { path, layout } satisfies TableLayoutRequestBody,
    fallback: "Changing the layout failed",
  });
}

export async function postFlowAppMode(path: string, appMode: boolean): Promise<void> {
  await requestVoid("/api/space/flow-app-mode", {
    method: "POST",
    body: { path, appMode } satisfies FlowAppModeRequestBody,
    fallback: "Remembering App Mode failed",
  });
}

export async function fetchSortKeys(dir: string): Promise<string[]> {
  const body = await request<SortKeysResponse>(`/api/space/sort-keys?dir=${encodeURIComponent(dir)}`, {
    fallback: "Failed to load properties",
  });
  return body.keys;
}

export async function fetchSpaceGraph(): Promise<SpaceGraphResponse> {
  return request<SpaceGraphResponse>("/api/space/graph", { fallback: "Failed to load the graph" });
}

export async function fetchSpaceTags(): Promise<SpaceTagsResponse> {
  return request<SpaceTagsResponse>("/api/space/tags", { fallback: "Failed to load the tags" });
}

export async function postSpaceTagChange(change: SpaceTagChangeRequestBody): Promise<SpaceTagsResponse> {
  return request<SpaceTagsResponse>("/api/space/tags", {
    method: "POST",
    body: change satisfies SpaceTagChangeRequestBody,
    fallback: "Changing the tag failed",
  });
}

export async function fetchSpaceBookmarks(): Promise<SpaceBookmarksResponse> {
  return request<SpaceBookmarksResponse>("/api/space/bookmarks", { fallback: "Failed to load the bookmarks" });
}

export async function postSpaceBookmarkChange(change: SpaceBookmarkChangeRequestBody): Promise<SpaceBookmarksResponse> {
  return request<SpaceBookmarksResponse>("/api/space/bookmarks", {
    method: "POST",
    body: change satisfies SpaceBookmarkChangeRequestBody,
    fallback: "Changing the bookmarks failed",
  });
}

export async function fetchSpacePresets(): Promise<SpacePresetsResponse> {
  return request<SpacePresetsResponse>("/api/space/presets", { fallback: "Failed to load the presets" });
}

export async function postSpacePresetChange(change: SpacePresetChangeRequestBody): Promise<SpacePresetsResponse> {
  return request<SpacePresetsResponse>("/api/space/presets", {
    method: "POST",
    body: change satisfies SpacePresetChangeRequestBody,
    fallback: "Changing the presets failed",
  });
}

export async function fetchLayout(): Promise<LayoutResponse> {
  return request<LayoutResponse>("/api/space/layout", { fallback: "Failed to load the layout" });
}

export async function postSetFolderState(collapsedFolders: string[], expandedFolders: string[]): Promise<void> {
  await requestVoid("/api/space/layout", {
    method: "POST",
    body: { collapsedFolders, expandedFolders } satisfies LayoutRequestBody,
    fallback: "Saving the layout failed",
  });
}

export async function postSetGroups(groups: LayoutGroup[], focusedGroup: number): Promise<void> {
  await requestVoid("/api/space/layout", {
    method: "POST",
    body: { groups, focusedGroup } satisfies LayoutRequestBody,
    fallback: "Saving the layout failed",
  });
}

export async function fetchFile(filePath: string): Promise<FileResponse> {
  return request<FileResponse>(`/api/file?path=${encodeURIComponent(filePath)}`, { fallback: "Failed to load file" });
}

// Thrown when the file no longer has the revision the save named:
// something else wrote it since this copy was read, and nothing was written.
// Unlike every other failure, retrying the same save can never succeed.
export class SaveConflictError extends ApiError {
  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message, status, body);
    this.name = "SaveConflictError";
  }
}

// `baseRevision` is the revision `content` was composed from; without one the
// write is unconditional. The reply's revision is the base for the next save.
export async function putFile(
  filePath: string,
  content: string,
  baseRevision?: string,
  source?: PutFileRequestBody["source"],
): Promise<PutFileResponse> {
  // A failed write throws, like every other call here. Everything that
  // writes a document goes through saveQueue, which catches this and retries
  // — or, for a SaveConflictError, holds the content until the writer
  // decides.
  return request<PutFileResponse>(`/api/file?path=${encodeURIComponent(filePath)}`, {
    method: "PUT",
    body: { content, baseRevision, source } satisfies PutFileRequestBody,
    fallback: "Write failed",
    error: (message, body, status) =>
      status === 409 ? new SaveConflictError(message, status, body) : new ApiError(message, status, body),
  });
}

// The raw-bytes route: an `<img>` src, or a fetch of the bytes themselves.
export function rawFileUrl(path: string): string {
  return `/api/file/raw?path=${encodeURIComponent(path)}`;
}

// The path a raw-bytes address names, resolved against this page, or
// undefined for any other address. Comparing origins is the caller's.
export function rawFilePath(url: URL): string | undefined {
  return url.pathname === "/api/file/raw" ? (url.searchParams.get("path") ?? undefined) : undefined;
}

// The two raw-bytes /api/file/raw calls — a GET for the image pane's drag/
// drop-picker preview (wants the actual Blob) and a HEAD for the image
// pane's Size row (wants only the content-length header, not the body).
// Same URL-building either way, so callers pick the verb they need rather
// than this wrapper picking one for them.
export async function fetchFileRaw(path: string): Promise<Response> {
  return fetch(rawFileUrl(path));
}

export async function headFileRaw(path: string): Promise<Response> {
  return fetch(rawFileUrl(path), { method: "HEAD" });
}

export function thumbnailUrl(path: string): string {
  return `/api/file/thumbnail?path=${encodeURIComponent(path)}`;
}

/** Facts for a clip the browser couldn't decode, read by the host from its
 * header and kept in place of a thumbnail for `version`. */
export async function postClipFacts(path: string, version: string): Promise<ClipFactsResponse> {
  return request<ClipFactsResponse>(
    `/api/file/thumbnail-facts?path=${encodeURIComponent(path)}&version=${encodeURIComponent(version)}`,
    { method: "POST", fallback: "Couldn't read the clip's header" },
  );
}

export async function fetchThumbnailUsage(): Promise<ThumbnailUsageResponse> {
  return request<ThumbnailUsageResponse>("/api/thumbnails", { fallback: "Couldn't measure the thumbnails" });
}

export async function postClearThumbnails(): Promise<void> {
  await requestVoid("/api/thumbnails/clear", { method: "POST", fallback: "Couldn't clear the thumbnails" });
}

/** Stores a thumbnail made from the file at `version` (its folder listing's
 * own token), with what was decoded of the file. A 409 means the file changed
 * since; the thumbnail just made still shows, and the next listing makes
 * another. */
export async function putThumbnail(
  path: string,
  version: string,
  { image, width, height, duration }: { image: Blob; width: number; height: number; duration?: number },
): Promise<void> {
  const facts = `&width=${width}&height=${height}${duration === undefined ? "" : `&duration=${duration}`}`;
  const response = await fetch(`${thumbnailUrl(path)}&version=${encodeURIComponent(version)}${facts}`, {
    method: "PUT",
    headers: { "content-type": image.type || "application/octet-stream" },
    body: image,
  });
  if (!response.ok) throw await readError(response, { fallback: "Thumbnail upload failed" });
}

export async function getFileSha256(path: string): Promise<string> {
  const { sha256 } = await request<FileSha256Response>(`/api/file/sha256?path=${encodeURIComponent(path)}`, {
    fallback: "Hash failed",
  });
  return sha256;
}

export async function getFileInfo(path: string): Promise<FileInfoResponse> {
  return request<FileInfoResponse>(`/api/file/info?path=${encodeURIComponent(path)}`, { fallback: "Stat failed" });
}

export async function getFileDescription(path: string): Promise<string | undefined> {
  const { description } = await request<FileDescriptionResponse>(
    `/api/file/description?path=${encodeURIComponent(path)}`,
    { fallback: "Description read failed" },
  );
  return description;
}

export async function getBacklinks(path: string): Promise<Backlink[]> {
  const { backlinks } = await request<BacklinksResponse>(`/api/file/backlinks?path=${encodeURIComponent(path)}`, {
    fallback: "Backlinks read failed",
  });
  return backlinks;
}

export async function getPixelFormat(path: string): Promise<PixelFormatResponse> {
  return request<PixelFormatResponse>(`/api/file/pixel-format?path=${encodeURIComponent(path)}`, {
    fallback: "Header read failed",
  });
}

export async function getVideoFormat(path: string): Promise<ClipHeaderResponse> {
  return request<ClipHeaderResponse>(`/api/file/video-format?path=${encodeURIComponent(path)}`, {
    fallback: "Header read failed",
  });
}

// The sandbox broker's client half: one call family for every sandboxed
// kind, `kind` naming whose declarations and grants the server checks. A
// sandboxed frame's opaque origin can't reach these, so the parent calls them
// once its own broker has validated the request; Flow nodes run trusted in
// the page and call them directly.
//
// A space image pick never comes here: the host-owned picker reads it
// through /api/file/raw.

export async function sandboxRead(kind: SandboxKind, path: string, targetPath: string): Promise<SandboxReadResult> {
  return request<SandboxReadResult>("/api/sandbox/read", {
    method: "POST",
    body: { kind, path, targetPath } satisfies SandboxReadRequestBody,
    fallback: "Read failed",
  });
}

export async function sandboxWrite(
  kind: SandboxKind,
  path: string,
  targetPath: string,
  content: string,
): Promise<void> {
  await requestVoid("/api/sandbox/write", {
    method: "POST",
    body: { kind, path, targetPath, content } satisfies SandboxWriteRequestBody,
    fallback: "Write failed",
  });
}

export async function sandboxAddRow(
  kind: SandboxKind,
  path: string,
  targetPath: string,
  values: Record<string, string>,
): Promise<AddRowResponse> {
  return request<AddRowResponse>("/api/sandbox/add-row", {
    method: "POST",
    body: { kind, path, targetPath, values } satisfies SandboxAddRowRequestBody,
    fallback: "Adding the row failed",
  });
}

export async function sandboxAddToNote(
  kind: SandboxKind,
  path: string,
  targetPath: string,
  text: string,
  affixMode: AffixMode,
): Promise<void> {
  await requestVoid("/api/sandbox/add-to-note", {
    method: "POST",
    body: { kind, path, targetPath, text, affixMode } satisfies SandboxAddToNoteRequestBody,
    fallback: "Adding to the note failed",
  });
}

export async function sandboxGrant(kind: SandboxKind, path: string, capabilityKey: string): Promise<void> {
  await requestVoid("/api/sandbox/grant", {
    method: "POST",
    body: { kind, path, capabilityKey } satisfies SandboxGrantRequestBody,
    fallback: "Grant failed",
  });
}

export async function sandboxRevoke(kind: SandboxKind, path: string, capabilityKey: string): Promise<void> {
  await requestVoid("/api/sandbox/revoke", {
    method: "POST",
    body: { kind, path, capabilityKey } satisfies SandboxGrantRequestBody,
    fallback: "Revoke failed",
  });
}

export async function sandboxSetUnattended(
  kind: SandboxKind,
  path: string,
  allowed: boolean,
  until?: string,
): Promise<void> {
  await requestVoid("/api/sandbox/unattended", {
    method: "POST",
    body: { kind, path, allowed, until } satisfies SandboxUnattendedRequestBody,
    fallback: "Couldn't change unattended runs",
  });
}

// A generation's Console entry is the run's to write: this module stays DOM-
// and closure-free.
export async function sandboxGenerate(
  kind: SandboxKind,
  path: string,
  body: GenerateRequestBody,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  return request<GenerateResponse>("/api/sandbox/generate", {
    method: "POST",
    body: { kind, path, ...body } satisfies SandboxGenerateRequestBody,
    fallback: "Generate failed",
    signal,
  });
}

export async function sandboxGenerateOptions(
  kind: SandboxKind,
  path: string,
  body: GenerateOptionsRequestBody,
  signal?: AbortSignal,
): Promise<GenerateOptionsResponse> {
  return request<GenerateOptionsResponse>("/api/sandbox/generate-options", {
    method: "POST",
    body: { kind, path, ...body } satisfies SandboxGenerateOptionsRequestBody,
    fallback: "Generate failed",
    signal,
  });
}

export async function sandboxGenerateImage(
  kind: SandboxKind,
  path: string,
  body: GenerateImageRequestBody,
  signal?: AbortSignal,
): Promise<GenerateImageRouteResponse> {
  return request<GenerateImageRouteResponse>("/api/sandbox/generate-image", {
    method: "POST",
    body: { kind, path, ...body } satisfies SandboxGenerateImageRequestBody,
    fallback: "Image generation failed",
    signal,
  });
}

/** The clip already there for these inputs, or the job making it, which the
 * caller then waits on through /api/jobs. */
export async function sandboxGenerateVideo(
  kind: SandboxKind,
  path: string,
  body: GenerateVideoRequestBody,
  signal?: AbortSignal,
): Promise<GenerateVideoRouteResponse> {
  return request<GenerateVideoRouteResponse>("/api/sandbox/generate-video", {
    method: "POST",
    body: { kind, path, ...body } satisfies SandboxGenerateVideoRequestBody,
    fallback: "Video generation failed",
    signal,
  });
}

export async function postFindContext(directoryPath: string, query: string): Promise<FindContextResponse> {
  return request<FindContextResponse>(`/api/find-context?path=${encodeURIComponent(directoryPath)}`, {
    method: "POST",
    body: { query } satisfies FindContextRequestBody,
    fallback: "Find in context failed",
  });
}

/** A file the focused pane points at apart from its own: the one its preview
 * shows, or a gallery's selected tile. */
export interface SelectedFile {
  path: string;
  previewing: boolean;
}

// Mirrors the server's EditorContext (chatHandler.ts): the copilot's context
// is keyed off what the editor pane is actually showing, never the
// possibly-stale active path, which would let an open image's bytes (or a
// file a pane renders) be handed to edit_current_document.
//
// `file` goes with any view, "none" included: a Class's preview shows over a
// tab the copilot is told no file of.
export type ChatViewContext = (
  | { view: "document"; path: string; selection?: SelectedRange }
  | { view: "folder"; path: string }
  | { view: "image"; path: string }
  | { view: "video"; path: string }
  | { view: "pdf"; path: string }
  | { view: "applet"; path: string }
  | { view: "flow"; path: string; node?: string }
  | { view: "table"; path: string }
  | { view: "none" }
) & { file?: SelectedFile };

// "none" names no parameter: a request without one is a turn with no file open.
const CHAT_VIEW_QUERY_PARAM: Record<Exclude<ChatViewContext["view"], "none">, string> = {
  document: "path",
  folder: "folderPath",
  image: "imagePath",
  video: "videoPath",
  pdf: "pdfPath",
  applet: "appletPath",
  flow: "flowPath",
  table: "tablePath",
};

function selectionQuery(context: ChatViewContext): string {
  if (context.view === "flow" && context.node !== undefined) return `&node=${encodeURIComponent(context.node)}`;
  const selection = context.view === "document" ? context.selection : undefined;
  return selection ? `&selection=${formatSelectedRange(selection)}` : "";
}

// Appended rather than built with URLSearchParams so the path keeps its
// percent-encoding: a space path with a space in it has to survive the trip,
// and URLSearchParams would spell that space as `+`. The tab beside carries
// no selection: the hint is the focused tab's.
function chatViewQuery(context: ChatViewContext, beside: ChatViewContext | undefined): string {
  const params: string[] = [];
  if (context.view !== "none") {
    params.push(`${CHAT_VIEW_QUERY_PARAM[context.view]}=${encodeURIComponent(context.path)}${selectionQuery(context)}`);
  }
  if (context.file) {
    const previewing = context.file.previewing ? "&previewing=1" : "";
    params.push(`selectedFile=${encodeURIComponent(context.file.path)}${previewing}`);
  }
  if (beside && beside.view !== "none") {
    params.push(`${besideParam(CHAT_VIEW_QUERY_PARAM[beside.view])}=${encodeURIComponent(beside.path)}`);
  }
  return params.length === 0 ? "" : `?${params.join("&")}`;
}

/** `beside` is the tab the other editor group shows, when it names a file. */
export async function postChat(
  context: ChatViewContext,
  history: ChatMessage[],
  message: string,
  models: Pick<ChatRequestBody, "model" | "effort"> = {},
  beside?: ChatViewContext,
): Promise<ChatResponse> {
  return request<ChatResponse>(`/api/chat${chatViewQuery(context, beside)}`, {
    method: "POST",
    body: { history, message, ...models } satisfies ChatRequestBody,
    fallback: "Chat failed",
  });
}

/** `fetch: false` skips the remote: the working tree against refs already fetched. */
export async function fetchGitStatus({ fetch = true }: { fetch?: boolean } = {}): Promise<GitStatus> {
  return request<GitStatus>(fetch ? "/api/git/status" : "/api/git/status?fetch=0", {
    fallback: "Failed to load git status",
  });
}

export async function postGitCommit(message: string): Promise<GitActionResponse> {
  return request<GitActionResponse>("/api/git/commit", {
    method: "POST",
    body: { message } satisfies GitCommitRequestBody,
    fallback: "Commit failed",
  });
}

export async function postGitPull(): Promise<GitActionResponse> {
  return request<GitActionResponse>("/api/git/pull", { method: "POST", fallback: "Pull failed" });
}

export async function postGitPush(): Promise<GitActionResponse> {
  return request<GitActionResponse>("/api/git/push", { method: "POST", fallback: "Push failed" });
}

export async function postGitSync(): Promise<GitActionResponse> {
  return request<GitActionResponse>("/api/git/sync", { method: "POST", fallback: "Sync failed" });
}

export async function fetchModels(): Promise<ModelsResponse> {
  return request<ModelsResponse>("/api/models", { fallback: "Failed to load models" });
}

export async function fetchImageModels(): Promise<ImageModelsResponse> {
  return request<ImageModelsResponse>("/api/image-models", { fallback: "Failed to load image models" });
}

export async function postDefaultModel(model: string): Promise<void> {
  await requestVoid("/api/models/default", {
    method: "POST",
    body: { model } satisfies DefaultModelRequestBody,
    fallback: "Couldn't save the default text model",
  });
}

export async function postDefaultImageModel(model: string): Promise<void> {
  await requestVoid("/api/image-models/default", {
    method: "POST",
    body: { model } satisfies DefaultModelRequestBody,
    fallback: "Couldn't save the default image model",
  });
}

export async function fetchVideoModels(): Promise<VideoModelsResponse> {
  return request<VideoModelsResponse>("/api/video-models", { fallback: "Failed to load video models" });
}

export async function postDefaultVideoModel(model: string): Promise<void> {
  await requestVoid("/api/video-models/default", {
    method: "POST",
    body: { model } satisfies DefaultModelRequestBody,
    fallback: "Couldn't save the default video model",
  });
}

export async function fetchProviders(): Promise<ProvidersResponse> {
  return request<ProvidersResponse>("/api/providers", { fallback: "Failed to load providers" });
}

export async function postSaveProvider(payload: SaveProviderRequestBody): Promise<void> {
  await requestVoid("/api/providers", {
    method: "POST",
    body: payload,
    fallback: "Couldn't save the provider",
  });
}

/** Saves the enabled list `lists` names, text or image, leaving the other. */
export async function postSaveProviderModels(
  id: string,
  lists: Pick<SaveProviderRequestBody, "textModels" | "imageModels">,
): Promise<void> {
  await requestVoid("/api/providers", {
    method: "POST",
    body: { id, ...lists } satisfies SaveProviderRequestBody,
    fallback: "Couldn't save the model selection",
  });
}

export async function postDiscoverProviderModels(id: string): Promise<DiscoverModelsResponse> {
  const body = await request<Partial<DiscoverModelsResponse>>("/api/providers/discover", {
    method: "POST",
    body: { id } satisfies ProviderIdRequestBody,
    fallback: "Couldn't reach the provider",
  });
  return { textModels: body.textModels ?? [], imageModels: body.imageModels ?? [] };
}

export async function postDeleteProvider(id: string): Promise<void> {
  await requestVoid("/api/providers/delete", {
    method: "POST",
    body: { id } satisfies ProviderIdRequestBody,
    fallback: "Couldn't delete the provider",
  });
}

/** Starts a ChatGPT sign-in and answers the page to approve it on. */
export async function postProviderSignIn(id: string, options: { planUsage?: boolean } = {}): Promise<string> {
  const body = await request<ProviderSignInStartResponse>("/api/providers/sign-in", {
    method: "POST",
    body: { id, ...options } satisfies ProviderSignInRequestBody,
    fallback: "Couldn't start signing in",
  });
  return body.authorizationUrl;
}

export async function fetchProviderSignInStatus(id: string): Promise<ProviderSignInStatus> {
  return request<ProviderSignInStatus>(`/api/providers/sign-in?id=${encodeURIComponent(id)}`, {
    fallback: "Couldn't check the sign-in",
  });
}

export async function postProviderSignOut(id: string): Promise<ProviderSignOutResponse> {
  return request<ProviderSignOutResponse>("/api/providers/sign-out", {
    method: "POST",
    body: { id } satisfies ProviderIdRequestBody,
    fallback: "Couldn't sign out",
  });
}

export async function fetchMcpServers(): Promise<McpServersResponse> {
  return request<McpServersResponse>("/api/mcp-servers", { fallback: "Failed to load MCP servers" });
}

export async function postSaveMcpServer(payload: SaveMcpServerRequestBody): Promise<void> {
  await requestVoid("/api/mcp-servers", {
    method: "POST",
    body: payload,
    fallback: "Couldn't save the MCP server",
  });
}

export async function postDeleteMcpServer(id: string): Promise<void> {
  await requestVoid("/api/mcp-servers/delete", {
    method: "POST",
    body: { id } satisfies McpServerIdRequestBody,
    fallback: "Couldn't delete the MCP server",
  });
}

export async function postConnectMcpServer(id: string): Promise<McpServerConnectResponse> {
  return request<McpServerConnectResponse>("/api/mcp-servers/connect", {
    method: "POST",
    body: { id } satisfies McpServerIdRequestBody,
    fallback: "Couldn't connect to the MCP server",
  });
}

export async function postMcpSignIn(id: string): Promise<string> {
  const body = await request<McpSignInStartResponse>("/api/mcp-servers/sign-in", {
    method: "POST",
    body: { id } satisfies McpServerIdRequestBody,
    fallback: "Couldn't start signing in",
  });
  return body.authorizationUrl;
}

export async function fetchMcpSignInStatus(id: string): Promise<McpSignInStatus> {
  return request<McpSignInStatus>(`/api/mcp-servers/sign-in?id=${encodeURIComponent(id)}`, {
    fallback: "Couldn't check the sign-in",
  });
}

export async function fetchPublishers(): Promise<PublishersResponse> {
  return request<PublishersResponse>("/api/publishers", { fallback: "Failed to load publishers" });
}

export async function postSavePublisher(payload: SavePublisherRequestBody): Promise<PublisherSaveResult> {
  const response = await apiFetch("/api/publishers", {
    method: "POST",
    body: payload,
    fallback: "Couldn't save the publisher",
  });
  if (response.status === 204) return {};
  return (await response.json()) as PublisherSaveResult;
}

// Thrown instead of a plain Error so a failed site create can carry
// `existingSite` back to the New Site modal.
export class CreateSiteError extends Error {
  constructor(
    message: string,
    public readonly existingSite?: ExistingSogmaSite,
  ) {
    super(message);
  }
}

// The site-create call's `error` hook.
function createSiteError(message: string, body: Record<string, unknown> | undefined): CreateSiteError {
  return new CreateSiteError(message, (body as Partial<CreateSiteErrorBody> | undefined)?.existingSite);
}

export async function postCreateSite(
  parentPath: string,
  input: ({ name: string; domain?: string } | { existingSite: ExistingSogmaSite }) & { publisherId?: string },
): Promise<CreateSiteResponse> {
  const body: CreateSiteRequestBody =
    "existingSite" in input
      ? { parentPath, publisherId: input.publisherId, existingSite: input.existingSite }
      : { parentPath, publisherId: input.publisherId, name: input.name, domain: input.domain };
  return request<CreateSiteResponse>("/api/space/site", {
    method: "POST",
    body,
    fallback: "Failed to create site",
    error: createSiteError,
  });
}

export async function postDeletePublisher(id: string): Promise<void> {
  await requestVoid("/api/publishers/delete", {
    method: "POST",
    body: { id } satisfies PublisherIdRequestBody,
    fallback: "Couldn't delete the publisher",
  });
}

export class PublishDocumentError extends Error {}

// The assistant rail's context panel's Publish/Update button
// (docs/publishing.md's Publishing a document section) — one call for both first publish and
// every update after, same as the server route: whether it's a create or an
// update is decided server-side by whether the file already carries an id.
export async function postPublishDocument(path: string): Promise<PublishDocumentResponse> {
  return request<PublishDocumentResponse>("/api/space/publish", {
    method: "POST",
    body: { path } satisfies PublishDocumentRequestBody,
    fallback: "Failed to publish",
    error: (message) => new PublishDocumentError(message),
  });
}

// Site Settings (docs/publishing.md) — the publisher's own settings schema
// and current values, and the merge-patch write, both through routes that
// hold the token server-side. A rejected write carries `field`, the JSON
// Pointer of the control the service refused, so the dialog can name it.
export class SiteSettingsError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "SiteSettingsError";
    this.field = field;
  }
}

// The `error` hook both site-settings calls pass to `request`.
function siteSettingsError(message: string, body: Record<string, unknown> | undefined): SiteSettingsError {
  return new SiteSettingsError(message, (body as Partial<SiteSettingsErrorBody> | undefined)?.field);
}

export async function fetchSiteSettings(sitePath: string): Promise<SiteSettingsResponse> {
  return request<SiteSettingsResponse>(`/api/space/site/settings?path=${encodeURIComponent(sitePath)}`, {
    fallback: "Failed to load site settings",
    error: siteSettingsError,
  });
}

// One Save: `changes` carries only what changed, so anything absent is left
// exactly as the service and `_site.json` hold it, including settings this
// pragma never rendered.
export async function postSiteSettings(
  sitePath: string,
  changes: SiteSettingsChanges,
): Promise<SaveSiteSettingsResponse> {
  return request<SaveSiteSettingsResponse>("/api/space/site/settings", {
    method: "POST",
    body: { path: sitePath, ...changes } satisfies SaveSiteSettingsRequestBody,
    fallback: "Failed to save site settings",
    error: siteSettingsError,
  });
}

export async function postSiteImage(sitePath: string, image: string): Promise<SiteImageUploadResponse> {
  return request<SiteImageUploadResponse>("/api/space/site/image", {
    method: "POST",
    body: { path: sitePath, image } satisfies SiteImageUploadRequestBody,
    fallback: "Failed to upload the image",
  });
}
