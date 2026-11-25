// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInfoResponse, FileResponse } from "../../web/core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE } from "../../web/core/paths.ts";
import { createFilePreview, createSelectedSection, PREVIEW_PAGE_MENU } from "../../web/filePreview.ts";
import { dateTimeLabel } from "../../web/lib/dateText.ts";
import { createDialogService } from "../../web/services/dialog.ts";
import { createFormats } from "../../web/services/formats.ts";
import { MEDIA_MENU } from "../../web/services/videoMenu.ts";
import { fireDrag } from "./support/drag.ts";
import { memoryViews } from "./support/editorLayout.ts";
import { fakeContextMenu } from "./support/fakeContextMenu.ts";
import { testPreviewSources } from "./support/previewSources.ts";

// jsdom runs no animations, so each run is recorded and ended by hand.
interface Run {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish(): void;
  cancelled: boolean;
}

let runs: Run[] = [];

// jsdom decodes nothing: a picture counts as decoded once it has loaded.
HTMLImageElement.prototype.decode ??= () => Promise.resolve();

beforeEach(() => {
  runs = [];
  HTMLElement.prototype.animate = function (keyframes, options) {
    let finish = () => {};
    let abort = (_reason: unknown) => {};
    const finished = new Promise<void>((resolve, reject) => {
      finish = resolve;
      abort = reject;
    });
    const run: Run = {
      element: this,
      keyframes: keyframes as Keyframe[],
      options: options as KeyframeAnimationOptions,
      finish,
      cancelled: false,
    };
    runs.push(run);
    return {
      finished,
      cancel() {
        run.cancelled = true;
        abort(new DOMException("Cancelled", "AbortError"));
      },
    } as unknown as Animation;
  };
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const STILLS = ["stills/a.png", "stills/b.png"];

// `inPlace` false is a pane that opens nothing in place; `at` is the context
// the pane's tab is seen in; `details` hands the preview an Info section to
// keep, as a pane with no selection of its own does.
function setup({ files = STILLS, inPlace = true, at = "", details = false, sources = testPreviewSources } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const refocus = vi.fn();
  const openInPlace = inPlace ? vi.fn() : undefined;
  const contextMenu = fakeContextMenu();
  const held = memoryViews();
  const read = sources(held);
  const section = details ? createSelectedSection(read) : undefined;
  const preview = createFilePreview({
    ...read,
    details: section,
    host,
    context: () => at,
    refocus,
    count: () => files.length,
    fileAt: (index) => (files[index] ? { path: files[index], name: files[index].split("/").pop() ?? "" } : undefined),
    loadFile: vi.fn(async (): Promise<FileResponse> => ({ kind: "missing" }) as unknown as FileResponse),
    formats: createFormats(),
    contextMenu,
    dialog: createDialogService(),
    openPath: vi.fn(),
    openInPlace,
  });
  const overlay = host.querySelector(".file-preview") as HTMLElement;
  const frame = () => overlay.querySelector(".file-preview-frame");
  return {
    preview,
    overlay,
    frame,
    refocus,
    openInPlace,
    contextMenu,
    look: held.of(at).look,
    guides: held.of(at).guides,
    held,
    read,
    section: section?.section,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a file preview's fades", () => {
  it("fades the backdrop in as the file grows to its size, and swaps a step at once", () => {
    const { preview, overlay, frame } = setup();
    preview.show(0);
    expect(runs.map((run) => [run.element, run.keyframes])).toEqual([
      [overlay, [{ opacity: 0 }, { opacity: 1 }]],
      [
        frame(),
        [
          { opacity: 0, transform: "scale(0.95)" },
          { opacity: 1, transform: "none" },
        ],
      ],
    ]);

    preview.key("ArrowRight");
    expect(preview.shownIndex()).toBe(1);
    expect(runs).toHaveLength(2);
  });

  it("closes at once to clicks, keys and focus, and lets the file go once the fade ends", async () => {
    const { preview, overlay, refocus } = setup();
    preview.show(0);
    preview.close();
    expect(preview.shownIndex()).toBeUndefined();
    expect(refocus).toHaveBeenCalledTimes(1);
    expect(overlay.inert).toBe(true);
    expect(overlay.hidden).toBe(false);
    const fades = runs.slice(2);
    expect(fades.map((run) => [run.keyframes, run.options.fill])).toEqual([
      [[{ opacity: 0 }], "forwards"],
      [[{ opacity: 0, transform: "scale(0.95)" }], "forwards"],
    ]);

    for (const fade of fades) fade.finish();
    await settle();
    expect(overlay.hidden).toBe(true);
    expect(overlay.inert).toBe(false);
    expect(overlay.querySelector(".file-preview-frame")).toBeNull();
    expect(fades.every((fade) => fade.cancelled)).toBe(true);
  });

  it("opens fresh over a close still fading", async () => {
    const { preview, overlay } = setup();
    preview.show(0);
    preview.close();
    const fades = runs.slice(2);
    preview.show(1);
    expect(fades.every((fade) => fade.cancelled)).toBe(true);
    expect(overlay.hidden).toBe(false);
    expect(overlay.inert).toBe(false);
    expect(runs.slice(4).map((run) => run.keyframes[0])).toEqual([
      { opacity: 0 },
      { opacity: 0, transform: "scale(0.95)" },
    ]);
    // The cut-short fade ending later hides nothing.
    for (const fade of fades) fade.finish();
    await settle();
    expect(overlay.hidden).toBe(false);
  });

  it("stays instant when the system asks for less motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    const { preview, overlay } = setup();
    preview.show(0);
    preview.close();
    expect(runs).toHaveLength(0);
    expect(overlay.hidden).toBe(true);
  });
});

// A click opens the preview, so the rest of a double-click lands on it.
describe("a double-click on what opened the preview", () => {
  const press = (target: Element, type: string, detail: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));

  it("opens nothing, nor does Enter, where the pane opens nothing in place", () => {
    const { preview, overlay } = setup({ inPlace: false });
    preview.show(0);
    press(overlay, "click", 2);
    press(overlay, "dblclick", 2);
    expect(preview.shownIndex()).toBe(0);
    expect(preview.key("Enter")).toBe(false);
    expect(preview.shownIndex()).toBe(0);
  });

  // jsdom plays no media, so the clip's play, pause and full screen are watched.
  it("never plays, pauses or fills the screen with a clip it lands on, and opens the file", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { preview, overlay, openInPlace } = setup({ files: ["clips/a.mp4"] });
    preview.show(0);
    const video = overlay.querySelector("video") as HTMLVideoElement;
    const frame = video.parentElement as HTMLElement;
    frame.requestFullscreen = vi.fn(async () => undefined);
    pause.mockClear();

    press(video, "click", 2);
    press(video, "dblclick", 2);
    expect([play.mock.calls.length, pause.mock.calls.length]).toEqual([0, 0]);
    expect(frame.requestFullscreen).not.toHaveBeenCalled();
    expect(openInPlace).toHaveBeenCalledWith(0);

    // Begun on the clip, the double-click is the player's.
    press(video, "mousedown", 1);
    press(video, "dblclick", 2);
    expect(frame.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(openInPlace).toHaveBeenCalledTimes(1);
    play.mockRestore();
    pause.mockRestore();
  });

  it("never opens the menu of a ⋮ it lands on", () => {
    const { preview, overlay, contextMenu } = setup();
    preview.show(0);
    const more = overlay.querySelector(".media-hud-more") as HTMLButtonElement;
    press(more, "click", 2);
    expect(contextMenu.opened).toHaveLength(0);
    expect(preview.shownIndex()).toBe(0);

    // Begun on the ⋮, the click is its own.
    press(more, "mousedown", 1);
    press(more, "click", 1);
    expect(contextMenu.opened).toHaveLength(1);
  });

  it("never turns the look of a clip whose LOOK badge it lands on", () => {
    const { preview, overlay, look } = setup({ files: ["clips/a.mp4"] });
    look.set({ lut: "panchromatic", on: true });
    preview.show(0);
    const badge = overlay.querySelector(".media-hud-badge") as HTMLButtonElement;
    press(badge, "click", 2);
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });
  });

  it("never turns the guides whose switch it lands on", () => {
    const { preview, overlay, guides } = setup({ files: ["clips/a.mp4"] });
    guides.set({ ...guides.get(), title: true });
    preview.show(0);
    const toggle = overlay.querySelector(".media-hud-guides") as HTMLButtonElement;
    press(toggle, "click", 2);
    expect(guides.get().shown).toBe(true);
  });
});

