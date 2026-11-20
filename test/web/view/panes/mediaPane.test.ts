// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipHeaderResponse, PixelFormatResponse } from "../../../../web/core/apiClient.ts";
import { DRAGGED_ENTRY_TYPE } from "../../../../web/core/paths.ts";
import { NO_GUIDES } from "../../../../web/lib/videoGuides.ts";
import { NO_LOOK } from "../../../../web/lib/videoLut.ts";
import type { EditorPane } from "../../../../web/services/editorPanes.ts";
import { MEDIA_MENU } from "../../../../web/services/videoMenu.ts";
import { createImagePane, createVideoPane, imagePane, videoPane } from "../../../../web/view/panes/mediaPane.ts";
import { fireDrag } from "../../support/drag.ts";
import { memoryLook, memorySetting } from "../../support/editorLayout.ts";
import { fakeContextMenu } from "../../support/fakeContextMenu.ts";
import { fakePaneGroup } from "../../support/paneGroup.ts";

// jsdom lays nothing out, so there is no resize to observe; a picture's
// shown size is stubbed in below.
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom decodes nothing: a picture counts as decoded once it has loaded.
HTMLImageElement.prototype.decode ??= () => Promise.resolve();

// The raw route's answer to a HEAD: its Content-Length is the file's size.
const sized = async () => ({ ok: true, headers: new Headers({ "content-length": "86016" }) }) as Response;

// The server's reading of the file's header.
const rgba8 = async (): Promise<PixelFormatResponse> => ({
  colorModel: "rgb",
  alpha: true,
  bitDepth: 8,
  sourceType: null,
});

// The raw route's answer to a GET of an SVG that sets no size of its own.
const unsizedSvg = async () =>
  new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-130 -130 2412 1137.4"><path d="M0 0h1v1z"/></svg>');

function setup(
  head: (path: string) => Promise<Response> = sized,
  format: (path: string) => Promise<PixelFormatResponse> = rgba8,
  file: (path: string) => Promise<Response> = unsizedSvg,
) {
  const headFile = vi.fn(head);
  const pixelFormat = vi.fn(format);
  const fetchFile = vi.fn(file);
  const guides = memorySetting(NO_GUIDES);
  const lut = memoryLook();
  const contextMenu = fakeContextMenu();
  const pane = createImagePane({
    rawFileUrl: (path) => `/raw?path=${path}`,
    headFile,
    pixelFormat,
    fetchFile,
    guides,
    lut,
    contextMenu,
  });
  document.body.append(pane.element);
  return { pane, headFile, pixelFormat, fetchFile, guides, lut, contextMenu };
}

// Lets every lookup the open started settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// What a decoded, laid-out picture reports: jsdom produces none of it.
// Fractional on purpose, as a centred picture shrunk to fit usually is.
function describeDecoded(img: HTMLImageElement, natural: [number, number], shown: [number, number]): void {
  Object.defineProperty(img, "naturalWidth", { value: natural[0], configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: natural[1], configurable: true });
  describeShown(img, shown);
  img.dispatchEvent(new Event("load"));
}

// jsdom loads nothing, so the test says when the picture has, and how its
// decode ends.
async function loadAndDecode(img: HTMLImageElement, decoded: Promise<void> = Promise.resolve()): Promise<void> {
  img.decode = () => decoded;
  img.dispatchEvent(new Event("load"));
  await settle();
}

function describeShown(img: HTMLImageElement, [width, height]: [number, number], left = 40.5, top = 24.25): void {
  img.getBoundingClientRect = () => ({ left, top, width, height }) as DOMRect;
}

function hudText(pane: EditorPane): string[] {
  return [...pane.element.querySelectorAll(".media-hud-bar")].map((bar) =>
    [...bar.children].map((cell) => cell.textContent).join(" | "),
  );
}

const current = { isCurrent: () => true };
const tab = { kind: "image" as const, path: "art/cover.png" };

function details(pane: EditorPane): HTMLElement {
  if (!pane.inspector) throw new Error("the pane has no Info-tab section");
  return pane.inspector;
}

function rows(pane: EditorPane): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of details(pane).querySelectorAll(".meta-row")) {
    const key = row.querySelector(".meta-key")?.textContent ?? "";
    out[key] = row.querySelector(".meta-value")?.textContent ?? "";
  }
  return out;
}

