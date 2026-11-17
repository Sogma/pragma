// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAGGED_ENTRY_TYPE } from "../../../web/core/paths.ts";
import { writePathFrom } from "../../../web/core/spaceTree.ts";
import { formatFileSize } from "../../../web/lib/dom.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createMediaField, resolveMediaFolder, resolveMediaValue } from "../../../web/services/mediaField.ts";
import type { DroppedImportResult } from "../../../web/services/mediaImport.ts";
import { fireDrag } from "../support/drag.ts";

beforeEach(() => {
  document.body.replaceChildren();
});

// The stored form is a note's: relative from the document's folder, or a
// rooted library path. Resolution and formatting are two halves of one rule.
describe("resolveMediaValue", () => {
  it("resolves a relative reference from the document's folder", () => {
    expect(resolveMediaValue("projects/demo", "cover.png")).toBe("projects/demo/cover.png");
    expect(resolveMediaValue("projects/demo", "../stills/a.png")).toBe("projects/stills/a.png");
    expect(resolveMediaValue("", "cover.png")).toBe("cover.png");
  });

  it("keeps a library path absolute, and resolves a library document within its library", () => {
    expect(resolveMediaValue("projects/demo", "lib:takes/batch/one.mp4")).toBe("lib:takes/batch/one.mp4");
    expect(resolveMediaValue("lib:takes/batch", "one.mp4")).toBe("lib:takes/batch/one.mp4");
    expect(resolveMediaValue("lib:takes/batch", "../other.mp4")).toBe("lib:takes/other.mp4");
  });

  it("reads an empty or unreadable value as no file", () => {
    expect(resolveMediaValue("x", "")).toBeUndefined();
    expect(resolveMediaValue("x", "   ")).toBeUndefined();
    expect(resolveMediaValue("x", "ftp:nope/a.png")).toBeUndefined();
  });
});

describe("writePathFrom, as a media value is written", () => {
  it("writes a space file relative to a space document", () => {
    expect(writePathFrom("projects/demo", { root: "space", path: "projects/demo/cover.png" })).toBe("cover.png");
    expect(writePathFrom("projects/demo", { root: "space", path: "stills/a.png" })).toBe("../../stills/a.png");
  });

  it("writes a library file absolutely from a space document", () => {
    expect(writePathFrom("projects/demo", { root: { library: "takes" }, path: "batch/one.mp4" })).toBe(
      "lib:takes/batch/one.mp4",
    );
  });

  it("writes relative within one library, and refuses anything outside it from a library document", () => {
    expect(writePathFrom("lib:takes/batch", { root: { library: "takes" }, path: "batch/one.mp4" })).toBe("one.mp4");
    expect(writePathFrom("lib:takes/batch", { root: "space", path: "a.png" })).toBeUndefined();
    expect(writePathFrom("lib:takes/batch", { root: { library: "other" }, path: "a.png" })).toBeUndefined();
  });
});

// A drop folder is written the way a value is, and held to the same
// library line a value is.
describe("resolveMediaFolder", () => {
  it("falls back to the document's own folder when none is set", () => {
    expect(resolveMediaFolder("projects/demo", undefined)).toBe("projects/demo");
    expect(resolveMediaFolder("projects/demo", "  ")).toBe("projects/demo");
  });

  it("resolves a relative folder from the document's folder, ignoring a trailing slash", () => {
    expect(resolveMediaFolder("projects/demo", "stills/")).toBe("projects/demo/stills");
    expect(resolveMediaFolder("projects/demo", "../shared")).toBe("projects/shared");
  });

  it("keeps a library folder absolute from a space document", () => {
    expect(resolveMediaFolder("projects/demo", "lib:takes/batch")).toBe("lib:takes/batch");
  });

  it("refuses a folder outside a library document's own library, or an unreadable one", () => {
    expect(resolveMediaFolder("lib:takes/batch", "incoming")).toBe("lib:takes/batch/incoming");
    expect(resolveMediaFolder("lib:takes/batch", "lib:other/x")).toBeUndefined();
    expect(resolveMediaFolder("projects/demo", "ftp:nope")).toBeUndefined();
  });
});

