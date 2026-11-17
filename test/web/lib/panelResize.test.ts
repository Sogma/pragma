// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { wirePanelResize } from "../../../web/lib/panelResize.ts";

function wire() {
  const handle = document.createElement("div");
  document.body.append(handle);
  const apply = vi.fn();
  const commit = vi.fn();
  const store = wirePanelResize({
    handle,
    axis: "ew",
    minSize: 100,
    beginDrag: () => (event) => event.clientX,
    apply,
    commit,
  });
  return { handle, apply, commit, store };
}

const move = (clientX: number) => document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
const release = () => document.dispatchEvent(new MouseEvent("mouseup"));

describe("wirePanelResize", () => {
  it("applies every move, floored, and commits the last size once on release", () => {
    const { handle, apply, commit } = wire();

    handle.dispatchEvent(new MouseEvent("mousedown"));
    move(250);
    move(40);
    expect(apply.mock.calls).toEqual([[250], [100]]);
    expect(commit).not.toHaveBeenCalled();

    release();
    expect(commit.mock.calls).toEqual([[100]]);

    move(300);
    release();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("commits nothing for a press that never moved", () => {
    const { handle, commit } = wire();

    handle.dispatchEvent(new MouseEvent("mousedown"));
    release();

    expect(commit).not.toHaveBeenCalled();
  });

  it("starts the same drag from each part of an edge, and lights the parts together", () => {
    const parts = [document.createElement("div"), document.createElement("div")];
    document.body.append(...parts);
    const apply = vi.fn();
    wirePanelResize({ handle: parts, axis: "ew", minSize: 0, beginDrag: () => (event) => event.clientX, apply });
    const marked = (className: string) => parts.map((part) => part.classList.contains(className));

    parts[1].dispatchEvent(new MouseEvent("mouseenter"));
    expect(marked("hover")).toEqual([true, true]);
    parts[1].dispatchEvent(new MouseEvent("mouseleave"));
    expect(marked("hover")).toEqual([false, false]);

    parts[1].dispatchEvent(new MouseEvent("mousedown"));
    expect(marked("dragging")).toEqual([true, true]);
    move(250);
    release();
    expect(marked("dragging")).toEqual([false, false]);

    parts[0].dispatchEvent(new MouseEvent("mousedown"));
    move(300);
    release();
    expect(apply.mock.calls).toEqual([[250], [300]]);
  });

  it("commits nothing when the widget goes away mid-drag", () => {
    const { handle, commit, store } = wire();

    handle.dispatchEvent(new MouseEvent("mousedown"));
    move(250);
    store.dispose();
    release();

    expect(commit).not.toHaveBeenCalled();
  });

  describe("on a panel the drag can hide", () => {
    function wireHiding() {
      const handle = document.createElement("div");
      document.body.append(handle);
      const apply = vi.fn();
      const commit = vi.fn();
      let hidden = false;
      const setHidden = vi.fn((next: boolean) => {
        hidden = next;
      });
      wirePanelResize({
        handle,
        axis: "ew",
        minSize: 200,
        beginDrag: () => (event) => event.clientX,
        apply,
        commit,
        hide: { isHidden: () => hidden, setHidden, size: () => 280 },
      });
      return { handle, apply, commit, setHidden };
    }

    it("hides it under 50px and shows it again only back at the floor", () => {
      const { handle, apply, commit, setHidden } = wireHiding();

      handle.dispatchEvent(new MouseEvent("mousedown"));
      move(120);
      move(49);
      move(150);
      expect(setHidden.mock.calls).toEqual([[true]]);

      move(200);
      move(260);
      expect(setHidden.mock.calls).toEqual([[true], [false]]);
      expect(apply.mock.calls).toEqual([[200], [200], [260]]);

      release();
      expect(commit.mock.calls).toEqual([[260]]);
    });

    it("commits nothing for a drag that ends with it hidden, and hands back the size it started at", () => {
      const { handle, apply, commit } = wireHiding();

      handle.dispatchEvent(new MouseEvent("mousedown"));
      move(240);
      move(20);
      release();

      expect(commit).not.toHaveBeenCalled();
      expect(apply.mock.calls).toEqual([[240], [280]]);
    });
  });
});