// The badge the video tab's overlay holds, over the look every viewer shares.
describe("a previewed clip's or still's LOOK badge", () => {
  it("sits between the dimensions and the frame rate, its click or D turning the look off and on", () => {
    const { preview, overlay, look } = setup({ files: ["clips/a.mp4", "stills/b.svg"] });
    look.set({ lut: "panchromatic", on: true });
    preview.show(0);
    const [bar, ...others] = overlay.querySelectorAll(".media-hud-bar");
    const badge = bar.querySelector("button.media-hud-badge") as HTMLButtonElement;
    expect(others).toHaveLength(0);
    const cell = badge.parentElement as HTMLElement;
    expect([bar.children.length, [...bar.children].indexOf(cell), badge.textContent]).toEqual([3, 1, "LOOK"]);

    badge.click();
    expect(look.get()).toEqual({ lut: "panchromatic", on: false });
    expect(badge.getAttribute("aria-pressed")).toBe("false");
    expect(preview.shownIndex()).toBe(0);
    expect(preview.key("D")).toBe(true);
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });

    // A vector image has no pixels to grade, so no look to turn.
    preview.show(1);
    expect(overlay.querySelector(".media-hud-badge")).toBeNull();
    expect(preview.key("d")).toBe(false);
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });
  });

  it("sits between a still's dimensions and its scale, D turning the look", () => {
    const { preview, overlay, look } = setup();
    look.set({ lut: "orthochromatic", on: true });
    preview.show(0);
    const [top] = overlay.querySelectorAll(".media-hud-bar");
    const badge = top.querySelector("button.media-hud-badge") as HTMLButtonElement;
    const cell = badge.parentElement as HTMLElement;
    expect([top.children.length, [...top.children].indexOf(cell), badge.textContent]).toEqual([3, 1, "LOOK"]);
    expect(preview.key("d")).toBe(true);
    expect(look.get()).toEqual({ lut: "orthochromatic", on: false });
  });

  it("stops following the look once the preview moves on, or closes", async () => {
    const { preview, overlay, look } = setup({ files: ["clips/a.mp4", "clips/b.mp4"] });
    look.set({ lut: "orthochromatic", on: true });
    preview.show(0);
    const first = overlay.querySelector(".media-hud-badge") as HTMLButtonElement;
    preview.show(1);
    const second = overlay.querySelector(".media-hud-badge") as HTMLButtonElement;
    look.set({ lut: "orthochromatic", on: false });
    expect([first.getAttribute("aria-pressed"), second.getAttribute("aria-pressed")]).toEqual(["true", "false"]);

    preview.close();
    for (const run of runs) run.finish();
    await settle();
    look.set({ lut: "orthochromatic", on: true });
    expect(second.getAttribute("aria-pressed")).toBe("false");
  });

  // Each badge's own menu in the ⋮'s place, for the context the pane's tab is seen in.
  it("opens the Looks list at a right-click on it, and the Guides tiles at one on the guides switch", () => {
    const { preview, overlay, look, guides, contextMenu } = setup({ files: ["clips/a.mp4"], at: "projects/film" });
    look.set({ lut: "panchromatic", on: true });
    guides.set({ ...guides.get(), title: true });
    preview.show(0);
    const badge = overlay.querySelector(".media-hud-badge") as HTMLButtonElement;
    const toggle = overlay.querySelector(".media-hud-guides") as HTMLButtonElement;
    for (const target of [badge, toggle]) {
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 9 }));
    }
    expect(contextMenu.opened.map((opened) => [opened.flyoutOf?.label, opened.anchor, opened.arg])).toEqual([
      ["Looks", badge, { context: "projects/film" }],
      ["Guides", toggle, { context: "projects/film" }],
    ]);
  });
});

