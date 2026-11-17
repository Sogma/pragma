// The Links tab's list: each file the open document links to, grouped under
// its folder, then each file a Class holding it links it to, under that
// Class, then each note linking to it, under Backlinks and its folder. Set
// to one list, each side lists its files A–Z with no folder headings.
//
// A row acts like a tree row, a click opening it in place and a right-click
// opening its menu. A linked file's chevron shows its description; a linking
// note's, the lines that mention the open document.
import { entryNameKey } from "../../src/protocol/entryName.ts";
import { dirnameOf } from "../../src/protocol/rootedPath.ts";
import { hasKnownKind } from "../../src/protocol/types.ts";
import { wikilinkName } from "../../src/protocol/wikilink.ts";
import type { Backlink, BacklinkMention, ClassLinks } from "../core/apiClient.ts";
import { type DocumentLinks, entryIconAt } from "../core/spaceTree.ts";
import type { Disposable } from "../lib/disposable.ts";
import { createInspectorSection, must, setEntryIcon } from "../lib/dom.ts";
import { flash } from "../lib/flash.ts";
import type { Setting } from "../services/settings.ts";
import type { OpenSource } from "../services/tabs.ts";

export interface LinksListDeps {
  open: (path: string, from?: OpenSource) => void;
  showMenu: (path: string, at: { x: number; y: number }) => void;
  // A linking note's menu, which acts on the note and its mentions.
  showLinkingMenu: (path: string, at: { x: number; y: number }) => void;
  // Opens a linking note at one of its mentions.
  openMention: (path: string, mention: BacklinkMention) => void;
  // A file's description, or undefined when it has none.
  describe: (path: string) => Promise<string | undefined>;
  // `paths` in the order the file tree draws them.
  treeOrder: (paths: readonly string[]) => string[];
  // Whether each side lists as one list rather than by folder. The switch
  // on the first heading sets it, and every list follows.
  oneList: Setting<boolean>;
}

export interface LinksList extends Disposable {
  element: HTMLElement;
  render(links: DocumentLinks, classLinks?: readonly ClassLinks[], linkedFrom?: readonly Backlink[]): void;
  // Drops the descriptions already read, so expanded rows read them again:
  // for a fresh document, or after the space changed. Typing only redraws.
  forgetDescriptions(): void;
  // Opens `path`'s row to its description, scrolls it into view and flashes
  // it: the action that reveals a row is always taken in the text.
  reveal(path: string): void;
}

function span(className: string, text = ""): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

// Each folder by its name; folders sharing a name by as many trailing
// segments as tell them apart, or two unrelated `notes` folders would merge
// into one group.
function folderLabels(folders: readonly string[]): Map<string, string> {
  const segments = new Map(folders.map((folder) => [folder, folder === "" ? [] : folder.split("/")]));
  const label = (folder: string, depth: number) => segments.get(folder)?.slice(-depth).join("/") || "Space";
  const labels = new Map<string, string>();
  for (const folder of folders) {
    const length = segments.get(folder)?.length ?? 0;
    let depth = 1;
    while (
      depth < length &&
      folders.some((other) => other !== folder && label(other, depth) === label(folder, depth))
    ) {
      depth++;
    }
    labels.set(folder, label(folder, depth));
  }
  return labels;
}

function group(title: string, rows: HTMLElement[]): HTMLElement {
  const { section, body } = createInspectorSection(title);
  section.hidden = false;
  body.className = "inspector-links-rows";
  body.append(...rows);
  return section;
}

function item(...children: HTMLElement[]): HTMLElement {
  const element = document.createElement("div");
  element.className = "inspector-link-item";
  element.append(...children);
  return element;
}

// Characters of a line kept before its first mention: enough to read the
// mention in, few enough that one deep in a paragraph still shows in the
// panel's narrow column.
const LEAD_CHARS = 40;

