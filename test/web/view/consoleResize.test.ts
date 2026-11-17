// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { wireConsoleResize } from "../../../web/view/consoleResize.ts";

function setup(saved: number | undefined, editorHeight: number) {
  const root = document.documentElement.style;
  root.setProperty("--console-min-height", "60px");
  root.setProperty("--statusbar-height", "24px");
  root.setProperty("--editor-min-height", "100px");
  const panel = document.createElement("div");
  const handle = document.createElement("div");
  const editor = document.createElement("div");
  Object.defineProperty(editor, "clientHeight", { value: editorHeight });
  document.body.append(editor, panel, handle);
  wireConsoleResize({ panel, handle, editor, height: { get: () => saved, set: vi.fn() } });
  return panel;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("the Console's height", () => {
  it("comes back as it was saved", () => {
    expect(setup(200, 800).style.height).toBe("200px");
  });

  // The document above keeps --editor-min-height, the status bar its own.
  it("is capped in a window shorter than the one it was saved in, never under its floor", () => {
    expect(setup(900, 500).style.height).toBe("376px");
    expect(setup(20, 800).style.height).toBe("60px");
  });

  it("stays the stylesheet's until one is saved", () => {
    expect(setup(undefined, 800).style.height).toBe("");
  });
});