// Each kind's ways to open its file sit in a ⋮ at the foot of what it
// shows: a clip's in its player, a still's and a page's at the end of the
// bottom bar. Nothing lies over the group's toolbar.
describe("a previewed file's More options", () => {
  const bars = (overlay: HTMLElement) =>
    [...overlay.querySelectorAll(".media-hud-bar")].map((bar) =>
      [...bar.children].map((cell) => (cell.matches(".media-hud-more") ? "⋮" : cell.textContent)),
    );
  // jsdom lays nothing out: the picture decodes at `size`, shown at `shown`.
  function decode(overlay: HTMLElement, shown: [number, number], size: [number, number] = [4000, 3000]) {
    const img = overlay.querySelector(".file-preview-frame img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: size[0] });
    Object.defineProperty(img, "naturalHeight", { value: size[1] });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: shown[0], height: shown[1] }) as DOMRect;
    img.dispatchEvent(new Event("load"));
    return img;
  }

  it("opens the media menu for the clip's file under its player's button", () => {
    const { preview, overlay, contextMenu } = setup({ files: ["clips/a.mp4"], at: "projects/film" });
    preview.show(0);
    const more = overlay.querySelector(".video-player-more") as HTMLButtonElement;
    expect(overlay.querySelector(".media-hud-more")).toBeNull();

    more.click();
    expect(contextMenu.opened).toEqual([
      {
        menu: MEDIA_MENU,
        arg: { file: "clips/a.mp4", bookmark: "clips/a.mp4", context: "projects/film" },
        anchor: more,
        align: "end",
        ariaLabel: "More options",
      },
    ]);
    expect(preview.shownIndex()).toBe(0);
  });

  it("ends a still's bottom bar, after its name, and opens the media menu for the file under it", () => {
    const { preview, overlay, contextMenu } = setup();
    preview.show(0);
    decode(overlay, [600, 450]);
    expect(bars(overlay)).toEqual([
      ["4000 × 3000 (4:3)", "", "15%"],
      ["a.png", "⋮"],
    ]);
    const more = overlay.querySelector(".media-hud-more") as HTMLButtonElement;
    expect([more.tabIndex, more.getAttribute("aria-label")]).toEqual([-1, "More options"]);

    more.click();
    expect(contextMenu.opened).toEqual([
      {
        menu: MEDIA_MENU,
        arg: { file: "stills/a.png", bookmark: "stills/a.png", context: "" },
        anchor: more,
        align: "end",
        ariaLabel: "More options",
      },
    ]);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // A second press closes it, the preview staying.
    more.click();
    expect(contextMenu.isOpen()).toBe(false);
    expect(preview.shownIndex()).toBe(0);

    // The next file's bar has its own, for its own file.
    preview.key("ArrowRight");
    (overlay.querySelector(".media-hud-more") as HTMLButtonElement).click();
    expect(contextMenu.opened.at(-1)?.arg).toEqual({ file: "stills/b.png", bookmark: "stills/b.png", context: "" });
  });

  it("ends a page's bar, after its name and count", async () => {
    const { preview, overlay, contextMenu } = setup({ files: ["notes/a.md"] });
    preview.show(0);
    await settle();
    expect(bars(overlay)).toEqual([["a.md", "", "⋮"]]);
    const hud = overlay.querySelector(".file-preview-document > .media-hud") as HTMLElement;
    expect(hud.hidden).toBe(false);

    (overlay.querySelector(".media-hud-more") as HTMLButtonElement).click();
    expect(contextMenu.opened.at(-1)).toMatchObject({ menu: PREVIEW_PAGE_MENU, arg: { file: "notes/a.md" } });
  });

  it("lays nothing over the group's toolbar: the arrows are the only controls beside the file", () => {
    const { preview, overlay } = setup({ files: ["stills/a.png", "clips/b.mp4", "notes/c.md"] });
    for (const index of [0, 1, 2]) {
      preview.show(index);
      expect([...overlay.children].map((child) => child.className)).toEqual([
        "pane-overlay-nav file-preview-nav is-prev",
        "pane-overlay-stage file-preview-stage",
        "pane-overlay-nav file-preview-nav is-next",
      ]);
    }
  });

  // The facts would cover most of a small picture, so they go, and the ⋮
  // stays: without it, a pane that opens nothing in place couldn't open it.
  it("stays alone on a still too small for its facts, or one that never decodes", () => {
    const { preview, overlay } = setup();
    preview.show(0);
    const hud = overlay.querySelector(".media-hud") as HTMLElement;
    expect(hud.hidden).toBe(true);
    const img = decode(overlay, [180, 135], [180, 135]);
    expect([hud.hidden, hud.classList.contains("is-bare")]).toEqual([false, true]);
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 450 }) as DOMRect;
    preview.fit();
    expect([hud.hidden, hud.classList.contains("is-bare")]).toEqual([false, false]);

    preview.key("ArrowRight");
    const broken = overlay.querySelector(".media-hud") as HTMLElement;
    overlay.querySelector(".file-preview-frame img")?.dispatchEvent(new Event("error"));
    expect([broken.hidden, broken.classList.contains("is-bare")]).toEqual([false, true]);
  });
});

