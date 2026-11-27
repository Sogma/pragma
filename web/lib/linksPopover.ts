// The popover a Links button opens, on a Class's toolbar or a Table's: the
// files the file links, each under a heading saying what it gives, with a
// remove button, then a file picked or dragged in from the tree to add one.
// The owner keeps the file and saves each change; what the links give is
// worded here, by owner, so the two popovers say it the same way.
import type { ClassLinkUse } from "../../src/protocol/class.ts";
import type { EntryIcon } from "../core/paths.ts";
import { el, setEntryIcon } from "./dom.ts";

export type LinksOwner = "class" | "table";

export interface LinksPopoverDeps {
  owner: LinksOwner;
  // The links as the file writes them, in its order.
  links(): readonly string[];
  change(edit: (links: string[]) => void): void;
  // Offers the files the owner can link at `anchor`, handing the one picked
  // to `pick` written from the owner's folder.
  pickFile(anchor: HTMLElement, pick: (link: string) => void): void;
  // A tree's file row dropped on the popover, written from the owner's
  // folder, or why it can't be one. Undefined for a drop that isn't a tree row's.
  droppedFile(event: DragEvent): { link: string } | { refused: string } | undefined;
  // A link as the popover shows it: what it gives, and its file's icon, name and path.
  describeLink(link: string): { use: ClassLinkUse; icon: EntryIcon; name: string; path: string };
  // The popover's content changed height, so its flyout places it again.
  resized(): void;
}

interface Wording {
  sections: readonly { use: ClassLinkUse; heading: string; gives: string }[];
  add: string;
  empty: string;
}

// A Table's links are its Flows; a file of another kind a hand-written list
// holds still shows, so it can be removed.
const WORDING: Record<LinksOwner, Wording> = {
  class: {
    sections: [
      { use: "toolkit", heading: "Flows", gives: "buttons in each note's Tools tab" },
      { use: "template", heading: "Templates", gives: "New note starts from one" },
      { use: "reference", heading: "Files", gives: "in each note's Links tab" },
    ],
    add: "+ Add file",
    empty:
      "A Flow gives each note its buttons, a template from _templates starts each new note, and any other file shows in each note's Links tab.",
  },
  table: {
    sections: [
      { use: "toolkit", heading: "Flows", gives: "buttons in the Tools tab" },
      { use: "reference", heading: "Other files", gives: "nothing in a Table" },
    ],
    add: "+ Add Flow",
    empty: "A Flow's buttons show in the Tools tab while this Table is open, and run on the rows ticked.",
  },
};

export function createLinksPopover(deps: LinksPopoverDeps): HTMLElement {
  const wording = WORDING[deps.owner];
  const panel = el("div", "popover class-popover");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Links");
  const body = el("div", "class-popover-body");
  const refusal = el("div", "inline-error class-popover-error");
  panel.appendChild(body);

  function add(link: string): void {
    deps.change((links) => {
      if (!links.includes(link)) links.push(link);
    });
    draw();
  }

  function draw(): void {
    body.replaceChildren();
    const links = deps.links();
    const described = links.map((link, index) => ({ index, ...deps.describeLink(link) }));
    for (const { use, heading, gives } of wording.sections) {
      const shown = described.filter((link) => link.use === use);
      if (shown.length === 0) continue;
      const title = el("div", "caption class-popover-heading", heading);
      title.appendChild(el("span", "class-links-gives", ` · ${gives}`));
      body.appendChild(title);
      for (const { index, icon, name, path } of shown) {
        const row = el("div", "class-link");
        const glyph = el("span");
        setEntryIcon(glyph, icon);
        const label = el("span", "class-link-name", name);
        label.dataset.tooltip = path;
        const remove = el("button", "icon-button class-icon-button");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove this link");
        remove.appendChild(el("span", "class-icon class-icon-x"));
        remove.addEventListener("click", () => {
          deps.change((each) => each.splice(index, 1));
          draw();
        });
        row.append(glyph, label, remove);
        body.appendChild(row);
      }
    }
    const pick = el("button", "class-popover-add", wording.add);
    pick.type = "button";
    pick.addEventListener("click", () => deps.pickFile(pick, add));
    refusal.hidden = true;
    body.append(pick, refusal, el("div", "caption class-popover-note", "or drag one in from the tree"));
    if (links.length === 0) body.appendChild(el("div", "caption class-popover-note", wording.empty));
    deps.resized();
  }

  panel.addEventListener("dragover", (event) => {
    event.preventDefault();
    panel.classList.add("drag-over");
  });
  panel.addEventListener("dragleave", (event) => {
    if (!panel.contains(event.relatedTarget as Node | null)) panel.classList.remove("drag-over");
  });
  panel.addEventListener("drop", (event) => {
    panel.classList.remove("drag-over");
    const dropped = deps.droppedFile(event);
    if (!dropped) return;
    event.preventDefault();
    if ("link" in dropped) {
      add(dropped.link);
      return;
    }
    refusal.textContent = dropped.refused;
    refusal.hidden = false;
  });

  draw();
  return panel;
}
