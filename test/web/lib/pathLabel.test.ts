// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { applyShowExtensions, createPathLabel, type PathNames } from "../../../web/lib/pathLabel.ts";

// jsdom lays nothing out: a test that resizes a label calls its observer
// itself, and the frame the label fits in comes at once.
let notify: ((entries: { target: Element }[]) => void) | undefined;
const observed = new Set<Element>();
globalThis.ResizeObserver = class {
  constructor(callback: (entries: { target: Element }[]) => void) {
    notify = callback;
  }
  observe(target: Element) {
    observed.add(target);
  }
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
  callback(0);
  return 0;
});
vi.stubGlobal("cancelAnimationFrame", () => {});

const names = (id: string) => new Map([["personas", "Personas"]]).get(id);

// Each piece the label shows, in order, a library's icon marked.
function pieces(label: HTMLElement): string[] {
  const shown = label.querySelectorAll(
    ".path-label-root-icon, .path-label-root, .path-label-more, .path-label-folder, .path-label-separator, .path-label-name, .path-label-after",
  );
  return [...shown].map((piece) =>
    piece.classList.contains("path-label-root-icon") ? "[library]" : (piece.textContent ?? ""),
  );
}

describe("createPathLabel", () => {
  // What a right-click on the chip copies, whatever it shows of the path.
  it("keeps its whole path and whether it names a file or a folder", () => {
    const file = createPathLabel("notes/drafts/act-one/a.md", names, { compact: true });
    expect([file.dataset.path, file.dataset.pathType]).toEqual(["notes/drafts/act-one/a.md", "file"]);
    const folder = createPathLabel("notes/drafts", names, { type: "directory" });
    expect([folder.dataset.path, folder.dataset.pathType]).toEqual(["notes/drafts", "directory"]);
  });

  it("draws a library's scheme as its icon and name, keeping the folder the file sits in", () => {
    const label = createPathLabel("lib:personas/Lina/tester.png", names);
    expect(pieces(label)).toEqual(["[library]", "Personas", "/", "Lina", "/", "tester.png"]);
    expect(label.dataset.tooltip).toBe("lib:personas/Lina/tester.png");
  });

  it("shows every folder, and a compact label one … for the folders between", () => {
    const path = "projects/getting-started/characters/aria.md";
    expect(pieces(createPathLabel(path, names))).toEqual([
      "projects",
      "/",
      "getting-started",
      "/",
      "characters",
      "/",
      "aria.md",
    ]);
    const label = createPathLabel(path, names, { compact: true });
    expect(pieces(label)).toEqual(["projects", "/", "…", "/", "characters", "/", "aria.md"]);
    expect(label.dataset.tooltip).toBe(path);
    expect(observed.has(label)).toBe(false);
    expect(pieces(createPathLabel("lib:personas/cast/2026/Lina/take.png", names, { compact: true }))).toEqual([
      "[library]",
      "Personas",
      "/",
      "…",
      "/",
      "Lina",
      "/",
      "take.png",
    ]);
  });

  it("starts a space path at its top folder, one in a top-level folder there, and one at the top level at its name", () => {
    expect(pieces(createPathLabel("projects/characters/aria.md", names))).toEqual([
      "projects",
      "/",
      "characters",
      "/",
      "aria.md",
    ]);
    expect(pieces(createPathLabel("characters/aria.md", names))).toEqual(["characters", "/", "aria.md"]);
    expect(pieces(createPathLabel("aria.md", names))).toEqual(["aria.md"]);
  });

  it("names a library by its id until its name is read, and a root by itself", () => {
    expect(pieces(createPathLabel("lib:footage/still.png", names))).toEqual(["[library]", "footage", "/", "still.png"]);
    expect(pieces(createPathLabel("lib:personas", names))).toEqual(["[library]", "Personas"]);
    expect(pieces(createPathLabel("", names))).toEqual(["Space"]);
  });

  // A break between the two would leave the punctuation alone on a line.
  // A narrow line cuts that piece from its start, keeping the end of the name.
  it("keeps what follows where the path is in one piece, its characters in order", () => {
    const label = createPathLabel("lib:personas/cast/2026/Lina/take.png", names, { after: ".", compact: true });
    expect([...label.children].map((piece) => piece.className)).toEqual(["path-label-box", "path-label-after"]);
    expect([...(label.firstElementChild?.children ?? [])].map((piece) => piece.className)).toEqual([
      "path-label-root-icon",
      "path-label-root",
      "path-label-separator",
      "path-label-tail",
    ]);
    expect(label.querySelector(".path-label-tail > .path-label-run")?.textContent).toBe("…/Lina/take.png");
    expect(createPathLabel("characters/aria.md", names).querySelector(".path-label-tail")?.textContent).toBe(
      "characters/aria.md",
    );
  });

  it("keeps the punctuation after the path inside the label", () => {
    expect(pieces(createPathLabel("characters/aria.md", names, { after: "?" }))).toEqual([
      "characters",
      "/",
      "aria.md",
      "?",
    ]);
  });

  it("shows a path that doesn't parse as written", () => {
    const label = createPathLabel("foo:bar/baz.md", names);
    expect(pieces(label)).toEqual(["foo:bar/baz.md"]);
    expect(label.dataset.tooltip).toBe("foo:bar/baz.md");
  });

  it("shows a path from a folder it is in, that folder itself by its name, and any other path whole", () => {
    const from = (path: string, folder: string) => createPathLabel(path, names, { type: "directory", from: folder });
    expect(pieces(from("forbidden/story/world", "forbidden"))).toEqual(["story", "/", "world"]);
    expect(pieces(from("forbidden/story", "forbidden/story"))).toEqual(["story"]);
    expect(pieces(from("notes/world", "forbidden"))).toEqual(["notes", "/", "world"]);
    expect(pieces(from("lib:personas/world", "forbidden"))).toEqual(["[library]", "Personas", "/", "world"]);
    expect(from("forbidden/story/world", "forbidden").dataset.tooltip).toBe("forbidden/story/world");
  });

  it("draws a path standing alone without the box that sets one apart in running text", () => {
    expect(
      createPathLabel("story/world", names, { standalone: true }).classList.contains("path-label-standalone"),
    ).toBe(true);
    expect(createPathLabel("story/world", names).classList.contains("path-label-standalone")).toBe(false);
  });

  it("starts with the entry's icon as the tree draws it, a plain file's as a file, and a root with none", () => {
    const asked: Array<[string, string]> = [];
    const withIcons: PathNames = {
      libraryName: names,
      icon: (path, type) => {
        asked.push([path, type]);
        return { glyph: path.endsWith(".md") ? "markdown" : type === "directory" ? "folder" : undefined };
      },
    };
    const glyph = (label: HTMLElement) =>
      label.querySelector<HTMLElement>(".path-label-box > .path-label-icon:first-child")?.dataset.entryIcon;
    expect(glyph(createPathLabel("projects/getting-started/aria.md", withIcons))).toBe("markdown");
    expect(glyph(createPathLabel("projects/pre-prod/casting", withIcons))).toBe("folder");
    expect(glyph(createPathLabel("notes/data.xyz", withIcons))).toBe("file");
    expect(glyph(createPathLabel("projects/v1.2", withIcons, { type: "directory" }))).toBe("folder");
    expect(asked.map(([, type]) => type)).toEqual(["file", "directory", "file", "directory"]);
    expect(glyph(createPathLabel("lib:personas", withIcons))).toBeUndefined();
    expect(glyph(createPathLabel("projects/getting-started/aria.md", names))).toBeUndefined();

    // A library's icon leads, so the entry's sits beside the path.
    const library = createPathLabel("lib:personas/Lina/tester.png", withIcons);
    expect([...(library.firstElementChild?.children ?? [])].slice(0, 3).map((piece) => piece.className)).toEqual([
      "path-label-root-icon",
      "path-label-icon",
      "path-label-root",
    ]);
  });

  it("sets a known kind's extension apart, for Show extensions to show, and keeps it in the tooltip", () => {
    const label = createPathLabel("projects/getting-started/writing-prompts.table.html", names);
    expect(label.querySelector(".path-label-name")?.firstChild?.textContent).toBe("writing-prompts");
    expect(label.querySelector(".path-label-ext")?.textContent).toBe(".table.html");
    expect(label.dataset.tooltip).toBe("projects/getting-started/writing-prompts.table.html");
    expect(createPathLabel("notes/data.xyz", names).querySelector(".path-label-ext")).toBeNull();
    expect(createPathLabel("projects/v1.2", names, { type: "directory" }).querySelector(".path-label-ext")).toBeNull();

    applyShowExtensions(true);
    expect(document.documentElement.classList.contains("show-extensions")).toBe(true);
    applyShowExtensions(false);
    expect(document.documentElement.classList.contains("show-extensions")).toBe(false);
  });
});