// As the image view's: how big a still is shown against its own pixels, at
// the top bar's right, measured again whenever the preview is fitted.
describe("a previewed still's scale", () => {
  it("follows the picture as a resized pane fits the preview again", () => {
    const { preview, overlay } = setup();
    preview.show(0);
    const img = overlay.querySelector(".file-preview-frame img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 4000 });
    Object.defineProperty(img, "naturalHeight", { value: 3000 });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 450 }) as DOMRect;
    img.dispatchEvent(new Event("load"));
    const topRight = () => overlay.querySelector(".media-hud-bar")?.lastElementChild?.textContent;
    expect(topRight()).toBe("15%");

    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 750 }) as DOMRect;
    preview.fit();
    expect(topRight()).toBe("25%");
  });
});

// The stylesheets lay a still's or a clip's bars in bands of its mat.
describe("a previewed file's bands", () => {
  it("marks a still's frame and a clip's for bands in the mat", () => {
    const { preview, overlay } = setup({ files: ["stills/a.png", "clips/b.mp4"] });
    const hasBands = () => overlay.querySelector(".file-preview-frame")?.classList.contains("has-bands");
    preview.show(0);
    expect(hasBands()).toBe(true);
    preview.show(1);
    expect(hasBands()).toBe(true);
  });
});