describe("imagePane", () => {
  it("describes an image pane with no title bar", () => {
    const descriptor = imagePane(fakeContextMenu());
    expect(descriptor.kind).toBe("image");
    const pane = descriptor.create(fakePaneGroup());
    expect(pane.title()).toBeUndefined();
    expect(pane.titleHost).toBeUndefined();
  });

  // Size, modified time and SHA-256 are the Info tab's own facts, for every
  // kind; the pane adds only what the loaded bytes can answer.
  it("shows the image, with its details in the Info-tab section", async () => {
    const { pane, headFile, pixelFormat } = setup(sized, () => new Promise(() => {}));
    expect(details(pane).hidden).toBe(true);
    await pane.setInput(tab, current);

    expect(pane.element.classList.contains("editor-image")).toBe(true);
    expect(pane.element.querySelector(".meta-rows")).toBeNull();
    const img = pane.element.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/raw?path=art/cover.png");
    expect(img?.alt).toBe("cover.png");
    expect(details(pane).hidden).toBe(false);
    expect(details(pane).querySelector(".inspector-section-title")?.textContent).toBe("Image");
    expect(rows(pane)).toEqual({ Dimensions: "…", "Color mode": "…", "Bit depth": "…" });
    expect(headFile).toHaveBeenCalledWith("art/cover.png"); // for the overlay's size
    expect(pixelFormat).toHaveBeenCalledWith("art/cover.png");

    img?.dispatchEvent(new Event("load"));
    expect(rows(pane).Dimensions).toBe("0 × 0px"); // jsdom decodes nothing; the wiring is what's under test
  });

  it("writes nothing once the open went stale", async () => {
    const { pane } = setup();
    await pane.setInput(tab, { isCurrent: () => false });
    pane.element.querySelector("img")?.dispatchEvent(new Event("load"));
    await settle();
    expect(rows(pane)).toEqual({ Dimensions: "…", "Color mode": "…", "Bit depth": "…" });
    expect(hudText(pane)).toEqual([" |  |  | ", "cover.png |  | "]);
  });

  it("lays name, size, dimensions, color mode, scale and the ⋮ over the picture, in its own frame", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    await settle();

    const img = pane.element.querySelector("img") as HTMLImageElement;
    // The overlay follows the picture in the frame they share, never placed
    // by measuring it.
    const hud = img.nextElementSibling as HTMLElement;
    expect(img.parentElement?.className).toBe("media-frame editor-image-frame");
    expect(hud.className).toBe("media-hud");
    expect(hud.hidden).toBe(true);

    describeDecoded(img, [600, 800], [450.5, 600.75]);
    expect(hud.hidden).toBe(false);
    expect(hudText(pane)).toEqual(["600 × 800 (3:4) | 75% |  | RGBA 8-bit", "cover.png | 84 KB | "]);
    expect(hud.querySelector(".media-hud-bar:last-child > :last-child")?.getAttribute("aria-label")).toBe(
      "More options",
    );
    expect(hud.getAttribute("style")).toBeNull();
  });

  // A thumbnail-sized picture would be all bar, so only its ⋮ stays.
  it("keeps only the ⋮ on a picture too small to carry the bars", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const img = pane.element.querySelector("img") as HTMLImageElement;
    describeDecoded(img, [32, 32], [32, 32]);
    const hud = pane.element.querySelector(".media-hud") as HTMLElement;
    expect([hud.hidden, hud.classList.contains("is-bare")]).toEqual([false, true]);
  });

  it("leaves the size out when the lookup fails", async () => {
    const { pane } = setup(async () => Promise.reject(new Error("offline")));
    await pane.setInput(tab, current);
    await settle();
    describeDecoded(pane.element.querySelector("img") as HTMLImageElement, [600, 800], [600, 800]);
    expect(hudText(pane)).toEqual(["600 × 800 (3:4) | 100% |  | RGBA 8-bit", "cover.png |  | "]);
  });

  // As the video tab shows a clip, through the guides and the look every
  // viewer shares; a vector image has no pixels to grade.
  it("lays the guides over the picture, and its look where it has pixels", async () => {
    const { pane, lut } = setup();
    lut.set({ lut: "panchromatic", on: true });
    await pane.setInput(tab, current);
    const frame = pane.element.querySelector(".editor-image-frame") as HTMLElement;
    expect([...frame.children].map((child) => child.className.toString())).toEqual(["", "media-hud", "picture-layers"]);
    const layers = frame.querySelector(".picture-layers") as HTMLElement;
    expect([...layers.children].map((child) => child.getAttribute("class"))).toEqual(["video-lut", "video-guides"]);
    const badge = pane.element.querySelector(".media-hud-badge") as HTMLElement;
    expect([badge.textContent, badge.hidden]).toEqual(["LOOK", false]);

    await pane.setInput({ kind: "image", path: "art/logo.svg" }, current);
    const vector = pane.element.querySelector(".picture-layers") as HTMLElement;
    expect([...vector.children].map((child) => child.getAttribute("class"))).toEqual(["video-guides"]);
    expect((pane.element.querySelector(".media-hud-badge") as HTMLElement).hidden).toBe(true);
  });

  it("turns the guides with G and the look with D while it holds focus, and no look on a vector image", async () => {
    const { pane, guides, lut } = setup();
    lut.set({ lut: "orthochromatic", on: true });
    await pane.setInput(tab, current);
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", { key, cancelable: true });
      pane.element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    pane.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(pane.element);

    expect(press("g")).toBe(true);
    expect(guides.get().shown).toBe(false);
    expect(press("D")).toBe(true);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: false });

    await pane.setInput({ kind: "image", path: "art/logo.svg" }, current);
    expect(press("d")).toBe(false);
    expect(lut.get()).toEqual({ lut: "orthochromatic", on: false });
    expect(press("G")).toBe(true);
    expect(guides.get().shown).toBe(true);
  });

  // The menu every media file's ⋮ opens, which knows its own tab.
  it("opens the file's media menu from the ⋮ that ends its bottom bar", async () => {
    const { pane, contextMenu } = setup();
    await pane.setInput(tab, current);
    const more = pane.element.querySelector(".media-hud-bar:last-child > .media-hud-more") as HTMLButtonElement;
    expect(more.tabIndex).toBe(-1);
    more.click();
    expect(contextMenu.opened).toEqual([
      {
        menu: MEDIA_MENU,
        arg: { file: "art/cover.png", bookmark: "art/cover.png" },
        anchor: more,
        align: "end",
        ariaLabel: "More options",
      },
    ]);
  });

  it.each([
    [{ colorModel: "rgb", alpha: false, bitDepth: 16, sourceType: null }, "RGB", "16 bits per channel", "RGB 16-bit"],
    [{ colorModel: "cmyk", alpha: false, bitDepth: 8, sourceType: null }, "CMYK", "8 bits per channel", "CMYK 8-bit"],
    [
      { colorModel: "grayscale", alpha: true, bitDepth: 8, sourceType: null },
      "Grayscale + alpha",
      "8 bits per channel",
      "Grayscale + alpha 8-bit",
    ],
    // A palette's depth is its index's: one per pixel, not per channel.
    [
      { colorModel: "indexed", alpha: false, bitDepth: 1, sourceType: null },
      "Indexed",
      "1 bit per pixel",
      "Indexed 1-bit",
    ],
  ] as const)("names %o the way an image editor's Mode menu does", async (format, mode, depth, overlay) => {
    const { pane } = setup(sized, async () => format);
    await pane.setInput(tab, current);
    await settle();
    expect(rows(pane)).toMatchObject({ "Color mode": mode, "Bit depth": depth });
    expect(pane.element.querySelectorAll(".media-hud-bar span")[2].textContent).toBe(overlay);
  });

  it("names a picture's source from the IPTC source type its header declares, and none without one", async () => {
    const made = setup(sized, async () => ({ ...(await rgba8()), sourceType: "trainedAlgorithmicMedia" }));
    await made.pane.setInput(tab, current);
    await settle();
    expect(rows(made.pane)).toMatchObject({ Source: "Made by AI" });

    const plain = setup(sized, rgba8);
    await plain.pane.setInput(tab, current);
    await settle();
    expect(Object.keys(rows(plain.pane))).not.toContain("Source");
  });

  it("shows the color rows as Unknown when the header can't be read", async () => {
    const { pane } = setup(sized, async () => Promise.reject(new Error("422")));
    await pane.setInput(tab, current);
    await settle();
    expect(rows(pane)).toMatchObject({ "Color mode": "Unknown", "Bit depth": "Unknown" });
    expect(hudText(pane)[0]).toBe(" |  |  | ");
  });

  // A vector has no pixel format to read.
  it("asks nothing of an SVG's header and gives it no color rows", async () => {
    const { pane, pixelFormat } = setup();
    await pane.setInput({ kind: "image", path: "art/logo.svg" }, current);
    await settle();
    expect(rows(pane)).toEqual({ Dimensions: "…" });
    expect(pixelFormat).not.toHaveBeenCalled();
  });

  // With no size of its own, the picture has nothing for its frame to hug
  // and would show at nothing; the browser decodes it at a default 300 wide.
  it("shows and describes an SVG that sets no size at its viewBox's extent", async () => {
    const { pane, fetchFile } = setup();
    await pane.setInput({ kind: "image", path: "art/logo.svg" }, current);
    await settle();
    expect(fetchFile).toHaveBeenCalledWith("art/logo.svg");
    const img = pane.element.querySelector("img") as HTMLImageElement;
    expect(img.classList.contains("is-unsized")).toBe(true);
    expect(img.style.getPropertyValue("--svg-width")).toBe("2412px");

    describeDecoded(img, [300, 141], [651.5, 307.25]);
    await settle();
    expect(rows(pane)).toEqual({ Dimensions: "2412 × 1137px (2.12:1)" });
    expect(hudText(pane)[0]).toBe("2412 × 1137 (2.12:1) | 27% |  | ");
    expect(pane.element.className).toBe("editor-image is-zoomable");
  });

  it("heads an SVG's section as a vector image, and the next PNG's as an image", async () => {
    const { pane } = setup();
    const title = () => details(pane).querySelector(".inspector-section-title")?.textContent;
    await pane.setInput({ kind: "image", path: "art/logo.svg" }, current);
    expect(title()).toBe("Vector image");
    await pane.setInput(tab, current);
    expect(title()).toBe("Image");
  });

  it("describes an SVG that sets its own size by that size", async () => {
    const own = async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"/>');
    const { pane } = setup(sized, rgba8, own);
    await pane.setInput({ kind: "image", path: "art/logo.svg" }, current);
    await settle();
    const img = pane.element.querySelector("img") as HTMLImageElement;
    expect(img.classList.contains("is-unsized")).toBe(false);
    describeDecoded(img, [120, 60], [120, 60]);
    await settle();
    expect(rows(pane)).toEqual({ Dimensions: "120 × 60px (2:1)" });
  });

  it("reads a raster image's own size, never its text", async () => {
    const { pane, fetchFile } = setup();
    await pane.setInput(tab, current);
    describeDecoded(pane.element.querySelector("img") as HTMLImageElement, [600, 800], [450, 600]);
    expect(rows(pane).Dimensions).toBe("600 × 800px (3:4)");
    expect(fetchFile).not.toHaveBeenCalled();
  });

  // Drawn sooner, the board would flash in the picture's box before its
  // pixels, and stay until an opaque picture covered it.
  it("puts a decoded SVG or PNG on the checkerboard, and no other picture", async () => {
    const { pane } = setup();
    const paths = { "art/logo.svg": true, "art/cover.png": true, "art/photo.jpg": false, "art/loop.gif": false };
    for (const [path, checkered] of Object.entries(paths)) {
      await pane.setInput({ kind: "image", path }, current);
      const img = pane.element.querySelector("img") as HTMLImageElement;
      expect(img.classList.contains("shows-transparency"), `${path} before it loads`).toBe(false);
      await loadAndDecode(img);
      expect(img.classList.contains("shows-transparency"), path).toBe(checkered);
    }

    await pane.setInput({ kind: "image", path: "art/broken.png" }, current);
    const broken = pane.element.querySelector("img") as HTMLImageElement;
    await loadAndDecode(broken, Promise.reject(new Error("The source image cannot be decoded.")));
    expect(broken.classList.contains("shows-transparency")).toBe(false);
  });

  it("shows a shrunk picture at actual size on a click, and fits it again on the next", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    await settle();
    const img = pane.element.querySelector("img") as HTMLImageElement;
    describeDecoded(img, [600, 800], [450, 600]);
    expect(pane.element.className).toBe("editor-image is-zoomable");

    describeShown(img, [600, 800]);
    img.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100 }));
    expect(pane.element.className).toBe("editor-image is-actual-size");
    expect(hudText(pane)[0]).toBe("600 × 800 (3:4) | 100% |  | RGBA 8-bit");

    describeShown(img, [450, 600]);
    img.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100 }));
    expect(pane.element.className).toBe("editor-image is-zoomable");
    expect(hudText(pane)[0]).toBe("600 × 800 (3:4) | 75% |  | RGBA 8-bit");
  });

  it("leaves a picture already at 100% or more as it is on a click", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const img = pane.element.querySelector("img") as HTMLImageElement;
    describeDecoded(img, [300, 200], [300, 200]);
    img.dispatchEvent(new MouseEvent("click"));
    expect(pane.element.className).toBe("editor-image");
  });

  it("measures the picture again as the pointer arrives, for its scale and room for the bars", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    await settle();
    const img = pane.element.querySelector("img") as HTMLImageElement;
    const hud = img.nextElementSibling as HTMLElement;
    describeDecoded(img, [600, 800], [450, 600]);
    describeShown(img, [453, 604], 38);
    img.dispatchEvent(new Event("pointerenter"));
    expect(hudText(pane)[0]).toBe("600 × 800 (3:4) | 76% |  | RGBA 8-bit");
    describeShown(img, [150, 200]);
    img.dispatchEvent(new Event("pointerenter"));
    expect([hud.hidden, hud.classList.contains("is-bare")]).toEqual([false, true]);
  });

  // At actual size the picture overflows the scroller; the bars stick to its
  // edges by CSS, from the picture's own frame.
  it("keeps the overlay in the picture's frame at actual size", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const img = pane.element.querySelector("img") as HTMLImageElement;
    describeDecoded(img, [2400, 1600], [700, 466]);
    describeShown(img, [2400, 1600], -300, -200);
    img.dispatchEvent(new MouseEvent("click", { clientX: 400, clientY: 300 }));
    expect(pane.element.className).toBe("editor-image is-actual-size");
    const hud = img.nextElementSibling as HTMLElement;
    expect([hud.className, hud.hidden, hud.getAttribute("style")]).toEqual(["media-hud", false, null]);
  });

  it("moves a picture at actual size by a drag, which leaves it at actual size", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const img = pane.element.querySelector("img") as HTMLImageElement;
    const scroller = pane.element.querySelector(".editor-image-scroller") as HTMLElement;
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
          clientX: x,
          clientY: y,
        }),
      );
    const drag = (from: Element) => {
      pointer("pointerdown", from, 400, 300);
      pointer("pointermove", window, 340, 280);
      pointer("pointerup", window, 340, 280);
    };
    describeDecoded(img, [2400, 1600], [700, 466]);

    drag(img);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([0, 0]);

    img.dispatchEvent(new MouseEvent("click", { clientX: 400, clientY: 300 }));
    scroller.scrollLeft = 500;
    scroller.scrollTop = 300;
    // The margin around the picture isn't the picture.
    drag(scroller);
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([500, 300]);
    drag(img);
    img.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 340, clientY: 280 }));
    expect([scroller.scrollLeft, scroller.scrollTop]).toEqual([560, 320]);
    expect(pane.element.className).toBe("editor-image is-actual-size");

    await settle();
    img.dispatchEvent(new MouseEvent("click", { clientX: 340, clientY: 280 }));
    expect(pane.element.classList.contains("is-actual-size")).toBe(false);
  });

  it("drags a fitted picture as its file, and leaves one at actual size to the pan", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const img = pane.element.querySelector("img") as HTMLImageElement;
    describeDecoded(img, [2400, 1600], [700, 466]);
    expect([...fireDrag(img, "dragstart")]).toEqual([
      ["text/plain", "art/cover.png"],
      [DRAGGED_ENTRY_TYPE, "file"],
    ]);

    img.dispatchEvent(new MouseEvent("click", { clientX: 400, clientY: 300 }));
    expect(pane.element.classList.contains("is-actual-size")).toBe(true);
    expect(fireDrag(img, "dragstart").size).toBe(0);
  });

  it("opens the next image fitted", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const img = pane.element.querySelector("img") as HTMLImageElement;
    describeDecoded(img, [600, 800], [450, 600]);
    img.dispatchEvent(new MouseEvent("click"));
    await pane.setInput({ kind: "image", path: "art/back.png" }, current);
    expect(pane.element.classList.contains("is-actual-size")).toBe(false);
  });

  describe("with motion", () => {
    // jsdom runs no animations: each one started is kept, and the test says
    // when it finishes.
    function animated(img: HTMLImageElement) {
      const runs: { keyframes: Keyframe[]; finish(): void }[] = [];
      img.animate = ((keyframes: Keyframe[]) => {
        let finish = () => {};
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        runs.push({ keyframes, finish });
        return { finished, cancel: () => {} } as unknown as Animation;
      }) as HTMLElement["animate"];
      return runs;
    }

    // A 2400 × 1600 picture fitted at a quarter of its size; at actual size,
    // laid out from (-300, -200) as the scroll leaves it.
    async function zoomable() {
      const { pane } = setup();
      await pane.setInput(tab, current);
      const img = pane.element.querySelector("img") as HTMLImageElement;
      describeDecoded(img, [2400, 1600], [600, 400]);
      const atActualSize = () => pane.element.classList.contains("is-actual-size");
      img.getBoundingClientRect = () =>
        (atActualSize()
          ? { left: -300, top: -200, width: 2400, height: 1600 }
          : { left: 40, top: 24, width: 600, height: 400 }) as DOMRect;
      const layers = pane.element.querySelector(".picture-layers") as HTMLImageElement;
      return { pane, img, runs: animated(img), layerRuns: animated(layers) };
    }

    it("runs a zoom from the picture as it was shown, its overlay waiting and its guides and look riding along", async () => {
      const { pane, img, runs, layerRuns } = await zoomable();
      img.dispatchEvent(new MouseEvent("click", { clientX: 190, clientY: 224 }));
      expect(pane.element.className).toBe("editor-image is-zooming is-actual-size");
      expect(runs[0].keyframes[0]).toEqual({
        transform: "translate(340px, 224px) scale(0.25)",
        transformOrigin: "0 0",
      });
      expect(layerRuns.map((run) => run.keyframes)).toEqual([runs[0].keyframes]);
      runs[0].finish();
      await settle();
      expect(pane.element.className).toBe("editor-image is-actual-size");
      expect(hudText(pane)[0]).toBe("2400 × 1600 (3:2) | 100% |  | RGBA 8-bit");

      img.dispatchEvent(new MouseEvent("click"));
      expect(pane.element.className).toBe("editor-image is-zooming");
      expect(runs[1].keyframes[0]).toEqual({ transform: "translate(-340px, -224px) scale(4)", transformOrigin: "0 0" });
      runs[1].finish();
      await settle();
      expect(pane.element.className).toBe("editor-image is-zoomable");
    });

    // A click acts on the picture as it will stand.
    it("ends a zoom still running before the next click acts", async () => {
      const { pane, img, runs } = await zoomable();
      img.dispatchEvent(new MouseEvent("click"));
      img.dispatchEvent(new MouseEvent("click"));
      expect(pane.element.className).toBe("editor-image is-zooming");
      expect(runs).toHaveLength(2);
      await pane.setInput({ kind: "image", path: "art/back.png" }, current);
      expect(pane.element.className).toBe("editor-image");
    });

    it("moves nothing by a drag while a zoom runs", async () => {
      const { pane, img } = await zoomable();
      const scroller = pane.element.querySelector(".editor-image-scroller") as HTMLElement;
      img.dispatchEvent(new MouseEvent("click"));
      const before = [scroller.scrollLeft, scroller.scrollTop];
      for (const [type, target, x] of [
        ["pointerdown", img, 400],
        ["pointermove", window, 300],
        ["pointerup", window, 300],
      ] as const) {
        target.dispatchEvent(
          new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, pointerType: "mouse", clientX: x }),
        );
      }
      expect([scroller.scrollLeft, scroller.scrollTop]).toEqual(before);
    });
  });

  it("clearInput() empties the pane and hides its section", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    pane.clearInput();
    expect(pane.element.childElementCount).toBe(0);
    expect(details(pane).hidden).toBe(true);
    expect(rows(pane)).toEqual({});
  });
});

