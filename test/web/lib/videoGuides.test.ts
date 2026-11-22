// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createGuidesOverlay,
  frameBox,
  framingBox,
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

// The cut holds the protection, so the framing is shrunk inside it.
describe("framingBox", () => {
  it("shrinks a frame's cut about its middle by the share kept around it", () => {
    expect(framingBox({ x: 0, y: 0, width: 1920, height: 1080 }, 0.1)).toEqual({
      x: 96,
      y: 54,
      width: 1728,
      height: 972,
    });
    const cut = { x: 656.25, y: 0, width: 607.5, height: 1080 };
    expect(framingBox(cut, 0)).toEqual(cut);
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
      cross: true,
      level: true,
      protection: 0.07,
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

  it("keeps a protection in whole percents up to a quarter, and reads any other as none", () => {
    const protection = (value: unknown) => readGuides(JSON.stringify({ protection: value })).protection;
    expect([0.07, 0.25, 0.088, 0.3, -0.05, "0.1", null].map(protection)).toEqual([0.07, 0.25, 0.09, 0, 0, 0, 0]);
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

  // Framings inside their protection fill neither the picture's width nor its height.
  it("mattes a band down each side and a strip above and below each step of boxes short of both edges", () => {
    expect(matteOutside(1920, 1080, [framingBox(wide, 0.1)])).toBe(
      "M0 0H96V1080H0Z M1824 0H1920V1080H1824Z M96 0H1824V178.49H96Z M96 901.51H1824V1080H96Z",
    );
    expect(matteOutside(1920, 1080, [framingBox(tall, 0.1), framingBox(wide, 0.1)])).toBe(
      "M0 0H96V1080H0Z M1824 0H1920V1080H1824Z M96 0H686.63V178.49H96Z M686.63 0H1233.37V54H686.63Z " +
        "M1233.37 0H1824V178.49H1233.37Z M96 901.51H686.63V1080H96Z M686.63 1026H1233.37V1080H686.63Z " +
        "M1233.37 901.51H1824V1080H1233.37Z",
    );
    // A box inside another adds no step.
    expect(matteOutside(1920, 1080, [framingBox(wide, 0.1), framingBox(frameBox(1920, 1080, 1.85), 0.1)])).toBe(
      matteOutside(1920, 1080, [framingBox(frameBox(1920, 1080, 1.85), 0.1)]),
    );
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
    const svg = overlay.element.querySelector(".video-guides-lines") as SVGSVGElement;
    // The shapes drawn, in their order: each outline in the frames' group, and the level's marks while it shows.
    const shown = () =>
      [...svg.children]
        .flatMap((node) =>
          node.tagName !== "g" ? [node] : node.getAttribute("display") === "none" ? [] : [...node.children],
        )
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
      "video-guides-line is-frame",
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
      "video-guides-line is-frame",
      "video-guides-line is-frame",
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
    expect(shown()).toEqual(["video-guides-matte", "video-guides-line is-frame", "video-guides-line"]);
    const social = [...svg.querySelectorAll("rect")].at(-1) as Element;
    // The 9:16 cut is 607.5 by 1080 from x 656.25: 5% of its width off the left, 20% of its height off the top.
    expect(["x", "y", "width", "height"].map((name) => social.getAttribute(name))).toEqual([
      "686.63",
      "216",
      "473.85",
      "486",
    ]);
  });

  // On a 1920 by 1080 picture, the measured mark exactly: 7px bars from 4.5px off the middle out to 32.5px.
  it("draws the cross through the frame's middle, its lines out to the edges and stopping at its bars", () => {
    const { choice, overlay, svg, shown } = draw({ ...NO_GUIDES, cross: true });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual(["video-guides-line is-cross", "video-guides-cross-bars"]);
    const [, , lines, bars, keep, cut] = [...svg.querySelectorAll("path")];
    expect(lines.getAttribute("d")).toBe("M960 0V507.5M960 572.5V1080M0 540H927.5M992.5 540H1920");
    expect(bars.getAttribute("d")).toBe(
      "M956.5 507.5H963.5V535.5H956.5Z M956.5 544.5H963.5V572.5H956.5Z M927.5 536.5H955.5V543.5H927.5Z M964.5 536.5H992.5V543.5H964.5Z",
    );
    // The bars' mask keeps the picture but where the lines run on through them.
    const mask = svg.querySelector("mask") as SVGMaskElement;
    expect(bars.getAttribute("mask")).toBe(`url(#${mask.id})`);
    expect([keep.parentNode, cut.parentNode]).toEqual([mask, mask]);
    expect(keep.getAttribute("d")).toBe("M0 0H1920V1080H0Z");
    expect(cut.getAttribute("d")).toBe("M960 507.5V572.5M927.5 540H992.5");
    // A frame cut from the picture leaves the cross whole: it marks the picture itself.
    const whole = [lines, bars, cut].map((path) => path.getAttribute("d"));
    choice.set({ ...NO_GUIDES, frames: ["9:16"], cross: true });
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-frame",
      "video-guides-line is-cross",
      "video-guides-cross-bars",
    ]);
    expect([lines, bars, cut].map((path) => path.getAttribute("d"))).toEqual(whole);
  });

  // On a 1920 by 1080 picture: the 2.39 cut, and 10% of it kept around its framing.
  it("draws a frame's framing inside its cut, the cut keeping the protection, and the guides inside the framing", () => {
    const { overlay, svg, shown, names, box } = draw({ ...NO_GUIDES, frames: ["2.39"], title: true, protection: 0.1 });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-protection",
      "video-guides-line is-frame",
      "video-guides-line",
    ]);
    // The matte shades what the frame line leaves out, the protection with it.
    expect(svg.querySelector(".video-guides-matte")?.getAttribute("d")).toBe(
      "M0 0H96V1080H0Z M1824 0H1920V1080H1824Z M96 0H1824V178.49H96Z M96 901.51H1824V1080H96Z",
    );
    const [protection, framing, , , title] = [...svg.querySelectorAll("rect")];
    expect(box(protection)).toEqual(["0", "138.33", "1920", "803.35"]);
    expect(box(framing)).toEqual(["96", "178.49", "1728", "723.01"]);
    expect(box(title)).toEqual(["182.4", "214.64", "1555.2", "650.71"]);
    expect(names()).toEqual([["2.39", 5, 16.53]]);
  });

  // A wide frame and a tall one hold neither each other: each keeps its own protection.
  it("keeps protection around each frame no other holds, and draws the guides where their framings overlap", () => {
    const { overlay, svg, shown, box } = draw({
      ...NO_GUIDES,
      frames: ["9:16", "2.39"],
      extents: true,
      protection: 0.1,
    });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-protection",
      "video-guides-line is-frame",
      "video-guides-line is-protection",
      "video-guides-line is-frame",
      "video-guides-line is-extents",
    ]);
    expect(box(svg.querySelector(".is-extents") as Element)).toEqual(["686.63", "178.49", "546.75", "723.01"]);
  });

  // Protection is measured on the largest lit frame, whose frame line a smaller one inside it fits as it is.
  it("draws the protection of frames inside a larger one only around the larger, their frame lines kept", () => {
    const { choice, overlay, svg, shown, box } = draw({ ...NO_GUIDES, frames: ["1:1", "9:16"], protection: 0.1 });
    overlay.setSize(1920, 1080);
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-protection",
      "video-guides-line is-frame",
      "video-guides-line is-frame",
    ]);
    const [protection, square, tall] = [...svg.querySelectorAll("rect")];
    expect([box(protection), box(square), box(tall)]).toEqual([
      ["420", "0", "1080", "1080"],
      ["474", "54", "972", "972"],
      ["686.63", "54", "546.75", "972"],
    ]);
    // A frame of the picture's own shape holds every other: its protection is the picture's edge.
    choice.set({ ...NO_GUIDES, frames: ["16:9", "2.39"], protection: 0.1 });
    expect(shown()).toEqual(["video-guides-matte", "video-guides-line is-frame", "video-guides-line is-frame"]);
    // Two frames of one shape are outlined once, the first lit.
    overlay.setSize(1440, 1080);
    choice.set({ ...NO_GUIDES, frames: ["16:9", "1.77"], protection: 0.1 });
    expect(shown()).toEqual([
      "video-guides-matte",
      "video-guides-line is-protection",
      "video-guides-line is-frame",
      "video-guides-line is-frame",
    ]);
  });

  // With no frame lit the picture is the frame, whose protection runs out to the picture's edge.
  it("frames the whole picture inside the protection with no frame lit, as it does a frame of its own shape", () => {
    const { choice, overlay, svg, shown, names, box } = draw({ ...NO_GUIDES, protection: 0.1 });
    overlay.setSize(1920, 1080);
    expect(overlay.element.hasAttribute("hidden")).toBe(false);
    expect([shown(), names()]).toEqual([["video-guides-matte", "video-guides-line is-frame"], []]);
    expect(box(svg.querySelector(".is-frame") as Element)).toEqual(["96", "54", "1728", "972"]);
    expect(svg.querySelector(".video-guides-matte")?.getAttribute("d")).toBe(
      "M0 0H96V1080H0Z M1824 0H1920V1080H1824Z M96 0H1824V54H96Z M96 1026H1824V1080H96Z",
    );
    choice.set({ ...NO_GUIDES, frames: ["16:9"], action: true, protection: 0.1 });
    expect([shown(), names()]).toEqual([
      ["video-guides-matte", "video-guides-line is-frame", "video-guides-line"],
      [["16:9", 5, 5]],
    ]);
    const [, , action] = [...svg.querySelectorAll("rect")];
    expect(box(action)).toEqual(["156.48", "88.02", "1607.04", "903.96"]);
  });

  // A frame of the picture's own shape is its edge, and shows all of it.
  it("draws no matte, line or name for a frame of the picture's own shape, and hides every guide while they're off", () => {
    const { choice, overlay, shown, names } = draw({ ...NO_GUIDES, frames: ["16:9"], action: true });
    overlay.setSize(1920, 1080);
    expect([shown(), names()]).toEqual([["video-guides-line"], []]);
    choice.set({ ...NO_GUIDES, frames: ["9:16", "16:9"] });
    expect([shown(), names().map(([name]) => name)]).toEqual([["video-guides-line is-frame"], ["9:16"]]);
    choice.set({ ...NO_GUIDES, action: true, shown: false });
    expect(overlay.element.hasAttribute("hidden")).toBe(true);
  });

  // On a 1920 by 1080 picture the display draws in its own pixels from the middle, unscaled.
  it("draws the level display over the whole picture, its horizon out to both edges", () => {
    const { choice, overlay, svg, shown } = draw({ ...NO_GUIDES, level: true });
    overlay.setSize(1920, 1080);
    const level = svg.querySelector(".video-guides-level") as SVGGElement;
    const horizon = svg.querySelector(".video-guides-level-horizon") as SVGPathElement;
    expect(shown()).toEqual([
      "video-guides-level-horizon",
      "video-guides-level-ends",
      "video-guides-level-brackets",
      "video-guides-level-pitch",
      "video-guides-level-indicator",
      "video-guides-level-roll",
      "video-guides-level-dots",
    ]);
    expect([level.getAttribute("transform"), horizon.getAttribute("d")]).toEqual([
      "translate(960 540) scale(1)",
      "M-960 0H-215M215 0H960",
    ]);
    // Half the size, half the scale; a tall picture sizes it by its width, the horizon still out to its edges.
    overlay.setSize(960, 540);
    expect([level.getAttribute("transform"), horizon.getAttribute("d")]).toEqual([
      "translate(480 270) scale(0.5)",
      "M-960 0H-215M215 0H960",
    ]);
    overlay.setSize(1080, 1920);
    expect([level.getAttribute("transform"), horizon.getAttribute("d")]).toEqual([
      "translate(540 960) scale(1)",
      "M-540 0H-215M215 0H540",
    ]);
    // A frame cut from the picture leaves it whole.
    choice.set({ ...NO_GUIDES, frames: ["16:9"], level: true });
    expect([level.getAttribute("transform"), horizon.getAttribute("d")]).toEqual([
      "translate(540 960) scale(1)",
      "M-540 0H-215M215 0H540",
    ]);
    choice.set({ ...NO_GUIDES, title: true });
    expect(level.getAttribute("display")).toBe("none");
  });

  // Ids are page-wide: a shared one would hand every player's bars the first player's mask.
  it("gives each overlay's cross a mask of its own", () => {
    const masks = [draw(NO_GUIDES), draw(NO_GUIDES)].map(({ svg }) => svg.querySelector("mask") as SVGMaskElement);
    expect(masks[0].id).not.toBe(masks[1].id);
  });

  it("stops following the choice once disposed", () => {
    const { choice, overlay } = draw(NO_GUIDES);
    overlay.setSize(1920, 1080);
    overlay.dispose();
    choice.set({ ...NO_GUIDES, title: true });
    expect(overlay.element.hasAttribute("hidden")).toBe(true);
  });
});
