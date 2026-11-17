import type { EditorView } from "@codemirror/view";
import type { DocumentModel } from "./documents.ts";

export interface DocumentAccessDeps {
  getView(): EditorView | undefined;
  getActivePath(): string | undefined;
  // The open document's model, which answers whether it's private — a
  // block that doesn't parse included, which its properties can't show.
  getActiveDocument(): Pick<DocumentModel, "isPrivate" | "frontmatterError"> | undefined;
  // The whole file as it would be saved now: frontmatter and lifted title
  // around the editor's text.
  getContent(): string;
}

// The document at one moment: the whole file, the editor's text, the main
// selection within that text, and whether the editor was read-only, as
// reading view makes it: no proposal drawn over it can be accepted.
export interface DocumentSnapshot {
  content: string;
  text: string;
  from: number;
  to: number;
  readOnly: boolean;
}

// The narrow surface a toolkit button's run reaches its document through
// (docs/protocol.md, Flows → Actions). Unlike an applet's document calls it
// has no server leg: it acts on the already-open document's live editor
// state, not a space file.
export interface DocumentAccess {
  // Throws if `originPath` isn't the open document, or if it's
  // `visibility: private` — the gate a run passes before handing the
  // document's content on, the client-side counterpart of the server's
  // file-read doorway (see docs/architecture.md's Privacy).
  assertAccessible(originPath: string): void;
  // Checks only that the document is still open, not that it's private:
  // holding a snapshot reveals nothing, so the gate stays on whatever later
  // hands its content on.
  snapshot(originPath: string): DocumentSnapshot;
  // The live editor, for a caller that draws a proposal over it.
  editor(originPath: string): EditorView;
}

const NO_LONGER_OPEN = "The document this toolkit button was clicked in is no longer open";

export function createDocumentAccess(deps: DocumentAccessDeps): DocumentAccess {
  function assertAccessible(originPath: string): void {
    if (deps.getActivePath() !== originPath || !deps.getView()) throw new Error(NO_LONGER_OPEN);
    const active = deps.getActiveDocument();
    if (active?.isPrivate()) {
      const error = active.frontmatterError();
      throw new Error(
        error === undefined
          ? "This document is `visibility: private`, so a toolkit can't read or change it."
          : `This document's frontmatter isn't valid YAML (${error}), so it's kept private: a toolkit can't read or change it until that's fixed.`,
      );
    }
  }

  return {
    assertAccessible,
    snapshot(originPath) {
      const view = deps.getView();
      if (deps.getActivePath() !== originPath || !view) throw new Error(NO_LONGER_OPEN);
      const { from, to } = view.state.selection.main;
      return { content: deps.getContent(), text: view.state.doc.toString(), from, to, readOnly: view.state.readOnly };
    },
    editor(originPath) {
      assertAccessible(originPath);
      // The accessibility check above already confirmed the view is defined.
      return deps.getView() as EditorView;
    },
  };
}