// jsdom ships no media pipeline: load() and pause() report "not
// implemented", and nothing ever fills videoWidth or duration. The wiring
// between the element's events and the details section is what is under
// test, so both are stood in for.
beforeEach(() => {
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.pause = vi.fn();
});

// The server's reading of the container's header.
const clipFormat = (format: Partial<ClipHeaderResponse> = {}): ClipHeaderResponse => ({
  codec: "H.264",
  frameRate: 25,
  variableFrameRate: false,
  bitDepth: 8,
  hdr: null,
  alpha: false,
  audio: { codec: "AAC", channels: 2 },
  startTimecode: null,
  width: 1920,
  height: 1080,
  duration: 64,
  ...format,
});
const h264At25 = async (): Promise<ClipHeaderResponse> => clipFormat();

function videoSetup(ok = true, format: (path: string) => Promise<ClipHeaderResponse> = h264At25) {
  let release: () => void = () => {};
  const headFile = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = () => resolve({ ok, headers: new Headers({ "content-length": "3686" }) } as Response);
      }),
  );
  const videoFormat = vi.fn(format);
  const loop = memorySetting(false);
  const volume = memorySetting({ level: 1, muted: false });
  const guides = memorySetting(NO_GUIDES);
  const lut = memoryLook();
  const contextMenu = fakeContextMenu();
  const pane = createVideoPane({
    rawFileUrl: (path) => `/raw?path=${path}`,
    headFile,
    videoFormat,
    loop,
    volume,
    guides,
    lut,
    contextMenu,
  });
  document.body.append(pane.element);
  return { pane, headFile, videoFormat, loop, lut, contextMenu, release: () => release() };
}

