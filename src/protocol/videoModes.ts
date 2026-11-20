// A video model's task modes, in each spelling a provider's catalog writes
// them, and what a node's inputs say about them: the one they ask for, and
// why a picked one can't take them. A `mode` naming none of these is a
// quality tier, and is left to the person.

const TEXT = ["text-to-video", "t2v"];
const FRAMES = ["image-to-video"];
const REFERENCES = ["reference-to-video", "omni_reference"];
const SOURCE_CLIP = ["edit", "extend", "video-edit", "video_edit", "video_extension"];

/** What a node has wired: references of any kind, clips among them, and frames. */
export interface WiredInputs {
  references: boolean;
  clips: boolean;
  frames: boolean;
}

/** Whether a model's `mode` options are tasks rather than a quality tier. */
export function isTaskModes(modes: readonly string[]): boolean {
  return modes.some((mode) => [...TEXT, ...FRAMES, ...REFERENCES, ...SOURCE_CLIP].includes(mode));
}

/** The mode the inputs ask for among a model's own options: references, then
 * frames, then text alone. Never an edit or an extension, which only a
 * person's pick asks for; undefined when the model lists no such task. */
export function taskMode(modes: readonly string[], inputs: Omit<WiredInputs, "clips">): string | undefined {
  const asked = inputs.references ? REFERENCES : inputs.frames ? FRAMES : TEXT;
  return asked.find((spelling) => modes.includes(spelling));
}

/** Why a picked mode can't take the inputs: a short `hint` for its place in
 * a menu, and the node's error. Undefined when it can, or isn't a task. */
export function modeConflict(
  mode: string | undefined,
  inputs: WiredInputs,
): { hint: string; message: string } | undefined {
  if (!mode) return undefined;
  if (TEXT.includes(mode) && (inputs.references || inputs.frames)) {
    const message = `Mode "${mode}" takes no frames or references. Pick Auto, or a mode that takes them`;
    return { hint: "takes no references", message };
  }
  if (SOURCE_CLIP.includes(mode) && !inputs.clips) {
    return { hint: "needs a clip", message: `Mode "${mode}" needs a clip on a video reference` };
  }
  if (FRAMES.includes(mode) && !inputs.frames) {
    return { hint: "needs a frame", message: `Mode "${mode}" needs a start frame` };
  }
  if (REFERENCES.includes(mode) && !inputs.references && !inputs.frames) {
    return { hint: "needs a reference", message: `Mode "${mode}" needs a reference` };
  }
  return undefined;
}
