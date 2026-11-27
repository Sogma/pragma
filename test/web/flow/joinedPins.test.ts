// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { joinedPins, measureHandles, meetingPoint } from "../../../web/flow/joinedPins.ts";

// Where wires meet on a card whose own pins are hidden: a pin per wire,
// stacked about the meeting point, measured ahead of the hidden pins.

describe("joinedPins", () => {
  it("stacks a pin per wire about the meeting point, in its type's color and on its side", () => {
    const pins = joinedPins(
      [
        { id: "prompt", type: "text" },
        { id: "video_1", type: "video" },
        { id: "start_frame", type: "image" },
      ],
      "target",
    );
    expect(pins.map((pin) => pin.className)).toEqual([
      "flow-joined-pin target type-text",
      "flow-joined-pin target type-video",
      "flow-joined-pin target type-image",
    ]);
    expect(pins.map((pin) => pin.dataset.handleid)).toEqual(["prompt", "video_1", "start_frame"]);
    expect(pins.map((pin) => pin.style.getPropertyValue("--join-offset"))).toEqual(["-8px", "0px", "8px"]);
    expect(joinedPins([{ id: "path", type: "text" }], "source")[0].style.getPropertyValue("--join-offset")).toBe("0px");
  });

  it("puts a card's joined pins ahead of its own, so a wire ends on the joined one", () => {
    const card = document.createElement("div");
    const own = document.createElement("span");
    own.className = "handle target";
    own.dataset.handleid = "aspect_ratio";
    card.append(own, ...joinedPins([{ id: "aspect_ratio", type: "text" }], "target"));
    const rect = card.getBoundingClientRect();
    const bounds = measureHandles(card, rect, 1, "v1", "target");
    expect(bounds[0]).toMatchObject({ id: "aspect_ratio", nodeId: "v1", type: "target", position: "left" });
    expect(bounds.find((bound) => bound.id === "aspect_ratio")).toBe(bounds[0]);
    expect(meetingPoint("v1", "source", 240, 15)).toEqual({
      id: null,
      nodeId: "v1",
      type: "source",
      position: "right",
      x: 240,
      y: 15,
      width: 0,
      height: 0,
    });
  });

  // A hidden pin left in the measure would catch a connection drag ending near it.
  it("leaves out a pin of the card's own that doesn't show", () => {
    const card = document.createElement("div");
    const pin = (id: string, shows: boolean) => {
      const el = document.createElement("span");
      el.className = "handle source";
      el.dataset.handleid = id;
      Object.defineProperty(el, "checkVisibility", { value: () => shows });
      return el;
    };
    card.append(pin("image", true), pin("width", false), pin("height", true));
    const bounds = measureHandles(card, card.getBoundingClientRect(), 1, "l1", "source");
    expect(bounds.map((bound) => bound.id)).toEqual(["image", "height"]);
  });
});
