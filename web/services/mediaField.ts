// A `media` field's control: the thumbnail, name and state of the file a
// Table or Class cell points at, and the drop that sets it. One module
// for both panes, since a view may not import another view.
//
// The value is a path as a note writes one — relative to the document's
// folder, or a `lib:` path — not a capability-style path, so a table and the
// stills beside it move together and a move's link rewriting applies here.
import { resolveFileReference } from "../../src/protocol/relativeReference.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  parseRootedPath,
  type RootedPath,
  sameRoot,
} from "../../src/protocol/rootedPath.ts";
import { imageMediaTypeForPath, vectorImageMediaTypeForPath, videoMediaTypeForPath } from "../../src/protocol/types.ts";
import {
  ApiError,
  fetchFileRaw,
  getFileInfo,
  postCreateEntry,
  postUploadFile,
  rawFilePath,
  rawFileUrl,
} from "../core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE, readDraggedPath, wireEntryDrag } from "../core/paths.ts";
import { listedAsGone, noteUnlistedWrites, writePathFrom } from "../core/spaceTree.ts";
import { formatFileSize } from "../lib/dom.ts";
import { createInlineError } from "../lib/inlineError.ts";
import { type ThumbnailFacts, type ThumbnailHud, thumbnailHud } from "../lib/mediaHud.ts";
import { describeLoaded, readSvgStandInSize } from "../lib/svgSize.ts";
import type { DialogHandle, DialogService } from "./dialog.ts";
import { type DroppedImportResult, describeImportProblems, importDroppedFiles } from "./mediaImport.ts";

/** Where a stored value points, as a rooted path, or undefined for an empty
 * or unreadable one — resolved exactly as an image embed in a note is.
 * Unreadable is not an error: the file is hand-editable, and a cell mid-edit
 * renders as nothing rather than failing the row. */
export function resolveMediaValue(docDir: string, value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? resolveFileReference(docDir, trimmed) : undefined;
}

/** The folder a desktop drop lands in, as a rooted path: `folder` read the
 * way a value is, or the document's own folder when there is none. Undefined
 * when it can't be used — unreadable, or outside the library a library
 * document lives in, the same line drawn for a value. */
export function resolveMediaFolder(docDir: string, folder: string | undefined): string | undefined {
  const trimmed = folder?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) return docDir;
  const target = resolveMediaValue(docDir, trimmed);
  if (target === undefined) return undefined;
  const doc = parseRootedPath(docDir);
  if (isLibraryRoot(doc.root) && !sameRoot(doc.root, parseRootedPath(target).root)) return undefined;
  return target;
}

export interface MediaFolderPrompt {
  dialog: DialogService;
  docDir: string;
  current: string;
  /** Anchored inside this rather than over the whole window, so the sidebar
   * stays live and a folder can be dragged in from any tree. */
  host: HTMLElement;
  onOpen(handle: DialogHandle): void;
}

/** Asks for a media column's or field's drop folder, typed or dragged from a
 * tree. Resolves with the new value — `""` to clear it — or null when
 * cancelled. */
export function promptMediaFolder(options: MediaFolderPrompt): Promise<string | null> {
  const { dialog, docDir } = options;
  const inLibrary = isLibraryRoot(parseRootedPath(docDir).root);
  const outside = inLibrary ? "Choose a folder in this library." : "Choose a folder in the space or a library.";
  return dialog
    .prompt({
      title: "Media folder",
      message: inLibrary
        ? "Files dropped from outside Pragma are copied here. Drag a folder in from this library, or type one relative to this document; empty means this document's own folder."
        : "Files dropped from outside Pragma are copied here. Drag a folder in from a tree, or type one relative to this document or as lib:<id>/…; empty means this document's own folder.",
      label: "Folder",
      value: options.current,
      submitLabel: "Save",
      host: options.host,
      onOpen: (handle) => {
        wireFolderDrop(handle.panel, docDir, outside);
        options.onOpen(handle);
      },
      validate: (value) => (resolveMediaFolder(docDir, value) === undefined ? outside : undefined),
    })
    .then((value) => (value === null ? null : value.trim().replace(/\/+$/, "")));
}

