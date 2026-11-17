// The Properties tab of a Table, Flow or Class: its whole metadata
// block, description included, edited as a note's frontmatter is
// (docs/protocol.md's Metadata section).
import { metadataFromProperties, metadataProperties } from "../../src/protocol/metadata.ts";
import type { MetadataEntry } from "../../src/protocol/types.ts";
import { paintTagPills } from "../lib/tagPill.ts";
import type { TagSource } from "../lib/tagSuggestions.ts";
import { renderFrontmatter } from "../markdownRender.ts";
import type { ContextMenuService } from "../services/menus.ts";
import type { createPropertyEditor } from "./propertyEditor.ts";

export interface MetadataPropertiesDeps {
  createPropertyEditor: typeof createPropertyEditor;
  contextMenu: ContextMenuService;
  tags: TagSource;
}

export interface MetadataShowOptions {
  // The whole block after each edit. Absent, the rows are read-only.
  onChange?: (metadata: MetadataEntry[]) => void;
  // Keys the host sets itself, shown but never edited.
  readOnlyKeys?: readonly string[];
}

export interface MetadataProperties {
  // What the pane hands the inspector's Properties tab.
  readonly section: HTMLElement;
  show(path: string, metadata: readonly MetadataEntry[] | undefined, options: MetadataShowOptions): void;
  clear(): void;
}

export function createMetadataProperties(deps: MetadataPropertiesDeps): MetadataProperties {
  const section = document.createElement("section");
  section.className = "inspector-section";
  section.hidden = true;
  const body = document.createElement("div");
  section.append(body);

  return {
    section,
    show(path, metadata, { onChange, readOnlyKeys }) {
      const data = metadataProperties(metadata);
      const markEmpty = () => section.toggleAttribute("data-empty", Object.keys(data).length === 0);
      section.hidden = false;
      markEmpty();
      if (!onChange) {
        body.replaceChildren(Object.keys(data).length > 0 ? renderFrontmatter(data, path) : emptyNote());
        paintTagPills(body, deps.tags);
        return;
      }
      deps
        .createPropertyEditor(body, data, () => onChange(metadataFromProperties(data)), {
          contextMenu: deps.contextMenu,
          tags: deps.tags,
          path,
          textValues: true,
          readOnlyKeys,
          onStructuralChange: markEmpty,
        })
        .render();
    },
    clear() {
      section.hidden = true;
      section.removeAttribute("data-empty");
      body.replaceChildren();
    },
  };
}

function emptyNote(): HTMLElement {
  const note = document.createElement("p");
  note.className = "inspector-empty";
  note.textContent = "No properties.";
  return note;
}
