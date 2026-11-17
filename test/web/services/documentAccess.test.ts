// @vitest-environment jsdom
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createDocumentAccess, type DocumentAccessDeps } from "../../../web/services/documentAccess.ts";

// The open document as its model answers whether it's private.
const opened = (isPrivate: boolean, frontmatterError?: string) => () => ({
  isPrivate: () => isPrivate,
  frontmatterError: () => frontmatterError,
});

function setup(overrides: Partial<DocumentAccessDeps> = {}) {
  const view = new EditorView({ state: EditorState.create({ doc: "hello world" }) });
  const deps: DocumentAccessDeps = {
    getView: () => view,
    getActivePath: () => "note.md",
    getActiveDocument: opened(false),
    getContent: () => "---\ntags: [a]\n---\n\nhello world",
    ...overrides,
  };
  return { view, documentAccess: createDocumentAccess(deps) };
}

describe("assertAccessible", () => {
  it("does not throw when the origin path matches the currently open document", () => {
    const { documentAccess } = setup();
    expect(() => documentAccess.assertAccessible("note.md")).not.toThrow();
  });

  it("throws when the origin path no longer matches the open document", () => {
    const { documentAccess } = setup({ getActivePath: () => "other.md" });
    expect(() => documentAccess.assertAccessible("note.md")).toThrow(
      "The document this toolkit button was clicked in is no longer open",
    );
  });

  it("throws when there is no view at all", () => {
    const { documentAccess } = setup({ getView: () => undefined });
    expect(() => documentAccess.assertAccessible("note.md")).toThrow(
      "The document this toolkit button was clicked in is no longer open",
    );
  });

  it("throws when the document is visibility: private", () => {
    const { documentAccess } = setup({ getActiveDocument: opened(true) });
    expect(() => documentAccess.assertAccessible("note.md")).toThrow(
      "This document is `visibility: private`, so a toolkit can't read or change it.",
    );
  });

  it("throws, naming the error, when the document's frontmatter doesn't parse", () => {
    const { documentAccess } = setup({ getActiveDocument: opened(true, "line 2: Map keys must be unique") });
    expect(() => documentAccess.assertAccessible("note.md")).toThrow(
      "frontmatter isn't valid YAML (line 2: Map keys must be unique), so it's kept private",
    );
  });

  it("does not throw for a document that isn't private", () => {
    const { documentAccess } = setup({ getActiveDocument: opened(false) });
    expect(() => documentAccess.assertAccessible("note.md")).not.toThrow();
  });
});

describe("editor", () => {
  it("hands back the live editor behind the same gate", () => {
    const { view, documentAccess } = setup();
    expect(documentAccess.editor("note.md")).toBe(view);
    const { documentAccess: hidden } = setup({ getActiveDocument: opened(true) });
    expect(() => hidden.editor("note.md")).toThrow("visibility: private");
  });
});

describe("snapshot", () => {
  it("captures the whole file, the editor text, and the main selection at one moment", () => {
    const { view, documentAccess } = setup();
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    expect(documentAccess.snapshot("note.md")).toEqual({
      content: "---\ntags: [a]\n---\n\nhello world",
      text: "hello world",
      from: 6,
      to: 11,
      readOnly: false,
    });
  });

  it("captures whether the editor was read-only, as reading view makes it", () => {
    const { view, documentAccess } = setup();
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    expect(documentAccess.snapshot("note.md").readOnly).toBe(true);
  });

  it("refuses a document that is no longer open, but not a private one", () => {
    expect(() => setup({ getActivePath: () => "other.md" }).documentAccess.snapshot("note.md")).toThrow(
      "no longer open",
    );
    const { documentAccess } = setup({ getActiveDocument: opened(true) });
    expect(() => documentAccess.snapshot("note.md")).not.toThrow();
    expect(() => documentAccess.editor("note.md")).toThrow("visibility: private");
  });
});
