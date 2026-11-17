// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileResponse } from "../../web/core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE } from "../../web/core/paths.ts";
import { createFilePreview, PREVIEW_CLIP_MENU } from "../../web/filePreview.ts";
import { createDialogService } from "../../web/services/dialog.ts";
import { createFormats } from "../../web/services/formats.ts";
import { fireDrag } from "./support/drag.ts";
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

// `inPlace` false is a pane that opens nothing in place.
function setup({ files = STILLS, inPlace = true } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const refocus = vi.fn();
  const openInPlace = inPlace ? vi.fn() : undefined;
  const contextMenu = { open: vi.fn(), close: vi.fn(), isOpen: () => false };
  const sources = testPreviewSources();
  const preview = createFilePreview({
    ...sources,
    host,
    refocus,
    count: () => files.length,
    fileAt: (index) => (files[index] ? { path: files[index], name: files[index].slice(7) } : undefined),
    loadFile: vi.fn(async (): Promise<FileResponse> => ({ kind: "missing" }) as unknown as FileResponse),
    formats: createFormats(),
    contextMenu,
    dialog: createDialogService(),
    openPath: vi.fn(),
    openBeside: vi.fn(),
    openInPlace,
  });
  const overlay = host.querySelector(".file-preview") as HTMLElement;
  const frame = () => overlay.querySelector(".file-preview-frame");
  return { preview, overlay, frame, refocus, openInPlace, contextMenu, look: sources.videoLut };
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

  it("never turns the look of a clip whose LOOK badge it lands on", () => {
    const { preview, overlay, look } = setup({ files: ["clips/a.mp4"] });
    look.set({ lut: "panchromatic", on: true });
    preview.show(0);
    const badge = overlay.querySelector(".media-hud-badge") as HTMLButtonElement;
    press(badge, "click", 2);
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });
  });
});

// The badge the video tab's overlay holds, over the look every player shares.
describe("a previewed clip's LOOK badge", () => {
  it("sits between the dimensions and the frame rate, its click or D turning the look off and on", () => {
    const { preview, overlay, look } = setup({ files: ["clips/a.mp4", "stills/b.png"] });
    look.set({ lut: "panchromatic", on: true });
    preview.show(0);
    const [bar, ...others] = overlay.querySelectorAll(".media-hud-bar");
    const badge = bar.querySelector("button.media-hud-badge") as HTMLButtonElement;
    expect(others).toHaveLength(0);
    expect([bar.children.length, [...bar.children].indexOf(badge), badge.textContent]).toEqual([3, 1, "LOOK"]);

    badge.click();
    expect(look.get()).toEqual({ lut: "panchromatic", on: false });
    expect(badge.getAttribute("aria-pressed")).toBe("false");
    expect(preview.shownIndex()).toBe(0);
    expect(preview.key("D")).toBe(true);
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });

    // A still has no look to turn.
    preview.show(1);
    expect(overlay.querySelector(".media-hud-badge")).toBeNull();
    expect(preview.key("d")).toBe(false);
    expect(look.get()).toEqual({ lut: "panchromatic", on: true });
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
});

// The clip's own menu adds the ways to open it, as the toolbar's open
// button's menu offers them, before its bookmark.
describe("a previewed clip's More options", () => {
  it("opens the preview's clip menu for the clip's file under its button", () => {
    const { preview, overlay, contextMenu } = setup({ files: ["clips/a.mp4"] });
    preview.show(0);
    const more = overlay.querySelector(".video-player-more") as HTMLButtonElement;

    more.click();
    expect(contextMenu.open).toHaveBeenCalledWith({
      menu: PREVIEW_CLIP_MENU,
      arg: { file: "clips/a.mp4", bookmark: "clips/a.mp4" },
      anchor: more,
      align: "end",
      ariaLabel: "More options",
    });
    expect(preview.shownIndex()).toBe(0);
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
