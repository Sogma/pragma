// A context's look, which every viewer with a LOOK badge seen in that
// context shows its picture through: the one kept for it, or one tried from
// Looks before it is picked. A LUT file's cube is read once, through the raw
// route, for every context, and a kept file look whose file has left its
// preset folder shows nothing and says so.

import { entryNameKey } from "../../src/protocol/entryName.ts";
import { type Lut, readLutFile } from "../../src/protocol/lutFile.ts";
import type { LutEntry } from "../../src/protocol/presets.ts";
import { presetFolderAt, presetFolderOf } from "../../src/protocol/presets.ts";
import { fetchFileRaw } from "../core/apiClient.ts";
import { onPresetsChanged, presetFoldersOf, presets } from "../core/presets.ts";
import type { LookChoice } from "../lib/contextView.ts";
import { Emitter } from "../lib/emitter.ts";
import { builtInCube, isBuiltInLook, type Look } from "../lib/videoLut.ts";
import type { Setting } from "./settings.ts";

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

// Each context's look, told when the listed LUTs change or a cube lands.
const announcers = new Set<(landed: boolean) => void>();
const announceAll = (landed: boolean) => {
  for (const announce of announcers) announce(landed);
};

onPresetsChanged(() => {
  readListed();
  for (const path of files.keys()) if (!listed.has(entryNameKey(path))) files.delete(path);
  announceAll(false);
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
  announceAll(true);
}

function cube(lut: string): Lut | undefined {
  if (isBuiltInLook(lut)) return builtInCube(lut);
  const held = files.get(lut);
  if (held === undefined) void load(lut);
  return typeof held === "object" ? held : undefined;
}

/** The look of a context whose kept look is `kept`. */
export function createLookChoice(kept: Setting<Look>): LookChoice {
  let trying: string | null = null;
  const shown = (): Look => {
    if (trying !== null) return { lut: trying, on: true };
    const look = kept.get();
    if (look.lut !== null && !isBuiltInLook(look.lut) && !listed.has(entryNameKey(look.lut))) {
      return { ...look, on: false };
    }
    return look;
  };
  // Told only when what shows changes, or a cube it waited for lands: a
  // viewer told again restarts its drawing.
  const changes = new Emitter<Look>(shown());
  const announce = (landed = false) => {
    const next = shown();
    const now = changes.get();
    if (!landed && next.lut === now.lut && next.on === now.on) return;
    changes.set(next);
  };
  announcers.add(announce);
  // A kept look arriving from the server shows; a pick announces itself.
  let picking = false;
  kept.subscribe(() => {
    if (!picking) announce();
  });
  return {
    get: shown,
    set(look) {
      trying = null;
      picking = true;
      kept.set(look);
      picking = false;
      announce(true);
    },
    subscribe: (listener) => changes.subscribe(listener),
    cube,
    kept: () => kept.get(),
    trying: () => trying !== null,
    missing: () => trying === null && isMissing(kept.get()),
    tryLook(lut) {
      if (lut === trying) return;
      trying = lut;
      announce();
    },
  };
}
