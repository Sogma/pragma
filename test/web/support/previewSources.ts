import { vi } from "vitest";
import type { PreviewSources } from "../../../web/filePreview.ts";
import { memorySetting, memoryViews } from "./editorLayout.ts";

// What a pane's file preview reads, with no server behind it: a file's raw
// URL by its path, readable line length on, Loop off, the volume full, each
// context's guides and look as `held` keeps them, none until set, and every
// clip 24 fps H.264.
export function testPreviewSources(held = memoryViews()): PreviewSources {
  return {
    rawFileUrl: (path) => `/raw?path=${path}`,
    fetchFile: vi.fn(async () => new Response("")),
    videoFormat: vi.fn(async () => ({ codec: "H.264", frameRate: 24, variableFrameRate: false })),
    readingResolvers: vi.fn(() => ({
      image: () => undefined,
      link: () => undefined,
      wikilink: () => undefined,
      wikilinkPending: () => false,
      hint: () => undefined,
    })),
    readableLineLength: {
      subscribe: (listener) => {
        listener(true);
        return () => undefined;
      },
    },
    videoLoop: memorySetting(false),
    videoVolume: memorySetting({ level: 1, muted: false }),
    views: held.views,
  };
}
