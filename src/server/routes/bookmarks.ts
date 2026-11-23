// The space's bookmarks (`.pragma/bookmarks.json`). A change names one
// bookmark and the server applies it to the file as it stands, so two
// windows changing different bookmarks never write over each other.
import type { Hono } from "hono";
import type { SpaceBookmarkChangeRequestBody, SpaceBookmarksResponse } from "../../protocol/api.ts";
import { type BookmarkChange, bookmarkPath } from "../../protocol/bookmarks.ts";
import { changeSpaceBookmark, readSpaceBookmarks } from "../spaceBookmarks.ts";
import type { Incoming, RouteContext } from "./shared.ts";

const KINDS = ["add", "remove", "move"] as const;

// The body as a change, or why it isn't one.
function readChange(body: Incoming<SpaceBookmarkChangeRequestBody>): BookmarkChange | string {
  const fields = body as Record<string, unknown>;
  const named = KINDS.filter((kind) => fields[kind] !== undefined);
  if (named.length !== 1) return "a change must add, remove or move one bookmark";
  const [kind] = named;
  const path = typeof fields[kind] === "string" ? bookmarkPath(fields[kind]) : undefined;
  if (path === undefined) return `${kind} must be a path in the space or a library`;
  if (kind === "add") return { add: path };
  if (kind === "remove") return { remove: path };
  if (fields.before === undefined) return { move: path };
  const before = typeof fields.before === "string" ? bookmarkPath(fields.before) : undefined;
  return before === undefined ? "before must be a path in the space or a library" : { move: path, before };
}

export function mountBookmarkRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  app.all("/api/space/bookmarks", async (c) => {
    if (c.req.method === "GET") return c.json<SpaceBookmarksResponse>(readSpaceBookmarks(spaceRoot));
    if (c.req.method !== "POST") return c.body(null, 405);

    const change = readChange((await c.req.json()) as Incoming<SpaceBookmarkChangeRequestBody>);
    if (typeof change === "string") return c.text(change, 400);
    return c.json<SpaceBookmarksResponse>(await changeSpaceBookmark(spaceRoot, change));
  });
}
