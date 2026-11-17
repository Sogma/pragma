// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../web/core/apiClient.ts", () => ({
  fetchFileTypeSettings: vi.fn(async () => ({ showAllFileTypes: false })),
  fetchHistorySettings: vi.fn(async () => ({ keepHistory: true })),
  fetchThumbnailUsage: vi.fn(async () => ({ bytes: 97_517_568, count: 3100 })),
  fetchTrashSettings: vi.fn(async () => ({ moveToTrash: true })),
  postClearHistory: vi.fn(async () => undefined),
  postClearThumbnails: vi.fn(async () => undefined),
  postFileTypeSettings: vi.fn(async () => undefined),
  postHistorySettings: vi.fn(async () => undefined),
  postTrashSettings: vi.fn(async () => undefined),
}));

const api = await import("../../../web/core/apiClient.ts");
const { bindToggle } = await import("../../../web/lib/toggleRow.ts");
const { createFilesSettings } = await import("../../../web/view/filesSettings.ts");

// The page's controls, as Settings → Files holds them.
function page(): HTMLElement {
  const root = document.createElement("div");
  for (const id of [
    "setting-show-extensions",
    "setting-show-all-file-types",
    "setting-move-to-trash",
    "setting-keep-history",
    "setting-clear-history",
    "setting-clear-thumbnails",
  ]) {
    const button = document.createElement("button");
    button.id = id;
    root.append(button);
  }
  const usage = document.createElement("div");
  usage.id = "setting-thumbnails-usage";
  root.append(usage);
  return root;
}

function bound(confirmed: boolean) {
  const confirm = vi.fn(async () => confirmed);
  const files = createFilesSettings({ alert: vi.fn(), bindToggle, dialog: () => ({ confirm }) });
  const root = page();
  files.bind(root, {
    showExtensions: { get: () => false, set: vi.fn(), subscribe: () => () => undefined },
    onNamesChanged: vi.fn(),
    onListingChanged: vi.fn(),
  });
  const click = (id: string) => root.querySelector<HTMLButtonElement>(`#${id}`)?.click();
  return { confirm, click, root, files };
}

describe("Settings → Files, History", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves the switch as the server's setting", async () => {
    const { click, root } = bound(true);
    click("setting-keep-history");
    expect(api.postHistorySettings).toHaveBeenCalledWith(false);
    expect(root.querySelector("#setting-keep-history")?.getAttribute("aria-checked")).toBe("false");
  });

  it("clears every version only once the writer confirms", async () => {
    const asked = bound(false);
    asked.click("setting-clear-history");
    await vi.waitFor(() => expect(asked.confirm).toHaveBeenCalledOnce());
    expect(api.postClearHistory).not.toHaveBeenCalled();

    const confirmed = bound(true);
    confirmed.click("setting-clear-history");
    await vi.waitFor(() => expect(api.postClearHistory).toHaveBeenCalledOnce());
    expect(confirmed.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Clear history", danger: true }));
  });
});

describe("Settings → Files, Thumbnails", () => {
  beforeEach(() => vi.clearAllMocks());

  const usageText = (root: HTMLElement) => root.querySelector("#setting-thumbnails-usage")?.textContent;
  const clear = (root: HTMLElement) => root.querySelector<HTMLButtonElement>("#setting-clear-thumbnails");

  it("says what the thumbnails take each time the page shows", async () => {
    const { root, files } = bound(true);
    files.refresh();
    await vi.waitFor(() =>
      expect(usageText(root)).toBe(
        "3,100 thumbnails, 93 MB. Galleries make them again as they show your images and clips.",
      ),
    );
    expect(clear(root)?.disabled).toBe(false);
  });

  // Nothing is lost to a clear: galleries make the thumbnails again.
  it("clears them all without asking, then says none are kept", async () => {
    const { root, files, click, confirm } = bound(true);
    files.refresh();
    await vi.waitFor(() => expect(usageText(root)).toContain("3,100"));
    vi.mocked(api.fetchThumbnailUsage).mockResolvedValueOnce({ bytes: 0, count: 0 });
    click("setting-clear-thumbnails");

    await vi.waitFor(() =>
      expect(usageText(root)).toBe("None kept. Galleries make them as they show your images and clips."),
    );
    expect(api.postClearThumbnails).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(clear(root)?.disabled).toBe(true);
  });
});
