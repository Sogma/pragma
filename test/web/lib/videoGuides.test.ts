// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createGuidesOverlay,
  frameBox,
  type Guides,
  insetBox,
  matteOutside,
  NO_GUIDES,
  readGuides,
  SOCIAL_SAFE,
  sharedBox,
  TITLE_SAFE,
  toggleFrame,
  toggleGuides,
} from "../../../web/lib/videoGuides.ts";
import { memorySetting } from "../support/editorLayout.ts";

describe("frameBox", () => {
  it("is the whole picture with no frame picked, or one of the clip's own shape", () => {
    const whole = { x: 0, y: 0, width: 1920, height: 1080, cut: false };
    expect(frameBox(1920, 1080, 0)).toEqual(whole);
    expect(frameBox(1920, 1080, 16 / 9)).toEqual(whole);
    // 1.77 is 16:9 rounded: a matte a hair wide would be a stray line.
    expect(frameBox(1920, 1080, 1.77)).toEqual(whole);
  });

  it("cuts a narrower shape at the picture's full height, from its middle", () => {
    expect(frameBox(1920, 1080, 9 / 16)).toEqual({ x: 656.25, y: 0, width: 607.5, height: 1080, cut: true });
  });

  it("cuts a wider shape at the picture's full width, from its middle", () => {
    const scope = frameBox(1920, 1080, 2.39);
    expect(scope).toMatchObject({ x: 0, width: 1920, cut: true });
    expect(scope.height).toBeCloseTo(803.35, 2);
    expect(scope.y).toBeCloseTo(138.33, 2);
  });
});

describe("insetBox", () => {
  it("takes its share from every side, title safe keeping 90%", () => {
    expect(insetBox({ x: 0, y: 0, width: 1920, height: 1080 }, TITLE_SAFE)).toEqual({
      x: 96,
      y: 54,
      width: 1728,
      height: 972,
    });
  });

  it("takes each side's own share, as social safe does", () => {
    const social = insetBox({ x: 0, y: 0, width: 1080, height: 1920 }, SOCIAL_SAFE);
    expect(social.x).toBeCloseTo(54, 6);
    expect(social.y).toBeCloseTo(384, 6);
    expect(social.width).toBeCloseTo(842.4, 6);
    expect(social.height).toBeCloseTo(864, 6);
  });
});

describe("readGuides", () => {
  it("reads back what was stored", () => {
    const stored: Guides = {
      shown: false,
      frames: ["4:5", "2.39"],
      extents: true,
      action: false,
      title: true,
      center: true,
      social: true,
    };
    expect(readGuides(JSON.stringify(stored))).toEqual(stored);
  });

  it("reads anything missing, unknown or broken as no guide", () => {
    expect(readGuides(null)).toEqual(NO_GUIDES);
    expect(readGuides("{")).toEqual(NO_GUIDES);
    expect(readGuides("7")).toEqual(NO_GUIDES);
    expect(readGuides(JSON.stringify({ frames: "9:16", title: "yes" }))).toEqual(NO_GUIDES);
    expect(readGuides(JSON.stringify({ title: true }))).toEqual({ ...NO_GUIDES, title: true });
    // A lone `frame`, which this reader doesn't know, reads as none.
    expect(readGuides(JSON.stringify({ frame: "9:16", title: true }))).toEqual({ ...NO_GUIDES, title: true });
  });

  it("keeps the frames it knows, once each, in the menu's order", () => {
    expect(readGuides(JSON.stringify({ frames: ["2.39", "3:2", "9:16", "9:16"] })).frames).toEqual(["9:16", "2.39"]);
  });
});

describe("toggleFrame", () => {
  it("turns a frame on in the menu's order, and off again", () => {
    expect(toggleFrame([], "2.39")).toEqual(["2.39"]);
    expect(toggleFrame(["2.39"], "9:16")).toEqual(["9:16", "2.39"]);
    expect(toggleFrame(["9:16", "2.39"], "9:16")).toEqual(["2.39"]);
  });
});

