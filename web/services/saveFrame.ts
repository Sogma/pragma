// Save frame…, in the More options of a player with a frame on screen: the
// frame taken as the item is picked, saved as a PNG named after its clip and
// timecode, never over a file. The folder offered first is the one a frame
// seen in the same context went to last (the server's frameFolders.ts), the
// context being the one the menu was opened in.
import type { SpaceTreeNode } from "../../src/protocol/api.ts";
import { entryNameKey, illegalEntryNameReason } from "../../src/protocol/entryName.ts";
import { basenameOf, formatRootedPath, isLibraryRoot, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import { fetchFrameFolder, getVideoFormat, postFrameFolder, postUploadFile } from "../core/apiClient.ts";
import {
  ensureLibraryPermissions,
  isLibraryLocated,
  isWritableRoot,
  libraryIds,
  libraryName,
} from "../core/libraries.ts";
import { stripExtension } from "../core/paths.ts";
import { findEntry, getTree, loadLibraryTree } from "../core/spaceTree.ts";
import { FALLBACK_FPS, type FrameGrab, timecode } from "../lib/videoPlayer.ts";
import type { DialogService } from "./dialog.ts";
import { createFolderField } from "./folderChooser.ts";
import type { MenuItem } from "./menus.ts";
import { menuContext } from "./videoMenu.ts";

const EXTENSION = ".png";

/** A frame's name before its extension: its clip's, an underscore, then the
 * timecode it stands at, with dashes for the colons no name may hold. */
export function frameName(clip: string, seconds: number, fps: number): string {
  return `${stripExtension(basenameOf(clip))}_${timecode(seconds, fps).replaceAll(":", "-")}`;
}

/** The file a typed name saves as: the field shows the extension after it,
 * so one typed as well is not doubled. */
export function frameFileName(typed: string): string {
  const name = typed.trim();
  const stem = name.toLowerCase().endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length).trimEnd() : name;
  return stem ? `${stem}${EXTENSION}` : "";
}

/** Why `name` can't be saved in a folder whose entries are `taken`, or
 * undefined when it can. A name is never stepped around here: the person
 * typed it, so they choose another. */
export function frameNameRefusal(name: string, taken: readonly string[]): string | undefined {
  if (!name) return "Enter a name.";
  if (/[\\/]/.test(name)) return "A name can't contain a slash.";
  const illegal = illegalEntryNameReason(name);
  if (illegal) return `${illegal}.`;
  const key = entryNameKey(name);
  if (taken.some((entry) => entryNameKey(entry) === key)) return `"${name}" is already in that folder.`;
  return undefined;
}

// What is already in `folder`, by its root's tree.
async function namesIn(folder: string): Promise<string[]> {
  const { root, path } = parseRootedPath(folder);
  const tree = isLibraryRoot(root) ? await loadLibraryTree(root.library) : getTree();
  const entries = path === "" ? tree : findEntry(path, tree)?.children;
  return (entries ?? []).map((entry) => entry.name);
}

// The roots a frame can go to: the space, then each library this computer
// has and Pragma may write to, its folders rooted as the chooser names them.
async function writableRoots(): Promise<SpaceTreeNode[]> {
  await ensureLibraryPermissions();
  const rooted = (id: string, nodes: readonly SpaceTreeNode[]): SpaceTreeNode[] =>
    nodes.map((node) => ({
      ...node,
      path: formatRootedPath({ root: { library: id }, path: node.path }),
      children: node.children && rooted(id, node.children),
    }));
  const libraries = libraryIds().filter((id) => isLibraryLocated(id) && isWritableRoot({ library: id }));
  const trees = await Promise.all(
    libraries.map(async (id): Promise<SpaceTreeNode> => {
      const top = formatRootedPath({ root: { library: id }, path: "" });
      return {
        name: libraryName(id) ?? id,
        path: top,
        type: "directory",
        children: rooted(id, await loadLibraryTree(id)),
      };
    }),
  );
  return [{ name: "Space", path: "", type: "directory", children: getTree() }, ...trees];
}

function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The frame couldn't be drawn."))), "image/png");
  });
}

export interface SaveFrameDeps {
  dialog(): DialogService;
}

async function saveFrame(deps: SaveFrameDeps, clip: string, frame: FrameGrab, context: string): Promise<void> {
  // A dialog opens in the page, under a player's full screen, where it would
  // wait unseen.
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  const [folder, fps] = await Promise.all([
    fetchFrameFolder(clip, context).catch(() => ""),
    getVideoFormat(clip).then(
      (format) => format.frameRate,
      () => null,
    ),
  ]);
  const field = createFolderField({
    value: folder,
    roots: writableRoots,
    rootIcon: (root) => ({ glyph: root.path === "" ? "space" : "library" }),
    label: "Choose a folder",
  });
  await deps.dialog().form({
    title: "Save frame",
    figure: frame.canvas,
    fields: [
      { id: "name", label: "Name", value: frameName(clip, frame.seconds, fps ?? FALLBACK_FPS), suffix: EXTENSION },
      { id: "folder", label: "Folder", control: field },
    ],
    submitLabel: "Save",
    busyLabel: "Saving…",
    submit: async (values) => {
      const name = frameFileName(values.name);
      const refusal = frameNameRefusal(name, await namesIn(values.folder));
      if (refusal) return refusal;
      await postUploadFile(values.folder, name, await pngOf(frame.canvas));
      await postFrameFolder(context, values.folder).catch(() => undefined);
      return undefined;
    },
  });
}

// The clip a media menu's argument names, and the frame its player offers.
function frameArg(arg: unknown): { clip: string; take: () => FrameGrab } | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  const { file, frame } = arg as { file?: unknown; frame?: unknown };
  return typeof file === "string" && typeof frame === "function"
    ? { clip: file, take: frame as () => FrameGrab }
    : undefined;
}

/** Save frame… in a media file's More options, shown only where a player
 * offers the frame it shows: never for a still, nor a clip still loading. */
export function saveFrameMenuItem(deps: SaveFrameDeps): MenuItem {
  return {
    label: "Save frame…",
    group: "guides",
    when: (_, arg) => frameArg(arg) !== undefined,
    run: (_, arg) => {
      const offered = frameArg(arg);
      return offered ? saveFrame(deps, offered.clip, offered.take(), menuContext(arg)) : undefined;
    },
  };
}
