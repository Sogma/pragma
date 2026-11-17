// A context's settings (src/protocol/scopeSettings.ts) as the Context dialog
// edits them and the Properties tab shows them: a group per document kind
// whose settings apply to the context, a row per declared setting, then any
// key the block holds that nothing declares, read-only and kept as written.
import { basenameOf, dirnameOf } from "../../src/protocol/rootedPath.ts";
import {
  isSettingsBlock,
  SCOPE_SETTINGS,
  type ScopeSetting,
  settingFolder,
  settingSource,
  settingValue,
} from "../../src/protocol/scopeSettings.ts";
import type { DocumentType } from "../../src/protocol/types.ts";
import { findDirectoryNode, holdsDocumentType, pathNames, scopeBlock } from "../core/spaceTree.ts";
import { buildOpenRow } from "../lib/dom.ts";
import { createPathLabel } from "../lib/pathLabel.ts";
import type { ScopeSettingWords } from "./formats.ts";

/** A document kind's words for its settings, by the kind's name. */
export type SettingWords = (kind: string) => ScopeSettingWords | undefined;

export interface SettingRow {
  setting: ScopeSetting;
  label: string;
  description: string;
}

interface SettingGroup {
  title?: string;
  rows: SettingRow[];
  unknown: [string, unknown][];
}

/** A setting's id: its kind's name and its key, as the block nests them. */
export function settingId(setting: ScopeSetting): string {
  return setting.kind === undefined ? setting.key : `${setting.kind}.${setting.key}`;
}

// Core's settings first, then each kind whose settings apply to the context
// at `folder`: it holds a document of that kind, or already sets one of the
// kind's keys. A kind with nothing to show here would only be noise.
function settingGroups(folder: string, pragma: unknown, words: SettingWords): SettingGroup[] {
  const block = isSettingsBlock(pragma) ? pragma : {};
  const kinds = [...new Set(SCOPE_SETTINGS.flatMap((setting) => (setting.kind === undefined ? [] : [setting.kind])))];
  const group = (kind: string | undefined, holder: Record<string, unknown>): SettingGroup => {
    const declared = SCOPE_SETTINGS.filter((setting) => setting.kind === kind);
    const named = kind === undefined ? undefined : words(kind);
    return {
      title: kind === undefined ? undefined : (named?.title ?? kind),
      rows: declared.map((setting) => ({
        setting,
        label: named?.keys[setting.key]?.label ?? setting.key,
        description: named?.keys[setting.key]?.description ?? "",
      })),
      unknown: Object.entries(holder).filter(
        ([key]) => !declared.some((setting) => setting.key === key) && (kind !== undefined || !kinds.includes(key)),
      ),
    };
  };
  const kindGroups = kinds.flatMap((kind) => {
    const value = block[kind];
    const holder = isSettingsBlock(value) ? value : {};
    const applies = Object.keys(holder).length > 0 || holdsDocumentType(folder, kind as DocumentType);
    return applies ? [group(kind, holder)] : [];
  });
  return [group(undefined, block), ...kindGroups].filter((each) => each.rows.length > 0 || each.unknown.length > 0);
}

/** What an enclosing context gives a setting: the folder, that context's
 * folder and its name. */
export interface InheritedSetting {
  path: string;
  scope: string;
  from: string;
}

/** What an enclosing context gives `setting` for the context at `folder`;
 * undefined when none gives it a folder. */
export function inheritedSetting(folder: string, setting: ScopeSetting): InheritedSetting | undefined {
  if (folder === "") return undefined;
  const source = settingSource(scopeBlock, dirnameOf(folder), setting);
  const path = source && settingFolder(source.scope, source.value);
  if (!source || path === undefined) return undefined;
  return { path, scope: source.scope, from: source.scope === "" ? "the space" : basenameOf(source.scope) };
}

function groupElement(title: string | undefined, rows: HTMLElement[], cardClass = "settings-card"): HTMLElement {
  const group = document.createElement("div");
  group.className = "settings-group";
  if (title !== undefined) {
    const heading = document.createElement("h3");
    heading.className = "section-label settings-group-title";
    heading.textContent = title;
    group.append(heading);
  }
  const card = document.createElement("div");
  card.className = cardClass;
  card.append(...rows);
  group.append(card);
  return group;
}

function text(className: string, value: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = value;
  return element;
}

