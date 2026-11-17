// The pill a list value shows as, and a tag's: filled with its tag's color
// from the space's tag vocabulary (docs/protocol.md's Tags: `color` is the
// pill's display color), its text whichever of dark or light reads better on
// it. A tag the vocabulary doesn't color keeps the plain pill. A pill is a
// tag's when it carries `data-tag`.
//
// Every surface draws its pills here, and the editor's in-text tag takes its
// colors here, so no surface can show a tag without its color.
import { illegalTagNameReason, type TagDefinition, tagDefinition, tagNameOf } from "../../src/protocol/tags.ts";
import { normalizeHexColor } from "../../src/protocol/types.ts";
import { readableTextColor } from "./color.ts";
import type { TagSource } from "./tagSuggestions.ts";

export function createPill(text: string): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "pill";
  const label = document.createElement("span");
  label.className = "pill-label";
  label.textContent = text;
  pill.append(label);
  return pill;
}

/** The pill of the tag `value` names, filled at once from `tags`; without
 * them, once the pills around it are painted. A value that names no tag
 * keeps the plain pill, its tooltip saying why. */
export function createTagPill(value: string, tags?: readonly TagDefinition[]): HTMLElement {
  const name = tagNameOf(value);
  if (name === undefined) {
    const pill = createPill(value);
    pill.dataset.tooltip = illegalTagNameReason(value) ?? "";
    return pill;
  }
  const pill = createPill(name);
  pill.dataset.tag = name;
  if (tags) paintTagPill(pill, tags);
  return pill;
}

/** The fill a tag's pill takes and the text color that reads on it; none
 * for a tag the vocabulary doesn't color. */
export function tagPillColors(
  name: string,
  tags: readonly TagDefinition[],
): { background: string; color: string } | undefined {
  const background = normalizeHexColor(tagDefinition(tags, name)?.color ?? "");
  return background ? { background, color: readableTextColor(background) } : undefined;
}

export function paintTagPill(pill: HTMLElement, tags: readonly TagDefinition[]): void {
  const colors = tagPillColors(pill.dataset.tag ?? "", tags);
  pill.classList.toggle("has-tag-color", colors !== undefined);
  pill.style.background = colors?.background ?? "";
  pill.style.color = colors?.color ?? "";
}

/** Paints every tag pill under `root` from the vocabulary as last read, and
 * again once a fresh read lands. With no tag pills there, nothing is read. */
export function paintTagPills(root: ParentNode, source: TagSource): void {
  const paint = () => {
    for (const pill of root.querySelectorAll<HTMLElement>("[data-tag]")) paintTagPill(pill, source.known());
  };
  if (!root.querySelector("[data-tag]")) return;
  paint();
  void source.read().then(paint);
}