// The whole panel takes the drop, not just the field: a small input is a
// hard target to hit from across the window. Only a tree's folder row is
// accepted — a file would leave "its folder" to guesswork.
function wireFolderDrop(panel: HTMLElement, docDir: string, outside: string): void {
  const input = panel.querySelector<HTMLInputElement>(".dialog-input");
  const error = panel.querySelector<HTMLElement>(".dialog-error");
  if (!input) return;
  const refuse = (message: string) => {
    if (!error) return;
    error.replaceChildren(createInlineError({ message }));
    error.hidden = false;
  };
  panel.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes(DRAGGED_ENTRY_TYPE)) return;
    event.preventDefault();
    panel.classList.add("drag-over");
  });
  panel.addEventListener("dragleave", (event) => {
    if (!panel.contains(event.relatedTarget as Node | null)) panel.classList.remove("drag-over");
  });
  panel.addEventListener("drop", (event) => {
    panel.classList.remove("drag-over");
    const dragged = readDraggedPath(event);
    if (!dragged) return;
    event.preventDefault();
    if (event.dataTransfer?.getData(DRAGGED_ENTRY_TYPE) !== "directory") {
      refuse("Drop a folder, not a file.");
      return;
    }
    const value = formatRootedPath(dragged) === docDir ? "" : writePathFrom(docDir, dragged, { folder: true });
    if (value === undefined) {
      refuse(outside);
      return;
    }
    input.value = value;
    if (error) error.hidden = true;
    input.focus();
  });
}

export interface MediaFieldSpec {
  /** The document's own folder, rooted: `""` for the space's top level,
   * `lib:<id>` or `lib:<id>/…` for a library. */
  docDir: string;
  value: string;
  /** Where a desktop drop is copied, as stored: read the way a value is,
   * the document's own folder when absent. */
  folder?: string;
  readOnly: boolean;
  onChange(value: string): void;
  /** The run of fields a preview's arrows step through with this one, in
   * the order drawn: its column's, say. */
  strip: string;
  /** Whether the file's name shows beside its picture, as its column says.
   * Hidden, it is the picture's tooltip; a state, such as an unreadable
   * path, always shows. */
  showName?: boolean;
  /** A click on the thumbnail, with the file it shows and this field. */
  openItem(rootedPath: string, field: HTMLElement): void;
  /** Where a click on an offline file says what became of it. */
  dialog: DialogService;
  notify(message: string): void;
  /** Copies dropped desktop files into a folder; see mediaImportFor. */
  importFiles(files: readonly File[], dir: string): Promise<DroppedImportResult>;
}

/** The real importer, over the dialog the pane already holds — the same
 * service a tree drop uses, so a file dropped on a cell gets the same
 * progress and the same refusals. */
export function mediaImportFor(dialog: DialogService): MediaFieldSpec["importFiles"] {
  return async (files, dir) => {
    const problem = await ensureFolder(dir);
    if (problem) {
      return {
        imported: [],
        refused: [],
        failed: files.map((file) => ({ name: file.name, reason: problem })),
        cancelled: false,
      };
    }
    const result = await importDroppedFiles(files, dir, {
      dialog,
      createEntry: postCreateEntry,
      upload: postUploadFile,
    });
    // The listing learns of a copy only on its next read, and a redraw
    // before then must not call the file just linked gone.
    if (result.imported.length > 0) noteUnlistedWrites();
    return result;
  };
}

// A configured folder is made on the first drop into it rather than when
// it's set, so naming one costs nothing until it's used. Create answers 409
// for a folder already there, which is the common case, not a failure.
async function ensureFolder(dir: string): Promise<string | undefined> {
  const { root, path } = parseRootedPath(dir);
  if (path === "") return undefined;
  const parent = formatRootedPath({ root, path: dirnameOf(path) });
  try {
    await postCreateEntry(parent, basenameOf(path), "directory");
    return undefined;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return undefined;
    return error instanceof Error ? error.message : "Could not create the folder";
  }
}

const PLAY_GLYPH = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3Z"/></svg>`;
const FILE_GLYPH = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

// What an editor shows for media it can't reach, in as many words as the
// thumbnail's width holds (media-field.css).
function offlineSlate(): HTMLElement {
  const slate = document.createElement("span");
  slate.className = "media-field-offline";
  slate.setAttribute("aria-hidden", "true");
  const line = (className: string, text: string) => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    return span;
  };
  slate.append(line("media-field-offline-short", "Offline"), line("media-field-offline-long", "Media offline"));
  return slate;
}