// Every frame is cut from the middle, so they overlap in one box, and what
// none of them shows is two bands or four corners.
describe("sharedBox and matteOutside", () => {
  const tall = frameBox(1920, 1080, 9 / 16);
  const wide = frameBox(1920, 1080, 2.39);

  it("finds where frames overlap, the whole picture for none", () => {
    expect(sharedBox(1920, 1080, [])).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    const shared = sharedBox(1920, 1080, [tall, wide]);
    expect([shared.x, shared.width]).toEqual([tall.x, tall.width]);
    expect([shared.y, shared.height]).toEqual([wide.y, wide.height]);
  });

  it("mattes two bands beside one kind of cut, the four corners between two, and nothing for none or the whole picture", () => {
    expect(matteOutside(1920, 1080, [tall])).toBe("M0 0H656.25V1080H0Z M1263.75 0H1920V1080H1263.75Z");
    expect(matteOutside(1920, 1080, [wide])).toBe("M0 0H1920V138.33H0Z M0 941.67H1920V1080H0Z");
    expect(matteOutside(1920, 1080, [tall, wide])).toBe(
      "M0 0H656.25V138.33H0Z M1263.75 0H1920V138.33H1263.75Z M0 941.67H656.25V1080H0Z M1263.75 941.67H1920V1080H1263.75Z",
    );
    expect(matteOutside(1920, 1080, [])).toBe("");
    expect(matteOutside(1920, 1080, [tall, frameBox(1920, 1080, 16 / 9)])).toBe("");
  });
});

// G hides every guide and brings them back, the picks kept.
describe("toggleGuides", () => {
  it("hides the guides and shows them again, keeping the picks", () => {
    const guides = memorySetting<Guides>({ ...NO_GUIDES, frames: ["4:5"], title: true });
    toggleGuides(guides);
    expect(guides.get()).toEqual({ ...NO_GUIDES, frames: ["4:5"], title: true, shown: false });
    toggleGuides(guides);
    expect(guides.get()).toEqual({ ...NO_GUIDES, frames: ["4:5"], title: true, shown: true });
  });
});

