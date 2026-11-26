// The Properties tab of a Table, Flow or Class: its whole metadata
// block, description included, edited as a note's frontmatter is
// (docs/protocol.md's Metadata section). The block may give a key a type,
// set from the key's menu.
import {
  METADATA_TYPE_OPTIONS,
  metadataFields,
  metadataFromProperties,
  metadataProperties,
} from "../../src/protocol/metadata.ts";
import { type FieldValueType, type MetadataEntry, retypeField, type TableColumn } from "../../src/protocol/types.ts";
import { paintTagPills } from "../lib/tagPill.ts";
import type { TagSource } from "../lib/tagSuggestions.ts";
import { renderFrontmatter } from "../markdownRender.ts";
import type { DialogService } from "../services/dialog.ts";
import { fieldSettingItems } from "../services/fieldSettings.ts";
import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import type { createPropertyEditor } from "./propertyEditor.ts";

export interface MetadataPropertiesDeps {
  createPropertyEditor: typeof createPropertyEditor;
  contextMenu: ContextMenuService;
  tags: TagSource;
  // Asks for a type's settings, such as a select's options.
  dialog: DialogService;
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
      // The block's types, by key, which the rows draw with and every save
      // writes back; a rename or removal carries its key's along.
      const fields = metadataFields(metadata);
      const markEmpty = () => section.toggleAttribute("data-empty", Object.keys(data).length === 0);
      section.hidden = false;
      markEmpty();
      if (!onChange) {
        body.replaceChildren(Object.keys(data).length > 0 ? renderFrontmatter(data, path, fields, true) : emptyNote());
        paintTagPills(body, deps.tags);
        return;
      }
      const save = () => onChange(metadataFromProperties(data, fields));
      const editor = deps.createPropertyEditor(body, data, save, {
        contextMenu: deps.contextMenu,
        tags: deps.tags,
        path,
        textValues: true,
        readOnlyKeys,
        onStructuralChange: markEmpty,
        fields,
        keyItems: (key) => typeItems(key),
        onKeyRenamed: (from, to) => {
          const field = fields.find((each) => each.id === from);
          if (field) Object.assign(field, { id: to, label: to });
        },
        onKeyRemoved: (key) => {
          const at = fields.findIndex((each) => each.id === key);
          if (at !== -1) fields.splice(at, 1);
        },
      });
      editor.render();

      // Saved at once and drawn again, so the key's control follows its type.
      // Text is a key with no type.
      function setType(key: string, type: FieldValueType): void {
        const at = fields.findIndex((each) => each.id === key);
        if (type === "text") {
          if (at !== -1) fields.splice(at, 1);
        } else if (at === -1) fields.push({ id: key, type, label: key });
        else retypeField(fields[at], type);
        save();
        editor.render();
      }

      function changed(field: TableColumn, edit: (field: TableColumn) => void): void {
        edit(field);
        save();
        editor.render();
      }

      // A type this build doesn't know reads as text, but checks no type.
      function typeItems(key: string): MenuItem[] {
        const field = fields.find((each) => each.id === key);
        const current = field?.unknownType ? undefined : (field?.type ?? "text");
        const settings = field
          ? fieldSettingItems(field, {
              change: (edit) => changed(field, edit),
              dialog: deps.dialog,
              options: () => askOptions(field),
              noRows: true,
            })
          : [];
        return [
          {
            label: "Type",
            submenu: METADATA_TYPE_OPTIONS.map(({ value, label }) => ({
              label,
              checked: () => current === value,
              run: () => setType(key, value),
            })),
          },
          ...settings,
        ];
      }

      function askOptions(field: TableColumn): void {
        void deps.dialog
          .prompt({
            title: `${field.id} options`,
            message: "Comma-separated, in the order the menu shows them.",
            label: "Options",
            value: (field.options ?? []).join(", "),
            submitLabel: "Save",
          })
          .then((value) => {
            if (value === null) return;
            changed(field, (each) => {
              each.options = value
                .split(",")
                .map((option) => option.trim())
                .filter(Boolean);
            });
          });
      }
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
