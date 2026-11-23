// The space's `_presets.json`. A change names one folder and the server
// applies it to the file as it stands, so two windows changing different
// folders never write over each other.
import type { Hono } from "hono";
import type { SpacePresetChangeRequestBody, SpacePresetsResponse } from "../../protocol/api.ts";
import { isPresetKind, type PresetChange } from "../../protocol/presets.ts";
import { changeSpacePresets, PresetRefusal, readSpacePresets } from "../presets.ts";
import type { Incoming, RouteContext } from "./shared.ts";

// The body as a change, or why it isn't one.
function readChange(body: Incoming<SpacePresetChangeRequestBody>): PresetChange | string {
  const fields = body as Record<string, unknown>;
  const named = (["add", "remove"] as const).filter((key) => fields[key] !== undefined);
  if (named.length !== 1) return "a change must add or remove one folder";
  const [key] = named;
  const kind = fields[key];
  if (!isPresetKind(kind)) return `${key} must name a kind of preset: templates or luts`;
  if (typeof fields.folder !== "string") return "folder must be a path in the space or a library";
  return key === "add" ? { add: kind, folder: fields.folder } : { remove: kind, folder: fields.folder };
}

export function mountPresetRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  app.all("/api/space/presets", async (c) => {
    try {
      if (c.req.method === "GET") return c.json<SpacePresetsResponse>(await readSpacePresets(spaceRoot));
      if (c.req.method !== "POST") return c.body(null, 405);
      const change = readChange((await c.req.json()) as Incoming<SpacePresetChangeRequestBody>);
      if (typeof change === "string") return c.text(change, 400);
      return c.json<SpacePresetsResponse>(await changeSpacePresets(spaceRoot, change));
    } catch (error) {
      if (error instanceof PresetRefusal) return c.text(error.message, 409);
      throw error;
    }
  });
}
