// The add-tag input's suggestions: the space's tag vocabulary
// (docs/protocol.md's Tags) and the tags its documents carry, narrowed by
// what's typed, each tag with its color. A suggestion, never a rule: a tag
// the vocabulary doesn't list is still added, and a last row offers to add
// it to the vocabulary too.
//
// The input's own keydown takes the list's keys. It runs before the
// document's keybinding dispatcher, so Escape closes the list without also
// closing a dialog the input sits in.

import { isTagName, sameTag, type TagDefinition, tagKey, unmarkedTagName } from "../../src/protocol/tags.ts";
import { normalizeHexColor } from "../../src/protocol/types.ts";
import { createSuggestionList, type SuggestionRow } from "./suggestionList.ts";

export interface TagSource {
  // The vocabulary as last read, drawn at once while `read` refreshes it:
  // the tags cell is rebuilt after every add, and a list that waited on each
  // read would blink.
  known(): readonly TagDefinition[];
  // Never rejects; a vocabulary that can't be read suggests nothing.
  read(): Promise<readonly TagDefinition[]>;
  // Adds a tag to the vocabulary, rejecting with why it couldn't. Without
  // it, the list offers no "Add to Tags" row.
  declare?(name: string): Promise<void>;
  // The tags documents carry that the vocabulary doesn't declare, as last
  // read, suggested beside the declared ones.
  used?(): readonly string[];
}

export interface TagSuggestionsSpec {
  source: TagSource;
  // Tags the item already has, which the list leaves out.
  applied: () => readonly string[];
  onPick: (name: string) => void;
}

export interface TagSuggestions {
  // The highlighted suggestion, which Enter adds in place of the typed text.
  highlighted(): string | undefined;
}

const LIST_ID = "tag-suggestions";

export function attachTagSuggestions(input: HTMLInputElement, spec: TagSuggestionsSpec): TagSuggestions {
  let matches: TagDefinition[] = [];
  // The typed tag the last row offers to add to the vocabulary, while no
  // tag it lists matches it, case aside.
  let adding: string | undefined;
  const list = createSuggestionList(input, {
    id: LIST_ID,
    label: "Tags",
    className: "tag-suggestions",
    onClose: () => {
      matches = [];
      adding = undefined;
    },
  });

  // Enter takes the first match unasked only when it begins with what's
  // typed: a new tag that sits inside a known one ("ink" in "thinking") must
  // still go in as typed.
  function filter(): number {
    const typed = unmarkedTagName(input.value);
    const query = typed.toLowerCase();
    const known = spec.source.known();
    matches = rankTags(suggested(spec.source), query, spec.applied());
    const declarable = isTagName(typed) && !known.some((tag) => sameTag(tag.name, typed));
    adding = spec.source.declare && declarable ? typed : undefined;
    return query && matches[0]?.name.toLowerCase().startsWith(query) ? 0 : -1;
  }

  function show(): void {
    const active = filter();
    const rows = matches.map(option);
    if (adding !== undefined) rows.push(addOption(adding, matches.length));
    list.show(rows, active);
  }

  function option(tag: TagDefinition): SuggestionRow {
    return {
      fill: (row) => {
        const swatch = document.createElement("span");
        swatch.className = "tag-suggestion-swatch";
        const color = normalizeHexColor(tag.color);
        if (color) swatch.style.setProperty("--swatch", color);
        const name = document.createElement("span");
        name.className = "tag-suggestion-name";
        name.textContent = tag.name;
        row.append(swatch, name);
      },
      pick: () => spec.onPick(tag.name),
    };
  }

  function addOption(name: string, index: number): SuggestionRow {
    return {
      fill: (row) => {
        row.className = "tag-suggestion-add";
        row.classList.toggle("menu-item-separated", index > 0);
        const icon = document.createElement("span");
        icon.className = "tag-suggestion-add-icon";
        const label = document.createElement("span");
        label.className = "tag-suggestion-add-label";
        label.textContent = `Add “${name}” to Tags`;
        row.append(icon, label);
      },
      pick: () => addToTags(name),
    };
  }

  // Applied as any typed tag is, then added to the vocabulary; a refusal
  // leaves the tag applied and says why.
  function addToTags(name: string): void {
    list.close();
    spec.onPick(name);
    void spec.source.declare?.(name)?.catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : `Couldn't add “${name}” to Tags.`);
    });
  }

  input.addEventListener("focus", () => {
    show();
    void spec.source.read().then(() => {
      if (list.isShowing() && input.isConnected) show();
    });
  });
  input.addEventListener("input", show);
  input.addEventListener("blur", list.close);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (!list.isOpen()) {
      if (event.key === "ArrowDown") show();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // -1 is the typed text itself, a stop between the last row and the first.
      const stops = matches.length + (adding === undefined ? 0 : 1) + 1;
      list.highlight(((list.active() + 1 + (event.key === "ArrowDown" ? 1 : -1) + stops) % stops) - 1);
    } else if (
      (event.key === "Enter" || event.key === ",") &&
      adding !== undefined &&
      list.active() === matches.length
    ) {
      // The input's own Enter handler, attached after this one, would add
      // the typed text without adding it to the vocabulary.
      event.preventDefault();
      event.stopImmediatePropagation();
      addToTags(adding);
    } else if (event.key === "Escape") {
      event.preventDefault();
      list.close();
    }
  });

  return { highlighted: () => matches[list.active()]?.name };
}

/** The tags a source suggests: the declared ones, then those only in use. */
export function suggested(source: TagSource): TagDefinition[] {
  return [...source.known(), ...(source.used?.() ?? []).map((name) => ({ name, color: "" }))];
}

// What's typed matches anywhere in a name, case aside: names it begins
// first, then the rest, alphabetical within each. `skip` also drops a tag
// listed twice, in any case.
export function rankTags(tags: readonly TagDefinition[], query: string, applied: readonly string[]): TagDefinition[] {
  const skip = new Set(applied.map(tagKey));
  const ranked: { tag: TagDefinition; rank: number }[] = [];
  for (const tag of tags) {
    const key = tagKey(tag.name);
    if (skip.has(key)) continue;
    skip.add(key);
    const at = tag.name.toLowerCase().indexOf(query);
    if (at !== -1) ranked.push({ tag, rank: at === 0 ? 0 : 1 });
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.tag.name.localeCompare(b.tag.name)).map(({ tag }) => tag);
}
