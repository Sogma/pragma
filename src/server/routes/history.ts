import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { keepsHistory, loadGlobalConfig, saveGlobalConfig } from "../../config/loadConfig.ts";
import type {
  HistoryFilesResponse,
  HistorySettings,
  HistoryVersionResponse,
  HistoryVersionsResponse,
} from "../../protocol/api.ts";
import { isLibraryRoot } from "../../protocol/rootedPath.ts";
import { clearHistory, historyFiles, historyVersion, historyVersions } from "../history.ts";
import { resolveRootedPath } from "../rootedFiles.ts";
import type { RouteContext } from "./shared.ts";

const failed = (error: unknown) => (error instanceof Error ? error.message : "Internal error");

// Earlier versions of the space's files. The app's own routes, never the
// agent endpoint's, and read by no tool: a version may hold what a note's
// `visibility: private` now keeps from agents and the copilot.
export function mountHistoryRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  app.all("/api/history/settings", async (c) => {
    if (c.req.method === "GET") return c.json<HistorySettings>({ keepHistory: keepsHistory(loadGlobalConfig()) });
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const { keepHistory } = (await c.req.json()) as Partial<HistorySettings>;
      if (typeof keepHistory !== "boolean") return c.text("keepHistory must be true or false", 400);
      saveGlobalConfig({ ...loadGlobalConfig(), keepHistory: keepHistory ? undefined : false });
      return c.body(null, 204);
    } catch (error) {
      return c.text(failed(error), 500);
    }
  });

  app.all("/api/history", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      return c.json<HistoryFilesResponse>({ files: await historyFiles(spaceRoot) });
    } catch (error) {
      return c.text(failed(error), 500);
    }
  });

  app.all("/api/history/file", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    const spacePath = c.req.query("path");
    if (!spacePath) return c.text("Missing path query parameter", 400);
    try {
      return c.json<HistoryVersionsResponse>({ versions: await historyVersions(spaceRoot, spacePath) });
    } catch (error) {
      return c.text(failed(error), 500);
    }
  });

  app.all("/api/history/version", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    const spacePath = c.req.query("path");
    const id = c.req.query("id");
    if (!spacePath || !id) return c.text("Missing path or id query parameter", 400);
    try {
      const content = await historyVersion(spaceRoot, spacePath, id);
      if (content === undefined) return c.text("No such version", 404);
      const { filePath, rooted } = resolveRootedPath(spaceRoot, spacePath, "read");
      const current = isLibraryRoot(rooted.root) ? undefined : await readFile(filePath, "utf8").catch(() => undefined);
      return c.json<HistoryVersionResponse>(current === undefined ? { content } : { content, current });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text(failed(error), 500);
    }
  });

  app.all("/api/history/clear", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      await clearHistory(spaceRoot);
      return c.body(null, 204);
    } catch (error) {
      return c.text(failed(error), 500);
    }
  });
}