function shownValue(value: unknown): string {
  if (isSettingsBlock(value)) {
    return Object.entries(value)
      .map(([key, each]) => `${key}: ${isSettingsBlock(each) || Array.isArray(each) ? "…" : String(each)}`)
      .join(", ");
  }
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

// Keys the block holds that no setting declares: another tool's, a newer
// Pragma's, a typo. Shown as written and never edited, so a save keeps them.
function unknownRows(entries: [string, unknown][]): HTMLElement[] {
  if (entries.length === 0) return [];
  return [
    text("context-settings-unknown-label", "Not used by Pragma"),
    ...entries.map(([key, value]) => {
      const row = document.createElement("div");
      row.className = "field-row context-settings-unknown";
      const words = document.createElement("div");
      words.className = "field-row-text";
      words.append(text("field-row-title", key));
      row.append(words, text("field-row-value", shownValue(value)));
      return row;
    }),
  ];
}

/** The Context dialog's groups for the context at `folder`, whose block is
 * `pragma`: each declared setting a row with its name, its line and the
 * control `control` draws for it, then the keys nothing declares. */
export function contextSettingsGroups(
  folder: string,
  pragma: unknown,
  words: SettingWords,
  control: (row: SettingRow) => HTMLElement,
): HTMLElement[] {
  return settingGroups(folder, pragma, words).map((group) =>
    groupElement(group.title, [
      ...group.rows.map((row) => {
        const element = document.createElement("div");
        element.className = "field-row";
        element.dataset.setting = settingId(row.setting);
        const words = document.createElement("div");
        words.className = "field-row-text";
        words.append(text("field-row-title", row.label), text("field-row-description", row.description));
        const holder = document.createElement("div");
        holder.className = "field-row-control context-setting-control";
        holder.append(control(row));
        element.append(words, holder);
        return element;
      }),
      ...unknownRows(group.unknown),
    ]),
  );
}

/** A setting's folder for the context at `folder`, as the Context dialog's
 * field and the Properties tab's card both show it: the folder `written`
 * names, else the one `inherited` gives, quiet and named for where it comes
 * from, each as its path from the context that gives it; else what the
 * setting lacks. A blank `written` counts as none. */
export function settingFolderLabel(
  folder: string,
  written: string | undefined,
  inherited: InheritedSetting | undefined,
): HTMLElement {
  const label = document.createElement("span");
  label.className = "context-setting-value";
  const own = written?.trim() ? written : undefined;
  const given = own === undefined ? inherited : undefined;
  const shown = own === undefined ? given?.path : settingFolder(folder, own);
  if (shown === undefined) {
    label.classList.add("is-empty");
    label.textContent = own === undefined ? "None" : "Names no folder here";
    return label;
  }
  const missing = findDirectoryNode(shown) === undefined;
  label.classList.toggle("is-inherited", given !== undefined);
  label.classList.toggle("is-missing", missing);
  if (missing) label.append("Missing:");
  label.append(
    createPathLabel(shown, pathNames, { type: "directory", from: given?.scope ?? folder, standalone: true }),
  );
  if (given) {
    const from = document.createElement("span");
    from.className = "context-setting-from";
    from.textContent = `from ${given.from}`;
    label.append(from);
  }
  return label;
}

// A setting's folder as the tab shows it, read from the context's block.
function settingLabel(folder: string, setting: ScopeSetting, pragma: unknown): HTMLElement {
  const own = settingValue(pragma, setting);
  return settingFolderLabel(folder, typeof own === "string" ? own : undefined, inheritedSetting(folder, setting));
}

/** The card a scope's AGENTS.md shows under its `pragma` row in the
 * Properties tab: the dialog's groups, read-only and without descriptions,
 * each setting a row that opens the Context dialog at it. Undefined when the
 * context has no settings to show. */
export function contextSettingsCard(
  folder: string,
  pragma: unknown,
  words: SettingWords,
  open: (setting: ScopeSetting) => void,
): HTMLElement | undefined {
  const groups = settingGroups(folder, pragma, words);
  if (groups.length === 0) return undefined;
  const card = document.createElement("div");
  card.className = "context-settings-card";
  card.append(
    ...groups.map((group) =>
      groupElement(
        group.title,
        [
          ...group.rows.map((row) =>
            buildOpenRow(
              settingId(row.setting),
              [text("field-row-title", row.label), settingLabel(folder, row.setting, pragma)],
              () => open(row.setting),
            ),
          ),
          ...unknownRows(group.unknown),
        ],
        "settings-card card",
      ),
    ),
  );
  return card;
}
