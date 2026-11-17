// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createGuidesOverlay,
  frameBox,
  type Guides,
  insetBox,
  NO_GUIDES,
  readGuides,
  SOCIAL_SAFE,
  TITLE_SAFE,
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
      frame: "2.39",
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
    expect(readGuides(JSON.stringify({ frame: "3:2", title: "yes" }))).toEqual(NO_GUIDES);
    expect(readGuides(JSON.stringify({ title: true }))).toEqual({ ...NO_GUIDES, title: true });
  });
});

describe("createGuidesOverlay", () => {
  function draw(guides: Guides) {
    const choice = memorySetting(guides);
    const overlay = createGuidesOverlay(choice);
    const svg = overlay.element;
    const shown = () =>
      [...svg.children]
        .filter((node) => node.getAttribute("display") === "inline")
        .map((node) => node.getAttribute("class"));
    return { choice, overlay, svg, shown };
  }

  it("stays hidden until the clip's size is known, and while nothing is picked", () => {
    const { choice, overlay, svg } = draw({ ...NO_GUIDES, title: true });
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("hidden")).toBe(true);
    overlay.setSize(1920, 1080);
    expect(svg.hasAttribute("hidden")).toBe(false);
    choice.set(NO_GUIDES);
    expect(svg.hasAttribute("hidden")).toBe(true);
  });

  it("mattes the picture outside a frame, outlines the frame, and draws its guides inside it", () => {
    const { overlay, svg, shown } = draw({ ...NO_GUIDES, frame: "9:16", extents: true, title: true, center: true });
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
      "M0 0H1920V1080H0Z M656.25 0V1080H1263.75V0Z",
    );
    const [cut, extents, , title] = [...svg.querySelectorAll("rect")];
    const box = (rect: Element) => ["x", "y", "width", "height"].map((name) => rect.getAttribute(name));
    expect(box(cut)).toEqual(["656.25", "0", "607.5", "1080"]);
    expect(box(extents)).toEqual(box(cut));
    expect(box(title)).toEqual(["686.63", "54", "546.75", "972"]);
    // The center mark, crossed at the frame's middle.
    expect(svg.querySelectorAll("path")[1]?.getAttribute("d")).toBe("M938.74 540H981.26M960 518.74V561.26");
  });

  it("draws the social safe area inside the frame, clear of its sides by their own shares", () => {
    const { overlay, svg, shown } = draw({ ...NO_GUIDES, frame: "9:16", social: true });
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

  it("draws no matte or outline for the clip's own frame, and hides every guide while they're off", () => {
    const { choice, overlay, svg, shown } = draw({ ...NO_GUIDES, action: true });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual(["video-guides-line"]);
    choice.set({ ...NO_GUIDES, action: true, shown: false });
    expect(svg.hasAttribute("hidden")).toBe(true);
  });

  it("stops following the choice once disposed", () => {
    const { choice, overlay, svg } = draw(NO_GUIDES);
    overlay.setSize(1920, 1080);
    overlay.dispose();
    choice.set({ ...NO_GUIDES, title: true });
    expect(svg.hasAttribute("hidden")).toBe(true);
  });
});
