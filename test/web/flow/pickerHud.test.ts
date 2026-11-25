// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPickedPicture, storedFile } from "../../../web/flow/pickerHud.ts";

describe("pickerHud", () => {
  it("names a stored path's file and sizes it from its base64 data", () => {
    expect(storedFile("space:refs/pic.png", "AAAA")).toEqual({ name: "pic.png", size: 3 });
    expect(storedFile("pic.png", "AAA=")).toEqual({ name: "pic.png", size: 2 });
    expect(storedFile("lib:footage/shots/plate.jpg", "AA==").name).toBe("plate.jpg");
  });

  it("holds the picture and its bars in one box, which takes the picture's shape once it decodes", () => {
    const { el, img } = createPickedPicture("data:image/png;base64,AAAA", { name: "plate.png", size: 2048 });
    const bars = el.querySelector(":scope > .media-hud") as HTMLElement;
    expect([...el.children]).toEqual([img, bars]);
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(bars.hidden).toBe(false);

    // jsdom decodes nothing: the picture's natural size is set by hand.
    Object.defineProperties(img, { naturalWidth: { value: 896 }, naturalHeight: { value: 1344 } });
    img.dispatchEvent(new Event("load"));
    expect(el.style.aspectRatio).toBe("896 / 1344");
    expect(Number(el.style.getPropertyValue("--picture-ratio"))).toBeCloseTo(2 / 3);
    // The dimensions and the scale in one box, then the ratio alone, the
    // stand-in a narrow App mode tile shows instead; jsdom lays nothing out,
    // so no scale.
    const cells = [...bars.children].map((bar) =>
      [...bar.children].map((cell) =>
        cell.classList.contains("flow-picture-facts")
          ? [...cell.children].map((fact) => fact.textContent)
          : cell.textContent,
      ),
    );
    expect(cells).toEqual([
      [["896 × 1344 (2:3)", ""], "2:3"],
      ["plate.png", "2.0 KB"],
    ]);
    expect(bars.querySelector(".flow-picture-ratio")?.textContent).toBe("2:3");
  });

  // On a card the picture's box has its shape; in App mode it fills the
  // tile, which contains the picture.
  it("shows the scale the picture is drawn at, measured as it loads and as the pointer arrives", () => {
    const { el, img } = createPickedPicture("data:image/png;base64,AAAA", { name: "plate.png", size: 2048 });
    const scale = () => el.querySelector(".flow-picture-facts")?.lastElementChild?.textContent;
    let box = [448, 672];
    Object.defineProperties(img, {
      naturalWidth: { value: 896 },
      naturalHeight: { value: 1344 },
      clientWidth: { get: () => box[0] },
      clientHeight: { get: () => box[1] },
    });
    img.dispatchEvent(new Event("load"));
    expect(scale()).toBe("50%");

    // A tile wider than the picture's shape: it is drawn at the tile's height.
    box = [600, 336];
    img.dispatchEvent(new Event("pointerenter"));
    expect(scale()).toBe("25%");
  });
});
