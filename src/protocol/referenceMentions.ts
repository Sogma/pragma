import { IMAGE_REFERENCES_MAX, VIDEO_REFERENCES_MAX } from "./flowNodes.ts";

/** The kinds of reference a prompt names by pin: `@image_N` and `@video_N`,
 * each its pin's id after an @. */
export type MentionKind = "image" | "video";

const CEILINGS: Record<MentionKind, number> = { image: IMAGE_REFERENCES_MAX, video: VIDEO_REFERENCES_MAX };

// What a prompt's mention becomes for a model whose words for a reference
// the host doesn't know. `{n}` is the reference's place among those of its
// kind that are sent.
export const DEFAULT_MENTIONS: Record<MentionKind, string> = {
  image: "reference image {n}",
  video: "reference video {n}",
};

export interface Mention {
  start: number;
  end: number;
  pin: number;
}

/** A prompt's mentions of a Generate node's reference pins of one kind, for
 * N from 1 to that kind's ceiling. A larger number, or one with a leading
 * zero, names no pin and stays plain text. */
export function referenceMentions(text: string, kind: MentionKind): Mention[] {
  const mentions: Mention[] = [];
  for (const match of text.matchAll(new RegExp(`@${kind}_(\\d+)\\b`, "g"))) {
    const pin = Number(match[1]);
    if (match[1].startsWith("0") || pin > CEILINGS[kind]) continue;
    mentions.push({ start: match.index, end: match.index + match[0].length, pin });
  }
  return mentions;
}

/** The pins of one kind a prompt names, each once, in the order first named. */
export function mentionedPins(text: string, kind: MentionKind): number[] {
  return [...new Set(referenceMentions(text, kind).map((mention) => mention.pin))];
}

/** The prompt a model gets: each mention of `kind` becomes `template` with
 * `{n}` set to its pin's place among `sent`, the pins of that kind whose
 * references go with the prompt, in that order. Throws for a mention of a
 * pin not among them. */
export function spellMentions(text: string, kind: MentionKind, sent: readonly number[], template: string): string {
  let spelled = "";
  let from = 0;
  for (const { start, end, pin } of referenceMentions(text, kind)) {
    const place = sent.indexOf(pin) + 1;
    if (!place) throw new Error(`The prompt names @${kind}_${pin}, but no ${kind} is sent for it`);
    spelled += text.slice(from, start) + template.replaceAll("{n}", String(place));
    from = end;
  }
  return spelled + text.slice(from);
}
