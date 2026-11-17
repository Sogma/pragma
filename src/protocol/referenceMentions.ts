import { IMAGE_REFERENCES_MAX } from "./flowNodes.ts";

// What a prompt's mention becomes for a model whose words for a reference
// the host doesn't know. `{n}` is the image's place among those sent.
export const DEFAULT_IMAGE_MENTION = "reference image {n}";

export interface ImageMention {
  start: number;
  end: number;
  pin: number;
}

/** A prompt's mentions of a Generate node's reference pins: `@image_N`, the
 * pin's id after an @, for N from 1 to the pins' ceiling. A larger number,
 * or one with a leading zero, names no pin and stays plain text. */
export function imageMentions(text: string): ImageMention[] {
  const mentions: ImageMention[] = [];
  for (const match of text.matchAll(/@image_(\d+)\b/g)) {
    const pin = Number(match[1]);
    if (match[1].startsWith("0") || pin > IMAGE_REFERENCES_MAX) continue;
    mentions.push({ start: match.index, end: match.index + match[0].length, pin });
  }
  return mentions;
}

/** The pins a prompt names, each once, in the order first named. */
export function mentionedImagePins(text: string): number[] {
  return [...new Set(imageMentions(text).map((mention) => mention.pin))];
}

/** The prompt a model gets: each mention becomes `template` with `{n}` set
 * to its pin's place among `sent`, the pins whose images go with the prompt,
 * in that order. Throws for a mention of a pin not among them. */
export function spellImageMentions(text: string, sent: readonly number[], template: string): string {
  let spelled = "";
  let from = 0;
  for (const { start, end, pin } of imageMentions(text)) {
    const place = sent.indexOf(pin) + 1;
    if (!place) throw new Error(`The prompt names @image_${pin}, but no image is sent for it`);
    spelled += text.slice(from, start) + template.replaceAll("{n}", String(place));
    from = end;
  }
  return spelled + text.slice(from);
}
