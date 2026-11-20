import { describe, expect, it } from "vitest";
import { isTaskModes, modeConflict, taskMode } from "../../src/protocol/videoModes.ts";

describe("taskMode", () => {
  const seedance = ["t2v", "omni_reference", "video_edit", "video_extension"];
  it("picks the task the inputs ask for in each spelling, references over frames", () => {
    expect(taskMode(seedance, { references: true, frames: true })).toBe("omni_reference");
    expect(taskMode(seedance, { references: false, frames: false })).toBe("t2v");
    expect(taskMode(["text-to-video", "reference-to-video", "edit"], { references: true, frames: false })).toBe(
      "reference-to-video",
    );
  });

  it("leaves the mode to the server where no option names the task", () => {
    // A model taking a frame in omni_reference is moved there by the server.
    expect(taskMode(seedance, { references: false, frames: true })).toBeUndefined();
    expect(taskMode(["std", "pro", "4k"], { references: true, frames: false })).toBeUndefined();
    expect(taskMode([], { references: false, frames: false })).toBeUndefined();
  });
});

describe("isTaskModes", () => {
  it("tells a task's modes from a quality tier's", () => {
    expect(isTaskModes(["t2v", "omni_reference", "video_edit"])).toBe(true);
    expect(isTaskModes(["text-to-video", "reference-to-video", "edit"])).toBe(true);
    expect(isTaskModes(["std", "pro", "4k"])).toBe(false);
  });
});

describe("modeConflict", () => {
  const none = { references: false, clips: false, frames: false };
  it("says why a picked mode can't take what's wired", () => {
    expect(modeConflict("text-to-video", { ...none, references: true })?.message).toBe(
      'Mode "text-to-video" takes no frames or references. Pick Auto, or a mode that takes them',
    );
    expect(modeConflict("t2v", { ...none, frames: true })?.hint).toBe("takes no references");
    expect(modeConflict("video_edit", { ...none, references: true })?.message).toBe(
      'Mode "video_edit" needs a clip on a video reference',
    );
    expect(modeConflict("image-to-video", none)?.hint).toBe("needs a frame");
    expect(modeConflict("reference-to-video", none)?.hint).toBe("needs a reference");
  });

  it("finds nothing for a mode its inputs fit, none picked, or a quality tier", () => {
    expect(modeConflict("edit", { references: true, clips: true, frames: false })).toBeUndefined();
    expect(modeConflict("omni_reference", { ...none, frames: true })).toBeUndefined();
    expect(modeConflict("text-to-video", none)).toBeUndefined();
    expect(modeConflict(undefined, { ...none, references: true })).toBeUndefined();
    expect(modeConflict("pro", { ...none, references: true })).toBeUndefined();
  });
});
