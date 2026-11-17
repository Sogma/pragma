// A preference held by the server, so every browser on the host offers the
// same: whether Delete trashes, whether every file type is listed. It holds
// its safe value until the server answers, and a save the server refuses
// flips it back.
import { Emitter } from "../lib/emitter.ts";
import type { Setting } from "./settings.ts";

export interface ServerSettingDeps {
  /** The value until the server answers: the safe direction. */
  initial: boolean;
  fetch(): Promise<boolean>;
  save(value: boolean): Promise<void>;
  /** A save the server refused, after the setting has flipped back. */
  onSaveFailed(error: unknown): void;
}

export interface ServerSetting extends Setting<boolean> {
  refresh(): Promise<void>;
}

export function createServerSetting(deps: ServerSettingDeps): ServerSetting {
  const value = new Emitter<boolean>(deps.initial);

  return {
    get: () => value.get(),
    subscribe: (listener) => value.subscribe(listener),
    set(next) {
      const previous = value.get();
      value.set(next);
      deps.save(next).catch((error: unknown) => {
        value.set(previous);
        deps.onSaveFailed(error);
      });
    },
    async refresh() {
      try {
        value.set(await deps.fetch());
      } catch {
        // The last value stands until the server can be reached.
      }
    },
  };
}
