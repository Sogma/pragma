import type { Lut } from "../../../src/protocol/lutFile.ts";
import { Emitter } from "../../../web/lib/emitter.ts";
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
