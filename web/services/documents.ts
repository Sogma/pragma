// Shared document models — the "model" of the tab / model / view-state split
// (docs/architecture.md's Files and views section): one per open path, and every edit
// goes through it and schedules its own save. Ownership is reference-counted
// and the last release flushes and forgets the model.
//
// A second tab shares the live working copy rather than re-reading disk, so
// a stale fetch never clobbers an unsaved edit.
//
// An edit is a change set, not a replacement string, so every view maps its
// own selection, folds and history through it and two panes on one file stay
// in step.

import { ChangeSet, type ChangeSpec, Text } from "@codemirror/state";
import {
  editFrontmatterYaml,
  isPrivate,
  parseFrontmatterYaml,
  sameFrontmatter,
  sameKeyOrder,
} from "../../src/protocol/frontmatter.ts";
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import type { DocumentType } from "../../src/protocol/types.ts";
import type {
  ActiveTitle,
  ClassLinks,
  FileResponse,
  SavedDocumentDates,
  TextFileResponse,
  TextToolkitInfo,
} from "../core/apiClient.ts";
import {
  composeDocumentHead,
  type DocumentParts,
  splitDocumentProperties,
  splitExactly,
  titleBarOf,
} from "../core/documentContent.ts";
import { stripExtension } from "../core/paths.ts";
import { diffWords } from "../lineDiff.ts";
import type { SaveQueue, SaveSource } from "./saveQueue.ts";

export type DocumentEvent =
  // `origin` is whoever made the change — a view passes itself — so it can
  // skip its own echo. `userEvent` is CodeMirror's transaction category,
  // forwarded so a peer view's history groups the change the same way.
  | { kind: "body"; changes: ChangeSet; origin: unknown; userEvent?: string }
  | { kind: "properties"; origin: unknown }
  | { kind: "title"; origin: unknown }
  | { kind: "reload" }
  | { kind: "saved" };

export interface BodyChangeSource {
  origin?: unknown;
  userEvent?: string;
  /** The Flow whose accepted proposal made the change, by its space path. */
  proposedBy?: string;
}

export interface DocumentModel {
  // Re-keyed by DocumentsService.move when the file is renamed.
  readonly path: string;
  readonly documentType: DocumentType;
  // Every toolkit the Classes holding the document give it; refreshed by
  // reload().
  readonly toolkits: readonly TextToolkitInfo[];
  // The other files the Classes holding it link it to, for its Links tab;
  // refreshed by reload().
  readonly classLinks: readonly ClassLinks[];
  // The text an editor shows: the file minus frontmatter and the lifted
  // `# Heading` (a note), or the whole file (screenplay).
  body(): string;
  // The same text as CodeMirror's Text, to seed a view's state without
  // copying and to compare against one cheaply.
  bodyText(): Text;
  // The live frontmatter object for a note — always present for one,
  // even empty — or undefined for a screenplay, and for a note
  // whose block doesn't parse. The property editor mutates it in
  // place, so it must report the change afterwards.
  properties(): Record<string, unknown> | undefined;
  // Why a note's block doesn't parse, if it doesn't. The block
  // then stays in the body as written, with no properties or title lifted.
  frontmatterError(): string | undefined;
  // Whether the document is kept from every model call: `visibility:
  // private`, or a block that doesn't parse, since nothing can show it isn't.
  isPrivate(): boolean;
  title(): ActiveTitle | undefined;
  // How many real file lines sit above body line 1 (frontmatter block plus
  // the `# Heading` and its blank line), for a gutter that shows the
  // document's real line numbers.
  lineOffset(): number;
  // The full file as it would be saved right now: the head, then the body.
  content(): string;
  // The text above the body, as Source mode shows it: the frontmatter block
  // and the blank lines after it, then the lifted heading and its own.
  head(): string;
  // Applies an edit made against the current body. The change set's length
  // must match the body: a view whose document drifted from the model must
  // not write through it.
  applyBodyChanges(changes: ChangeSet, source?: BodyChangeSource): void;
  // Applies an edit made against the whole file, as Source mode makes one.
  // The parts are read from the result again and every view is told what
  // moved: the body as a change, the title and the properties as changed.
  applyContentChanges(changes: ChangeSet, source?: BodyChangeSource): void;
  // Replaces the whole body, as one change every view maps through.
  setBody(text: string, origin?: unknown): void;
  setTitleText(text: string, origin?: unknown): void;
  notePropertiesChanged(origin?: unknown): void;
  // Folds keys a server-side write has already put in the file (a publish's
  // `id` and `pushed`) into the frontmatter without scheduling a save: the
  // file has them, and a save would mark the document changed since.
  adoptWrittenProperties(values: Record<string, unknown>): void;
  // Re-reads the file from disk, replacing everything, unless an edit is
  // still on its way there: that edit's save names the older revision, so it
  // is refused and the writer picks a side. Resolves false when the path is
  // no longer a text document.
  reload(): Promise<boolean>;
  subscribe(listener: (event: DocumentEvent) => void): () => void;
}

