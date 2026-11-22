// The Tags section under the space tree: the tags the space declares in
// `_tags.json` (docs/protocol.md's Tags), each drawn as its pill. A tag is
// declared here or from a tag input's "Add to Tags" row; applying one to a
// document never declares it.
//
// The pill only shows the tag. Its color changes through the row's context
// menu, which leaves a click on the pill free to open the tag itself.

import type { SpaceTagChangeRequestBody } from "../../../src/protocol/api.ts";
import { illegalTagNameReason, sameTag, type TagDefinition, tagKey, tagNameOf } from "../../../src/protocol/tags.ts";
import { openColorPicker } from "../../colorPicker.ts";
import type { TagVocabulary } from "../../core/tagVocabulary.ts";
import { el } from "../../lib/dom.ts";
import { flash } from "../../lib/flash.ts";
import { attachEditInputHandlers } from "../../lib/inlineEdit.ts";
import { createSectionAction } from "../../lib/sectionStack.ts";
import { createTagPill } from "../../lib/tagPill.ts";
import type { ContextMenuService, MenuItem } from "../../services/menus.ts";

export interface TagsSectionDeps {
  tags: TagVocabulary;
  contextMenu: ContextMenuService;
}

export interface TagsSection {
  // What the Space panel holds under the section's header.
  readonly body: HTMLElement;
  // The header's own actions: Add tag.
  readonly actions: HTMLElement[];
  // Reads the tags afresh and draws them.
  refresh(): void;
  // Where the section's header shows how many tags it lists: "" for none,
  // or for a file that doesn't read.
  showCountIn(setCount: (text: string) => void): void;
}

// Each tag once, as the first entry naming it has it, alphabetically.
function listed(tags: readonly TagDefinition[]): TagDefinition[] {
  const seen = new Set<string>();
  return tags
    .filter((tag) => !seen.has(tagKey(tag.name)) && seen.add(tagKey(tag.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function createTagsSection(deps: TagsSectionDeps): TagsSection {
  const body = el("div", "tags-section");
  const message = el("p", "stack-section-message");
  message.hidden = true;
  const list = el("div", "tags-section-list");
  list.hidden = true;
  body.append(message, list);
  const add = createSectionAction("Add tag", "plus", () => startNaming());

  // Nothing shows until the first read settles: neither an empty list nor
  // a message that may turn out to be wrong.
  let loaded = false;
  // The new tag's name field while it's open, kept across redraws.
  let naming: HTMLElement | undefined;
  let setCount: ((text: string) => void) | undefined;

  async function apply(change: SpaceTagChangeRequestBody): Promise<void> {
    try {
      await deps.tags.change(change);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Changing the tag failed");
    }
  }

  function render(): void {
    if (!loaded && !naming) return;
    // A file that doesn't read declares nothing and takes no changes, so
    // the section says why instead of offering any.
    const problem = deps.tags.problem();
    if (problem !== undefined) naming = undefined;
    const tags = listed(deps.tags.known());
    setCount?.(problem === undefined && tags.length > 0 ? tags.length.toLocaleString() : "");
    add.hidden = problem !== undefined;
    const text = problem ?? (tags.length === 0 && !naming ? "No tags in this space yet." : undefined);
    message.textContent = text ?? "";
    message.hidden = text === undefined;
    list.hidden = text !== undefined;
    list.replaceChildren(...(naming ? [naming] : []), ...tags.map(row));
  }

  function row(tag: TagDefinition): HTMLElement {
    const item = el("div", "tags-section-row");
    item.dataset.tagName = tag.name;
    const pill = createTagPill(tag.name, deps.tags.known());
    pill.classList.add("tags-section-pill");
    pill.dataset.tooltipOverflow = "";
    item.append(pill);
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      deps.contextMenu.open({ items: actions(tag, pill), at: { x: event.clientX, y: event.clientY } });
    });
    return item;
  }

  function actions(tag: TagDefinition, pill: HTMLElement): MenuItem[] {
    return [
      {
        label: "Color…",
        run: () =>
          openColorPicker({ anchor: pill, value: tag.color, onPick: (color) => void apply({ name: tag.name, color }) }),
      },
      { label: "Remove from Tags", group: "remove", run: () => apply({ name: tag.name, remove: true }) },
    ];
  }

  function startNaming(): void {
    if (naming) {
      naming.querySelector("input")?.focus();
      return;
    }
    const field = el("div", "tags-section-new");
    const input = el("input", "form-input");
    input.type = "text";
    input.placeholder = "Tag name";
    input.setAttribute("aria-label", "New tag's name");
    field.append(input);
    attachEditInputHandlers(input, (value) => void submitName(value), stopNaming);
    naming = field;
    render();
    input.focus();
  }

  function stopNaming(): void {
    naming = undefined;
    render();
  }

  // A name the list already holds, case aside, is shown rather than added
  // under a second spelling. One that names no tag is refused, saying why.
  async function submitName(value: string): Promise<void> {
    stopNaming();
    if (!value.trim()) return;
    const name = tagNameOf(value);
    if (name === undefined) {
      window.alert(illegalTagNameReason(value));
      return;
    }
    const known = deps.tags.known().find((tag) => sameTag(tag.name, name));
    if (!known) {
      await apply({ name });
      return;
    }
    const found = [...list.children].find((child) => (child as HTMLElement).dataset.tagName === known.name);
    if (!(found instanceof HTMLElement)) return;
    found.scrollIntoView?.({ block: "nearest" });
    flash(found);
  }

  deps.tags.subscribe(render);

  return {
    body,
    actions: [add],
    refresh: () =>
      void deps.tags.read().then(() => {
        loaded = true;
        render();
      }),
    showCountIn: (show) => {
      setCount = show;
      render();
    },
  };
}
