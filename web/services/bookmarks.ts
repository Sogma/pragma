// The space's bookmarks, as the Bookmarks view draws them and every menu's
// Bookmark item reads them, and the one way they change. A change names
// one bookmark and the server applies it to `.pragma/bookmarks.json` as the
// file stands, answering with every bookmark, so this copy is the file's
// after each.
import type { SpaceBookmark, SpaceBookmarkChangeRequestBody, SpaceBookmarksResponse } from "../../src/protocol/api.ts";
import { bookmarkPath, sameBookmark } from "../../src/protocol/bookmarks.ts";
import { fetchSpaceBookmarks, postSpaceBookmarkChange, type Tab } from "../core/apiClient.ts";
import * as workspace from "../core/workspace.ts";
import { Emitter } from "../lib/emitter.ts";
import type { CommandContext } from "./commands.ts";

export interface Bookmarks {
  list(): readonly SpaceBookmark[];
  // Why the bookmarks couldn't be read, as of the last answer.
  problem(): string | undefined;
  has(path: string): boolean;
  // Whether any read or change has answered yet: until one has, the list is
  // unknown rather than empty.
  loaded(): boolean;
  read(): Promise<void>;
  // Rejects with the server's message, for the caller to report.
  change(change: SpaceBookmarkChangeRequestBody): Promise<void>;
  // Fires at once, then after every answer, a read's or a change's.
  subscribe(listener: (answer: SpaceBookmarksResponse) => void): () => void;
}

export interface BookmarksApi {
  fetch(): Promise<SpaceBookmarksResponse>;
  change(change: SpaceBookmarkChangeRequestBody): Promise<SpaceBookmarksResponse>;
}

// Reached at call time, so a test that mocks the client without these never
// trips over them at import.
const SPACE_BOOKMARKS: BookmarksApi = {
  fetch: () => fetchSpaceBookmarks(),
  change: (change) => postSpaceBookmarkChange(change),
};

export function createBookmarks(api: BookmarksApi = SPACE_BOOKMARKS): Bookmarks {
  const answer = new Emitter<SpaceBookmarksResponse>({ bookmarks: [] });
  // A read that set out before a change's answer landed may hold the file
  // from before it, so only a read with no change landing meanwhile counts.
  let changes = 0;
  let answered = false;
  const settle = (next: SpaceBookmarksResponse) => {
    answered = true;
    answer.set(next);
  };

  return {
    list: () => answer.get().bookmarks,
    problem: () => answer.get().problem,
    has: (path) => answer.get().bookmarks.some((bookmark) => sameBookmark(bookmark.path, path)),
    loaded: () => answered,
    // A read that fails holds nothing, as a space with no bookmarks file
    // does, and says why.
    async read() {
      const seen = changes;
      let next: SpaceBookmarksResponse;
      try {
        next = await api.fetch();
      } catch (error) {
        next = { bookmarks: [], problem: error instanceof Error ? error.message : "Failed to load the bookmarks" };
      }
      if (seen === changes) settle(next);
    },
    async change(change) {
      const next = await api.change(change);
      changes++;
      settle(next);
    },
    subscribe: (listener) => answer.subscribe(listener),
  };
}

export const bookmarks = createBookmarks();

// A tab-strip menu's `{ groupId, index }`, as the tab it names.
function tabAt(arg: unknown): Tab | undefined {
  if (typeof arg !== "object" || arg === null || !("groupId" in arg) || !("index" in arg)) return undefined;
  const { groupId, index } = arg as { groupId: string; index: number };
  return workspace.groupById(groupId)?.tabs[index];
}

/** The entry a menu's argument names, as a bookmark holds it: a row of the
 * space's tree, a library's or the Bookmarks section, or a tab; with no
 * argument, the focused tab, for the palette. Undefined for anything a
 * bookmark can't name, which hides the menu's bookmark items. */
export function bookmarkTargetOf(arg: unknown, context: CommandContext): string | undefined {
  const tab = arg === undefined ? context.tab : tabAt(arg);
  if (tab !== undefined)
    return tab.kind === "empty" || tab.kind === "find-context" || tab.kind === "version"
      ? undefined
      : bookmarkPath(tab.path);
  if (typeof arg !== "object" || arg === null) return undefined;
  if ("bookmark" in arg) return typeof arg.bookmark === "string" ? bookmarkPath(arg.bookmark) : undefined;
  if (!("node" in arg)) return undefined;
  const { node } = arg as { node?: { path: string } | null };
  return node ? bookmarkPath(node.path) : undefined;
}
