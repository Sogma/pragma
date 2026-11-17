// The Console's height: dragged on its top edge and kept per browser.
import { pixelToken, wirePanelResize } from "../lib/panelResize.ts";
import type { Setting } from "../services/settings.ts";
import * as settings from "../services/settings.ts";

export interface ConsoleResizeDeps {
  panel: HTMLElement;
  handle: HTMLElement;
  // The column the Console shares with the editor groups and the status bar.
  editor: HTMLElement;
  height?: Pick<Setting<number | undefined>, "get" | "set">;
}

export function wireConsoleResize({ panel, handle, editor, height = settings.consoleHeight }: ConsoleResizeDeps): void {
  // Height from cursor to the window's bottom edge, floored at
  // --console-min-height so it can't be dragged away entirely.
  const minHeight = pixelToken("--console-min-height");
  const setHeight = (px: number) => {
    panel.style.height = `${px}px`;
  };
  // A height saved in a taller window is capped so the document above it
  // keeps --editor-min-height.
  const saved = height.get();
  if (saved !== undefined) {
    const room = editor.clientHeight - pixelToken("--statusbar-height") - pixelToken("--editor-min-height");
    setHeight(Math.max(minHeight, Math.min(saved, room)));
  }

  wirePanelResize({
    handle,
    axis: "ns",
    minSize: minHeight,
    beginDrag: () => (moveEvent) => window.innerHeight - moveEvent.clientY,
    apply: setHeight,
    commit: (px) => height.set(px),
  });
}
