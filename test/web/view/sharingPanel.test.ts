// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSharing,
  postCheckSharing,
  postDeleteSharing,
  postSaveSharing,
  type SharingResponse,
} from "../../../web/core/apiClient.ts";
import type { ConfirmOptions, DialogService } from "../../../web/services/dialog.ts";
import { type SharingPanelDeps, wireSharingPanel } from "../../../web/view/sharingPanel.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSharing: vi.fn(),
  postSaveSharing: vi.fn(async () => undefined),
  postCheckSharing: vi.fn(async () => undefined),
  postDeleteSharing: vi.fn(async () => undefined),
}));

const store = { kind: "plain-files", encrypted: false, available: true } as const;
const savedAt = (endpoint: string): SharingResponse => ({
  sharing: {
    kind: "s3",
    endpoint,
    bucket: "refs",
    region: "",
    accessKeyId: "AK",
    keySource: "stored",
  },
  store,
});
const saved = savedAt("https://store.example.test");

// Settings → Files' Sharing row and page, as web/index.html has them,
// trimmed to what the panel reads.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSharing).mockResolvedValue({ sharing: null, store });
  document.body.innerHTML = `
    <div id="settings-body">
      <div id="sharing-list"></div>
      <form id="sharing-form">
        <p id="sharing-form-message" hidden></p>
        <input id="sharing-form-endpoint" /><button id="sharing-form-check" type="button"></button>
        <input id="sharing-form-bucket" /><input id="sharing-form-region" />
        <input id="sharing-form-access-key" />
        <input id="sharing-form-secret" /><button id="sharing-form-save" type="submit">Save</button>
      </form>
      <button id="sharing-form-remove" hidden></button>
    </div>`;
});

