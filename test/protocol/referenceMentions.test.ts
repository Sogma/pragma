import { describe, expect, it } from "vitest";
import { IMAGE_REFERENCES_MAX } from "../../src/protocol/flowNodes.ts";
import {
  DEFAULT_IMAGE_MENTION,
  imageMentions,
  mentionedImagePins,
  spellImageMentions,
} from "../../src/protocol/referenceMentions.ts";

describe("imageMentions", () => {
  it("finds each @image_N naming a pin, with where it stands", () => {
    expect(imageMentions("Put @image_2 on @image_12.")).toEqual([
      { start: 4, end: 12, pin: 2 },
      { start: 16, end: 25, pin: 12 },
    ]);
  });

  it("leaves a number past the ceiling, a leading zero and a longer word as text", () => {
    const past = `@image_${IMAGE_REFERENCES_MAX + 1}`;
    expect(imageMentions(`${past} @image_02 @image_1x @image_1_b @images_1`)).toEqual([]);
  });
});

describe("mentionedImagePins", () => {
  it("names each pin once, in the order first named", () => {
    expect(mentionedImagePins("@image_3, @image_1 and @image_3 again")).toEqual([3, 1]);
  });
});

describe("spellImageMentions", () => {
  it("sends each mention as its pin's place among those sent, in the given words", () => {
    expect(spellImageMentions("@image_5 walks past @image_2", [2, 5], "Image {n}")).toBe("Image 2 walks past Image 1");
    expect(spellImageMentions("Light it like @image_7", [7], DEFAULT_IMAGE_MENTION)).toBe(
      "Light it like reference image 1",
    );
  });

  it("refuses a mention of a pin not sent", () => {
    expect(() => spellImageMentions("Use @image_4", [1, 2], "Image {n}")).toThrow(
      "The prompt names @image_4, but no image is sent for it",
    );
  });

  it("leaves a prompt with no mention as it is", () => {
    expect(spellImageMentions("A lighthouse at dusk", [1], "Image {n}")).toBe("A lighthouse at dusk");
  });
});
