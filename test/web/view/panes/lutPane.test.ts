// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lut, LutFile } from "../../../../src/protocol/lutFile.ts";
import {
  createLutPane,
  inputRangeText,
  STRIP_HEIGHT,
  STRIP_WIDTH,
  testStrip,
} from "../../../../web/view/panes/lutPane.ts";

const FILE = "looks/print.cube";

// A 2-point cube giving each color its opposite.
function inverting(extra: Partial<LutFile> = {}): LutFile {
  const table = new Float32Array(24);
  for (let at = 0; at < 8; at++) table.set([1 - (at & 1), 1 - ((at >> 1) & 1), 1 - ((at >> 2) & 1)], at * 3);
  return { size: 2, table, domainMin: [0, 0, 0], domainMax: [1, 1, 1], ...extra };
}

// The same cube as a `.cube` file's text.
function invertingText(title: string): string {
  const rows = Array.from({ length: 8 }, (_, at) => [1 - (at & 1), 1 - ((at >> 1) & 1), 1 - ((at >> 2) & 1)].join(" "));
  return `TITLE "${title}"\nLUT_3D_SIZE 2\n${rows.join("\n")}\n`;
}

// The tab over files by path, each its text, or the status its read answers.
function setup(files: Record<string, string | number> = { [FILE]: invertingText("Negative") }) {
  const fetchFile = vi.fn(async (path: string) => {
    const file = files[path] ?? 404;
    return typeof file === "number" ? new Response("", { status: file }) : new Response(file);
  });
  const pane = createLutPane({ fetchFile });
  const find = <T extends HTMLElement>(selector: string) => pane.element.querySelector<T>(selector);
  const rows = () =>
    [...(pane.inspector?.querySelectorAll(".meta-row") ?? [])].map((row) => [
      row.querySelector(".meta-key")?.textContent,
      row.querySelector(".meta-value")?.textContent,
    ]);
  const show = (path = FILE, current = true) => pane.setInput({ kind: "lut", path }, { isCurrent: () => current });
  return { pane, fetchFile, find, rows, show };
}

afterEach(() => vi.restoreAllMocks());

describe("createLutPane", () => {
  it("shows a LUT's strip before and after, and its facts in the Info tab", async () => {
    const { find, rows, show, pane } = setup();
    await show();
    expect(find(".lut-body")?.hidden).toBe(false);
    expect([...pane.element.querySelectorAll("figcaption")].map((caption) => caption.textContent)).toEqual([
      "Before",
      "After",
    ]);
    expect(find(".lut-message")?.hidden).toBe(true);
    expect(pane.inspector?.hidden).toBe(false);
    expect(rows()).toEqual([
      ["Title", "Negative"],
      ["Dimensions", "2 × 2 × 2"],
      ["Input range", "0 to 1"],
    ]);
  });

  it("reads the file it shows through the raw-file route, and again each time it shows", async () => {
    const { fetchFile, show } = setup();
    await show();
    await show();
    expect(fetchFile.mock.calls).toEqual([[FILE], [FILE]]);
  });

  it("says why a file can't be shown: not a LUT it can read, gone, or not loaded", async () => {
    const { find, show, pane } = setup({ [FILE]: "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n", "looks/broken.cube": 500 });
    await show();
    expect(find(".lut-message")?.textContent).toBe("This is a 1D LUT, which Pragma can't apply yet.");
    expect(find(".lut-message")?.hidden).toBe(false);
    expect(find(".lut-body")?.hidden).toBe(true);
    expect(pane.inspector?.hidden).toBe(true);

    await show("looks/gone.cube");
    expect(find(".lut-message")?.textContent).toBe(
      "This file isn't there any more. It may have been moved or deleted.",
    );
    await show("looks/broken.cube");
    expect(find(".lut-message")?.textContent).toBe("This LUT couldn't be loaded.");
  });

  it("drops a read the tab has moved on from", async () => {
    const { find, show } = setup();
    await show(FILE, false);
    expect(find(".lut-body")?.hidden).toBe(true);
    expect(find(".lut-message")?.hidden).toBe(true);
  });

  it("paints both strips, the second through the LUT", async () => {
    const painted: ImageData[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (image: ImageData) => painted.push(image),
    })) as never);
    const { show } = setup();
    await show();
    expect(painted).toHaveLength(2);
    const corner = (image: ImageData) => Array.from(image.data.slice(-STRIP_WIDTH * 4, -STRIP_WIDTH * 4 + 3));
    expect(corner(painted[0])).toEqual([0, 0, 0]);
    expect(corner(painted[1])).toEqual([255, 255, 255]);
  });
});

describe("testStrip", () => {
  const pixel = (pixels: Uint8ClampedArray, x: number, y: number) =>
    Array.from(pixels.slice((y * STRIP_WIDTH + x) * 4, (y * STRIP_WIDTH + x) * 4 + 4));

  it("runs every hue from light to dark above a gray ramp from black to white", () => {
    const pixels = testStrip(STRIP_WIDTH, STRIP_HEIGHT);
    expect(pixels).toHaveLength(STRIP_WIDTH * STRIP_HEIGHT * 4);
    expect(pixel(pixels, 0, 0)).toEqual([255, 204, 204, 255]);
    // The band's middle row holds each hue at full strength.
    expect(pixel(pixels, 0, 67)).toEqual([255, 0, 0, 255]);
    expect(pixel(pixels, 0, STRIP_HEIGHT - 1)).toEqual([0, 0, 0, 255]);
    expect(pixel(pixels, STRIP_WIDTH - 1, STRIP_HEIGHT - 1)).toEqual([255, 255, 255, 255]);
  });

  it("shows each pixel through a LUT when given one", () => {
    const pixels = testStrip(STRIP_WIDTH, STRIP_HEIGHT, inverting());
    expect(pixel(pixels, 0, 0)).toEqual([0, 51, 51, 255]);
    expect(pixel(pixels, 0, STRIP_HEIGHT - 1)).toEqual([255, 255, 255, 255]);
  });
});

describe("inputRangeText", () => {
  const range = (domainMin: Lut["domainMin"], domainMax: Lut["domainMax"]) =>
    inputRangeText({ size: 2, table: new Float32Array(24), domainMin, domainMax });

  it("writes one span for channels that share it, and each channel's otherwise", () => {
    expect(range([0, 0, 0], [1, 1, 1])).toBe("0 to 1");
    expect(range([0.1, 0.1, 0.1], [0.9, 0.9, 0.9])).toBe("0.1 to 0.9");
    expect(range([0, 0.5, 0], [1, 1, 2])).toBe("R 0 to 1, G 0.5 to 1, B 0 to 2");
  });
});
