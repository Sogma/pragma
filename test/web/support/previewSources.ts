import { vi } from "vitest";
import { basenameOf } from "../../../src/protocol/rootedPath.ts";
import type { PreviewSources, SelectedReads } from "../../../web/filePreview.ts";
import { memorySetting, memoryViews } from "./editorLayout.ts";

// What a pane's file preview and its Info section read, faked: a file's raw
// URL by its path, readable line length on, Loop off, the volume full, each
// context's guides and look as `held` keeps them, none until set, every clip
// a 24 fps H.264 1920 × 1080 header, every still 8-bit RGB, every file 2 KB
// changed on 1 November 2026, and every folder holding 5 files and 2 folders.
export function testPreviewSources(held = memoryViews()): PreviewSources & SelectedReads {
  return {
    rawFileUrl: (path) => `/raw?path=${path}`,
    fetchFile: vi.fn(async () => new Response("")),
    videoFormat: vi.fn(async () => ({
      codec: "H.264",
      frameRate: 24,
      variableFrameRate: false,
      bitDepth: 8,
      hdr: null,
      alpha: false,
      audio: { codec: "AAC", channels: 2 },
      startTimecode: null,
      width: 1920,
      height: 1080,
      duration: 12,
    })),
    fileInfo: vi.fn(async (path: string) => ({
      kind: "file" as const,
      name: basenameOf(path),
      size: 2048,
      modified: "2026-11-01T09:30:00.000Z",
    })),
    pixelFormat: vi.fn(async () => ({ colorModel: "rgb" as const, alpha: false, bitDepth: 8, sourceType: null })),
    folderTotals: vi.fn(() => "5 files, 2 folders"),
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