function landed(paths: string[]): DroppedImportResult {
  return { imported: paths, refused: [], failed: [], cancelled: false };
}

function field(value: string, overrides: Partial<Parameters<typeof createMediaField>[0]> = {}) {
  const spec = {
    docDir: "projects/demo",
    value,
    readOnly: false,
    onChange: vi.fn(),
    strip: "cover",
    openItem: vi.fn(),
    dialog: createDialogService(document.body),
    notify: vi.fn(),
    importFiles: vi.fn(async () => landed([])),
    ...overrides,
  };
  const element = createMediaField(spec);
  document.body.append(element);
  return { element, spec };
}

// jsdom has no DragEvent; a drop is a plain event carrying what the real one
// would: files, or the text a tree row writes.
function drop(
  element: HTMLElement,
  payload: { files?: File[]; text?: string; entry?: "file" | "directory"; uriList?: string },
): void {
  const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
  const data: Record<string, string | undefined> = {
    "text/plain": payload.text,
    [DRAGGED_ENTRY_TYPE]: payload.entry,
    "text/uri-list": payload.uriList,
  };
  const types = Object.keys(data).filter((type) => data[type] !== undefined);
  Object.defineProperty(event, "dataTransfer", {
    value: { files: payload.files ?? [], types, getData: (type: string) => data[type] ?? "" },
  });
  element.dispatchEvent(event);
}