const videoTab = { kind: "video" as const, path: "lib:takes/BR2-FINAL-LYRA-001.mp4" };

// The header a player reads before any picture: what jsdom would never
// produce on its own.
function describeLoaded(video: HTMLVideoElement, width: number, height: number, duration: number): void {
  Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  video.dispatchEvent(new Event("loadedmetadata"));
}

describe("videoPane", () => {
  it("describes a video pane with no title bar", () => {
    const descriptor = videoPane(fakeContextMenu());
    expect(descriptor.kind).toBe("video");
    const pane = descriptor.create(fakePaneGroup());
    expect(pane.title()).toBeUndefined();
    expect(pane.titleHost).toBeUndefined();
  });

  it("shows a player pointed at the raw-file route, with its details in the Info-tab section", async () => {
    const { pane, headFile, videoFormat, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);

    expect(pane.element.classList.contains("editor-video")).toBe(true);
    const video = pane.element.querySelector("video");
    expect(video?.getAttribute("src")).toBe("/raw?path=lib:takes/BR2-FINAL-LYRA-001.mp4");
    // Pragma's own controls, never the browser's.
    expect(video?.controls).toBe(false);
    // Opening a tab must cost a header, not a four-gigabyte clip.
    expect(video?.preload).toBe("metadata");
    // The player sits in its own frame, with its overlay and its controls.
    expect(video?.parentElement?.className).toBe("media-frame editor-video-stage");
    expect(video?.parentElement?.querySelector(".video-player.is-review")).not.toBeNull();
    expect(details(pane).querySelector(".inspector-section-title")?.textContent).toBe("Video");
    expect(rows(pane)).toEqual({ Dimensions: "…", Duration: "…", "Frame rate": "…", Codec: "…" });
    expect(headFile).toHaveBeenCalledWith("lib:takes/BR2-FINAL-LYRA-001.mp4");
    expect(videoFormat).toHaveBeenCalledWith("lib:takes/BR2-FINAL-LYRA-001.mp4");

    release();
    await opening;
  });

  it("fills dimensions and duration from the loaded header", async () => {
    const { pane, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    describeLoaded(pane.element.querySelector("video") as HTMLVideoElement, 2206, 946, 8);
    expect(rows(pane).Dimensions).toBe("2206 × 946px (21:9)");
    expect(rows(pane).Duration).toBe("0:08");
  });

  it("lays dimensions, codec, scale and frame rate along the top of the picture", async () => {
    const { pane, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    const video = pane.element.querySelector("video") as HTMLVideoElement;
    // The overlay is the player's next sibling: `video:hover + .media-hud`.
    const hud = video.nextElementSibling as HTMLElement;
    expect(hud.className).toBe("media-hud");
    expect(hud.hidden).toBe(true);

    video.getBoundingClientRect = () => ({ left: 12.5, top: 0, width: 960, height: 540 }) as DOMRect;
    describeLoaded(video, 1920, 1080, 8);
    expect(hud.hidden).toBe(false);
    // One bar: the player's own controls take the bottom edge on hover, and
    // show the duration.
    expect(hudText(pane)).toEqual(["1920 × 1080 (16:9) | H.264 | 50% |  | 25 fps"]);
    expect(hud.getAttribute("style")).toBeNull();
  });

  it("badges LOOK before the frame rate once a look is picked, pressed while on, following the choice every player shares", async () => {
    const { pane, lut, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    const video = pane.element.querySelector("video") as HTMLVideoElement;
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
    describeLoaded(video, 1920, 1080, 8);
    const badge = pane.element.querySelector(".media-hud-bar > button.media-hud-badge") as HTMLButtonElement;
    // Before the first pick there is nothing for it to turn on.
    expect(badge.textContent).toBe("");

    lut.set({ lut: "panchromatic", on: true });
    expect(hudText(pane)).toEqual(["1920 × 1080 (16:9) | H.264 | 50% | LOOK | 25 fps"]);
    expect(badge.getAttribute("aria-pressed")).toBe("true");
    expect(badge.getAttribute("aria-label")).toBe("Panchromatic look");
    expect(badge.dataset.tooltip).toBe("Panchromatic on, click to turn off (D)");
    expect(badge.tabIndex).toBe(-1);

    lut.set({ lut: "orthochromatic", on: false });
    expect(badge.textContent).toBe("LOOK");
    expect(badge.getAttribute("aria-pressed")).toBe("false");
    expect(badge.dataset.tooltip).toBe("Orthochromatic off, click to turn on (D)");

    // A closed pane stops listening.
    pane.dispose();
    lut.set({ lut: "orthochromatic", on: true });
    expect(badge.getAttribute("aria-pressed")).toBe("false");
  });

  it("turns the look off and back on from its badge or D, leaving focus on the pane for its keys", async () => {
    const { pane, lut, release } = videoSetup();
    lut.set({ lut: "panchromatic", on: true });
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    const badge = pane.element.querySelector(".media-hud-badge") as HTMLButtonElement;
    expect(badge.getAttribute("aria-pressed")).toBe("true");

    pane.element.focus();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    badge.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    badge.click();
    expect(lut.get()).toEqual({ lut: "panchromatic", on: false });
    expect(badge.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(pane.element);

    pane.element.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    expect(lut.get()).toEqual({ lut: "panchromatic", on: true });
    expect(badge.getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    [{ codec: "ProRes 422 HQ", frameRate: 24_000 / 1001, variableFrameRate: false }, "23.976 fps"],
    [{ codec: "HEVC", frameRate: 30_000 / 1001, variableFrameRate: false }, "29.97 fps"],
    [{ codec: "H.264", frameRate: 29.834, variableFrameRate: true }, "29.8 fps (variable)"],
  ] as const)("fills codec and frame rate from the container header: %o", async (format, rate) => {
    const { pane, release } = videoSetup(true, async () => clipFormat(format));
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    expect(rows(pane)).toMatchObject({ "Frame rate": rate, Codec: format.codec });
  });

  // What the header says past the codec and rate, each fact it gives a row of its own.
  it("lists the header's bit depth, dynamic range, alpha, audio and start timecode", async () => {
    const graded = clipFormat({
      codec: "ProRes 4444 XQ",
      bitDepth: 12,
      hdr: "pq",
      alpha: true,
      audio: null,
      startTimecode: "01:00:00:00",
    });
    const { pane, release } = videoSetup(true, async () => graded);
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    await settle();
    expect(rows(pane)).toMatchObject({
      "Bit depth": "12 bits per channel",
      "Dynamic range": "HDR (PQ)",
      Alpha: "Yes",
      Audio: "None",
      "Start timecode": "01:00:00:00",
    });

    const plain = videoSetup();
    const reopening = plain.pane.setInput(videoTab, current);
    plain.release();
    await reopening;
    await settle();
    expect(rows(plain.pane)).toMatchObject({ "Dynamic range": "SDR", Audio: "AAC, 2 channels" });
    expect(Object.keys(rows(plain.pane))).not.toContain("Alpha");
    expect(Object.keys(rows(plain.pane))).not.toContain("Start timecode");
  });

  // A live-recorded WebM may carry no frame duration at all.
  it("leaves a frame rate the header doesn't give out of the overlay", async () => {
    const { pane, release } = videoSetup(true, async () => clipFormat({ codec: "VP8", frameRate: null }));
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    const video = pane.element.querySelector("video") as HTMLVideoElement;
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
    describeLoaded(video, 1920, 1080, 8);
    expect(rows(pane)).toMatchObject({ "Frame rate": "Unknown", Codec: "VP8" });
    expect(hudText(pane)).toEqual(["1920 × 1080 (16:9) | VP8 | 50% |  | "]);
  });

  it("shows codec and frame rate as Unknown when the header can't be read", async () => {
    const { pane, release } = videoSetup(true, async () => Promise.reject(new Error("422")));
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    expect(rows(pane)).toMatchObject({ "Frame rate": "Unknown", Codec: "Unknown" });
  });

  it("takes the overlay down when the clip turns out unplayable", async () => {
    const { pane, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    const video = pane.element.querySelector("video") as HTMLVideoElement;
    video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect;
    describeLoaded(video, 1920, 1080, 8);
    video.dispatchEvent(new Event("error"));
    expect((video.nextElementSibling as HTMLElement).hidden).toBe(true);
  });

  // An extension names a container, not a codec: an HEVC .mp4 or a ProRes
  // .mov is listed and served and still may not decode here. The pane says
  // so rather than sitting blank.
  it("reports a format this browser can't play, without claiming the file is broken", async () => {
    // A header that gives no size or length either: the rows say so.
    const { pane, release } = videoSetup(true, async () => clipFormat({ width: null, height: null, duration: null }));
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    const failure = pane.element.querySelector(".editor-video-error") as HTMLElement;
    expect(failure.hidden).toBe(true);

    pane.element.querySelector("video")?.dispatchEvent(new Event("error"));
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toContain("untouched");
    expect(rows(pane).Dimensions).toBe("Unknown");
    expect(rows(pane).Duration).toBe("Unknown");
    // The header still reads when the picture doesn't.
    expect(rows(pane).Codec).toBe("H.264");
  });

  // The codec is the reason, so the message names it — also when the player
  // gives up before the header read comes back.
  it("names the codec it can't play, whichever answer comes first", async () => {
    let answer: (format: ClipHeaderResponse) => void = () => {};
    const { pane, release } = videoSetup(true, () => new Promise((resolve) => (answer = resolve)));
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;

    const failure = pane.element.querySelector(".editor-video-error") as HTMLElement;
    pane.element.querySelector("video")?.dispatchEvent(new Event("error"));
    expect(failure.textContent).toContain("can't play this video's format");

    answer(clipFormat({ codec: "ProRes 422 HQ" }));
    await settle();
    expect(failure.textContent).toBe("This browser can't play ProRes 422 HQ video. The file itself is untouched.");
  });

  // A clip the browser can't decode still has the size and length its header
  // gives, whichever of the two answers comes first.
  it("shows the header's size and length for a clip the browser can't play", async () => {
    for (const errorFirst of [true, false]) {
      let answer: (format: ClipHeaderResponse) => void = () => {};
      const { pane, release } = videoSetup(true, () => new Promise((resolve) => (answer = resolve)));
      const opening = pane.setInput(videoTab, current);
      release();
      await opening;
      const fail = () => pane.element.querySelector("video")?.dispatchEvent(new Event("error"));
      if (errorFirst) fail();
      answer(clipFormat({ codec: "ProRes 4444 XQ", width: 1188, height: 2112, duration: 26.8 }));
      await settle();
      if (!errorFirst) fail();
      expect(rows(pane), `error first: ${errorFirst}`).toMatchObject({
        Dimensions: "1188 × 2112px (9:16)",
        Duration: "0:26",
        Codec: "ProRes 4444 XQ",
      });
    }
  });

  // The failure that costs the most trust: a clip still audible after its
  // tab was switched away from. Removing the element is not enough on its
  // own, so the source is dropped.
  it("stops playback when the tab is switched away from or closed", async () => {
    const { pane, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    const video = pane.element.querySelector("video") as HTMLVideoElement;

    pane.clearInput();
    expect(video.pause).toHaveBeenCalled();
    expect(video.hasAttribute("src")).toBe(false);
    expect(pane.element.childElementCount).toBe(0);
    expect(details(pane).hidden).toBe(true);
  });

  it("stops the previous clip before showing the next", async () => {
    const { pane, release } = videoSetup();
    const first = pane.setInput(videoTab, current);
    release();
    await first;
    const firstVideo = pane.element.querySelector("video") as HTMLVideoElement;
    describeLoaded(firstVideo, 1920, 1080, 8);

    const second = pane.setInput({ kind: "video", path: "lib:takes/BR2-FINAL-PAGES-001.mp4" }, current);
    release();
    await second;

    expect(firstVideo.pause).toHaveBeenCalled();
    expect(firstVideo.hasAttribute("src")).toBe(false);
    expect(pane.element.querySelector("video")?.getAttribute("src")).toBe(
      "/raw?path=lib:takes/BR2-FINAL-PAGES-001.mp4",
    );
    expect(rows(pane).Dimensions).toBe("…");
  });

  it("writes nothing once the open went stale", async () => {
    const { pane, release } = videoSetup();
    const opening = pane.setInput(videoTab, { isCurrent: () => false });
    release();
    await opening;

    describeLoaded(pane.element.querySelector("video") as HTMLVideoElement, 1920, 1080, 8);
    expect(rows(pane).Dimensions).toBe("…");
    expect(rows(pane).Duration).toBe("…");
  });

  // A tab restored after its file was deleted raises the same error event
  // an undecodable file does; only the HEAD can tell them apart, and it has
  // the last word even when the element's error arrived first.
  it("names a missing file as missing, not as a format the browser can't play", async () => {
    const { pane, release } = videoSetup(false, async () => Promise.reject(new Error("404")));
    const opening = pane.setInput(videoTab, current);
    pane.element.querySelector("video")?.dispatchEvent(new Event("error"));
    release();
    await opening;

    const failure = pane.element.querySelector(".editor-video-error") as HTMLElement;
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toContain("isn't there");
    expect(rows(pane).Dimensions).toBe("Unknown");
    expect(rows(pane).Codec).toBe("Unknown");
  });

  // A failed HEAD says nothing about the file, so it is not reported gone.
  it("treats a failed existence check as present", async () => {
    const pane = createVideoPane({
      rawFileUrl: (path) => path,
      headFile: vi.fn(async () => Promise.reject(new Error("x"))),
      videoFormat: h264At25,
      loop: memorySetting(false),
      volume: memorySetting({ level: 1, muted: false }),
      guides: memorySetting(NO_GUIDES),
      lut: memoryLook(NO_LOOK),
      contextMenu: fakeContextMenu(),
    });
    await pane.setInput(videoTab, current);
    expect((pane.element.querySelector(".editor-video-error") as HTMLElement).hidden).toBe(true);
  });

  // The menu every media file's ⋮ opens, which knows its own tab.
  it("opens the media menu for the tab's file, and closes it from the same button", async () => {
    const { pane, contextMenu, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    const more = pane.element.querySelector(".video-player-more") as HTMLButtonElement;

    more.click();
    expect(contextMenu.opened).toHaveLength(1);
    const [menu] = contextMenu.opened;
    expect(menu?.menu).toBe(MEDIA_MENU);
    expect(menu?.arg).toEqual({ file: videoTab.path, bookmark: videoTab.path });
    expect(menu?.anchor).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");

    more.click();
    expect(contextMenu.isOpen()).toBe(false);
    expect(contextMenu.opened).toHaveLength(1);
  });

  // The player's keys go to the pane, which a press anywhere in it focuses;
  // a key on one of its buttons is the button's.
  it("plays, counts and marks from the keyboard while the pane has focus", async () => {
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    const { pane, release } = videoSetup();
    const opening = pane.setInput(videoTab, current);
    release();
    await opening;
    await settle();
    const video = pane.element.querySelector("video") as HTMLVideoElement;
    describeLoaded(video, 1920, 1080, 8);
    Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
    const key = (target: Element, name: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    const counter = () => pane.element.querySelector(".video-player-time")?.textContent;

    video.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(pane.element);
    key(pane.element.querySelector(".video-player-play") as HTMLElement, " ");
    expect(video.play).not.toHaveBeenCalled();
    key(pane.element, " ");
    expect(video.play).toHaveBeenCalled();

    // The header read's 25 fps is what the timecode counts.
    video.currentTime = 2;
    key(pane.element, "i");
    key(pane.element, "ArrowRight");
    expect(counter()).toBe("00:00:02:01");
    video.currentTime = 6;
    key(pane.element, "o");
    const seek = pane.element.querySelector(".video-player-seek") as HTMLElement;
    expect(seek.style.getPropertyValue("--range-start")).toBe("0.25");
    expect(seek.style.getPropertyValue("--range-end")).toBe("0.75");

    // Session only: the range is back when the tab is.
    const inAndOut = () => pane.element.querySelector(".video-player-range-toggle") as HTMLElement;
    const away = pane.setInput({ kind: "video", path: "lib:takes/BR2-FINAL-PAGES-001.mp4" }, current);
    release();
    await away;
    expect(inAndOut().getAttribute("aria-disabled")).toBe("true");
    const back = pane.setInput(videoTab, current);
    release();
    await back;
    expect(inAndOut().getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses a tab of another kind", async () => {
    const { pane } = videoSetup();
    await expect(pane.setInput({ kind: "image", path: "a.png" }, current)).rejects.toThrow(/can't show an? "image"/);
  });
});
