import { vi } from "vitest";
import type { Lut } from "../../../src/protocol/lutFile.ts";
import type { ContextView, LookChoice } from "../../../web/lib/contextView.ts";
import { Emitter } from "../../../web/lib/emitter.ts";
import { type Guides, NO_GUIDES } from "../../../web/lib/videoGuides.ts";
import { builtInCube, isBuiltInLook, type Look, type LutChoice, NO_LOOK } from "../../../web/lib/videoLut.ts";
import type { EditorLayout, Setting } from "../../../web/services/settings.ts";

/** A setting held in memory, so a test never reads or leaves one in localStorage. */
export function memorySetting<T>(initial: T): Setting<T> {
  const value = new Emitter(initial);
  return { get: () => value.get(), set: (next) => value.set(next), subscribe: (listener) => value.subscribe(listener) };
}

/** An editor layout held in memory, at the Editor page's defaults where not given. */
export function testLayout(initial: Partial<Record<keyof EditorLayout, boolean>> = {}): EditorLayout {
  return {
    readableLineLength: memorySetting(initial.readableLineLength ?? true),
    lineNumbers: memorySetting(initial.lineNumbers ?? false),
    foldMarkers: memorySetting(initial.foldMarkers ?? true),
    ...(initial.indentGuides === undefined ? {} : { indentGuides: memorySetting(initial.indentGuides) }),
  };
}

/** A look held in memory, its cubes Pragma's own LUTs and any LUT file
 * `files` holds by its path. */
export function memoryLook(initial: Look = NO_LOOK, files: Record<string, Lut> = {}): LutChoice & Setting<Look> {
  return Object.assign(memorySetting<Look>(initial), {
    cube: (lut: string) => (isBuiltInLook(lut) ? builtInCube(lut) : files[lut]),
  });
}

type HeldView = { guides: Setting<Guides>; look: LookChoice & Setting<Look> };

/** Each context's guides and look held in memory, none until set: `views`
 * is what a surface is handed, `of` reads a context's back. */
export function memoryViews(): { views: (context: string) => ContextView; of: (context: string) => HeldView } {
  const held = new Map<string, HeldView>();
  const of = (context: string) => {
    let view = held.get(context);
    if (!view) {
      view = { guides: memorySetting(NO_GUIDES), look: Object.assign(memoryLook(), { tryLook: vi.fn() }) };
      held.set(context, view);
    }
    return view;
  };
  return { views: of, of };
}
