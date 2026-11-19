import { describe, expect, it } from "vitest";
import { IMAGE_REFERENCES_MAX, VIDEO_REFERENCES_MAX } from "../../src/protocol/flowNodes.ts";
import {
  DEFAULT_MENTIONS,
  mentionedPins,
  referenceMentions,
  spellMentions,
} from "../../src/protocol/referenceMentions.ts";

describe("referenceMentions", () => {
  it("finds each @image_N naming a pin, with where it stands", () => {
    expect(referenceMentions("Put @image_2 on @image_12.", "image")).toEqual([
      { start: 4, end: 12, pin: 2 },
      { start: 16, end: 25, pin: 12 },
    ]);
  });

  it("leaves a number past the ceiling, a leading zero and a longer word as text", () => {
    const past = `@image_${IMAGE_REFERENCES_MAX + 1}`;
    expect(referenceMentions(`${past} @image_02 @image_1x @image_1_b @images_1`, "image")).toEqual([]);
  });

  // Each kind has its own pins and ceiling, so a clip's mention is never an image's.
  it("finds @video_N apart from @image_N, up to the clips' own ceiling", () => {
    const text = `@video_1 moves like @image_1, then @video_${VIDEO_REFERENCES_MAX + 1}`;
    expect(referenceMentions(text, "video")).toEqual([{ start: 0, end: 8, pin: 1 }]);
    expect(referenceMentions(text, "image").map((mention) => mention.pin)).toEqual([1]);
  });
});

describe("mentionedPins", () => {
  it("names each pin once, in the order first named", () => {
    expect(mentionedPins("@image_3, @image_1 and @image_3 again", "image")).toEqual([3, 1]);
    expect(mentionedPins("@video_2 then @image_1 then @video_2", "video")).toEqual([2]);
  });
});

describe("spellMentions", () => {
  it("sends each mention as its pin's place among those sent, in the given words", () => {
    expect(spellMentions("@image_5 walks past @image_2", "image", [2, 5], "Image {n}")).toBe(
      "Image 2 walks past Image 1",
    );
    expect(spellMentions("Light it like @image_7", "image", [7], DEFAULT_MENTIONS.image)).toBe(
      "Light it like reference image 1",
    );
  });

  it("spells a clip's mention by its place among the clips sent, leaving images alone", () => {
    expect(spellMentions("Move like @video_3 in @image_1", "video", [3], "@Video{n}")).toBe(
      "Move like @Video1 in @image_1",
    );
    expect(spellMentions("Pan as in @video_2", "video", [1, 2], DEFAULT_MENTIONS.video)).toBe(
      "Pan as in reference video 2",
    );
  });

  it("refuses a mention of a pin not sent", () => {
    expect(() => spellMentions("Use @image_4", "image", [1, 2], "Image {n}")).toThrow(
      "The prompt names @image_4, but no image is sent for it",
    );
    expect(() => spellMentions("Use @video_4", "video", [1], "Video {n}")).toThrow(
      "The prompt names @video_4, but no video is sent for it",
    );
  });

  it("leaves a prompt with no mention as it is", () => {
    expect(spellMentions("A lighthouse at dusk", "image", [1], "Image {n}")).toBe("A lighthouse at dusk");
  });
});