describe("a label in the room it has", () => {
  // Each character 8px wide, and what follows the top folder given `room`.
  function layOut(room: () => number) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const width = this.classList.contains("path-label-tail") ? room() : (this.textContent?.length ?? 0) * 8;
      return new DOMRect(0, 0, width, 16);
    });
  }

  it("folds the folders between, from the top down, as its room narrows, and brings them back", () => {
    let room = 1000;
    layOut(() => room);
    const line = document.createElement("p");
    const sentence = document.createElement("span");
    const label = createPathLabel("projects/client/season-2/pre-prod/casting", names);
    sentence.append("Grant permission to read:", label);
    line.append(sentence);
    document.body.append(line);
    notify?.([{ target: label }]);
    expect(label.textContent).toBe("projects/client/season-2/pre-prod/casting");
    // Its room is the paragraph: the sentence is inline, as wide as it is.
    expect(observed.has(line)).toBe(true);
    expect(observed.has(sentence)).toBe(false);

    room = 8 * "…/season-2/pre-prod/casting".length;
    notify?.([{ target: line }]);
    expect(label.textContent).toBe("projects/…/season-2/pre-prod/casting");

    room = 100;
    notify?.([{ target: line }]);
    expect(label.textContent).toBe("projects/…/pre-prod/casting");

    room = 1000;
    notify?.([{ target: line }]);
    expect(label.textContent).toBe("projects/client/season-2/pre-prod/casting");
    line.remove();
    vi.restoreAllMocks();
  });
});
