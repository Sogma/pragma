// A LUT's tab: a test strip as it is and through the LUT, with the LUT's
// facts in the Info tab.
import { type Lut, type LutFile, type LutRead, lookUp, readLutFile } from "../../../src/protocol/lutFile.ts";
import { fetchFileRaw } from "../../core/apiClient.ts";
import { appendMetaRow, createInspectorSection } from "../../lib/dom.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";

export interface LutPaneDeps {
  /** A GET against the raw-file route. */
  fetchFile(path: string): Promise<Response>;
}

const CHROME = { toolbar: false, readingView: false, statusbar: true, actions: [] } as const;

// The route is bound here, not handed in by the bootstrap; the factory still
// takes it, for tests.
export function lutPane(): EditorPaneDescriptor {
  return { kind: "lut", chrome: CHROME, create: () => createLutPane({ fetchFile: fetchFileRaw }) };
}

/** The test strip's size in pixels: four times as wide as it is tall. */
export const STRIP_WIDTH = 720;
export const STRIP_HEIGHT = 180;

// The hue band's lightness runs from this at its top to one less this at
// its foot, short of white and black, which every hue shares.
const LIGHTEST = 0.9;

// A fully saturated hue, `hue` in degrees, at `lightness`, as RGB from 0 to 1.
function hueColor(hue: number, lightness: number, out: number[]): void {
  const chroma = 1 - Math.abs(2 * lightness - 1);
  const sector = (hue % 360) / 60;
  const between = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] =
    sector < 1
      ? [chroma, between, 0]
      : sector < 2
        ? [between, chroma, 0]
        : sector < 3
          ? [0, chroma, between]
          : sector < 4
            ? [0, between, chroma]
            : sector < 5
              ? [between, 0, chroma]
              : [chroma, 0, between];
  const lift = lightness - chroma / 2;
  out[0] = red + lift;
  out[1] = green + lift;
  out[2] = blue + lift;
}

/** The test strip's RGBA pixels: every hue from left to right, light at the
 * top to dark at the foot, over a gray ramp from black to white along its
 * last quarter. Through `lut` when given, as a player shows a frame. */
export function testStrip(width: number, height: number, lut?: Lut): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const ramp = Math.round(height * 0.75);
  const color = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const lightness = LIGHTEST - (y / Math.max(ramp - 1, 1)) * (2 * LIGHTEST - 1);
    for (let x = 0; x < width; x++) {
      const across = width > 1 ? x / (width - 1) : 0;
      if (y < ramp) hueColor(across * 360, lightness, color);
      else color.fill(across);
      if (lut) lookUp(lut, color[0], color[1], color[2], color);
      const at = (y * width + x) * 4;
      pixels[at] = color[0] * 255;
      pixels[at + 1] = color[1] * 255;
      pixels[at + 2] = color[2] * 255;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

const sameRange = (range: readonly number[]) => range.every((value) => value === range[0]);
const number = (value: number) => String(Number(value.toFixed(4)));

/** A cube's input range as the Info tab writes it: one span for all three
 * channels when they share it, else each channel's. */
export function inputRangeText({ domainMin, domainMax }: Lut): string {
  if (sameRange(domainMin) && sameRange(domainMax)) return `${number(domainMin[0])} to ${number(domainMax[0])}`;
  return ["R", "G", "B"].map((name, at) => `${name} ${number(domainMin[at])} to ${number(domainMax[at])}`).join(", ");
}

function strip(caption: string): { figure: HTMLElement; canvas: HTMLCanvasElement } {
  const figure = document.createElement("figure");
  figure.className = "lut-strip";
  const canvas = document.createElement("canvas");
  canvas.width = STRIP_WIDTH;
  canvas.height = STRIP_HEIGHT;
  const label = document.createElement("figcaption");
  label.textContent = caption;
  figure.append(canvas, label);
  return { figure, canvas };
}

function paint(canvas: HTMLCanvasElement, lut?: Lut): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(STRIP_WIDTH, STRIP_HEIGHT);
  image.data.set(testStrip(STRIP_WIDTH, STRIP_HEIGHT, lut));
  context.putImageData(image, 0, 0);
}

export function createLutPane(deps: LutPaneDeps): EditorPane {
  const element = document.createElement("div");
  element.className = "editor-lut";
  const before = strip("Before");
  const after = strip("After");
  const body = document.createElement("div");
  body.className = "lut-body";
  body.hidden = true;
  body.append(before.figure, after.figure);
  const message = document.createElement("p");
  message.className = "lut-message";
  message.hidden = true;
  element.append(body, message);
  const details = createInspectorSection("LUT");
  details.body.className = "meta-rows";

  function showMessage(text: string): void {
    message.textContent = text;
    message.hidden = false;
  }

  function fillDetails(lut: LutFile): void {
    details.body.replaceChildren();
    if (lut.title) appendMetaRow(details.body, "Title", lut.title);
    appendMetaRow(details.body, "Dimensions", `${lut.size} × ${lut.size} × ${lut.size}`);
    appendMetaRow(details.body, "Input range", inputRangeText(lut));
    details.section.hidden = false;
  }

  function clear(): void {
    body.hidden = true;
    message.hidden = true;
    details.body.replaceChildren();
    details.section.hidden = true;
  }

  async function read(path: string): Promise<LutRead> {
    const response = await deps.fetchFile(path).catch(() => undefined);
    if (response?.status === 404)
      return { problem: "This file isn't there any more. It may have been moved or deleted." };
    const text = response?.ok ? await response.text().catch(() => undefined) : undefined;
    return text === undefined ? { problem: "This LUT couldn't be loaded." } : readLutFile(text);
  }

  return {
    kind: "lut",
    element,
    inspector: details.section,
    async setInput(tab, ctx) {
      if (tab.kind !== "lut") throw new Error(`the LUT pane can't show a "${tab.kind}" tab`);
      clear();
      const found = await read(tab.path);
      if (!ctx.isCurrent()) return;
      if ("problem" in found) return showMessage(found.problem);
      fillDetails(found.lut);
      paint(before.canvas);
      paint(after.canvas, found.lut);
      body.hidden = false;
    },
    clearInput: clear,
    title: () => undefined, // the tab names it; no title bar
    dispose: () => element.remove(),
  };
}
