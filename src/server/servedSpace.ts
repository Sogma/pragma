// The space a host serves. Every host (`pragma start`, `pragma dev`, the
// desktop app) holds one ServedSpace and hands it to everything that reads
// the root, so a switch reaches the routes and the agent endpoint alike, and
// neither goes on serving the space it started with.
import path from "node:path";
import type { SpaceSwitcher } from "./routes/shared.ts";

export interface ServedSpace extends SpaceSwitcher {
  /** The space being served, resolved. */
  root(): string;
  /** Runs `listener` after every switch, with the new root. */
  onSwitch(listener: (root: string) => void): void;
}

export function createServedSpace(initialRoot: string): ServedSpace {
  let root = path.resolve(initialRoot);
  const listeners: ((root: string) => void)[] = [];
  return {
    root: () => root,
    switchTo(newRoot) {
      root = path.resolve(newRoot);
      for (const listener of listeners) listener(root);
    },
    onSwitch(listener) {
      listeners.push(listener);
    },
  };
}
