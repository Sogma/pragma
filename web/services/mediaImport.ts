// A drop of files from outside pragma onto a tree. Markdown becomes a
// document, images, video and PDFs go to the upload route, and anything else is
// refused by name. One service for every tree, so the space and a library
// take a drop the same way, with one progress dialog: a footage take is
// large enough that a silent wait reads as a failure, and worth stopping.
import { isMarkdownFile, mediaTypeForPath } from "../../src/protocol/types.ts";
import type { CreateEntryResponse, UploadEntryResponse } from "../core/apiClient.ts";
import { formatFileSize } from "../lib/dom.ts";
import type { DialogService } from "./dialog.ts";

export interface UploadProgressOptions {
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DroppedImportDeps {
  dialog: DialogService;
  createEntry(parentPath: string, name: string, type: "file", content: string): Promise<CreateEntryResponse>;
  upload(dir: string, name: string, file: Blob, options: UploadProgressOptions): Promise<UploadEntryResponse>;
}

export interface DroppedImportResult {
  /** Rooted paths, in the order they landed. */
  imported: string[];
  /** Names no tree could show, refused before any request went out. */
  refused: string[];
  /** Names whose request failed, with the server's reason. */
  failed: { name: string; reason: string }[];
  /** True when the person stopped it: whatever had not started was skipped. */
  cancelled: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Copies `files` into `dir`, a rooted path the tree handed out. Resolves
 * with what happened to each; never rejects, since a drop has nowhere to
 * put a thrown error. */
export async function importDroppedFiles(
  files: readonly File[],
  dir: string,
  deps: DroppedImportDeps,
): Promise<DroppedImportResult> {
  const result: DroppedImportResult = { imported: [], refused: [], failed: [], cancelled: false };
  const media = files.filter((file) => mediaTypeForPath(file.name) !== undefined);
  const notes = files.filter((file) => isMarkdownFile(file.name));
  for (const file of files) {
    if (!media.includes(file) && !notes.includes(file)) result.refused.push(file.name);
  }

  for (const file of notes) {
    try {
      const created = await deps.createEntry(dir, file.name, "file", await file.text());
      result.imported.push(created.path);
    } catch (error) {
      result.failed.push({ name: file.name, reason: error instanceof Error ? error.message : "Import failed" });
    }
  }

  if (media.length === 0) return result;

  // One dialog for the whole batch, and one cancel: it aborts the upload in
  // flight and skips the rest, since a person who stopped the first take
  // did not mean to sit through the other nine. The dialog stays open until
  // the loop closes it, so closing it by any route is a cancel, never a
  // silent detachment from an upload still running.
  let controller = new AbortController();
  let cancelRequested = false;
  const requestCancel = () => {
    cancelRequested = true;
    controller.abort();
  };
  const content = el("div", "dialog-body");
  const line = el("p", "dialog-message");
  const bar = document.createElement("progress");
  bar.className = "dialog-progress";
  bar.max = 1;
  bar.value = 0;
  const detail = el("p", "caption dialog-field-description");
  const actions = el("div", "dialog-actions");
  const cancel = el("button", "btn btn-large", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", requestCancel);
  actions.append(cancel);
  content.append(line, bar, detail, actions);
  const handle = deps.dialog.open({
    title: "Copying files",
    content,
    closeOnBackdrop: false,
    onEscape: () => {
      requestCancel();
      return true;
    },
  });
  void handle.closed.then(requestCancel);

  try {
    for (const [index, file] of media.entries()) {
      if (cancelRequested) break;
      controller = new AbortController();
      line.textContent =
        media.length === 1 ? `Copying ${file.name}` : `Copying ${file.name} (${index + 1} of ${media.length})`;
      bar.value = 0;
      detail.textContent = `0 B of ${formatFileSize(file.size)}`;
      try {
        const uploaded = await deps.upload(dir, file.name, file, {
          signal: controller.signal,
          onProgress: (sent, total) => {
            bar.value = total > 0 ? sent / total : 0;
            detail.textContent = `${formatFileSize(sent)} of ${formatFileSize(total)}`;
          },
        });
        result.imported.push(uploaded.path);
      } catch (error) {
        if (cancelRequested) break;
        result.failed.push({ name: file.name, reason: error instanceof Error ? error.message : "Upload failed" });
      }
    }
  } finally {
    result.cancelled = cancelRequested;
    handle.close();
  }
  return result;
}

/** What to tell the person once the drop has settled, or undefined when
 * everything landed. Refusals and failures are one message: both answer
 * "why isn't my file there", and a name appears in one list or the other. */
export function describeImportProblems(result: DroppedImportResult): string | undefined {
  const parts: string[] = [];
  if (result.refused.length > 0) {
    parts.push(`${result.refused.join(", ")}: not a note, image, video or PDF.`);
  }
  for (const { name, reason } of result.failed) parts.push(`${name}: ${reason}`);
  if (result.cancelled) parts.push("Copying was cancelled; files not yet started were skipped.");
  return parts.length > 0 ? `Couldn't import everything.\n\n${parts.join("\n")}` : undefined;
}