function wire(overrides: Partial<SharingPanelDeps> = {}) {
  const deps: SharingPanelDeps = {
    openSettingsSubpage: vi.fn(),
    closeSettingsSubpage: vi.fn(),
    dialog: () => {
      throw new Error("no dialog here");
    },
    ...overrides,
  };
  void wireSharingPanel(document.querySelector("#settings-body") as HTMLElement, deps)();
  return deps;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const row = () => document.querySelector<HTMLElement>("#sharing-list > .settings-open-row");
const sub = () => row()?.querySelector(".settings-row-sub")?.textContent;

describe("Settings → Files → Sharing", () => {
  it("reads Not set up until a bucket is, and opens an empty page offering no Test or Remove", async () => {
    const deps = wire();
    await vi.waitFor(() => expect(sub()).toBe("Not set up"));
    expect(row()?.dataset.settingsItem).toBe("sharing");
    row()?.click();
    expect(deps.openSettingsSubpage).toHaveBeenCalledWith("sharing");
    expect(byId<HTMLInputElement>("sharing-form-endpoint").value).toBe("");
    expect(byId("sharing-form-check").hidden).toBe(true);
    expect(byId("sharing-form-remove").hidden).toBe(true);
  });

  it("names the bucket once one is set up, and fills the page with all but the secret", async () => {
    vi.mocked(fetchSharing).mockResolvedValue(saved);
    wire();
    await vi.waitFor(() => expect(sub()).toBe("refs · example.test"));
    row()?.click();
    expect(byId<HTMLInputElement>("sharing-form-bucket").value).toBe("refs");
    expect(byId<HTMLInputElement>("sharing-form-access-key").value).toBe("AK");
    expect(byId<HTMLInputElement>("sharing-form-secret").value).toBe("");
    expect(byId<HTMLInputElement>("sharing-form-secret").placeholder).toBe(
      "a key is set (enter a new one to replace it)",
    );
    expect(byId("sharing-form-check").hidden).toBe(false);
  });

  it.each([
    ["https://0123abcd.eu.store.example.test:8443", "eu.store.example.test"],
    ["http://192.168.1.10:9000", "192.168.1.10"],
    ["https://example.test", "example.test"],
    ["http://localhost:9000", "localhost"],
  ])("shows the endpoint %s as %s", async (endpoint, host) => {
    vi.mocked(fetchSharing).mockResolvedValue(savedAt(endpoint));
    wire();
    await vi.waitFor(() => expect(sub()).toBe(`refs · ${host}`));
  });

  it("saves the fields and the secret, then says the round trip worked", async () => {
    wire();
    await vi.waitFor(() => expect(row()).not.toBeNull());
    row()?.click();
    byId<HTMLInputElement>("sharing-form-endpoint").value = " https://store.example.test ";
    byId<HTMLInputElement>("sharing-form-bucket").value = "refs";
    byId<HTMLInputElement>("sharing-form-access-key").value = "AK";
    byId<HTMLInputElement>("sharing-form-secret").value = "shh";
    vi.mocked(fetchSharing).mockResolvedValue(saved);
    byId<HTMLFormElement>("sharing-form").requestSubmit();
    await vi.waitFor(() => expect(byId("sharing-form-message").hidden).toBe(false));
    expect(postSaveSharing).toHaveBeenCalledWith({
      endpoint: "https://store.example.test",
      bucket: "refs",
      region: "",
      accessKeyId: "AK",
      secretAccessKey: "shh",
    });
    expect(byId("sharing-form-message").textContent).toBe(
      "Saved. A file went into the bucket, opened by its link and was deleted.",
    );
    expect(byId<HTMLInputElement>("sharing-form-secret").value).toBe("");
  });

  it("says in red why a save or a test failed", async () => {
    vi.mocked(fetchSharing).mockResolvedValue(saved);
    vi.mocked(postCheckSharing).mockRejectedValueOnce(new Error("The bucket answered 403: AccessDenied."));
    wire();
    await vi.waitFor(() => expect(row()).not.toBeNull());
    row()?.click();
    byId("sharing-form-check").click();
    await vi.waitFor(() =>
      expect(byId("sharing-form-message").textContent).toBe("The bucket answered 403: AccessDenied."),
    );
    expect(byId("sharing-form-message").classList.contains("inline-error")).toBe(true);
  });

  // A line emptied as the attempt starts would move the fields under it twice.
  it("keeps the last message up while the next attempt runs, then puts its own in its place", async () => {
    vi.mocked(fetchSharing).mockResolvedValue(saved);
    vi.mocked(postCheckSharing).mockRejectedValueOnce(new Error("The bucket answered 403: AccessDenied."));
    wire();
    await vi.waitFor(() => expect(row()).not.toBeNull());
    row()?.click();
    const line = byId("sharing-form-message");
    byId("sharing-form-check").click();
    await vi.waitFor(() => expect(line.textContent).toBe("The bucket answered 403: AccessDenied."));

    let answer = () => {};
    vi.mocked(postCheckSharing).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    byId("sharing-form-check").click();
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("The bucket answered 403: AccessDenied.");

    answer();
    await vi.waitFor(() => expect(line.classList.contains("inline-success")).toBe(true));
    expect(line.textContent).toBe("Sharing works. A file went into the bucket, opened by its link and was deleted.");
    expect(line.classList.contains("inline-error")).toBe(false);
  });

  it("removes the setup inside the confirmation, then goes back to Files", async () => {
    vi.mocked(fetchSharing).mockResolvedValue(saved);
    const confirm = vi.fn(async (options: ConfirmOptions) => {
      await options.action?.();
      return true;
    });
    const deps = wire({ dialog: () => ({ confirm }) as unknown as DialogService });
    await vi.waitFor(() => expect(sub()).toBe("refs · example.test"));
    row()?.click();
    byId("sharing-form-remove").click();
    await vi.waitFor(() => expect(deps.closeSettingsSubpage).toHaveBeenCalled());
    expect(postDeleteSharing).toHaveBeenCalled();
  });
});
