import { vi } from "vitest";
import type { PaneGroup } from "../../../web/services/editorPanes.ts";

/** A group for a pane built outside any editor group: editing, not reading,
 * and formatted, with every chrome hook a spy. */
export function fakePaneGroup(overrides: Partial<PaneGroup> = {}): PaneGroup {
  return {
    element: document.createElement("div"),
    isReadingView: () => false,
    leaveReadingView: vi.fn(),
    isSourceMode: () => false,
    rendered: vi.fn(),
    setFlowRuns: vi.fn(),
    showRuns: vi.fn(),
    setAddPropertyAvailable: vi.fn(),
    reportWordCount: vi.fn(),
    reportReadout: vi.fn(),
    announce: vi.fn(),
    notices: { begin: vi.fn(), add: vi.fn() },
    placeChanged: vi.fn(),
    viewChanged: vi.fn(),
    openToSide: vi.fn(async () => {}),
    ...overrides,
  };
}
