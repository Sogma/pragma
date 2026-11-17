import type { ContextMenuService, MenuItem } from "../services/menus.ts";
import type { ModelConsole } from "../services/modelConsole.ts";

export interface ConsoleMenuDeps {
  consoleEntries: HTMLElement;
  contextMenu: ContextMenuService;
  modelConsole: Pick<ModelConsole, "entryAt" | "allText" | "clear">;
}

// Right-click on the Console: Copy, Copy All and Clear Console. This menu
// replaces the browser's, taking its Copy of a selection with it, so a
// selection that touches the clicked entry wins over the whole entry —
// otherwise copying part of a prompt would copy all of it.
export function wireConsoleMenu({ consoleEntries, contextMenu, modelConsole }: ConsoleMenuDeps): void {
  consoleEntries.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const entry = event.target instanceof Node ? modelConsole.entryAt(event.target) : undefined;
    const selection = window.getSelection();
    const selected =
      entry && selection && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(entry.element)
        ? selection.toString()
        : "";
    const items: MenuItem[] = [];
    if (entry) items.push({ label: "Copy", group: "copy", run: () => copy(selected || entry.text) });
    items.push(
      {
        label: "Copy All",
        group: "copy",
        run: () => copy(modelConsole.allText()),
        disabled: () => !modelConsole.allText(),
      },
      {
        label: "Clear Console",
        group: "clear",
        run: () => modelConsole.clear(),
        disabled: () => consoleEntries.childElementCount === 0,
      },
    );
    contextMenu.open({ items, at: { x: event.clientX, y: event.clientY }, ariaLabel: "Console" });
  });
}

// A refused clipboard is swallowed, as the copy buttons do: only a
// permission-denied browser hits it.
function copy(text: string): void {
  navigator.clipboard.writeText(text).catch(() => undefined);
}