export interface DocumentsService {
  // Registers a model from an already-fetched response and takes a
  // reference on it. A model already open for that path is returned as is —
  // its live working copy wins over the fresh response.
  adopt(file: TextFileResponse): DocumentModel;
  // Re-reads these paths from disk into whatever models are open on them,
  // for a caller that has just rewritten the files behind the editor's back
  // (a git pull). Paths nothing has open are skipped. Resolves to the paths
  // whose file could not be re-read — deleted, or no longer a text document
  // — which the caller has to deal with at the tab level.
  reloadPaths(paths: readonly string[]): Promise<string[]>;
  get(path: string): DocumentModel | undefined;
  // Drops one reference. The last release writes any pending save and
  // forgets the model.
  release(path: string): Promise<void>;
  // A space rename or move: every model at or under `from` is re-keyed.
  move(from: string, to: string): void;
  // Edits a note's frontmatter whether or not anything has it
  // open: through the open model when there is one, so every editor on it
  // follows, else through one held just long enough to save the change.
  editProperties(path: string, edit: (properties: Record<string, unknown>) => void): Promise<void>;
  flushAll(): Promise<void>;
}

export interface DocumentsDeps {
  queue: SaveQueue;
  fetchFile: (path: string) => Promise<FileResponse>;
}

// A restore and an accepted proposal say so in their transaction, a Flow's
// proposal naming its Flow, and the save they make carries it, so History
// labels the change by who made it.
function saveSourceOf({ userEvent, proposedBy }: BodyChangeSource): SaveSource | undefined {
  if (userEvent === "input.restore") return { source: "restored" };
  if (userEvent !== "input.proposal") return undefined;
  return proposedBy === undefined ? { source: "copilot" } : { source: "flow", flow: proposedBy };
}

function heldBy(frontmatter: string | undefined): Record<string, unknown> {
  return frontmatter === undefined ? {} : parseFrontmatterYaml(frontmatter);
}

// CodeMirror's own default line split, so a CRLF file reads the same here
// as it did when the editor split it itself; it is written back with "\n".
function textOf(body: string): Text {
  return Text.of(body.split(/\r\n?|\n/));
}

// Where a body's first block ends: the start of the line after its first
// blank line, or never, when the whole body is one block.
function firstBlockEnd(body: Text): number {
  for (let number = 2; number < body.lines; number++) {
    if (!body.line(number).text.trim() && body.line(number - 1).text.trim()) return body.line(number + 1).from;
  }
  return Number.POSITIVE_INFINITY;
}

