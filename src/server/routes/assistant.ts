import type { Hono } from "hono";
import {
  besideParam,
  CHAT_MODES,
  type ChatRequestBody,
  type ChatResponse,
  type ErrorBody,
  type FindContextRequestBody,
  type FindContextResponse,
  type SelectedRange,
} from "../../protocol/api.ts";
import { defaultTextModel, UnresolvedModelError } from "../../protocol/modelProvider.ts";
import { formatRootedPath, isLibraryPath, isLibraryRoot } from "../../protocol/rootedPath.ts";
import { parseSelectedRange } from "../../protocol/selectedRange.ts";
import { setupNeedOf } from "../../protocol/setupNeed.ts";
import { rasterImageMediaTypeForPath } from "../../protocol/types.ts";
import { type EditorContext, EffortLevelError, runChat, type SelectedFile } from "../chatHandler.ts";
import { runFindContext } from "../findContextHandler.ts";
import { PathAccessError, resolveRootedPath } from "../rootedFiles.ts";
import { resolveWithinSpace } from "../spaceFiles.ts";
import { type RouteContext, sendTextError } from "./shared.ts";

// The range the writer has selected, when the editor sent one.
// Dropped rather than rejected when it doesn't parse: the selection is a
// hint about the open document, and no hint is worth failing a turn over.
function parseSelection(value: string | undefined): SelectedRange | undefined {
  return value === undefined ? undefined : parseSelectedRange(value);
}

// Each non-document view's own query parameter, in the order they're tried.
const FILE_VIEW_PARAMS = [
  ["imagePath", "image"],
  ["videoPath", "video"],
  ["pdfPath", "pdf"],
  ["appletPath", "applet"],
  ["flowPath", "flow"],
  ["tablePath", "table"],
] as const;

// An image resolves against whichever root it names, as its pane's does. A
// library's file reaches the copilot only as a raster image to look at: its
// other tools read the space. One that isn't there to see, a hidden one
// included, leaves the copilot nothing on screen rather than failing the chat.
function imageContext(spaceRoot: string, named: string): EditorContext {
  let resolved: ReturnType<typeof resolveRootedPath>;
  try {
    resolved = resolveRootedPath(spaceRoot, named, "read");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { view: "none" };
    throw error;
  }
  const { filePath, rooted } = resolved;
  if (isLibraryRoot(rooted.root) && !rasterImageMediaTypeForPath(filePath)) return { view: "none" };
  return { view: "image", filePath, path: formatRootedPath(rooted) };
}

// The file the focused pane points at, resolved as an image's path is. A
// hint, as a selection is, so one that doesn't resolve is dropped rather than
// failing the turn, and a library's counts only as a raster image to look at.
function parseSelectedFile(spaceRoot: string, query: (name: string) => string | undefined): SelectedFile | undefined {
  const named = query("selectedFile");
  if (!named) return undefined;
  try {
    const { filePath, rooted } = resolveRootedPath(spaceRoot, named, "read");
    if (isLibraryRoot(rooted.root) && !rasterImageMediaTypeForPath(filePath)) return undefined;
    return { filePath, path: formatRootedPath(rooted), previewing: query("previewing") === "1" };
  } catch {
    return undefined;
  }
}

// The editor pane shows one thing at a time, so every view's own parameter
// wins over `path`, which may be a stale one left over from whatever was
// open before. A request naming none is a turn with no file open — sent,
// never refused, so the chat answers whatever the editor is showing; so is
// one naming a library's file in any view but an image.
function parseEditorContext(spaceRoot: string, query: (name: string) => string | undefined): EditorContext {
  const folderPath = query("folderPath");
  if (folderPath !== undefined) {
    if (isLibraryPath(folderPath)) return { view: "none" };
    return { view: "folder", dirPath: resolveWithinSpace(spaceRoot, folderPath || ".") };
  }
  for (const [param, view] of FILE_VIEW_PARAMS) {
    const relativePath = query(param);
    if (!relativePath) continue;
    if (view === "image") return imageContext(spaceRoot, relativePath);
    if (isLibraryPath(relativePath)) return { view: "none" };
    const filePath = resolveWithinSpace(spaceRoot, relativePath);
    if (view === "flow") return { view, filePath, node: query("node") || undefined };
    return { view, filePath };
  }
  const relativePath = query("path");
  if (!relativePath || isLibraryPath(relativePath)) return { view: "none" };
  return {
    view: "document",
    filePath: resolveWithinSpace(spaceRoot, relativePath),
    selection: parseSelection(query("selection")),
  };
}

export function mountAssistantRoutes(app: Hono, { spaceRoot, contextSources }: RouteContext): void {
  app.all("/api/find-context", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const relativePath = c.req.query("path");
      if (!relativePath) return c.text("Missing path query parameter", 400);

      const body = (await c.req.json()) as FindContextRequestBody;
      const result = await runFindContext(spaceRoot, relativePath, body.query);
      return c.json<FindContextResponse>(result);
    } catch (error) {
      return sendTextError(c, error);
    }
  });

  app.all("/api/chat", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const context = parseEditorContext(spaceRoot, (name) => c.req.query(name));
      const beside = parseEditorContext(spaceRoot, (name) => c.req.query(besideParam(name)));
      const body = (await c.req.json()) as ChatRequestBody;
      // Same precedence as every generation call: the chat panel's own pick,
      // else the default. With neither, the turn is refused, never guessed.
      const model = body.model || defaultTextModel();
      if (body.mode !== undefined && !CHAT_MODES.includes(body.mode)) {
        return c.text(`Unknown copilot mode "${body.mode}".`, 400);
      }
      const result = await runChat(spaceRoot, context, body.history, body.message, model, {
        effort: body.effort,
        mode: body.mode,
        beside: beside.view === "none" ? undefined : beside,
        selected: parseSelectedFile(spaceRoot, (name) => c.req.query(name)),
        contextSources,
      });
      return c.json<ChatResponse>(result);
    } catch (error) {
      const need = setupNeedOf(error);
      if (need) {
        const status = need.kind === "providerKey" ? 401 : 400;
        return c.json<ErrorBody>({ message: (error as Error).message, need }, status);
      }
      if (error instanceof UnresolvedModelError) return c.text(error.message, 400);
      if (error instanceof EffortLevelError) return c.text(error.message, 400);
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });
}
