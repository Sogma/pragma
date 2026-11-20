// The look every viewer with a LOOK badge shows its picture through: the one
// kept, or one tried from Looks before it is picked. A LUT file's cube is
// read once, through the raw route, and a kept file look whose file has left
// its preset folder shows nothing and says so.

import { entryNameKey } from "../../src/protocol/entryName.ts";
import { type Lut, readLutFile } from "../../src/protocol/lutFile.ts";
import type { LutEntry } from "../../src/protocol/presets.ts";
import { presetFolderAt, presetFolderOf } from "../../src/protocol/presets.ts";
import { fetchFileRaw } from "../core/apiClient.ts";
import { onPresetsChanged, presetFoldersOf, presets } from "../core/presets.ts";
import { Emitter } from "../lib/emitter.ts";
import { builtInCube, isBuiltInLook, type Look, type LutChoice } from "../lib/videoLut.ts";
import { videoLut } from "./settings.ts";

let trying: string | null = null;
const files = new Map<string, Lut | "loading" | "unreadable">();

// Every LUT the listed folders hold, by its folded rooted path.
let listed = new Set<string>();
function readListed(): void {
  const keys = new Set<string>();
  const walk = (entries: readonly LutEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === "group") walk(entry.entries);
      else keys.add(entryNameKey(entry.path));
    }
  };
  for (const view of presetFoldersOf("luts")) walk(view.luts ?? []);
  listed = keys;
}

// A kept LUT file is missing when a folder the space lists for LUTs should
// hold it and doesn't. One outside every listed folder is another space's,
// and only shows nothing.
function isMissing(look: Look): boolean {
  if (look.lut === null || isBuiltInLook(look.lut) || listed.has(entryNameKey(look.lut))) return false;
  const folders = presets().folders.flatMap((view) => {
    const folder = presetFolderOf(view.written);
    return folder ? [{ kind: view.kind, written: view.written, folder }] : [];
  });
  return presetFolderAt(folders, look.lut, "luts") !== undefined;
}

function shown(): Look {
  if (trying !== null) return { lut: trying, on: true };
  const kept = videoLut.get();
  if (kept.lut !== null && !isBuiltInLook(kept.lut) && !listed.has(entryNameKey(kept.lut))) {
    return { ...kept, on: false };
  }
  return kept;
}

// Told only when what shows changes, or a cube it waited for lands: a viewer
// told again restarts its drawing.
const changes = new Emitter<Look>(shown());
function announce(landed = false): void {
  const next = shown();
  const now = changes.get();
  if (!landed && next.lut === now.lut && next.on === now.on) return;
  changes.set(next);
}

onPresetsChanged(() => {
  readListed();
  for (const path of files.keys()) if (!listed.has(entryNameKey(path))) files.delete(path);
  announce();
});

async function load(path: string): Promise<void> {
  files.set(path, "loading");
  try {
    const response = await fetchFileRaw(path);
    const read = readLutFile(await response.text());
    files.set(path, "lut" in read ? read.lut : "unreadable");
  } catch {
    files.set(path, "unreadable");
  }
  announce(true);
}

export const looks: LutChoice & { tryLook(lut: string | null): void } = {
  get: shown,
  set(look) {
    trying = null;
    videoLut.set(look);
    announce(true);
  },
  subscribe: (listener) => changes.subscribe(listener),
  cube(lut) {
    if (isBuiltInLook(lut)) return builtInCube(lut);
    const held = files.get(lut);
    if (held === undefined) void load(lut);
    return typeof held === "object" ? held : undefined;
  },
  kept: () => videoLut.get(),
  trying: () => trying !== null,
  missing: () => trying === null && isMissing(videoLut.get()),
  tryLook(lut) {
    if (lut === trying) return;
    trying = lut;
    announce();
  },
};
