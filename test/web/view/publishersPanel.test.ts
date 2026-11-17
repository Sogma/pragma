// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublishers, postSavePublisher } from "../../../web/core/apiClient.ts";
import { must } from "../../../web/lib/dom.ts";
import { wirePublishersPanel } from "../../../web/view/publishersPanel.ts";
import { fakeContextMenu } from "../support/fakeContextMenu.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchPublishers: vi.fn(),
  postSavePublisher: vi.fn(),
}));

// Node's URL: under jsdom the global one is jsdom's, which Node's fs refuses.
const html = readFileSync(new NodeURL("../../../web/index.html", import.meta.url), "utf8");

describe("Settings → Publishing's list", () => {
  it("says why the list couldn't load", async () => {
    vi.mocked(fetchPublishers).mockRejectedValue(new Error("config.json: publishers[0] has no id"));
    document.body.innerHTML = must("#settings-body", new DOMParser().parseFromString(html, "text/html")).outerHTML;
    wirePublishersPanel(must<HTMLElement>("#settings-body"), {
      openSettingsSubpage: vi.fn(),
      closeSettingsSubpage: vi.fn(),
      dialog: () => {
        throw new Error("no dialog here");
      },
      contextMenu: fakeContextMenu(),
    })();

    const note = must<HTMLElement>("#publishers-storage-note");
    await vi.waitFor(() => expect(note.hidden).toBe(false));
    expect(note.textContent).toBe("config.json: publishers[0] has no id");
  });
});

describe("Settings → Publishing's form", () => {
  beforeEach(() => vi.clearAllMocks());

  function wire() {
    vi.mocked(fetchPublishers).mockResolvedValue({
      publishers: [],
      store: { kind: "plain-files", encrypted: false, available: true },
    });
    document.body.innerHTML = must("#settings-body", new DOMParser().parseFromString(html, "text/html")).outerHTML;
    const deps = {
      openSettingsSubpage: vi.fn(),
      closeSettingsSubpage: vi.fn(),
      dialog: (): never => {
        throw new Error("no dialog here");
      },
      contextMenu: fakeContextMenu(),
    };
    wirePublishersPanel(must<HTMLElement>("#settings-body"), deps)();
    must<HTMLButtonElement>("#publishers-add").click();
    return deps;
  }
  const line = () => must<HTMLElement>("#publishers-form-message");
  const submitKey = (key: string) => {
    must<HTMLInputElement>("#publishers-form-key").value = key;
    must<HTMLFormElement>("#publishers-form").requestSubmit();
  };

  it("stays on the publisher it saved when the key couldn't be checked", async () => {
    vi.mocked(postSavePublisher).mockResolvedValue({ error: "fetch failed" });
    const deps = wire();
    submitKey("sk-1");
    await vi.waitFor(() => expect(line().hidden).toBe(false));
    expect(line().textContent).toBe("Saved, but Pragma couldn't reach Sogma to check the key: fetch failed");
    expect(line().classList.contains("inline-warning")).toBe(true);
    expect(line().classList.contains("inline-error")).toBe(false);
    expect(deps.closeSettingsSubpage).not.toHaveBeenCalled();
    expect(must<HTMLElement>("#publishers-form-remove").hidden).toBe(false);

    // A second Set saves the same publisher again, never a second one.
    submitKey("sk-2");
    await vi.waitFor(() => expect(postSavePublisher).toHaveBeenCalledTimes(2));
    expect(vi.mocked(postSavePublisher).mock.calls.map(([payload]) => payload.id)).toEqual(["sogma", "sogma"]);
  });

  it("goes back to the list once the publisher took the key", async () => {
    vi.mocked(postSavePublisher).mockResolvedValue({});
    const deps = wire();
    submitKey("sk-1");
    await vi.waitFor(() => expect(deps.closeSettingsSubpage).toHaveBeenCalled());
  });

  it("stays on the form, in red, when the publisher rejects the key", async () => {
    vi.mocked(postSavePublisher).mockRejectedValue(new Error("The publisher rejected that API key."));
    const deps = wire();
    submitKey("sk-1");
    await vi.waitFor(() => expect(line().textContent).toBe("The publisher rejected that API key."));
    expect(line().classList.contains("inline-error")).toBe(true);
    expect(deps.closeSettingsSubpage).not.toHaveBeenCalled();
  });
});
