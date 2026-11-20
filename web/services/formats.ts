// The text format registry (docs/architecture.md's Files and views section). A format
// registers for a document type and supplies what the document pane asks of
// it: the editor's language, the links the Links tab lists, and reading view.
// The pane names no format, so a type with none registered opens as plain
// text rather than failing.
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RootedPath } from "../../src/protocol/rootedPath.ts";
import { type DocumentType, isDocumentType } from "../../src/protocol/types.ts";
import type { DocumentLinks } from "../core/spaceTree.ts";
import type { Disposable } from "../lib/disposable.ts";
import type { DocumentModel } from "./documents.ts";
import type { MenuItem } from "./menus.ts";

/** What the document pane offers a format, for whichever document it shows. */
export interface FormatContext {
  // Read on use: an editor state outlives the tab it was built for.
  path(): string | undefined;
  // Opens the menu for a file that a name in the text links to.
  showLinkMenu(file: string, at: { x: number; y: number }): void;
  // Opens a file a link in the text names, as a click in reading view opens
  // it; `anchor` is the link's element.
  openPath(path: string, anchor: HTMLElement): void;
  // Opens Search narrowed to a tag written in the text.
  searchTag(name: string): void;
}

/** A format's page in Settings → Editor → Formats. */
export interface FormatSettings {
  // The row's name and the page's title.
  readonly label: string;
  // The line under the row's name: which files the format covers.
  readonly detail: string;
  // The page's content, built once, its controls applying themselves.
  page(): HTMLElement;
}

/** A document kind's words for the settings it declares in a context
 * (src/protocol/scopeSettings.ts): its group's heading, then each setting's
 * name and the line under it, by key. */
export interface ScopeSettingWords {
  readonly title: string;
  readonly keys: Readonly<Record<string, { readonly label: string; readonly description: string }>>;
}

/** One thing a format's text can have done to it from the Format column,
 * the palette or a key: a mark, a kind of line, or a plain action. Its
 * command is `format.<id>` and its glyph `--icon-<glyph>`. */
export interface FormatAction {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
  // Consecutive actions of different groups get a line between them.
  readonly group: string;
  // Its default chord, in the keybinding service's grammar.
  readonly key?: string;
  // Out of the column until a drag on its foot brings it in.
  readonly more?: boolean;
  // A line the picker's menu leaves out of its kinds, though the picker
  // still draws its glyph while the selection is in it. A tool among them
  // is listed with the other tools.
  readonly unlistedKind?: boolean;
  // Drawn below the format's other tools, wherever it is listed: last but
  // for the column's own Source mode. Like Source mode, a usual one stays in
  // a shrinking column until every other tool has left it.
  readonly last?: boolean;
  // The kind of line the document's title is written as. Where the pane
  // shows the title in its bar, running it moves the cursor there instead.
  readonly title?: boolean;
  // Whether the selection is in it. Absent for an action that is no state.
  isOn?(state: EditorState): boolean;
  // Whether it can run where the selection is; absent, it always can. One
  // that can't is greyed in the column and its picker, and left out of the
  // palette.
  applies?(state: EditorState): boolean;
  run(view: EditorView): void;
}

/** What a format's Format column offers: the kinds a line can be, which
 * its picker turns a line into, and the rest. */
export interface FormatActions {
  // In the picker's order.
  readonly lines: readonly FormatAction[];
  // One of `lines`: the plain line every other kind turns back into.
  readonly plain: FormatAction;
  readonly marks: readonly FormatAction[];
  // The column's tools in its order, though it draws those with `more`
  // below the usual ones; the picker's menu lists every one after its
  // kinds. Each is one of `lines` or `marks`, which its button runs it
  // through by id.
  readonly tools: readonly FormatAction[];
  // The glyph the column's Source mode button draws; the generic
  // `source-mode` when absent.
  readonly sourceGlyph?: string;
}

/** Runs the action `id` names, as a button or command does: a kind of line
 * the selection is already in turns it back into the plain line. */
export function applyFormat(actions: FormatActions, id: string, view: EditorView): boolean {
  const line = actions.lines.find((action) => action.id === id);
  const action = line ?? actions.marks.find((action) => action.id === id);
  if (!action || action.applies?.(view.state) === false) return false;
  if (line && line !== actions.plain && line.isOn?.(view.state)) actions.plain.run(view);
  else action.run(view);
  return true;
}

/** A rendered page, and whether the space has changed where its links lead
 * since it was drawn, so it must be drawn again. */
export interface ReadingPage {
  page: DocumentFragment;
  changed(): boolean;
}

export interface TextFormat {
  // The editor's language and the format's own editing behaviour.
  extensions(context: FormatContext): Extension;
  // The text drawn formatted while it is edited, which a group's Source mode
  // turns off. Absent, the format has no Source mode.
  formatting?(context: FormatContext): Extension;
  // What its Format column offers, which the palette and their keys run
  // too. Absent, the format has no Format column.
  readonly actions?: FormatActions;
  // Its own rows in the editor's ⋮ menu, while reading as well as editing.
  readonly menu?: readonly MenuItem[];
  // Marks over what in its text isn't prose, such as code, for the
  // spellchecker to skip; on only while spellcheck is. Absent, all of it is
  // checked.
  readonly spellcheckSkips?: Extension;
  // The files the document links to, each mention an offset into the
  // editor's text.
  links(model: DocumentModel, state: EditorState): DocumentLinks;
  // Reading view as a rendered page, whose space-relative links carry
  // `data-space-path` for the pane to open. Absent, reading view locks the
  // editor instead.
  renderReading?(model: DocumentModel): ReadingPage;
  // Whether an image dropped or pasted in is embedded, as Markdown's `![]()`.
  readonly embedsImages: boolean;
  // The link a tree row dropped into the text writes when it isn't an image;
  // undefined when the document can't name it.
  linkFor?(docPath: string, target: RootedPath, folder: boolean): string | undefined;
  // The space's files changed under the open document.
  spaceChanged?(view: EditorView): void;
  // A format with preferences of its own keeps them on its own page.
  readonly settings?: FormatSettings;
  // Words for the settings its document type declares in a context, which
  // the Context dialog and the Properties tab show.
  readonly scopeSettings?: ScopeSettingWords;
}

/** What a document type with no format registered opens as. */
export const PLAIN_TEXT: TextFormat = {
  extensions: () => [],
  links: () => ({ found: [], missing: [] }),
  embedsImages: false,
};

export interface FormatRegistry {
  // Registering a document type twice throws: two formats fighting over one
  // type is a bug, not a merge.
  register(documentType: DocumentType, format: TextFormat): Disposable;
  get(documentType: DocumentType): TextFormat;
  // In registration order.
  list(): { documentType: DocumentType; format: TextFormat }[];
  // A document kind's words for its settings in a context, by the kind's
  // name; undefined for a kind no format is registered for.
  scopeSettings(kind: string): ScopeSettingWords | undefined;
}

export function createFormats(): FormatRegistry {
  const formats = new Map<DocumentType, TextFormat>();
  return {
    register(documentType, format) {
      if (formats.has(documentType)) throw new Error(`a format for "${documentType}" is already registered`);
      formats.set(documentType, format);
      return {
        dispose: () => {
          if (formats.get(documentType) === format) formats.delete(documentType);
        },
      };
    },
    get: (documentType) => formats.get(documentType) ?? PLAIN_TEXT,
    list: () => [...formats].map(([documentType, format]) => ({ documentType, format })),
    scopeSettings: (kind) => (isDocumentType(kind) ? formats.get(kind)?.scopeSettings : undefined),
  };
}