export function createDocuments(deps: DocumentsDeps): DocumentsService {
  const models = new Map<string, { model: DocumentModel; refs: number; setPath(path: string): void }>();

  function createModel(file: TextFileResponse) {
    let path = file.path;
    const split = splitDocumentProperties(file);
    let bodyText = textOf(split.body);
    let properties = split.properties;
    // The block as the file holds it, and what it holds apart from the live
    // `properties` handed out for editing. A save splices only the keys
    // that differ between the two, so every line no edit touched — its
    // comments, quoting, a flow list — is written back as it was.
    let frontmatter = split.frontmatter;
    let held = heldBy(frontmatter);
    let gap = split.gap;
    let frontmatterError = split.frontmatterError;
    let title = titleBarOf(file.documentType, split, path);
    let read = split.read;
    // Seeded from the file itself; recomputed from the working copy after
    // any change that can move it (a property added, a title typed).
    let lineOffset = split.lineOffset;
    let toolkits: readonly TextToolkitInfo[] = file.toolkits;
    let classLinks: readonly ClassLinks[] = file.classLinks;
    const listeners = new Set<(event: DocumentEvent) => void>();

    function emit(event: DocumentEvent): void {
      for (const listener of listeners) listener(event);
    }
    // Run on each reported change and again on every compose, so a mutation
    // that skipped its report still reaches the file. Splicing per report is
    // what lets a key renamed in place read as one rename rather than a
    // removal and an addition.
    //
    // A block emptied of its last property is gone, so one added after it
    // is a new block, with a new block's one blank line, as is one added to
    // a file whose gap is the blank lines it opens with.
    function syncFrontmatter(): void {
      if (!properties || (sameFrontmatter(held, properties) && sameKeyOrder(held, properties))) return;
      const created = frontmatter === undefined;
      frontmatter = editFrontmatterYaml(frontmatter, properties);
      held = heldBy(frontmatter);
      if (frontmatter === undefined || created) gap = undefined;
    }
    function head(): string {
      syncFrontmatter();
      return composeDocumentHead(title?.text, frontmatter, read, gap, bodyText.length > 0);
    }
    function content(): string {
      return head() + bodyText.toString();
    }
    function applyBodyChanges(changes: ChangeSet, source: BodyChangeSource): void {
      if (changes.empty) return;
      if (changes.length !== bodyText.length) {
        throw new Error(`a change against ${changes.length} characters can't apply to ${path} (${bodyText.length})`);
      }
      takeBody(changes.apply(bodyText), changes, source);
    }
    function takeBody(next: Text, changes: ChangeSet, source: BodyChangeSource): void {
      bodyText = next;
      scheduleSave(saveSourceOf(source));
      emit({ kind: "body", changes, origin: source.origin, userEvent: source.userEvent });
    }
    function applyContentChanges(changes: ChangeSet, source: BodyChangeSource): void {
      if (changes.empty) return;
      const above = head();
      if (changes.length !== above.length + bodyText.length) {
        throw new Error(`a whole-file change of ${changes.length} characters can't apply to ${path}`);
      }
      // Most keystrokes: the body alone changed, and the head over it stays.
      // A body opening on a blank line would hand that line to the head, and
      // a heading with nothing under it gains its blank line once something
      // is, so either is split again.
      const below = bodyEdit(changes, above);
      if (below) {
        const next = below.apply(bodyText);
        const opensBlank = next.sliceString(0, 1) === "\n";
        if (!opensBlank && composeDocumentHead(title?.text, frontmatter, read, gap, next.length > 0) === above) {
          takeBody(next, below, source);
          return;
        }
      }
      resplit(changes.apply(textOf(above + bodyText.toString())).toString(), below, above, source);
    }
    // A whole-file edit as one against the body, when every change in it lands
    // where it can't move the split: below the head and, with no title lifted,
    // below the body's first block too, which a `#`, an `===` underline or a
    // `---` typed into it could make a title or a frontmatter block.
    function bodyEdit(changes: ChangeSet, above: string): ChangeSet | undefined {
      if (frontmatterError !== undefined) return undefined;
      const from = above.length + (title?.text.trim() ? 0 : firstBlockEnd(bodyText));
      const specs: ChangeSpec[] = [];
      let below = true;
      changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        below &&= fromA >= from;
        specs.push({ from: fromA - above.length, to: toA - above.length, insert: inserted });
      });
      return below ? ChangeSet.of(specs, bodyText.length) : undefined;
    }
    // Takes the parts of `text` in place of the ones held, then tells every
    // view what moved, each change named as `source`'s. While the head stays
    // the body's change is the edit itself; only a moved split is diffed.
    function resplit(text: string, below: ChangeSet | undefined, above: string, source: BodyChangeSource): void {
      const was = { body: bodyText, title: title?.text, read: read?.heading, frontmatter, frontmatterError };
      adopt(splitExactly({ documentType: file.documentType, content: text }));
      scheduleSave(saveSourceOf(source));
      if (!was.body.eq(bodyText)) {
        const changes =
          below && head() === above
            ? below
            : ChangeSet.of(diffWords(was.body.toString(), bodyText.toString()), was.body.length);
        emit({ kind: "body", changes, origin: source.origin, userEvent: source.userEvent });
      }
      if (title?.text !== was.title || read?.heading !== was.read) emit({ kind: "title", origin: source.origin });
      if (frontmatter !== was.frontmatter || frontmatterError !== was.frontmatterError) {
        emit({ kind: "properties", origin: source.origin });
      }
    }
    function adopt(next: DocumentParts): void {
      bodyText = textOf(next.body);
      properties = next.properties;
      frontmatter = next.frontmatter;
      held = heldBy(frontmatter);
      gap = next.gap;
      frontmatterError = next.frontmatterError;
      title = titleBarOf(file.documentType, next, path);
      read = next.read;
      lineOffset = next.lineOffset;
    }
    function recomputeLineOffset(): void {
      lineOffset = (head().match(/\n/g) ?? []).length;
    }
    function scheduleSave(source?: SaveSource): void {
      deps.queue.schedule(
        path,
        content(),
        (dates: SavedDocumentDates | undefined) => {
          // The server may have just written created/updated into the file;
          // fold them in narrowly so an edit made meanwhile survives.
          if (dates && properties) {
            Object.assign(properties, dates);
            emit({ kind: "saved" });
          }
        },
        source,
      );
    }

    const model: DocumentModel = {
      get path() {
        return path;
      },
      documentType: file.documentType,
      get toolkits() {
        return toolkits;
      },
      get classLinks() {
        return classLinks;
      },
      body: () => bodyText.toString(),
      bodyText: () => bodyText,
      properties: () => properties,
      frontmatterError: () => frontmatterError,
      isPrivate: () => (properties ? isPrivate(properties) : frontmatterError !== undefined),
      title: () => title,
      lineOffset: () => lineOffset,
      content,
      head,
      applyBodyChanges: (changes, source = {}) => applyBodyChanges(changes, source),
      applyContentChanges: (changes, source = {}) => applyContentChanges(changes, source),
      setBody(text, origin) {
        if (text === bodyText.toString()) return;
        applyBodyChanges(ChangeSet.of({ from: 0, to: bodyText.length, insert: text }, bodyText.length), { origin });
      },
      setTitleText(text, origin) {
        if (!title || title.text === text) return;
        title.text = text;
        recomputeLineOffset();
        scheduleSave();
        emit({ kind: "title", origin });
      },
      notePropertiesChanged(origin) {
        recomputeLineOffset();
        scheduleSave();
        emit({ kind: "properties", origin });
      },
      adoptWrittenProperties(values) {
        if (!properties) return;
        Object.assign(properties, values);
        recomputeLineOffset();
        emit({ kind: "properties", origin: undefined });
      },
      async reload() {
        const fresh = await deps.fetchFile(path);
        if (fresh.kind !== "text") return false;
        const settled = deps.queue.settledRevision(path);
        if (settled === undefined || settled === fresh.revision) return true;
        deps.queue.noteRevision(path, fresh.revision);
        adopt(splitDocumentProperties(fresh));
        toolkits = fresh.toolkits;
        classLinks = fresh.classLinks;
        emit({ kind: "reload" });
        return true;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    return {
      model,
      refs: 0,
      setPath(next: string) {
        path = next;
        const placeholder = stripExtension(basenameOf(next));
        if (!title || title.placeholder === placeholder) return;
        title.placeholder = placeholder;
        emit({ kind: "title", origin: undefined });
      },
    };
  }

  async function editModel(path: string, apply: (model: DocumentModel) => void): Promise<void> {
    const open = models.get(path)?.model;
    if (open) return apply(open);
    const file = await deps.fetchFile(path);
    if (file.kind !== "text") throw new Error(`${path} is not a text document`);
    // A model opened during the fetch is the one adopted, and edited.
    const model = service.adopt(file);
    try {
      apply(model);
    } finally {
      await service.release(path);
    }
  }

  const service: DocumentsService = {
    adopt(file) {
      let entry = models.get(file.path);
      if (!entry) {
        // Content still queued for this path is newer than the fetch — a
        // debounced save, or a failed one being retried. Building from disk
        // would hand the next keystroke a stale base, and latest-wins would
        // discard the edit the queue held safe.
        //
        // Only a model built from the fetch takes the fetch's revision; one
        // built from queued content keeps the base the queue already holds.
        const queued = deps.queue.pendingContent(file.path);
        if (queued === undefined) deps.queue.noteRevision(file.path, file.revision);
        entry = createModel(queued === undefined ? file : { ...file, content: queued });
        models.set(file.path, entry);
      }
      entry.refs++;
      return entry.model;
    },
    async reloadPaths(paths) {
      const failed: string[] = [];
      for (const path of paths) {
        const entry = models.get(path);
        if (!entry) continue;
        try {
          if (!(await entry.model.reload())) failed.push(path);
        } catch {
          // Gone from disk, most likely — the caller closes its tab.
          failed.push(path);
        }
      }
      return failed;
    },
    get: (path) => models.get(path)?.model,
    async release(path) {
      const entry = models.get(path);
      if (!entry) return;
      entry.refs--;
      if (entry.refs > 0) return;
      models.delete(path);
      await deps.queue.flush(path);
    },
    move(from, to) {
      deps.queue.move(from, to);
      for (const [path, entry] of [...models]) {
        if (path !== from && !path.startsWith(`${from}/`)) continue;
        const next = to + path.slice(from.length);
        models.delete(path);
        entry.setPath(next);
        models.set(next, entry);
      }
    },
    editProperties: (path, edit) =>
      editModel(path, (model) => {
        const properties = model.properties();
        const error = model.frontmatterError();
        if (error !== undefined) throw new Error(`${path}'s frontmatter isn't valid YAML (${error})`);
        if (!properties) throw new Error(`${path} has no frontmatter to edit`);
        edit(properties);
        model.notePropertiesChanged();
      }),
    flushAll: async () => {
      await deps.queue.flush();
    },
  };
  return service;
}