// Why a file shows offline: the space's listing called it gone, or its
// picture failed to load.
type Offline = "unlisted" | "unloaded";

// A file's own tab says this of one that has gone; a cell says the same.
const GONE_TEXT = "This file isn't there any more. It may have been moved or deleted.";

// A bare "Not found" is the info route's word for nothing at the path. Any
// other refusal, such as a library no longer registered, gives its reason in
// its own words, which say more than the general sentence.
function refusalText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404 && error.message === "Not found") return GONE_TEXT;
  return error instanceof Error ? error.message : GONE_TEXT;
}

// For a file that is there but failed to load. A video's words are its own
// tab's: a container names no codec, so ProRes in a `.mov` is the ordinary
// case. Every image type listed decodes, so a failed one is damaged or
// misnamed.
function undecodableText(target: string): string {
  return videoMediaTypeForPath(target)
    ? "This browser can't play this video's format. The file itself is untouched."
    : "This browser can't show this image. The file may be damaged, or not the format its name says.";
}

interface OfflineDetails {
  reason: string;
  path: string;
  /** The value as the document writes it. */
  written: string;
  /** For a file that is there. */
  size?: number;
}

// Why, then which file. The value as written shows only where it says more
// than the path and the name do: one relative to a folder, or escaped.
function showOfflineDetails(dialog: DialogService, details: OfflineDetails): void {
  const content = document.createElement("div");
  content.className = "dialog-body";
  const reason = document.createElement("p");
  reason.className = "dialog-message";
  reason.textContent = details.reason;
  const facts = document.createElement("dl");
  facts.className = "dialog-details";
  const fact = (term: string, text: string) => {
    const key = document.createElement("dt");
    key.textContent = term;
    const value = document.createElement("dd");
    value.textContent = text;
    facts.append(key, value);
  };
  fact("Path", details.path);
  if (details.written !== details.path && details.written !== basenameOf(details.path)) {
    fact("Value", details.written);
  }
  if (details.size !== undefined) fact("Size", formatFileSize(details.size));
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn btn-large primary dialog-primary";
  ok.textContent = "OK";
  actions.append(ok);
  content.append(reason, facts, actions);
  const handle = dialog.open({ title: "Media offline", content, initialFocus: ok });
  ok.addEventListener("click", () => handle.close());
}

/** The file behind a picture Pragma itself shows, dragged as an image: one
 * whose address is this page's raw-file route. */
function servedPicture(event: DragEvent): RootedPath | undefined {
  const address = event.dataTransfer
    ?.getData("text/uri-list")
    .split(/\r?\n/)
    .find((line) => line !== "" && !line.startsWith("#"));
  if (!address) return undefined;
  try {
    const url = new URL(address, location.href);
    const path = url.origin === location.origin ? rawFilePath(url) : undefined;
    return path === undefined ? undefined : parseRootedPath(path);
  } catch {
    return undefined;
  }
}

/** The fields drawn in `within` on `field`'s strip, in the order shown. */
export function mediaStrip(within: HTMLElement, field: HTMLElement): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>(".media-field")].filter(
    (other) => other.dataset.mediaStrip === field.dataset.mediaStrip,
  );
}

/** The rooted path of the file a media field shows: undefined for none, and
 * for one that has gone. */
export function mediaFieldPath(field: HTMLElement | undefined): string | undefined {
  if (!field || field.classList.contains("is-missing")) return undefined;
  return field.dataset.mediaPath || undefined;
}

/** Puts focus on a media field's thumbnail, where a click on it leaves it. */
export function focusMediaField(field: HTMLElement): void {
  field.querySelector<HTMLElement>(".media-field-thumb")?.focus();
}

// A media field's hover bars, for the file it shows.
interface Bars {
  target: string;
  hud: ThumbnailHud;
  facts: ThumbnailFacts;
  sized: boolean;
  /** A still, whose bars show the scale it is drawn at. */
  still: boolean;
}

