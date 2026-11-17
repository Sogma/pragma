import { describe, expect, it } from "vitest";
import { createEditorPanes, type EditorPaneDescriptor } from "../../../web/services/editorPanes.ts";

function descriptor(kind: EditorPaneDescriptor["kind"]): EditorPaneDescriptor {
  return {
    kind,
    chrome: { toolbar: false, readingView: false, statusbar: false, actions: [] },
    create: () => ({}) as never,
  };
}

describe("createEditorPanes", () => {
  it("registers a descriptor per kind and reports what it has", () => {
    const panes = createEditorPanes();
    const table = descriptor("table");
    panes.register(table);

    expect(panes.has("table")).toBe(true);
    expect(panes.get("table")).toBe(table);
    expect(panes.has("flow")).toBe(false);
    expect(panes.get("flow")).toBeUndefined();
  });

  it("rejects a second descriptor for the same kind", () => {
    const panes = createEditorPanes();
    panes.register(descriptor("table"));

    expect(() => panes.register(descriptor("table"))).toThrow(/already registered/);
  });

  it("disposing a registration removes it, and only it", () => {
    const panes = createEditorPanes();
    const table = panes.register(descriptor("table"));
    panes.register(descriptor("flow"));

    table.dispose();

    expect(panes.has("table")).toBe(false);
    expect(panes.has("flow")).toBe(true);
    expect(() => panes.register(descriptor("table"))).not.toThrow();
  });
});