describe("createGuidesOverlay", () => {
  function draw(guides: Guides) {
    const choice = memorySetting(guides);
    const overlay = createGuidesOverlay(choice);
    const svg = overlay.element.querySelector("svg") as SVGSVGElement;
    // The shapes drawn, in their order: each outline in the frames' group.
    const shown = () =>
      [...svg.children]
        .flatMap((node) => (node.tagName === "g" ? [...node.children] : [node]))
        .filter((node) => node.parentNode !== svg || node.getAttribute("display") === "inline")
        .map((node) => node.getAttribute("class"));
    // Where each name sits, as a share of the picture to a hundredth.
    const at = (share: string) => Math.round(Number.parseFloat(share) * 100) / 100;
    const names = () =>
      [...overlay.element.querySelectorAll<HTMLElement>(".video-guides-name")].map((name) => [
        name.textContent,
        at(name.style.left),
        at(name.style.top),
      ]);
    const box = (rect: Element) => ["x", "y", "width", "height"].map((name) => rect.getAttribute(name));
    return { choice, overlay, svg, shown, names, box };
  }

  it("stays hidden until the media's size is known, and while nothing is picked", () => {
    const { choice, overlay } = draw({ ...NO_GUIDES, title: true });
    expect(overlay.element.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.element.hasAttribute("hidden")).toBe(true);
    overlay.setSize(1920, 1080);
    expect(overlay.element.hasAttribute("hidden")).toBe(false);
    choice.set(NO_GUIDES);
    expect(overlay.element.hasAttribute("hidden")).toBe(true);
  });

  it("mattes the picture outside one frame, outlines and names it, and draws its guides inside it", () => {
    const { overlay, svg, shown, names, box } = draw({
      ...NO_GUIDES,
      frames: ["9:16"],
      extents: true,
      title: true,
      center: true,
    });
    overlay.setSize(1920, 1080);
    expect(svg.getAttribute("viewBox")).toBe("0 0 1920 1080");
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-cut",
      "video-guides-line is-extents",
      "video-guides-line",
      "video-guides-line",
    ]);
    expect(svg.querySelector(".video-guides-matte")?.getAttribute("d")).toBe(
      "M0 0H656.25V1080H0Z M1263.75 0H1920V1080H1263.75Z",
    );
    const [cut, extents, , title] = [...svg.querySelectorAll("rect")];
    expect(box(cut)).toEqual(["656.25", "0", "607.5", "1080"]);
    expect(box(extents)).toEqual(box(cut));
    expect(box(title)).toEqual(["686.63", "54", "546.75", "972"]);
    // The center mark, crossed at the frame's middle.
    expect(svg.querySelectorAll("path")[1]?.getAttribute("d")).toBe("M938.74 540H981.26M960 518.74V561.26");
    expect(names()).toEqual([["9:16", 34.18, 0]]);
    expect(
      (overlay.element.querySelector(".video-guides-names") as HTMLElement).style.getPropertyValue("--guides-aspect"),
    ).toBe(String(1920 / 1080));
  });

  it("outlines and names each frame, mattes what none shows, and draws the guides where all overlap", () => {
    const { overlay, svg, shown, names, box } = draw({ ...NO_GUIDES, frames: ["9:16", "2.39"], extents: true });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-cut",
      "video-guides-line is-cut",
      "video-guides-line is-extents",
    ]);
    expect(svg.querySelector(".video-guides-matte")?.getAttribute("d")).toBe(
      "M0 0H656.25V138.33H0Z M1263.75 0H1920V138.33H1263.75Z M0 941.67H656.25V1080H0Z M1263.75 941.67H1920V1080H1263.75Z",
    );
    const [tall, wide, extents] = [...svg.querySelectorAll("rect")];
    expect(box(tall)).toEqual(["656.25", "0", "607.5", "1080"]);
    expect(box(wide)).toEqual(["0", "138.33", "1920", "803.35"]);
    expect(box(extents)).toEqual(["656.25", "138.33", "607.5", "803.35"]);
    expect(names()).toEqual([
      ["9:16", 34.18, 0],
      ["2.39", 0, 12.81],
    ]);
  });

  it("draws the social safe area inside the frame, clear of its sides by their own shares", () => {
    const { overlay, svg, shown } = draw({ ...NO_GUIDES, frames: ["9:16"], social: true });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual(["video-guides-matte", "video-guides-line is-cut", "video-guides-line"]);
    const social = [...svg.querySelectorAll("rect")].at(-1) as Element;
    // The 9:16 cut is 607.5 by 1080 from x 656.25: 5% of its width off the left, 20% of its height off the top.
    expect(["x", "y", "width", "height"].map((name) => social.getAttribute(name))).toEqual([
      "686.63",
      "216",
      "473.85",
      "486",
    ]);
  });

  // A frame of the picture's own shape is its edge, and shows all of it.
  it("draws no matte, line or name for a frame of the picture's own shape, and hides every guide while they're off", () => {
    const { choice, overlay, shown, names } = draw({ ...NO_GUIDES, frames: ["16:9"], action: true });
    overlay.setSize(1920, 1080);
    expect([shown(), names()]).toEqual([["video-guides-line"], []]);
    choice.set({ ...NO_GUIDES, frames: ["9:16", "16:9"] });
    expect([shown(), names().map(([name]) => name)]).toEqual([["video-guides-line is-cut"], ["9:16"]]);
    choice.set({ ...NO_GUIDES, action: true, shown: false });
    expect(overlay.element.hasAttribute("hidden")).toBe(true);
  });

  it("stops following the choice once disposed", () => {
    const { choice, overlay } = draw(NO_GUIDES);
    overlay.setSize(1920, 1080);
    overlay.dispose();
    choice.set({ ...NO_GUIDES, title: true });
    expect(overlay.element.hasAttribute("hidden")).toBe(true);
  });
});
