// Settings → Files: which files the space lists, how their names show, what
// Delete does, whether History keeps earlier versions, and the thumbnails
// galleries keep. How names show is this browser's; the rest are the
// server's, the same for every browser on the host.
import {
  fetchFileTypeSettings,
  fetchHistorySettings,
  fetchThumbnailUsage,
  fetchTrashSettings,
  postClearHistory,
  postClearThumbnails,
  postFileTypeSettings,
  postHistorySettings,
  postTrashSettings,
} from "../core/apiClient.ts";
import { formatFileSize, must } from "../lib/dom.ts";
import { applyShowExtensions } from "../lib/pathLabel.ts";
import type { bindToggle } from "../lib/toggleRow.ts";
import type { DialogService } from "../services/dialog.ts";
import { createServerSetting, type ServerSetting } from "../services/serverSetting.ts";
import type { Setting } from "../services/settings.ts";

export interface FilesPageDeps {
  showExtensions: Setting<boolean>;
  /** Redraws every name the setting changes. */
  onNamesChanged(): void;
  /** Reads every listing again, once the server lists the new way. */
  onListingChanged(): void;
}

export interface FilesSettings {
  /** Whether Delete moves to the trash. A stale value only changes what a
   * confirmation offers: the delete request carries the choice confirmed. */
  moveToTrash: ServerSetting;
  /** Wires the page's toggles, all inside `page`. */
  bind(page: HTMLElement, deps: FilesPageDeps): void;
  refresh(): void;
}

export interface FilesSettingsDeps {
  alert(message: string): void;
  /** The Settings dialog's own, handed in since a view never imports one. */
  bindToggle: typeof bindToggle;
  /** Asks before Clear history deletes every version. A getter, since the
   * dialog service is made after this page. */
  dialog(): Pick<DialogService, "confirm">;
}

export function createFilesSettings({ alert, bindToggle, dialog }: FilesSettingsDeps): FilesSettings {
  const failed = (fallback: string) => (error: unknown) => alert(error instanceof Error ? error.message : fallback);
  let listingChanged = (): void => undefined;

  const moveToTrash = createServerSetting({
    initial: true,
    fetch: async () => (await fetchTrashSettings()).moveToTrash,
    save: postTrashSettings,
    onSaveFailed: failed("Couldn't save the trash setting"),
  });
  const allFileTypes = createServerSetting({
    initial: false,
    fetch: async () => (await fetchFileTypeSettings()).showAllFileTypes,
    // A listing read before the server saved would still list the old way.
    save: async (value) => {
      await postFileTypeSettings(value);
      listingChanged();
    },
    onSaveFailed: failed("Couldn't save the file types setting"),
  });
  const keepHistory = createServerSetting({
    initial: true,
    fetch: async () => (await fetchHistorySettings()).keepHistory,
    save: postHistorySettings,
    onSaveFailed: failed("Couldn't save the history setting"),
  });

  async function clearHistory(): Promise<void> {
    const confirmed = await dialog().confirm({
      title: "Clear history",
      message: "Every earlier version kept for this space is deleted. Your files stay as they are.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (confirmed) await postClearHistory().catch(failed("Couldn't clear the history"));
  }

  let usage: HTMLElement | undefined;
  let clearThumbnails: HTMLButtonElement | undefined;

  // What the thumbnails take, said beside the Clear that frees it. Nothing is
  // lost to a clear, so it asks nothing first.
  async function showUsage(): Promise<void> {
    const measured = await fetchThumbnailUsage().catch(() => undefined);
    if (!usage || !clearThumbnails || !measured) return;
    const { bytes, count } = measured;
    usage.textContent =
      count > 0
        ? `${count.toLocaleString()} thumbnails, ${formatFileSize(bytes)}. Galleries make them again as they show your images and clips.`
        : "None kept. Galleries make them as they show your images and clips.";
    clearThumbnails.disabled = count === 0;
  }

  return {
    moveToTrash,
    bind(page, deps) {
      listingChanged = deps.onListingChanged;
      bindToggle(must<HTMLButtonElement>("#setting-show-extensions", page), deps.showExtensions, {
        apply: applyShowExtensions,
        onChange: deps.onNamesChanged,
      });
      bindToggle(must<HTMLButtonElement>("#setting-show-all-file-types", page), allFileTypes);
      bindToggle(must<HTMLButtonElement>("#setting-move-to-trash", page), moveToTrash);
      bindToggle(must<HTMLButtonElement>("#setting-keep-history", page), keepHistory);
      must<HTMLButtonElement>("#setting-clear-history", page).addEventListener("click", () => void clearHistory());
      usage = must<HTMLElement>("#setting-thumbnails-usage", page);
      clearThumbnails = must<HTMLButtonElement>("#setting-clear-thumbnails", page);
      clearThumbnails.addEventListener("click", async () => {
        await postClearThumbnails().catch(failed("Couldn't clear the thumbnails"));
        await showUsage();
      });
    },
    refresh() {
      void moveToTrash.refresh();
      void allFileTypes.refresh();
      void keepHistory.refresh();
      void showUsage();
    },
  };
}