// A still shows through the guides and the look every viewer shares, as a
// clip does, laid over it in its own frame; a vector image has no pixels to
// grade. G turns the guides on a still or a clip, never on a page.
describe("a previewed still's guides and look", () => {
  const layerClasses = (overlay: HTMLElement) =>
    [...(overlay.querySelector(".file-preview-frame > .picture-layers")?.children ?? [])].map((layer) =>
      layer.getAttribute("class"),
    );

  it("lays the look and the guides over a raster still, the guides alone over a vector image, and neither over a clip", () => {
    const { preview, overlay } = setup({ files: ["stills/a.png", "stills/b.svg", "clips/c.mp4"] });
    preview.show(0);
    expect(layerClasses(overlay)).toEqual(["video-lut", "video-guides"]);
    preview.show(1);
    expect(layerClasses(overlay)).toEqual(["video-guides"]);
    preview.show(2);
    expect(overlay.querySelector(".picture-layers")).toBeNull();
  });

  it("sizes the guides to the decoded still", () => {
    const { preview, overlay, guides } = setup();
    guides.set({ ...guides.get(), frames: ["9:16"] });
    preview.show(0);
    const img = overlay.querySelector(".file-preview-frame img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1600 });
    Object.defineProperty(img, "naturalHeight", { value: 1000 });
    img.dispatchEvent(new Event("load"));
    expect(overlay.querySelector(".video-guides-lines")?.getAttribute("viewBox")).toBe("0 0 1600 1000");
  });

  it("turns the guides with G on a still or a clip, never on a page", () => {
    const { preview, guides } = setup({ files: ["stills/a.png", "clips/b.mp4", "notes/c.md"] });
    preview.show(0);
    expect(preview.key("g")).toBe(true);
    expect(guides.get().shown).toBe(false);
    preview.show(1);
    expect(preview.key("G")).toBe(true);
    expect(guides.get().shown).toBe(true);
    preview.show(2);
    expect(preview.key("g")).toBe(false);
    expect(guides.get().shown).toBe(true);
  });

  it("holds a guides switch before any LOOK, on a still, a clip or a vector image, its click turning them in place", () => {
    const { preview, overlay, guides } = setup({ files: ["stills/a.png", "clips/b.mp4", "stills/c.svg"] });
    guides.set({ ...guides.get(), title: true });
    const cell = () => overlay.querySelector(".media-hud-bar > .media-hud-badges") as HTMLElement;
    const parts = () => [...cell().children].map((child) => (child.matches(".media-hud-guides") ? "guides" : "look"));
    preview.show(0);
    expect(parts()).toEqual(["guides", "look"]);
    preview.show(1);
    expect(parts()).toEqual(["guides", "look"]);
    preview.show(2);
    expect(parts()).toEqual(["guides"]);

    (cell().querySelector("button.media-hud-guides") as HTMLButtonElement).click();
    expect(guides.get().shown).toBe(false);
    expect(preview.shownIndex()).toBe(2);
  });
});

// A previewed still keeps its own drag, whose copy of its bytes an app
// outside Pragma takes, and carries its file beside it.
describe("a previewed still's drag", () => {
  it("carries its file from the picture itself", () => {
    const { preview, frame } = setup();
    preview.show(0);
    const img = (frame() as HTMLElement).querySelector("img") as HTMLImageElement;
    expect(img.draggable).toBe(true);
    expect([...fireDrag(img, "dragstart")]).toEqual([
      ["text/plain", "stills/a.png"],
      [DRAGGED_ENTRY_TYPE, "file"],
    ]);
  });
});

// A pane with no selection of its own hands the preview its Info section,
// which then names the file shown as the gallery names its selected entry.
describe("a previewed file's Info section", () => {
  const rows = (section: HTMLElement | undefined) =>
    Object.fromEntries(
      [...(section?.querySelectorAll(".meta-row") ?? [])].map((row) => [
        row.querySelector(".meta-key")?.textContent,
        row.querySelector(".meta-value")?.textContent,
      ]),
    );
  const title = (section: HTMLElement | undefined) => section?.querySelector(".inspector-section-title")?.textContent;
  const changed = dateTimeLabel("2026-11-01T09:30:00.000Z");

  it("follows the file shown, from what showing it teaches and what it reads, and hides once the preview closes", async () => {
    const { preview, overlay, section } = setup({ files: ["stills/a.png", "clips/b.mp4"], details: true });
    expect(section?.hidden).toBe(true);

    preview.show(0);
    expect([section?.hidden, title(section)]).toEqual([false, "Selected Image"]);
    expect(rows(section)).toEqual({ Name: "a.png", "Color mode": "…", "Bit depth": "…" });
    const img = overlay.querySelector(".file-preview-frame img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 4000 });
    Object.defineProperty(img, "naturalHeight", { value: 3000 });
    img.dispatchEvent(new Event("load"));
    await settle();
    expect(rows(section)).toEqual({
      Name: "a.png",
      Dimensions: "4000 × 3000px (4:3)",
      "Color mode": "RGB",
      "Bit depth": "8 bits per channel",
      Size: "2.0 KB",
      Modified: changed,
    });

    // jsdom decodes no clip, so its header's size and length stand in.
    preview.key("ArrowRight");
    await settle();
    expect(title(section)).toBe("Selected Video");
    expect(rows(section)).toEqual({
      Name: "b.mp4",
      Dimensions: "1920 × 1080px (16:9)",
      Duration: "0:12",
      "Frame rate": "24 fps",
      Codec: "H.264",
      "Bit depth": "8 bits per channel",
      "Dynamic range": "SDR",
      Audio: "AAC, 2 channels",
      Size: "2.0 KB",
      Modified: changed,
    });

    preview.close();
    expect(section?.hidden).toBe(true);
  });

  it("takes nothing from a file stepped past that finishes loading late", async () => {
    const answers = new Map<string, (size: number) => void>();
    const { preview, overlay, section } = setup({
      details: true,
      sources: (held) => ({
        ...testPreviewSources(held),
        fileInfo: vi.fn(
          (path: string) =>
            new Promise<FileInfoResponse>((resolve) =>
              answers.set(path, (size) =>
                resolve({ kind: "file", name: path, size, modified: "2026-11-01T09:30:00.000Z" }),
              ),
            ),
        ),
      }),
    });
    preview.show(0);
    const first = overlay.querySelector(".file-preview-frame img") as HTMLImageElement;
    preview.key("ArrowRight");
    Object.defineProperty(first, "naturalWidth", { value: 4000 });
    Object.defineProperty(first, "naturalHeight", { value: 3000 });
    first.dispatchEvent(new Event("load"));
    answers.get("stills/a.png")?.(9_000_000);
    await settle();
    expect(rows(section)).toEqual({ Name: "b.png", "Color mode": "RGB", "Bit depth": "8 bits per channel" });

    answers.get("stills/b.png")?.(2048);
    await settle();
    expect(rows(section)).toMatchObject({ Name: "b.png", Size: "2.0 KB" });
  });

  it("reads nothing for it where the pane shows its own selection", async () => {
    const { preview, read } = setup({ files: ["stills/a.png", "clips/b.mp4"] });
    preview.show(0);
    preview.key("ArrowRight");
    await settle();
    expect(read.fileInfo).not.toHaveBeenCalled();
    expect(read.pixelFormat).not.toHaveBeenCalled();
  });
});

describe("a right-click on previewed media", () => {
  const rightClick = (target: Element, init: MouseEventInit = {}) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 70,
      clientY: 90,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };

  it("opens a still's or a clip's ⋮ menu where it lands, and leaves its mat, bars and controls and a page's text alone", () => {
    const { preview, overlay, contextMenu } = setup({ files: ["stills/a.png", "clips/b.mp4", "notes/c.md"] });
    preview.show(0);
    rightClick(overlay.querySelector(".file-preview-frame img") as Element);
    expect(contextMenu.opened.at(-1)).toMatchObject({
      menu: MEDIA_MENU,
      at: { x: 70, y: 90 },
      anchor: overlay.querySelector(".media-hud-more"),
    });
    let opened = contextMenu.opened.length;
    const onMat = rightClick(overlay.querySelector(".file-preview-frame") as Element);
    const onBar = rightClick(overlay.querySelector(".file-preview-frame .media-hud-bar") as Element);
    expect([contextMenu.opened.length, onMat.defaultPrevented, onBar.defaultPrevented]).toEqual([opened, false, false]);
    preview.show(1);
    rightClick(overlay.querySelector(".file-preview-frame video") as Element);
    expect(contextMenu.opened.at(-1)).toMatchObject({ anchor: overlay.querySelector(".video-player-more") });
    opened = contextMenu.opened.length;
    const onControls = rightClick(overlay.querySelector(".file-preview-frame .video-player-bar") as Element);
    expect([contextMenu.opened.length, onControls.defaultPrevented]).toEqual([opened, false]);
    preview.show(2);
    const onPage = rightClick(overlay.querySelector(".file-preview-document") as Element);
    expect([contextMenu.opened.length, onPage.defaultPrevented]).toEqual([opened, false]);
  });

  // The host holds focus while a preview shows, so the menu key's lands there.
  it("opens it at the media's centre for the menu key", () => {
    const { preview, overlay, contextMenu } = setup();
    preview.show(0);
    (overlay.querySelector(".file-preview-frame img") as HTMLElement).getBoundingClientRect = () =>
      new DOMRect(100, 50, 600, 400);
    rightClick(overlay.parentElement as HTMLElement, { button: -1 });
    expect(contextMenu.opened.at(-1)?.at).toEqual({ x: 400, y: 250 });
  });
});
