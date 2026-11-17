// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import frameScript from "../../../../web/view/panes/pdfFrame.js?raw";

type Posted = { type?: unknown; key?: unknown; selection?: unknown };

// The frame script runs here as the frame runs it, over a page holding only
// its viewer container; what it posts to its parent is what the pane hears.
describe("the PDF frame", () => {
  const posted: Posted[] = [];
  let restore: () => void;

  beforeAll(() => {
    document.body.innerHTML = '<div id="viewerContainer"></div>';
    const spy = vi.spyOn(window.parent, "postMessage").mockImplementation(((message: Posted) => {
      posted.push(message);
    }) as typeof window.postMessage);
    restore = () => spy.mockRestore();
    new Function(frameScript)();
  });
  afterAll(() => restore());
  beforeEach(() => {
    posted.length = 0;
  });

  function press(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(event);
    return event;
  }
  const keysHandedUp = () => posted.filter((message) => message.type === "key").map((message) => message.key);

  it("hands a function key up to the app, alone or with Shift", () => {
    const f1 = press({ key: "F1" });
    const shiftF3 = press({ key: "F3", shiftKey: true });
    expect(keysHandedUp()).toEqual(["F1", "F3"]);
    expect(f1.defaultPrevented).toBe(true);
    expect(shiftF3.defaultPrevented).toBe(true);
  });

  it("hands up a chord with Ctrl, Alt or Meta held", () => {
    press({ key: "p", ctrlKey: true });
    press({ key: "ArrowLeft", altKey: true, metaKey: true });
    expect(keysHandedUp()).toEqual(["p", "ArrowLeft"]);
  });

  it("hands Ctrl+F up as Find, with the text selected in the frame", () => {
    const text = document.createElement("span");
    text.textContent = "On Paper";
    document.body.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    const find = press({ key: "f", ctrlKey: true });
    expect(posted).toContainEqual(expect.objectContaining({ type: "find-shortcut", selection: "On Paper" }));
    expect(find.defaultPrevented).toBe(true);
    window.getSelection()?.removeAllRanges();
    text.remove();
  });

  it("takes the host's tokens with its theme, by their own names", () => {
    const tokens = { "--find-match-bg": "#ffff55", "--border-input": "#333", color: "red" };
    const data = { source: "pragma-host", type: "theme", scheme: "dark", tokens };
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data }));
    const root = document.documentElement.style;
    expect([root.getPropertyValue("--find-match-bg"), root.getPropertyValue("--border-input")]).toEqual([
      "#ffff55",
      "#333",
    ]);
    expect(root.getPropertyValue("color")).toBe("");
  });

  it("keeps a plain key, and copy, for the frame's own viewer", () => {
    const plain = press({ key: "a" });
    const copy = press({ key: "c", ctrlKey: true });
    expect(keysHandedUp()).toEqual([]);
    expect(plain.defaultPrevented).toBe(false);
    expect(copy.defaultPrevented).toBe(false);
  });
});
