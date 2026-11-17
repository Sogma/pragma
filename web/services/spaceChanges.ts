// Follows the space, the library the Libraries panel has open, and the files
// open in tabs, for changes this window did not make: another program,
// another device, an agent. It asks the server on a short interval while the
// page is in view, and at once when the page comes back, rather than holding
// a connection open: an ask is one small read, through any proxy.
import { fetchSpaceChanges } from "../core/apiClient.ts";
import * as spaceTree from "../core/spaceTree.ts";

const ASK_EVERY_MS = 3000;

export interface SpaceChanges {
  /** Calls `onChanged` whenever the space's version moves past the one its
   * tree was last read at. Returns the way to stop following. */
  followSpace(onChanged: () => void): () => void;
  /** The same for library `id`, against the version `readAt` names: the one
   * the follower's own copy of the library was read at. */
  followLibrary(id: string, readAt: () => string | undefined, onChanged: () => void): () => void;
  /** Asks about `follower`'s files with every ask. */
  followFiles(follower: FileFollower): () => void;
}

/** Files asked about along with the trees, by rooted path. */
export interface FileFollower {
  /** The paths to ask about, read as each ask goes out. */
  paths(): readonly string[];
  /** Each path's revision now, or null for one gone; a path the server
   * could say nothing about is left out. */
  onRevisions(revisions: ReadonlyMap<string, string | null>): void;
}

export interface SpaceChangesDeps {
  fetch: typeof fetchSpaceChanges;
  /** The version the space's current tree was read at. */
  treeChanges: () => string | undefined;
}

interface Follower {
  readAt: () => string | undefined;
  onChanged: () => void;
  // Told once per copy and version: a refresh still reading, or one that
  // failed, is not asked for again until either side moves.
  told?: string;
}

function tell(follower: Follower, version: string | undefined): void {
  const read = follower.readAt();
  if (read === undefined || version === undefined || version === read) return;
  const pair = `${read}\n${version}`;
  if (follower.told === pair) return;
  follower.told = pair;
  follower.onChanged();
}

export function createSpaceChanges(deps: SpaceChangesDeps): SpaceChanges {
  const space = new Set<Follower>();
  const libraries = new Map<string, Set<Follower>>();
  const files = new Set<FileFollower>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let asking = false;
  let askAgain = false;

  const following = () => space.size > 0 || libraries.size > 0 || files.size > 0;

  // An ask wanted while one is out runs as soon as it is back, so a tree
  // just followed learns where it starts without waiting a whole interval.
  async function ask(): Promise<void> {
    if (asking) {
      askAgain = true;
      return;
    }
    if (!following() || document.visibilityState === "hidden") return;
    asking = true;
    // The panel opens one library at a time, and an ask names one.
    const [library] = libraries.keys();
    const asked = new Map([...files].map((follower) => [follower, follower.paths()] as const));
    try {
      const versions = await deps.fetch(library, [...new Set([...asked.values()].flat())]);
      for (const follower of space) tell(follower, versions.space);
      if (library !== undefined) for (const follower of libraries.get(library) ?? []) tell(follower, versions.library);
      for (const [follower, paths] of asked) {
        if (!files.has(follower)) continue;
        const revisions = new Map<string, string | null>();
        for (const path of paths) {
          const revision = versions.files?.[path];
          if (revision !== undefined) revisions.set(path, revision);
        }
        follower.onRevisions(revisions);
      }
    } catch {
      // A failed ask is the next one's to make up.
    } finally {
      asking = false;
    }
    if (askAgain) {
      askAgain = false;
      void ask();
    }
  }

  function startOrStop(): void {
    if (following() && timer === undefined) timer = setInterval(() => void ask(), ASK_EVERY_MS);
    else if (!following() && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function follow(followers: Set<Follower>, follower: Follower, forget: () => void): () => void {
    followers.add(follower);
    startOrStop();
    void ask();
    return () => {
      followers.delete(follower);
      if (followers.size === 0) forget();
      startOrStop();
    };
  }

  // What changed while the window was away shows as it comes back.
  const askNow = () => void ask();
  window.addEventListener("focus", askNow);
  document.addEventListener("visibilitychange", askNow);

  return {
    followSpace: (onChanged) => follow(space, { readAt: deps.treeChanges, onChanged }, () => undefined),
    followLibrary(id, readAt, onChanged) {
      const followers = libraries.get(id) ?? new Set<Follower>();
      libraries.set(id, followers);
      return follow(followers, { readAt, onChanged }, () => {
        if (libraries.get(id) === followers) libraries.delete(id);
      });
    },
    followFiles(follower) {
      files.add(follower);
      startOrStop();
      return () => {
        files.delete(follower);
        startOrStop();
      };
    },
  };
}

export const spaceChanges = createSpaceChanges({ fetch: fetchSpaceChanges, treeChanges: spaceTree.treeChanges });
