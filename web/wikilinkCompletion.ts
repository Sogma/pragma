// The `[[` link suggester for Markdown: offers the files and folders in the
// document's own root, its scope's first, and for a space document every
// library's files too. A pick is written the way a host writes any path: as a
// wikilink, or a Markdown link while Use [[Wikilinks]] is off.
//
// The display title is read only once a file is picked, so the pipe or a
// Markdown link's text lands a moment after the link, as its own edit. It goes
// in at the link's position mapped through whatever was typed meanwhile, and
// is dropped if the link itself was edited first.
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion,
} from "@codemirror/autocomplete";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { dirnameOf, isLibraryPath, parseRootedPath } from "../src/protocol/rootedPath.ts";
import { isAppletFile, isClassFile, isFlowFile, isMarkdownFile, isTableFile } from "../src/protocol/types.ts";
import { formatWikilinkLabel, wikilinkName } from "../src/protocol/wikilink.ts";
import type { FileResponse } from "./core/apiClient.ts";
import { displayTitleOf } from "./core/documentContent.ts";
import { type LinkOffer, linkOffers } from "./core/linkOffers.ts";
import { type LinkScope, writePathFrom } from "./core/spaceTree.ts";

export interface WikilinkCompletionDeps {
  // The open document's path, rooted as its tab holds it.
  docPath: () => string | undefined;
  scope: (docPath: string) => LinkScope | undefined;
  /** Every library's files, rooted, offered to a space document. */
  libraryFiles: () => Promise<readonly string[]>;
  loadFile: (address: string) => Promise<FileResponse>;
  /** False writes a pick as a Markdown link. */
  writesWikilinks: () => boolean;
}

const MAX_OPTIONS = 50;
const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock"]);
// A link's target half being typed: `[[`, then no bracket, pipe or line break.
const OPEN_LINK = /\[\[[^[\]|\n]*$/;
// What follows the cursor in that link: the rest of the target, then its close or its pipe.
const LINK_TAIL = /^([^[\]|\n]*)(\]\]|\|)?/;

// `at` is the end of a just-written target, mapped through later edits.
interface PendingPipe {
  id: number;
  at: number;
}
const addPending = StateEffect.define<PendingPipe>();
const settlePending = StateEffect.define<number>();
let nextPendingId = 0;

const pendingPipes = StateField.define<readonly PendingPipe[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map(({ id, at }) => ({ id, at: tr.changes.mapPos(at, -1) })) : value;
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next = [...next, effect.value];
      else if (effect.is(settlePending)) next = next.filter(({ id }) => id !== effect.value);
    }
    return next;
  },
});

function insideCode(context: CompletionContext): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1);
    node;
    node = node.parent
  ) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

function hasTitle(path: string): boolean {
  return isMarkdownFile(path) || isTableFile(path) || isClassFile(path) || isFlowFile(path) || isAppletFile(path);
}

async function loadTitle(deps: WikilinkCompletionDeps, path: string): Promise<string | undefined> {
  if (!hasTitle(path)) return undefined;
  try {
    return displayTitleOf(await deps.loadFile(path));
  } catch {
    return undefined;
  }
}

// A bracket or backslash in a Markdown link's text would end it early or
// escape what follows, so each is escaped.
const markdownLinkText = (text: string): string => text.replace(/[[\]\\]/g, "\\$&");

function addPipe(view: EditorView, id: number, target: string, title: string | undefined): void {
  const pending = view.state.field(pendingPipes, false)?.find((entry) => entry.id === id);
  if (!pending) return;
  const { at } = pending;
  const label = formatWikilinkLabel(target, title);
  const intact = view.state.sliceDoc(at - target.length, at) === target && view.state.sliceDoc(at, at + 2) === "]]";
  view.dispatch({
    changes: label !== target && intact ? { from: at, insert: label.slice(target.length) } : undefined,
    effects: settlePending.of(id),
  });
}

// `at` is where the link's text starts: it is swapped for the display title
// only while it still reads as the name first written there.
function addTitle(view: EditorView, id: number, name: string, title: string | undefined): void {
  const pending = view.state.field(pendingPipes, false)?.find((entry) => entry.id === id);
  if (!pending) return;
  const { at } = pending;
  const text = title === undefined ? name : markdownLinkText(title.replace(/\s+/g, " ").trim());
  const intact = view.state.sliceDoc(at - 1, at + name.length + 2) === `[${name}](`;
  view.dispatch({
    changes: text && text !== name && intact ? { from: at, to: at + name.length, insert: text } : undefined,
    effects: settlePending.of(id),
  });
}

// What the pick is written as from this document, by the writing rule.
function written(scope: LinkScope, offer: LinkOffer, form: "markdown" | "wikilink"): string | undefined {
  const target = parseRootedPath(offer.path);
  return writePathFrom(dirnameOf(scope.docPath), target, { form, scopes: scope.scopes, folder: offer.folder });
}

