// The space's declared tags (docs/protocol.md's Tags). A change names one
// tag and the server applies it to `_tags.json` as it stands, so two windows
// changing different tags never write over each other.
import type { Hono } from "hono";
import type { SpaceTagChangeRequestBody, SpaceTagsResponse } from "../../protocol/api.ts";
import { illegalTagNameReason, type TagChange, tagNameOf } from "../../protocol/tags.ts";
import { normalizeHexColor } from "../../protocol/types.ts";
import { changeSpaceTag, readSpaceTags, undeclaredTags } from "../spaceTags.ts";
import type { Incoming, RouteContext } from "./shared.ts";

// The body as a change, or why it isn't one.
function readChange(body: Incoming<SpaceTagChangeRequestBody>): TagChange | string {
  const typed = typeof body.name === "string" ? body.name : "";
  const name = tagNameOf(typed);
  if (name === undefined) return illegalTagNameReason(typed) ?? "name must be a tag";
  const change: TagChange = { name };
  if (body.remove !== undefined) {
    if (body.remove !== true) return "remove must be true";
    change.remove = true;
  }
  if (body.color !== undefined) {
    const color = typeof body.color === "string" ? normalizeHexColor(body.color) : "";
    if (body.color !== "" && !color) return "color must be a hex color, or empty";
    change.color = color;
  }
  return change;
}

export function mountTagRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  // Each answer carries the tags in use beside the declared ones, so a
  // change leaves the browser's suggestions whole.
  const withUsed = async (answer: SpaceTagsResponse): Promise<SpaceTagsResponse> => ({
    ...answer,
    used: await undeclaredTags(spaceRoot, answer.tags),
  });

  app.all("/api/space/tags", async (c) => {
    if (c.req.method === "GET") return c.json<SpaceTagsResponse>(await withUsed(readSpaceTags(spaceRoot)));
    if (c.req.method !== "POST") return c.body(null, 405);

    const change = readChange((await c.req.json()) as Incoming<SpaceTagChangeRequestBody>);
    if (typeof change === "string") return c.text(change, 400);
    return c.json<SpaceTagsResponse>(await withUsed(await changeSpaceTag(spaceRoot, change)));
  });
}
