// The space's trash: what Delete moved into `.trash/`, listed, moved back out
// or removed for good, and whether Delete offers the trash at all. Entries are
// named bare, never as a rooted path — the rooted resolver refuses every
// hidden segment for a write, and only the space's own trash is reachable
// here, never a library's.
import type { Hono } from "hono";
import { loadGlobalConfig, saveGlobalConfig } from "../../config/loadConfig.ts";
import type {
  DeleteFromTrashRequestBody,
  MoveFromTrashRequestBody,
  MoveFromTrashResponse,
  TrashResponse,
  TrashSettings,
} from "../../protocol/api.ts";
import { formatWithinRoot, isSpaceTarget, resolveRootedPath } from "../rootedFiles.ts";
import { deleteFromTrash, emptyTrash, listTrash, moveFromTrash } from "../spaceFiles.ts";
import type { RouteContext } from "./shared.ts";

export function mountTrashRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  // Install-global, not per space: it decides what happens to the host's
  // files, so every browser on the host offers the same.
  app.all("/api/trash-settings", async (c) => {
    if (c.req.method === "GET") {
      return c.json<TrashSettings>({ moveToTrash: loadGlobalConfig().moveToTrash !== false });
    }
    if (c.req.method !== "POST") return c.body(null, 405);
    const { moveToTrash } = (await c.req.json()) as Partial<TrashSettings>;
    if (typeof moveToTrash !== "boolean") return c.text("moveToTrash must be true or false", 400);
    saveGlobalConfig({ ...loadGlobalConfig(), moveToTrash: moveToTrash ? undefined : false });
    return c.body(null, 204);
  });

  app.all("/api/space/trash", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    return c.json<TrashResponse>({ entries: await listTrash(spaceRoot) });
  });

  app.all("/api/space/trash/delete", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    const body = (await c.req.json()) as DeleteFromTrashRequestBody;
    await deleteFromTrash(spaceRoot, body.name);
    return c.body(null, 204);
  });

  // The destination resolves through the doorway, as any write's does. A
  // library is refused, as the tree's move refuses one: a move stays inside
  // one root.
  app.all("/api/space/trash/move", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    const body = (await c.req.json()) as Partial<MoveFromTrashRequestBody>;
    if (typeof body.dir !== "string") return c.text("dir must be a folder of the space", 400);
    const destination = resolveRootedPath(spaceRoot, body.dir, "write");
    if (!isSpaceTarget(destination)) return c.text("The trash moves only into the space", 400);
    const landed = await moveFromTrash(spaceRoot, body.name, destination.filePath);
    return c.json<MoveFromTrashResponse>({ path: formatWithinRoot(destination, landed) });
  });

  app.all("/api/space/trash/empty", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    await emptyTrash(spaceRoot);
    return c.body(null, 204);
  });
}