// A line as written, from a little before its first mention, each marked.
function mentionSnippet(text: string, mentions: readonly BacklinkMention[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let at = Math.max(0, mentions[0].at - LEAD_CHARS);
  if (at > 0) fragment.append("…");
  for (const mention of mentions) {
    if (mention.at < at) continue;
    fragment.append(text.slice(at, mention.at));
    const mark = document.createElement("mark");
    mark.className = "match-mark";
    mark.textContent = text.slice(mention.at, mention.at + mention.length);
    fragment.append(mark);
    at = mention.at + mention.length;
  }
  fragment.append(text.slice(at));
  return fragment;
}

export function createLinksList(deps: LinksListDeps): LinksList {
  const element = document.createElement("div");
  element.className = "inspector-links";
  // Kept across redraws and documents, so a row stays open while typing and
  // is still open in the next scene that links the same file. A note can be
  // both linked and linking, and each of its rows opens on its own.
  const expanded = new Set<string>();
  const expandedLinking = new Set<string>();
  const described = new Map<string, Promise<string | undefined>>();

  function showDescription(path: string, target: HTMLElement): void {
    let reading = described.get(path);
    if (!reading) {
      reading = deps.describe(path).catch(() => undefined);
      described.set(path, reading);
      target.textContent = "…";
    }
    void reading.then((text) => {
      target.textContent = text ?? "No description.";
      target.classList.toggle("empty", text === undefined);
    });
  }

  // `folder` names the row's folder after its name, where a list has no
  // folder heading to say it.
  function foundRow(path: string, count: number | undefined, folder?: string): HTMLElement {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "inspector-link-toggle";
    toggle.setAttribute("aria-label", "Description");
    toggle.append(span("disclosure"));
    const row = document.createElement("button");
    row.type = "button";
    row.className = "inspector-link";
    row.classList.toggle("cant-open", !hasKnownKind(path));
    row.dataset.tooltip = path;
    const icon = span("inspector-link-icon");
    setEntryIcon(icon, entryIconAt(path, "file"));
    row.append(icon, span("inspector-link-name", wikilinkName(path)));
    if (folder !== undefined) row.append(span("caption inspector-link-folder", folder));
    if (count !== undefined) row.append(span("caption inspector-link-count", String(count)));
    row.addEventListener("click", () => deps.open(path, { anchor: row }));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      deps.showMenu(path, { x: event.clientX, y: event.clientY });
    });
    const line = document.createElement("div");
    line.className = "inspector-link-line";
    line.append(toggle, row);
    const description = document.createElement("p");
    description.className = "caption inspector-link-description";

    function apply(): void {
      const open = expanded.has(path);
      toggle.setAttribute("aria-expanded", String(open));
      description.hidden = !open;
      if (open) showDescription(path, description);
    }
    toggle.addEventListener("click", () => {
      if (expanded.has(path)) expanded.delete(path);
      else {
        expanded.add(path);
        // Opening a row asks again, in case the file changed meanwhile.
        described.delete(path);
      }
      apply();
    });
    apply();
    const found = item(line, description);
    found.dataset.path = path;
    return found;
  }

  function linkingRow({ path, mentions }: Backlink, folder?: string): HTMLElement {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "inspector-link-toggle";
    toggle.setAttribute("aria-label", "Mentions");
    toggle.append(span("disclosure"));
    const row = document.createElement("button");
    row.type = "button";
    row.className = "inspector-link";
    row.dataset.tooltip = path;
    const icon = span("inspector-link-icon");
    setEntryIcon(icon, entryIconAt(path, "file"));
    row.append(icon, span("inspector-link-name", wikilinkName(path)));
    if (folder !== undefined) row.append(span("caption inspector-link-folder", folder));
    row.addEventListener("click", () => deps.open(path, { anchor: row }));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      deps.showLinkingMenu(path, { x: event.clientX, y: event.clientY });
    });
    const line = document.createElement("div");
    line.className = "inspector-link-line";
    line.append(toggle, row);
    // One per line, opening at the line's first mention.
    const lines = document.createElement("div");
    lines.className = "inspector-link-mentions";
    const byLine = new Map<number, BacklinkMention[]>();
    for (const mention of mentions) byLine.set(mention.line, [...(byLine.get(mention.line) ?? []), mention]);
    for (const [number, onLine] of byLine) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inspector-link-mention";
      button.dataset.tooltip = `Line ${number}`;
      button.append(mentionSnippet(onLine[0].text, onLine));
      button.addEventListener("click", () => deps.openMention(path, onLine[0]));
      lines.append(button);
    }
    function apply(): void {
      const open = expandedLinking.has(path);
      toggle.setAttribute("aria-expanded", String(open));
      lines.hidden = !open;
    }
    toggle.addEventListener("click", () => {
      if (expandedLinking.has(path)) expandedLinking.delete(path);
      else expandedLinking.add(path);
      apply();
    });
    apply();
    return item(line, lines);
  }

  function missingRow(target: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "inspector-link missing";
    row.dataset.tooltip = "No file by this name";
    row.append(span("inspector-link-name", target));
    const line = document.createElement("div");
    line.className = "inspector-link-line";
    line.append(span("inspector-link-toggle-space"), row);
    return item(line);
  }

  let shown: DocumentLinks = { found: [], missing: [] };
  let shownClassLinks: readonly ClassLinks[] = [];
  let shownLinkedFrom: readonly Backlink[] = [];

  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

  // Groups sort by name and files follow the file tree, so no row moves as
  // typing adds a link. Tree order, not A–Z: a folder with a manual or
  // property order lists its files here the way the tree does.
  function folderGroups(paths: readonly string[], row: (path: string) => HTMLElement, prefix = ""): HTMLElement[] {
    const byFolder = new Map<string, HTMLElement[]>();
    for (const path of deps.treeOrder(paths)) {
      const folder = dirnameOf(path);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), row(path)]);
    }
    const labels = folderLabels([...byFolder.keys()]);
    return [...byFolder]
      .map(([folder, rows]) => ({ title: `${prefix}${labels.get(folder) ?? folder}`, rows }))
      .sort((a, b) => byName(a.title, b.title))
      .map(({ title, rows }) => group(title, rows));
  }

  // One list, A–Z. Rows from two folders sharing a name would read as one
  // file listed twice, so those rows name their folder, in as few segments
  // as tell them apart.
  function oneList(
    title: string,
    paths: readonly string[],
    row: (path: string, folder?: string) => HTMLElement,
  ): HTMLElement[] {
    if (paths.length === 0) return [];
    const foldersNamed = new Map<string, Set<string>>();
    for (const path of paths) {
      const key = entryNameKey(wikilinkName(path));
      foldersNamed.set(key, new Set([...(foldersNamed.get(key) ?? []), dirnameOf(path)]));
    }
    const folderOf = (path: string) => {
      const folders = foldersNamed.get(entryNameKey(wikilinkName(path))) ?? new Set<string>();
      return folders.size > 1 ? folderLabels([...folders]).get(dirnameOf(path)) : undefined;
    };
    const rows = [...paths]
      .sort((a, b) => byName(wikilinkName(a), wikilinkName(b)) || byName(a, b))
      .map((path) => row(path, folderOf(path)));
    return [group(title, rows)];
  }

  // Shows and names what a click does. It sits on the first heading in
  // either form, so the click leaves it under the pointer.
  function groupingToggle(): HTMLButtonElement {
    const flat = deps.oneList.get();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button inspector-links-grouping";
    button.dataset.grouping = flat ? "none" : "folders";
    button.setAttribute("aria-label", flat ? "Group by folder" : "Show as one list");
    button.addEventListener("click", () => {
      const focused = document.activeElement === button;
      deps.oneList.set(!flat);
      // The redraw replaced this button, so focus moves to the new one.
      if (focused) must<HTMLElement>(".inspector-links-grouping", element).focus();
    });
    return button;
  }

  function render(
    links: DocumentLinks,
    classLinks: readonly ClassLinks[] = [],
    linkedFrom: readonly Backlink[] = [],
  ): void {
    shown = links;
    shownClassLinks = classLinks;
    shownLinkedFrom = linkedFrom;
    const flat = deps.oneList.get();
    const { found, missing } = links;
    const linksNothing = found.length === 0 && missing.length === 0 && classLinks.length === 0;
    // The tab dims only when it has nothing to list either way.
    element.toggleAttribute("data-empty", linksNothing && linkedFrom.length === 0);
    const groups: HTMLElement[] = [];
    if (linksNothing) {
      const empty = document.createElement("p");
      empty.className = "inspector-empty";
      empty.textContent = "No links in this file.";
      groups.push(empty);
    }
    const counts = new Map(found.map((link) => [link.path, link.count]));
    const linkedRow = (path: string, folder?: string) => foundRow(path, counts.get(path), folder);
    groups.push(
      ...(flat ? oneList("Links to", [...counts.keys()], linkedRow) : folderGroups([...counts.keys()], linkedRow)),
    );
    if (missing.length) groups.push(group("Not found", [...missing].sort(byName).map(missingRow)));
    // A folder and a Class may share a name, so a Class's heading says
    // which it is.
    for (const { name, paths } of classLinks) {
      groups.push(
        group(
          `From the ${name} Class`,
          paths.map((path) => foundRow(path, undefined)),
        ),
      );
    }
    const linking = new Map(linkedFrom.map((backlink) => [backlink.path, backlink]));
    const linkingRowAt = (path: string, folder?: string) =>
      linkingRow(linking.get(path) ?? { path, mentions: [] }, folder);
    groups.push(
      ...(flat
        ? oneList("Backlinks", [...linking.keys()], linkingRowAt)
        : folderGroups([...linking.keys()], linkingRowAt, "Backlinks from ")),
    );
    // Only where the form changes something: a missing target or a Class's
    // files list the same either way.
    const first = groups.find((node) => node.classList.contains("inspector-section"));
    if (first && (found.length > 0 || linkedFrom.length > 0)) {
      must(".inspector-section-title", first).append(groupingToggle());
    }
    element.replaceChildren(...groups);
  }

  // Every list follows the setting, so a pane in the other group shows the
  // form just picked.
  const unsubscribe = deps.oneList.subscribe(() => render(shown, shownClassLinks, shownLinkedFrom));

  return {
    element,
    render,
    dispose() {
      unsubscribe();
    },
    forgetDescriptions() {
      described.clear();
    },
    reveal(path) {
      expanded.add(path);
      described.delete(path);
      render(shown, shownClassLinks, shownLinkedFrom);
      const row = [...element.querySelectorAll<HTMLElement>(".inspector-link-item")].find(
        (item) => item.dataset.path === path,
      );
      row?.scrollIntoView({ block: "nearest" });
      const link = row?.querySelector<HTMLElement>(".inspector-link");
      if (link) flash(link);
    },
  };
}