describe("createMediaField", () => {
  it("shows an image as its own picture, and opens it on click", () => {
    const { element, spec } = field("cover.png");
    const img = element.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/file/raw?path=projects%2Fdemo%2Fcover.png");
    expect(element.querySelector(".media-field-name")?.textContent).toBe("cover.png");
    (element.querySelector(".media-field-thumb") as HTMLButtonElement).click();
    expect(spec.openItem).toHaveBeenCalledWith("projects/demo/cover.png", element);
  });

  it("drags its picture as the file it shows", () => {
    const img = field("cover.png").element.querySelector("img") as HTMLImageElement;
    expect([...fireDrag(img, "dragstart")]).toEqual([
      ["text/plain", "projects/demo/cover.png"],
      [DRAGGED_ENTRY_TYPE, "file"],
    ]);
  });

  it("shows a video as a first-frame player, muted and metadata-only", () => {
    const { element } = field("lib:takes/batch/one.mp4");
    const video = element.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("/api/file/raw?path=lib%3Atakes%2Fbatch%2Fone.mp4");
    expect(video.preload).toBe("metadata");
    expect(video.muted).toBe(true);
  });

  it("reads an empty value as None, with nothing to open and nothing to clear", () => {
    const { element, spec } = field("");
    expect(element.classList.contains("is-empty")).toBe(true);
    expect(element.querySelector(".media-field-name")?.textContent).toBe("None");
    (element.querySelector(".media-field-thumb") as HTMLButtonElement).click();
    expect(spec.openItem).not.toHaveBeenCalled();
  });

  it("draws a file whose picture fails to load offline, keeping the value", () => {
    const { element, spec } = field("gone.png");
    element.querySelector("img")?.dispatchEvent(new Event("error"));
    const thumb = element.querySelector(".media-field-thumb") as HTMLButtonElement;
    expect(element.classList.contains("is-missing")).toBe(true);
    expect(element.querySelector("img")).toBeNull();
    expect(thumb.querySelector(".media-field-offline")?.textContent).toBe("OfflineMedia offline");
    expect([thumb.getAttribute("aria-label"), thumb.dataset.tooltip]).toEqual([
      "Media offline: gone.png",
      "projects/demo/gone.png",
    ]);
    expect(element.querySelector(".media-field-name")?.textContent).toBe("gone.png");
    expect(spec.onChange).not.toHaveBeenCalled();
  });

  it("stores a dragged tree row in the note's relative form, or rooted for a library", () => {
    const { element, spec } = field("");
    drop(element, { text: "projects/stills/a.png" });
    expect(spec.onChange).toHaveBeenLastCalledWith("../stills/a.png");
    drop(element, { text: "lib:takes/batch/one.mp4" });
    expect(spec.onChange).toHaveBeenLastCalledWith("lib:takes/batch/one.mp4");
    expect(element.querySelector("video")).not.toBeNull();
  });

  // A browser hands over a copy of any picture dragged as an image, named
  // after its address, beside whatever names it: a file Pragma names is
  // linked where it lies, and only a drop from elsewhere is copied in.
  it("links a file Pragma names though the drag also carries its bytes", () => {
    const importFiles = vi.fn(async () => landed([]));
    const { element, spec } = field("", { importFiles });
    const copy = new File([new Uint8Array(8)], "raw.png");
    drop(element, { files: [copy], text: "lib:personas/Lina/still.png", entry: "file" });
    expect(spec.onChange).toHaveBeenLastCalledWith("lib:personas/Lina/still.png");

    const served = `${location.origin}/api/file/raw?path=${encodeURIComponent("lib:personas/Lina/take two.png")}`;
    drop(element, { files: [copy], text: served, uriList: `# dragged\r\n${served}` });
    expect(spec.onChange).toHaveBeenLastCalledWith("lib:personas/Lina/take%20two.png");
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("copies in a picture dragged from another site, whatever its address", async () => {
    const importFiles = vi.fn(async () => landed(["projects/demo/raw.png"]));
    const { element, spec } = field("", { importFiles });
    const copy = new File([new Uint8Array(8)], "raw.png");
    drop(element, { files: [copy], uriList: "https://images.example.com/api/file/raw?path=stills%2Fa.png" });
    await vi.waitFor(() => expect(spec.onChange).toHaveBeenCalledWith("raw.png"));
    expect(importFiles).toHaveBeenCalledWith([copy], "projects/demo");
  });

  it("refuses a drop that would point a library document outside its library", () => {
    const { element, spec } = field("", { docDir: "lib:takes/batch" });
    drop(element, { text: "projects/a.png" });
    expect(spec.onChange).not.toHaveBeenCalled();
    expect(spec.notify).toHaveBeenCalledWith(expect.stringContaining("same library"));
  });

  it("copies a dropped desktop file beside the document and links the first", async () => {
    const importFiles = vi.fn(async () => landed(["projects/demo/take.mp4"]));
    const { element, spec } = field("", { importFiles });
    const take = new File([new Uint8Array(8)], "take.mp4");
    const second = new File([new Uint8Array(8)], "second.mp4");
    drop(element, { files: [take, second] });
    await vi.waitFor(() => expect(spec.onChange).toHaveBeenCalledWith("take.mp4"));
    expect(importFiles).toHaveBeenCalledWith([take], "projects/demo");
    expect(spec.notify).toHaveBeenCalledWith(expect.stringContaining("one file"));
  });

  it("copies a dropped desktop file into the media folder, linking it from the document", async () => {
    const importFiles = vi.fn(async () => landed(["projects/demo/stills/take.png"]));
    const { element, spec } = field("", { importFiles, folder: "stills" });
    const take = new File([new Uint8Array(8)], "take.png");
    drop(element, { files: [take] });
    await vi.waitFor(() => expect(spec.onChange).toHaveBeenCalledWith("stills/take.png"));
    expect(importFiles).toHaveBeenCalledWith([take], "projects/demo/stills");
  });

  it("refuses a desktop drop when the media folder can't be used, copying nothing", async () => {
    const { element, spec } = field("", { docDir: "lib:takes/batch", folder: "lib:other/x" });
    drop(element, { files: [new File([new Uint8Array(8)], "take.png")] });
    await Promise.resolve();
    expect(spec.importFiles).not.toHaveBeenCalled();
    expect(spec.notify).toHaveBeenCalledWith(expect.stringContaining("lib:other/x"));
  });

  // A PDF is media everywhere else a file is dropped, but a field's cell
  // shows a picture, which a PDF doesn't have.
  it("refuses a desktop file that is not a picture, without importing anything", async () => {
    for (const name of ["notes.zip", "paper.pdf"]) {
      const { element, spec } = field("");
      drop(element, { files: [new File([new Uint8Array(8)], name)] });
      await Promise.resolve();
      expect(spec.importFiles, name).not.toHaveBeenCalled();
      expect(spec.notify).toHaveBeenCalledWith(expect.stringContaining(name));
    }
  });

  it("clears on the clear button", () => {
    const { element, spec } = field("cover.png");
    (element.querySelector(".media-field-clear") as HTMLButtonElement).click();
    expect(spec.onChange).toHaveBeenCalledWith("");
    expect(element.classList.contains("is-empty")).toBe(true);
  });

  it("offers neither clear nor drop when read-only, but still opens", () => {
    const { element, spec } = field("cover.png", { readOnly: true });
    expect(element.querySelector(".media-field-clear")).toBeNull();
    drop(element, { text: "projects/stills/a.png" });
    expect(spec.onChange).not.toHaveBeenCalled();
    (element.querySelector(".media-field-thumb") as HTMLButtonElement).click();
    expect(spec.openItem).toHaveBeenCalled();
  });

  // A column shows its file names only when it says to; the picture keeps
  // the name as its tooltip and label. A state is no name, so it always
  // shows; an offline file's slate says so, and its name stays as set.
  it("hides the file's name unless its column shows it, the picture carrying it instead", () => {
    const nameOf = (element: HTMLElement) => element.querySelector(".media-field-name") as HTMLElement;
    const thumbOf = (element: HTMLElement) => element.querySelector(".media-field-thumb") as HTMLElement;
    const hidden = field("cover.png").element;
    expect(nameOf(hidden).hidden).toBe(true);
    expect(thumbOf(hidden).getAttribute("aria-label")).toBe("cover.png");
    expect(thumbOf(hidden).dataset.tooltip).toBe("cover.png");

    const shown = field("cover.png", { showName: true }).element;
    expect([nameOf(shown).hidden, nameOf(shown).textContent]).toEqual([false, "cover.png"]);
    expect(thumbOf(shown).dataset.tooltip).toBeUndefined();

    expect([nameOf(field("").element).hidden, nameOf(field("").element).textContent]).toEqual([false, "None"]);
    const gone = field("cover.png").element;
    gone.querySelector("img")?.dispatchEvent(new Event("error"));
    expect([nameOf(gone).hidden, nameOf(gone).textContent]).toEqual([true, "cover.png"]);
    const goneShown = field("cover.png", { showName: true }).element;
    goneShown.querySelector("img")?.dispatchEvent(new Event("error"));
    expect([nameOf(goneShown).hidden, nameOf(goneShown).textContent]).toEqual([false, "cover.png"]);
  });
});

// A failed load can't tell a file that has gone from one this browser can't
// decode, so the click asks the server and the modal says which it was.
describe("a click on an offline media field", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(status: number, body: string | object) {
    const fetchMock = vi.fn(async (_input: string) =>
      typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function explained(value: string) {
    const drawn = field(value);
    drawn.element.querySelector("img, video")?.dispatchEvent(new Event("error"));
    (drawn.element.querySelector(".media-field-thumb") as HTMLButtonElement).click();
    const panel = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>(".dialog-panel");
      expect(shown).not.toBeNull();
      return shown as HTMLElement;
    });
    const facts = [...panel.querySelectorAll("dt")].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    return { ...drawn, panel, facts, reason: panel.querySelector(".dialog-message")?.textContent };
  }

  it("says a gone file has gone, naming the path looked at and the value as written", async () => {
    const fetchMock = answer(404, "Not found");
    const { panel, facts, reason, spec } = await explained("stills/gone.png");
    expect(panel.querySelector(".dialog-title")?.textContent).toBe("Media offline");
    expect(reason).toBe("This file isn't there any more. It may have been moved or deleted.");
    expect(facts).toEqual([
      ["Path", "projects/demo/stills/gone.png"],
      ["Value", "stills/gone.png"],
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/file/info?path=projects%2Fdemo%2Fstills%2Fgone.png");
    expect(spec.openItem).not.toHaveBeenCalled();
    (panel.querySelector(".dialog-actions button") as HTMLButtonElement).click();
    expect(document.querySelector(".dialog-panel")).toBeNull();
  });

  it("gives a refusal's own reason, leaving out a value that says no more than the path", async () => {
    answer(404, 'No library "takes" is registered');
    const { facts, reason } = await explained("lib:takes/one.png");
    expect(reason).toBe('No library "takes" is registered');
    expect(facts).toEqual([["Path", "lib:takes/one.png"]]);
  });

  it("says a file that is there can't be decoded, with its size", async () => {
    answer(200, { kind: "file", size: 2048, modified: "2026-11-04T00:00:00Z" });
    const clip = await explained("take.mov");
    expect(clip.reason).toBe("This browser can't play this video's format. The file itself is untouched.");
    expect(clip.facts).toEqual([
      ["Path", "projects/demo/take.mov"],
      ["Size", formatFileSize(2048)],
    ]);
    (clip.panel.querySelector(".dialog-actions button") as HTMLButtonElement).click();
    const still = await explained("cover.png");
    expect(still.reason).toBe(
      "This browser can't show this image. The file may be damaged, or not the format its name says.",
    );
  });
});

// The space's listing says a file is gone with nothing asked of the server,
// but only for a space file, and only while no write it may lack is noted.
describe("a media field checked against the space's listing", () => {
  const LISTING = {
    files: ["projects/demo/cover.png", "projects/demo/notes.table.html"],
    folders: ["projects", "projects/demo"],
    scopes: [],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Fresh modules, so the listing loaded here leaves the other tests' empty.
  async function listed() {
    vi.resetModules();
    const spaceTree = await import("../../../web/core/spaceTree.ts");
    const media = await import("../../../web/services/mediaField.ts");
    const fetchMock = vi.fn(async (url: string) =>
      Response.json(String(url).startsWith("/api/space/paths") ? LISTING : []),
    );
    vi.stubGlobal("fetch", fetchMock);
    await spaceTree.refresh();
    fetchMock.mockClear();
    const draw = (value: string, docDir = "projects/demo") =>
      media.createMediaField({
        docDir,
        value,
        readOnly: false,
        onChange: vi.fn(),
        strip: "cover",
        openItem: vi.fn(),
        dialog: createDialogService(document.body),
        notify: vi.fn(),
        importFiles: vi.fn(async () => landed([])),
      });
    return { spaceTree, media, draw, fetchMock };
  }

  it("draws a file the listing lacks offline at once, with no picture to ask for", async () => {
    const { draw, fetchMock } = await listed();
    const gone = draw("gone.pdf");
    expect(gone.classList.contains("is-missing")).toBe(true);
    expect(gone.querySelector(".media-field-offline")).not.toBeNull();
    expect(draw("gone.png").querySelector("img")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws a file only the listing called gone from the file, once a click finds it there", async () => {
    const { draw, fetchMock } = await listed();
    const late = draw("late.png");
    document.body.append(late);
    expect(late.classList.contains("is-missing")).toBe(true);
    fetchMock.mockImplementation(async () =>
      Response.json({ kind: "file", size: 8, modified: "2026-11-04T00:00:00Z" }),
    );
    (late.querySelector(".media-field-thumb") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(late.querySelector("img")).not.toBeNull());
    expect(late.classList.contains("is-missing")).toBe(false);
    expect(document.querySelector(".dialog-panel")).toBeNull();
  });

  it("asks for a file the listing holds, in any case, and takes a library's on trust", async () => {
    const { draw } = await listed();
    expect(draw("Cover.PNG").querySelector("img")).not.toBeNull();
    expect(draw("lib:takes/one.png").querySelector("img")).not.toBeNull();
    expect(draw("lib:takes/one.png").classList.contains("is-missing")).toBe(false);
  });

  it("believes the listing again only once a read started after a noted write lands", async () => {
    const { spaceTree, draw } = await listed();
    spaceTree.noteUnlistedWrites();
    expect(draw("new.png").querySelector("img")).not.toBeNull();
    const reading = spaceTree.refresh();
    spaceTree.noteUnlistedWrites();
    await reading;
    expect(draw("new.png").querySelector("img")).not.toBeNull();
    await spaceTree.refresh();
    expect(draw("new.png").classList.contains("is-missing")).toBe(true);
  });

  it("notes a copy dropped in, so a redraw before the next read draws it", async () => {
    vi.doMock("../../../web/services/mediaImport.ts", async (original) => ({
      ...(await original<typeof import("../../../web/services/mediaImport.ts")>()),
      importDroppedFiles: vi.fn(async () => landed(["new.png"])),
    }));
    const { media, spaceTree } = await listed();
    await media.mediaImportFor({} as never)([new File(["x"], "new.png", { type: "image/png" })], "");
    expect(spaceTree.listedAsGone("new.png")).toBe(false);
    await spaceTree.refresh();
    expect(spaceTree.listedAsGone("new.png")).toBe(true);
    vi.doUnmock("../../../web/services/mediaImport.ts");
  });
});

// A gallery tile's hover bars, on the picture: what the file decodes to at
// once, and on the first hover that shows them the size, which a cell
// doesn't hold.
describe("a media field's hover bars", () => {
  const barsOf = (thumb: HTMLElement) =>
    [...thumb.querySelectorAll<HTMLElement>(".thumbnail-hud-bar")].map((bar) =>
      bar.hidden ? "(hidden)" : [...bar.children].map((cell) => cell.textContent).join(" | "),
    );

  it("give a still its dimensions as it loads, and its size from the file on the first hover", async () => {
    const info = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ kind: "file", size: 2048, modified: "2026-11-03T00:00:00Z" })));
    try {
      const { element } = field("cover.png");
      const thumb = element.querySelector(".media-field-thumb") as HTMLElement;
      const img = thumb.querySelector("img") as HTMLImageElement;
      Object.defineProperty(img, "naturalWidth", { value: 1600 });
      Object.defineProperty(img, "naturalHeight", { value: 900 });
      img.dispatchEvent(new Event("load"));
      expect(barsOf(thumb)).toEqual(["1600 × 900 (16:9) |  | 16:9", "(hidden)"]);

      thumb.dispatchEvent(new Event("pointerenter"));
      thumb.dispatchEvent(new Event("pointerenter"));
      await vi.waitFor(() => expect(barsOf(thumb)[1]).toBe(` | ${formatFileSize(2048)}`));
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0][0])).toContain("/api/file/info?path=projects%2Fdemo%2Fcover.png");
    } finally {
      info.mockRestore();
    }
  });

  it("give a clip its dimensions and duration once its metadata is in", () => {
    const { element } = field("take.mp4");
    const thumb = element.querySelector(".media-field-thumb") as HTMLElement;
    const video = thumb.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1920 });
    Object.defineProperty(video, "videoHeight", { value: 1080 });
    Object.defineProperty(video, "duration", { value: 7 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(barsOf(thumb)).toEqual(["1920 × 1080 (16:9) |  | 16:9", "0:07 | "]);
  });

  it("put none on an empty field", () => {
    const { element } = field("");
    expect(element.querySelector(".thumbnail-hud")).toBeNull();
  });
});