// Replaces the `[[` and what follows it in an open wikilink: its target, and
// in a closed one the close, or the display text a pipe kept, which becomes
// the link's text.
function insertMarkdownLink(
  view: EditorView,
  completion: Completion,
  deps: WikilinkCompletionDeps,
  scope: LinkScope,
  offer: LinkOffer,
  from: number,
  to: number,
): void {
  const destination = written(scope, offer, "markdown");
  if (destination === undefined) return;
  const lineEnd = view.state.doc.lineAt(to).to;
  const [, rest = "", close] = LINK_TAIL.exec(view.state.sliceDoc(to, lineEnd)) ?? [];
  let end = close === "]]" ? to + rest.length + 2 : to;
  let kept = "";
  if (close === "|") {
    const tail = view.state.sliceDoc(to + rest.length + 1, lineEnd);
    const closeAt = tail.indexOf("]]");
    if (closeAt !== -1) {
      kept = markdownLinkText(tail.slice(0, closeAt).trim());
      end = to + rest.length + 1 + closeAt + 2;
    }
  }
  const name = kept || markdownLinkText(wikilinkName(offer.folder ? `${offer.path}/` : offer.path));
  const link = `[${name}](${destination})`;
  const start = from - 2;
  const id = nextPendingId++;
  const titled = !kept && !offer.folder;
  view.dispatch({
    changes: { from: start, to: end, insert: link },
    selection: { anchor: start + link.length },
    effects: titled ? addPending.of({ id, at: start + 1 }) : [],
    annotations: pickedCompletion.of(completion),
    userEvent: "input.complete",
  });
  if (titled) void loadTitle(deps, offer.path).then((title) => addTitle(view, id, name, title));
}

function insertLink(
  view: EditorView,
  completion: Completion,
  deps: WikilinkCompletionDeps,
  scope: LinkScope,
  offer: LinkOffer,
  from: number,
  to: number,
): void {
  if (!deps.writesWikilinks()) {
    insertMarkdownLink(view, completion, deps, scope, offer, from, to);
    return;
  }
  const target = written(scope, offer, "wikilink");
  if (target === undefined) return;
  const [, rest = "", close] = LINK_TAIL.exec(view.state.sliceDoc(to, view.state.doc.lineAt(to).to)) ?? [];
  // The rest of an old target is replaced only inside a closed link; in an
  // unclosed one it is the prose that follows.
  const end = close ? to + rest.length : to;
  // A link that already has display text keeps it, and needs no title.
  const piped = close === "|";
  const at = from + target.length;
  const id = nextPendingId++;
  view.dispatch({
    changes: { from, to: end, insert: close ? target : `${target}]]` },
    selection: { anchor: piped ? at : at + 2 },
    effects: piped ? [] : addPending.of({ id, at }),
    annotations: pickedCompletion.of(completion),
    userEvent: "input.complete",
  });
  if (piped) return;
  if (offer.folder) addPipe(view, id, target, undefined);
  else void loadTitle(deps, offer.path).then((title) => addPipe(view, id, target, title));
}

export function wikilinkSource(deps: WikilinkCompletionDeps) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const open = context.matchBefore(OPEN_LINK);
    if (!open || insideCode(context)) return null;
    const docPath = deps.docPath();
    const scope = docPath === undefined ? undefined : deps.scope(docPath);
    if (!scope) return null;
    // A library document names only its own library's files.
    const libraryFiles = isLibraryPath(scope.docPath) ? [] : await deps.libraryFiles();
    if (context.aborted) return null;

    const docDir = dirnameOf(scope.docPath);
    // The suggester ranks by name, so a typed `./`, `../` or `/` matches nothing by itself.
    const query = open.text.slice(2).replace(/^(\.{1,2}\/|\/)+/, "");
    // A wikilink can't hold a bracket, so an entry named with one can't be linked.
    const offers = linkOffers(scope, libraryFiles, query, (path) => !/[[\]]/.test(path));

    return {
      from: open.from + 2,
      filter: false,
      options: offers.slice(0, MAX_OPTIONS).map((offer) => {
        const { path } = offer;
        const folder = dirnameOf(path);
        return {
          label: offer.folder ? `${wikilinkName(`${path}/`)}/` : wikilinkName(path),
          // Beside the note, a name says enough. Elsewhere the folder is shown,
          // and the root's is spelled as a root link spells it.
          detail: folder === docDir ? undefined : folder || "/",
          apply: (view: EditorView, completion: Completion, from: number, to: number) =>
            insertLink(view, completion, deps, scope, offer, from, to),
        };
      }),
    };
  };
}

export function wikilinkCompletion(deps: WikilinkCompletionDeps): Extension {
  return [pendingPipes, markdownLanguage.data.of({ autocomplete: wikilinkSource(deps) })];
}
