// The ⋮ button on a Websites, Libraries, Manage Spaces or welcome-window row,
// opening the "listItem" menu under it — shared so they can't drift apart on
// markup or click behaviour, and kept here so no panel has to import a view.
//
// One menu id serves every list, so every contribution's `when` gates on
// `target`'s `kind` (see view/sites.ts's site.settings). A row may pass no
// target, so a contribution must treat an absent one as "not my row".
import type { Access } from "../core/apiClient.ts";
import type { Command } from "../services/commands.ts";
import type { ContextMenu } from "../view/contextMenu.ts";

/** What a "listItem" menu item acts on. */
export type ListItemTarget =
  | { kind: "site"; path: string }
  // A Libraries row. Keyed by the library's id, for the same reason a space
  // row is: Locate exists precisely for the case where no recorded path
  // points at anything. The description, the path (absent until this
  // computer locates the library) and access ride along for Properties to
  // show, never to act on.
  | {
      kind: "library";
      id: string;
      label: string;
      description?: string;
      path?: string;
      access: Access;
      missing: boolean;
    }
  // A Manage Spaces row. Carries the registry id — never the path — because
  // every action here acts on the registry entry, including for a space
  // whose folder has moved or gone.
  | { kind: "space"; id: string; label: string; missing: boolean; isCurrent: boolean; trusted: boolean };

/** Locate… on a space row whose folder is gone, in Manage Spaces and the
 * welcome window alike: it rebinds the registry id to the folder picked, which
 * keeps the space's approvals attached to it. Offered only with `relocate`, a
 * native picker being the one place an arbitrary path may be chosen (see
 * docs/architecture.md's Document writes and reference integrity section). */
export function locateSpaceCommand(
  relocate: ((id: string) => Promise<string | undefined>) | undefined,
  located: () => Promise<void>,
): Command {
  return {
    id: "space.locate",
    label: "Locate…",
    when: (_, arg) => relocate !== undefined && isMissingSpace(arg),
    run: async (_, arg) => {
      if (!relocate || !isMissingSpace(arg)) return;
      if (await relocate(arg.id)) await located();
    },
  };
}

function isMissingSpace(arg: unknown): arg is Extract<ListItemTarget, { kind: "space" }> {
  const target = arg as ListItemTarget | undefined;
  return target?.kind === "space" && target.missing;
}

export function createListItemMenuButton(
  contextMenu: ContextMenu,
  label: string,
  target?: ListItemTarget,
): HTMLButtonElement {
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "icon-button list-item-menu";
  menuButton.setAttribute("aria-label", label);
  const menuIcon = document.createElement("span");
  menuIcon.className = "more-icon";
  menuButton.append(menuIcon);
  // stopPropagation keeps this click from also reaching the header's own
  // listener (header is this click's ancestor in the DOM).
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (contextMenu.isOpen(menuButton)) contextMenu.close();
    else {
      contextMenu.open({
        menu: "listItem",
        anchor: menuButton,
        align: "end",
        ariaLabel: label,
        arg: target,
        empty: "No actions yet",
      });
    }
  });
  return menuButton;
}
