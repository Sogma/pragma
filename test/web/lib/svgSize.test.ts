// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { describeLoaded, readSvgStandInSize, svgStandInSize } from "../../../web/lib/svgSize.ts";

const svg = (attributes: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><path d="M0 0h1v1z"/></svg>`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("svgStandInSize", () => {
  it("stands an SVG with no size of its own in at its viewBox's extent", () => {
    expect(svgStandInSize(svg('viewBox="-130 -130 2412 1137.4"'))).toEqual({ width: 2412, height: 1137.4 });
    expect(svgStandInSize(svg('viewBox="0,0,24,16"'))).toEqual({ width: 24, height: 16 });
  });

  // None of these gives the browser a size it draws the picture at.
  it("counts a percentage, auto or a font-relative size as none", () => {
    for (const size of ['width="100%" height="100%"', 'width="auto"', 'width="10em" height="5em"', 'width=""']) {
      expect(svgStandInSize(svg(`${size} viewBox="0 0 24 16"`)), size).toEqual({ width: 24, height: 16 });
    }
  });

  it("leaves an SVG that sets its own size to the browser", () => {
    for (const size of ['width="120" height="60px"', 'width="210mm"', 'height="1.5e2"', 'width=" 12pt "']) {
      expect(svgStandInSize(svg(`${size} viewBox="0 0 24 16"`)), size).toBeUndefined();
    }
  });

  it("stands one with neither a size nor a usable viewBox in at the browser's default box", () => {
    for (const viewBox of ["", 'viewBox="0 0 24"', 'viewBox="0 0 0 16"', 'viewBox="0 0 -24 16"', 'viewBox="a b c d"']) {
      expect(svgStandInSize(svg(viewBox)), viewBox).toEqual({ width: 300, height: 150 });
    }
  });

  it("gives nothing for text that isn't an SVG", () => {
    const texts = [
      "",
      "<html/>",
      '<svg viewBox="0 0 24 16"/>', // no SVG namespace, so no picture either
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><g></svg>',
    ];
    for (const text of texts) expect(svgStandInSize(text), text).toBeUndefined();
  });
});

describe("readSvgStandInSize", () => {
  it("reads the file's text through the raw-file route", async () => {
    const fetchFile = vi.fn(async () => new Response(svg('viewBox="0 0 24 16"')));
    expect(await readSvgStandInSize(fetchFile, "art/logo.svg")).toEqual({ width: 24, height: 16 });
    expect(fetchFile).toHaveBeenCalledWith("art/logo.svg");
  });

  it("gives no answer for a failed read", async () => {
    const missing = async () => new Response("Not found", { status: 404 });
    expect(await readSvgStandInSize(missing, "art/logo.svg")).toBeUndefined();
    const offline = async () => Promise.reject(new Error("offline"));
    expect(await readSvgStandInSize(offline, "art/logo.svg")).toBeUndefined();
  });
});

describe("describeLoaded", () => {
  function decoded(width: number, height: number): HTMLImageElement {
    const img = document.createElement("img");
    Object.defineProperty(img, "naturalWidth", { value: width });
    Object.defineProperty(img, "naturalHeight", { value: height });
    return img;
  }

  it("describes a picture by its own size as soon as it loads", () => {
    const img = decoded(600, 800);
    const describe = vi.fn();
    describeLoaded(img, undefined, describe);
    img.dispatchEvent(new Event("load"));
    expect(describe).toHaveBeenCalledWith(600, 800);
    expect(img.classList.contains("is-unsized")).toBe(false);
  });

  // The browser decodes an unsized SVG at a default width of 300.
  it("sizes and describes an unsized SVG by its stand-in, never the browser's default", async () => {
    const img = decoded(300, 141);
    const describe = vi.fn();
    describeLoaded(img, Promise.resolve({ width: 2412, height: 1137.4 }), describe);
    await settle();
    expect(img.classList.contains("is-unsized")).toBe(true);
    expect(img.style.getPropertyValue("--svg-width")).toBe("2412px");
    expect(Number(img.style.getPropertyValue("--svg-ratio"))).toBeCloseTo(2412 / 1137.4);

    img.dispatchEvent(new Event("load"));
    expect(describe).not.toHaveBeenCalled();
    await settle();
    expect(describe).toHaveBeenCalledExactlyOnceWith(2412, 1137);
  });

  it("describes an SVG that sets its own size by that size, once the lookup says so", async () => {
    const img = decoded(120, 60);
    const describe = vi.fn();
    describeLoaded(img, Promise.resolve(undefined), describe);
    img.dispatchEvent(new Event("load"));
    await settle();
    expect(describe).toHaveBeenCalledExactlyOnceWith(120, 60);
    expect(img.classList.contains("is-unsized")).toBe(false);
  });
});
