import { vi } from "vitest";
import type { PreviewSources } from "../../../web/filePreview.ts";
import { NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { type Look, NO_LOOK } from "../../../web/lib/videoLut.ts";
import { memorySetting } from "./editorLayout.ts";

// What a pane's file preview reads, with no server behind it: a file's raw
// URL by its path, readable line length on, Loop off, the volume full, no
// guides and no LUT, and every clip 24 fps H.264.
export function testPreviewSources(): PreviewSources {
  return {
    rawFileUrl: (path) => `/raw?path=${path}`,
    fetchFile: vi.fn(async () => new Response("")),
    videoFormat: vi.fn(async () => ({ codec: "H.264", frameRate: 24, variableFrameRate: false })),
    pixelFormat: vi.fn(async () => ({ colorModel: "rgb" as const, alpha: false, bitDepth: 8, sourceType: null })),
    readingResolvers: vi.fn(() => ({ image: () => undefined, link: () => undefined, wikilink: () => undefined })),
    readableLineLength: {
      subscribe: (listener) => {
        listener(true);
        return () => undefined;
      },
    },
    videoLoop: memorySetting(false),
    videoVolume: memorySetting({ level: 1, muted: false }),
    videoGuides: memorySetting(NO_GUIDES),
    videoLut: memorySetting<Look>(NO_LOOK),
  };
}
