import { CHAT_MODES, type ChatMode } from "../../src/protocol/api.ts";
import { Emitter } from "../lib/emitter.ts";
import { type Guides, readGuides } from "../lib/videoGuides.ts";
import { type Look, readLook } from "../lib/videoLut.ts";
import type { Volume } from "../lib/videoPlayer.ts";

// Typed get/set/subscribe per `pragma:*` localStorage key — the one owner of
// each preference's value, never a DOM attribute read back. A subscriber
// fires immediately, then on every change (see lib/emitter.ts). Applying a
// value's *effect* (a class, a CodeMirror reconfigure) stays with the view
// that owns it.

export interface Setting<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
}

// Also how a module keeps an on/off preference of its own, as createSetting
// below is for one with named values.
export function createBooleanSetting(key: string, parse: (stored: string | null) => boolean): Setting<boolean> {
  const emitter = new Emitter<boolean>(parse(localStorage.getItem(key)));
  return {
    get: () => emitter.get(),
    set(value: boolean): void {
      localStorage.setItem(key, String(value));
      emitter.set(value);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
}

// Hidden by default.
export const showExtensions = createBooleanSetting("pragma:show-extensions", (stored) => stored === "true");

// On by default: the link suggester writes [[wikilinks]], or Markdown links
// once this is off.
export const useWikilinks = createBooleanSetting("pragma:use-wikilinks", (stored) => stored !== "false");

// On by default: reading view keeps a paragraph's line breaks, or joins its
// lines as Markdown does once this is off.
export const singleLineBreaks = createBooleanSetting("pragma:single-line-breaks", (stored) => stored !== "false");

// On by default: a note's or a screenplay's syntax stays hidden where the
// selection touches it too, as in a rich text editor. Off, it shows there.
export const hideFormatSyntax = createBooleanSetting("pragma:hide-format-syntax", (stored) => stored !== "false");

// On by default: the editor underlines misspelled words in a note or a
// screenplay, and text fields keep the browser's own checking. Off stops both.
export const spellcheck = createBooleanSetting("pragma:spellcheck", (stored) => stored !== "false");

// Off by default, leaving an editor's selected text the grey of a tree's open
// file. On, an editor's, reading view's and a title's is lime with dark text
// in both themes.
export const brightSelection = createBooleanSetting("pragma:bright-selection", (stored) => stored === "true");

export const sidebarHidden = createBooleanSetting("pragma:sidebar-hidden", (stored) => stored === "true");

// The Format column beside a note being edited, in every group: a way of
// writing rather than a view of one note. Off until turned on in ⋮.
export const formatColumn = createBooleanSetting("pragma:format-column", (stored) => stored === "true");

// How many tools past a format's usual ones the Format column holds, fewer
// below 0, as a drag on its foot left it: one count for every group, as the
// column is. Counted from the usual tools, so a format that adds one still
// shows it.
const FORMAT_COLUMN_EXTRA_KEY = "pragma:format-column-extra";
const formatColumnExtraEmitter = new Emitter<number>(
  Number.parseInt(localStorage.getItem(FORMAT_COLUMN_EXTRA_KEY) ?? "", 10) || 0,
);
export const formatColumnExtra: Setting<number> = {
  get: () => formatColumnExtraEmitter.get(),
  set(value: number): void {
    localStorage.setItem(FORMAT_COLUMN_EXTRA_KEY, String(value));
    formatColumnExtraEmitter.set(value);
  },
  subscribe: (listener) => formatColumnExtraEmitter.subscribe(listener),
};

function createStringSetting(key: string): Setting<string> {
  const emitter = new Emitter<string>(localStorage.getItem(key) ?? "");
  return {
    get: () => emitter.get(),
    set(value: string): void {
      localStorage.setItem(key, value);
      emitter.set(value);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
}

// A preference a module keeps for itself, such as a text format's, under its
// own `pragma:*` key. The module's parser reads the stored value, so one this
// build doesn't know falls back to the module's default rather than failing.
export function createSetting<T extends string>(key: string, parse: (stored: string | null) => T): Setting<T> {
  const emitter = new Emitter<T>(parse(localStorage.getItem(key)));
  return {
    get: () => emitter.get(),
    set(value: T): void {
      localStorage.setItem(key, value);
      emitter.set(value);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
}

// Where the sidebar was left: the active rail view and, for the Libraries
// view, which library was open in it. Per browser like the collapsed flag
// above, not in the space's workspace file: the Libraries view is the same
// panel whichever space is open, and "where was I" belongs to the device that
// was there. "" means nothing remembered.
export const sidebarView = createStringSetting("pragma:sidebar-view");
export const sidebarLibrary = createStringSetting("pragma:sidebar-library");

// How large a gallery draws its tiles, per browser like the sidebar's place:
// how one device likes to look at folders. Their order is the folder's own,
// or its Sort by on this install.
export const galleryTileSize = createStringSetting("pragma:gallery-tile-size");

export const assistantHidden = createBooleanSetting("pragma:assistant-hidden", (stored) => stored === "true");

// The assistant inspector's selected tab ("" means the default) and whether
// it is folded down to its tab strip.
export const inspectorView = createStringSetting("pragma:inspector-view");
export const inspectorCollapsed = createBooleanSetting("pragma:inspector-collapsed", (stored) => stored === "true");

// The Links tab lists by folder until this is set, then each side as one list.
export const linksOneList = createBooleanSetting("pragma:links-one-list", (stored) => stored === "true");

// Off until a player's Loop turns it on: one choice for every video player,
// the gallery's preview and the video tab alike.
export const videoLoop = createBooleanSetting("pragma:video-loop", (stored) => stored === "true");

// One volume for every video player too, full and unmuted until a player
// changes it. A stored level outside 0 to 1 reads as full: a player hands
// the level to its clip, which refuses one out of range.
const VIDEO_VOLUME_KEY = "pragma:video-volume";
const VIDEO_MUTED_KEY = "pragma:video-muted";
const storedVideoLevel = Number.parseFloat(localStorage.getItem(VIDEO_VOLUME_KEY) ?? "");
const videoVolumeEmitter = new Emitter<Volume>({
  level: storedVideoLevel >= 0 && storedVideoLevel <= 1 ? storedVideoLevel : 1,
  muted: localStorage.getItem(VIDEO_MUTED_KEY) === "true",
});
export const videoVolume: Setting<Volume> = {
  get: () => videoVolumeEmitter.get(),
  set(value: Volume): void {
    localStorage.setItem(VIDEO_VOLUME_KEY, String(value.level));
    localStorage.setItem(VIDEO_MUTED_KEY, String(value.muted));
    videoVolumeEmitter.set(value);
  },
  subscribe: (listener) => videoVolumeEmitter.subscribe(listener),
};

// And one set of guides over every player's picture, none until a player's
// More options picks some. A stored value that doesn't read is none.
const VIDEO_GUIDES_KEY = "pragma:video-guides";
const videoGuidesEmitter = new Emitter<Guides>(readGuides(localStorage.getItem(VIDEO_GUIDES_KEY)));
export const videoGuides: Setting<Guides> = {
  get: () => videoGuidesEmitter.get(),
  set(value: Guides): void {
    localStorage.setItem(VIDEO_GUIDES_KEY, JSON.stringify(value));
    videoGuidesEmitter.set(value);
  },
  subscribe: (listener) => videoGuidesEmitter.subscribe(listener),
};

// And one look every player shows its picture through, none until a
// player's More options picks one. A stored look that doesn't read is none.
const VIDEO_LUT_KEY = "pragma:video-lut";
const videoLutEmitter = new Emitter<Look>(readLook(localStorage.getItem(VIDEO_LUT_KEY)));
export const videoLut: Setting<Look> = {
  get: () => videoLutEmitter.get(),
  set(value: Look): void {
    localStorage.setItem(VIDEO_LUT_KEY, JSON.stringify(value));
    videoLutEmitter.set(value);
  },
  subscribe: (listener) => videoLutEmitter.subscribe(listener),
};

// Where a panel's drag left it, in px, or for the split editor the left
// group's share of the row, below `max`. Absent until the first drag, which
// leaves the stylesheet's default in charge. Per browser like the flags
// above, not in the space's workspace file: a size fits a screen.
function createSizeSetting(key: string, max = Number.POSITIVE_INFINITY): Setting<number | undefined> {
  const stored = Number.parseFloat(localStorage.getItem(key) ?? "");
  const emitter = new Emitter<number | undefined>(stored > 0 && stored < max ? stored : undefined);
  return {
    get: () => emitter.get(),
    set(value: number | undefined): void {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
      emitter.set(value);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
}

export const sidebarWidth = createSizeSetting("pragma:sidebar-width");
export const assistantWidth = createSizeSetting("pragma:assistant-width");
export const inspectorHeight = createSizeSetting("pragma:inspector-height");
export const consoleHeight = createSizeSetting("pragma:console-height");
export const editorSplit = createSizeSetting("pragma:editor-split", 1);

// The Space panel's sections under the tree: whether each is open, and the
// height a drag left it at. Closed by default.
export const tagsSectionOpen = createBooleanSetting("pragma:tags-section-open", (stored) => stored === "true");
export const tagsSectionHeight = createSizeSetting("pragma:tags-section-height");
export const trashSectionOpen = createBooleanSetting("pragma:trash-section-open", (stored) => stored === "true");
export const trashSectionHeight = createSizeSetting("pragma:trash-section-height");
export const templatesSectionOpen = createBooleanSetting(
  "pragma:templates-section-open",
  (stored) => stored === "true",
);
export const templatesSectionHeight = createSizeSetting("pragma:templates-section-height");
export const historySectionOpen = createBooleanSetting("pragma:history-section-open", (stored) => stored === "true");
export const historySectionHeight = createSizeSetting("pragma:history-section-height");

export const showLineNumbers = createBooleanSetting("pragma:show-line-numbers", (stored) => stored === "true");

// Fold markers and readable-line-length default *on* — anything other than
// the literal string "false" (including an absent key) counts as enabled.
export const showFoldMarkers = createBooleanSetting("pragma:show-fold-markers", (stored) => stored !== "false");

export const readableLineLength = createBooleanSetting("pragma:readable-line-length", (stored) => stored !== "false");

/** How an editor lays out its text: kept to the readable line length or not,
 * and which gutter columns show. A pane follows the one it was given. */
export interface EditorLayout {
  readableLineLength: Setting<boolean>;
  lineNumbers: Setting<boolean>;
  foldMarkers: Setting<boolean>;
  // Absent where an editor draws no indentation guides.
  indentGuides?: Setting<boolean>;
}

// Settings → Editor's, for notes and screenplays.
export const editorLayout: EditorLayout = {
  readableLineLength,
  lineNumbers: showLineNumbers,
  foldMarkers: showFoldMarkers,
};

export const showConsole = createBooleanSetting("pragma:show-console", (stored) => stored === "true");

// Frames per second and the longest frame, on the Flow canvas and in the
// Graph tab (Settings → Advanced → Show stats).
export const showStats = createBooleanSetting("pragma:show-stats", (stored) => stored === "true");

// "system" follows the OS's light or dark mode, and is what an absent or
// unknown stored value reads as. index.html's inline script reads the key the
// same way before first paint.
export type Theme = "system" | "light" | "dark";

const THEME_KEY = "pragma:theme";
export function parseTheme(stored: string | null): Theme {
  return stored === "light" || stored === "dark" ? stored : "system";
}
const themeEmitter = new Emitter<Theme>(parseTheme(localStorage.getItem(THEME_KEY)));
export const theme: Setting<Theme> = {
  get: () => themeEmitter.get(),
  set(value: Theme): void {
    localStorage.setItem(THEME_KEY, value);
    themeEmitter.set(value);
  },
  subscribe: (listener) => themeEmitter.subscribe(listener),
};

/** A zoom as a percentage, picked from its own steps: the desktop window's,
 * or a module's own, such as a screenplay's page zoom. A stored value off
 * the steps reads as 100. */
export interface ZoomSetting extends Setting<number> {
  // Every picker's choices for it, smallest first.
  readonly levels: readonly number[];
}

export function createZoomSetting(key: string, levels: readonly number[]): ZoomSetting {
  const stored = Number(localStorage.getItem(key));
  const emitter = new Emitter<number>(levels.includes(stored) ? stored : 100);
  return {
    levels,
    get: () => emitter.get(),
    set(value: number): void {
      localStorage.setItem(key, String(value));
      emitter.set(value);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
}

// The window's steps: its Settings picker's choices and the steps Zoom In
// and Zoom Out move between, so the two never disagree.
export const ZOOM_LEVELS: readonly number[] = [80, 90, 100, 110, 125, 150, 175, 200];
export const zoom = createZoomSetting("pragma:zoom", ZOOM_LEVELS);

// A PDF's steps: PDF.js's own viewer's, wider than a screenplay's, since a
// page's print can be small and a whole page can be wanted at once.
export const PDF_ZOOM_LEVELS: readonly number[] = [50, 75, 100, 125, 150, 200, 300, 400];

/** Fit to width, or a percentage from the PDF's steps. */
export type PdfZoom = "fit" | number;

/** The zoom every PDF opens at, per browser as a screenplay's is: Fit to
 * width, adapting to each PDF, unless a step was picked. A stored value off
 * the steps reads as Fit to width. */
export function createPdfZoomSetting(key: string): Setting<PdfZoom> {
  const stored = Number(localStorage.getItem(key));
  const emitter = new Emitter<PdfZoom>(PDF_ZOOM_LEVELS.includes(stored) ? stored : "fit");
  return {
    get: () => emitter.get(),
    set(value: PdfZoom): void {
      localStorage.setItem(key, String(value));
      emitter.set(value);
    },
    subscribe: (listener) => emitter.subscribe(listener),
  };
}

export const pdfZoom = createPdfZoomSetting("pragma:pdf-zoom");

// The copilot's own model pick — a "<providerId>/<model>" ref, or "" to
// follow the default text model, which is config.json's, not this browser's.
// Kept separate so one Settings change moves both until the writer
// deliberately gives chat its own model (a local model for toolkits, a hosted
// one for conversation, say).
const CHAT_MODEL_KEY = "pragma:chat-model";
const chatModelEmitter = new Emitter<string>(localStorage.getItem(CHAT_MODEL_KEY) ?? "");
export const chatModel: Setting<string> = {
  get: () => chatModelEmitter.get(),
  set(value: string): void {
    localStorage.setItem(CHAT_MODEL_KEY, value);
    chatModelEmitter.set(value);
  },
  subscribe: (listener) => chatModelEmitter.subscribe(listener),
};

// The copilot's effort pick: a level, or "" to send none and leave the model
// at its own default. One pick across models, so a model without that level
// runs at its nearest one and switching back restores the pick.
const CHAT_EFFORT_KEY = "pragma:chat-effort";
const chatEffortEmitter = new Emitter<string>(localStorage.getItem(CHAT_EFFORT_KEY) ?? "");
export const chatEffort: Setting<string> = {
  get: () => chatEffortEmitter.get(),
  set(value: string): void {
    localStorage.setItem(CHAT_EFFORT_KEY, value);
    chatEffortEmitter.set(value);
  },
  subscribe: (listener) => chatEffortEmitter.subscribe(listener),
};

// What the copilot may do in a turn, Suggesting by default. A stored value
// this build doesn't know reads as Suggesting, never as a mode that grants
// more.
const CHAT_MODE_KEY = "pragma:chat-mode";
function parseChatMode(stored: string | null): ChatMode {
  return CHAT_MODES.find((mode) => mode === stored) ?? "suggesting";
}
const chatModeEmitter = new Emitter<ChatMode>(parseChatMode(localStorage.getItem(CHAT_MODE_KEY)));
export const chatMode: Setting<ChatMode> = {
  get: () => chatModeEmitter.get(),
  set(value: ChatMode): void {
    localStorage.setItem(CHAT_MODE_KEY, value);
    chatModeEmitter.set(value);
  },
  subscribe: (listener) => chatModeEmitter.subscribe(listener),
};

const EDITOR_FONT_SIZE_KEY = "pragma:editor-font-size";
export const DEFAULT_EDITOR_FONT_SIZE = 16;
const MIN_EDITOR_FONT_SIZE = 10;
const MAX_EDITOR_FONT_SIZE = 24;

function readEditorFontSize(): number {
  const raw = localStorage.getItem(EDITOR_FONT_SIZE_KEY);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, parsed));
}

const editorFontSizeEmitter = new Emitter<number>(readEditorFontSize());
export const editorFontSize: Setting<number> = {
  get: () => editorFontSizeEmitter.get(),
  set(size: number): void {
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(size));
    editorFontSizeEmitter.set(size);
  },
  subscribe: (listener) => editorFontSizeEmitter.subscribe(listener),
};

// The Editor's Font, for notes: one of its built-in fonts' values, or an
// installed font's family name.
export const DEFAULT_EDITOR_FONT = "sans-serif";
export const editorFont = createSetting("pragma:editor-font", (stored) =>
  stored?.trim() ? stored : DEFAULT_EDITOR_FONT,
);

// Appearance's Interface font, stored as the Editor's Font is. index.html's
// first-paint script reads this key too.
export const DEFAULT_INTERFACE_FONT = "sans-serif";
export const interfaceFont = createSetting("pragma:interface-font", (stored) =>
  stored?.trim() ? stored : DEFAULT_INTERFACE_FONT,
);

// A person's own shortcuts: chords by command id, each list replacing that
// command's defaults, an empty one unbinding it. A stored value of any other
// shape reads as none set.
export type ShortcutOverrides = Readonly<Record<string, readonly string[]>>;

const SHORTCUTS_KEY = "pragma:shortcuts";

function readShortcuts(): ShortcutOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "{}");
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((chord) => typeof chord === "string"),
    ),
  );
}

const shortcutsEmitter = new Emitter<ShortcutOverrides>(readShortcuts());
export const shortcuts: Setting<ShortcutOverrides> = {
  get: () => shortcutsEmitter.get(),
  set(value: ShortcutOverrides): void {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(value));
    shortcutsEmitter.set(value);
  },
  subscribe: (listener) => shortcutsEmitter.subscribe(listener),
};