export function createMediaField(spec: MediaFieldSpec): HTMLElement {
  const root = document.createElement("div");
  root.className = "media-field";
  root.dataset.mediaStrip = spec.strip;

  const thumb = document.createElement("button");
  thumb.type = "button";
  thumb.className = "media-field-thumb thumbnail-box";
  const name = document.createElement("span");
  name.className = "media-field-name";
  root.append(thumb, name);

  let value = spec.value;
  // The picture's hover bars, and what they know of the file it shows.
  let bars: Bars | undefined;
  let offline: Offline | undefined;
  // A click's question to the server, while it is out.
  let checking = false;

  function learn(shown: Bars, facts: ThumbnailFacts): void {
    if (shown !== bars) return;
    Object.assign(shown.facts, facts);
    shown.hud.fill(shown.facts);
  }

  // `believeListing` false draws from the file whatever the listing says.
  function render(believeListing = true): void {
    const target = resolveMediaValue(spec.docDir, value);
    root.dataset.mediaPath = target ?? "";
    root.classList.toggle("is-empty", target === undefined);
    root.classList.remove("is-missing");
    thumb.replaceChildren();
    thumb.disabled = target === undefined;
    thumb.removeAttribute("aria-label");
    delete thumb.dataset.tooltip;
    name.hidden = false;
    bars = undefined;
    offline = undefined;

    if (target === undefined) {
      name.textContent = value.trim() ? "Unreadable path" : "None";
      thumb.innerHTML = FILE_GLYPH;
      return;
    }

    const fileName = basenameOf(target);
    name.textContent = fileName;
    name.hidden = !spec.showName;
    thumb.setAttribute("aria-label", fileName);
    if (!spec.showName) thumb.dataset.tooltip = fileName;
    // A file the space's listing lacks is drawn offline with nothing asked
    // of the server. One the listing can't vouch for is fetched, and a
    // failed load draws the same.
    const onMissing = () => showOffline(target, fileName, "unloaded");
    if (believeListing && listedAsGone(target)) {
      showOffline(target, fileName, "unlisted");
      return;
    }
    // The picture is the file's own: an image scaled, or a video's first
    // frame, fetched lazily as the cell scrolls in.
    if (imageMediaTypeForPath(target)) {
      const img = document.createElement("img");
      img.className = "media-field-picture";
      img.loading = "lazy";
      img.alt = "";
      img.src = rawFileUrl(target);
      img.addEventListener("error", onMissing);
      wireEntryDrag(img, () => ({ path: target, type: "file" }));
      thumb.append(img);
      const shown = barsOn(target, true);
      const standIn = vectorImageMediaTypeForPath(target) ? readSvgStandInSize(fetchFileRaw, target) : undefined;
      describeLoaded(img, standIn, (width, height) => learn(shown, { width, height }));
    } else if (videoMediaTypeForPath(target)) {
      const video = document.createElement("video");
      video.className = "media-field-picture";
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = rawFileUrl(target);
      video.addEventListener("error", onMissing);
      thumb.append(video);
      const shown = barsOn(target, false);
      video.addEventListener("loadedmetadata", () => {
        const duration = Number.isFinite(video.duration) ? video.duration : undefined;
        learn(shown, { width: video.videoWidth, height: video.videoHeight, duration });
      });
    } else {
      thumb.innerHTML = FILE_GLYPH;
    }
  }

  // The thumbnail filled in the editor's offline slate, its name staying as
  // the column says, and the path it looked for as its tooltip.
  function showOffline(target: string, fileName: string, cause: Offline): void {
    root.classList.add("is-missing");
    bars = undefined;
    offline = cause;
    thumb.setAttribute("aria-label", `Media offline: ${fileName}`);
    thumb.dataset.tooltip = target;
    thumb.replaceChildren(offlineSlate());
  }

  // Over the picture just drawn, filled as the file tells its facts.
  function barsOn(target: string, still: boolean): Bars {
    bars = { target, hud: thumbnailHud(thumb), facts: {}, sized: false, still };
    bars.hud.fill(bars.facts);
    return bars;
  }

  // The size is the one fact the picture doesn't carry, so it is asked for
  // on the first hover that shows the bars: a cell too narrow for them
  // never asks. A still's scale is measured at every such hover, since a
  // card's picture follows the card's width.
  thumb.addEventListener("pointerenter", () => {
    const shown = bars;
    if (!shown?.hud.shown()) return;
    if (shown.still) shown.hud.measure();
    if (shown.sized) return;
    shown.sized = true;
    getFileInfo(shown.target).then(
      (info) => learn(shown, { size: info.size }),
      () => undefined,
    );
  });

  thumb.addEventListener("click", () => {
    const target = resolveMediaValue(spec.docDir, value);
    if (target === undefined) return;
    if (offline) void explainOffline(target, offline);
    else spec.openItem(target, root);
  });

  // An offline file's click asks the server what became of it: the slate
  // can't tell a file that has gone from one this browser can't decode, and
  // the listing it was drawn from may be behind. One there after all, which
  // only the listing called gone, is drawn from the file instead.
  async function explainOffline(target: string, cause: Offline): Promise<void> {
    if (checking) return;
    checking = true;
    let size: number | undefined;
    let reason: string;
    try {
      const info = await getFileInfo(target);
      if (info.kind === "file") size = info.size;
      reason = size === undefined ? GONE_TEXT : undecodableText(target);
    } catch (error) {
      reason = refusalText(error);
    } finally {
      checking = false;
    }
    if (!root.isConnected || resolveMediaValue(spec.docDir, value) !== target) return;
    if (size !== undefined && cause === "unlisted") {
      render(false);
      return;
    }
    showOfflineDetails(spec.dialog, { reason, path: target, written: value.trim(), size });
  }

  function set(next: string): void {
    value = next;
    spec.onChange(next);
    render();
  }

  if (!spec.readOnly) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "icon-button media-field-clear";
    clear.setAttribute("aria-label", "Clear");
    clear.addEventListener("click", () => set(""));
    root.append(clear);

    // A drop from a tree carries the row's rooted path as text; a drop from
    // the desktop carries files, which are copied into the media folder
    // first so there is something to link. Either way the cell ends up holding a
    // path, never bytes.
    //
    // A file Pragma names is linked where it lies, before any files the drop
    // also carries: a browser hands over a copy of any picture dragged as an
    // image, Pragma's own included, named after its address.
    root.addEventListener("dragover", (event) => {
      event.preventDefault();
      root.classList.add("drag-over");
    });
    root.addEventListener("dragleave", () => root.classList.remove("drag-over"));
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      root.classList.remove("drag-over");
      const named = event.dataTransfer?.types?.includes(DRAGGED_ENTRY_TYPE) ? readDraggedPath(event) : undefined;
      const files = event.dataTransfer?.files;
      const dragged = named ?? servedPicture(event) ?? (files?.length ? undefined : readDraggedPath(event));
      if (!dragged) {
        if (files?.length) void dropFiles(Array.from(files));
        return;
      }
      const next = writePathFrom(spec.docDir, dragged);
      if (next === undefined) {
        spec.notify("A table in a library can only point at files inside that same library.");
        return;
      }
      set(next);
    });
  }

  async function dropFiles(files: File[]): Promise<void> {
    // Only what the cell can draw, an image or a video's frame: a PDF the
    // shared media lookup would accept has nothing to show here.
    const media = files.filter((file) => imageMediaTypeForPath(file.name) ?? videoMediaTypeForPath(file.name));
    if (media.length === 0) {
      spec.notify(`${files.map((file) => file.name).join(", ")}: not an image or video.`);
      return;
    }
    const dir = resolveMediaFolder(spec.docDir, spec.folder);
    if (dir === undefined) {
      spec.notify(`This field's media folder "${spec.folder}" can't be used, so nothing was copied.`);
      return;
    }
    // One cell holds one file. The rest are left where they were rather
    // than copied in and then dropped on the floor.
    const result = await spec.importFiles([media[0]], dir);
    const landed = result.imported[0];
    if (landed !== undefined) {
      const next = writePathFrom(spec.docDir, parseRootedPath(landed));
      if (next !== undefined) set(next);
    }
    const problems = describeImportProblems(result);
    const extra = media.length > 1 ? `Only ${media[0].name} was linked; a cell holds one file.` : undefined;
    const message = [problems, extra].filter(Boolean).join("\n\n");
    if (message) spec.notify(message);
  }

  thumb.innerHTML = PLAY_GLYPH; // replaced on first render; keeps the button non-empty for a11y
  render();
  return root;
}
