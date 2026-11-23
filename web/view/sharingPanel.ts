import {
  fetchSharing,
  postCheckSharing,
  postDeleteSharing,
  postSaveSharing,
  type SharingResponse,
} from "../core/apiClient.ts";
import { buildOpenRow, must, replaceRows } from "../lib/dom.ts";
import type { DialogService } from "../services/dialog.ts";

export interface SharingPanelDeps {
  openSettingsSubpage: (id: string) => void;
  // Closing the subpage re-runs Files' show hook, which reloads the row.
  closeSettingsSubpage: () => void;
  // A getter: the dialog service exists only after Settings' markup is wired.
  dialog(): DialogService;
}

// Settings → Files → Sharing, over /api/sharing: one row that opens the
// bucket's page. The secret never comes back from the server, only whether
// one is saved, so its field is always blank.
//
// `root` is the whole `#settings-body`: the row sits on the Files page and
// the form on its sibling subpage.
export function wireSharingPanel(root: HTMLElement, deps: SharingPanelDeps): () => Promise<void> {
  const list = must<HTMLDivElement>("#sharing-list", root);
  const form = must<HTMLFormElement>("#sharing-form", root);
  const endpointInput = must<HTMLInputElement>("#sharing-form-endpoint", root);
  const bucketInput = must<HTMLInputElement>("#sharing-form-bucket", root);
  const regionInput = must<HTMLInputElement>("#sharing-form-region", root);
  const accessKeyInput = must<HTMLInputElement>("#sharing-form-access-key", root);
  const secretInput = must<HTMLInputElement>("#sharing-form-secret", root);
  const saveButton = must<HTMLButtonElement>("#sharing-form-save", root);
  const checkButton = must<HTMLButtonElement>("#sharing-form-check", root);
  const messageLine = must<HTMLParagraphElement>("#sharing-form-message", root);
  const removeButton = must<HTMLButtonElement>("#sharing-form-remove", root);

  let current: SharingResponse["sharing"] = null;

  function showMessage(message: string, level: "error" | "success" = "error"): void {
    messageLine.textContent = message;
    messageLine.classList.toggle("inline-error", level === "error");
    messageLine.classList.toggle("inline-success", level === "success");
    messageLine.hidden = false;
  }

  function setSecretPlaceholder(): void {
    secretInput.placeholder =
      current?.keySource === "stored"
        ? "a key is set (enter a new one to replace it)"
        : current?.keySource === "unreadable"
          ? "the saved key can't be used here: enter it again"
          : "";
  }

  function openForm(): void {
    messageLine.hidden = true;
    endpointInput.value = current?.endpoint ?? "";
    bucketInput.value = current?.bucket ?? "";
    regionInput.value = current?.region ?? "";
    accessKeyInput.value = current?.accessKeyId ?? "";
    secretInput.value = "";
    setSecretPlaceholder();
    checkButton.hidden = current === null;
    removeButton.hidden = current === null;
    if (current?.keyProblem) showMessage(current.keyProblem);
    deps.openSettingsSubpage("sharing");
  }

  // A save is kept only once the server has put a file in the bucket and
  // read it back by its link, which takes a moment.
  async function onSave(): Promise<void> {
    messageLine.hidden = true;
    saveButton.disabled = true;
    saveButton.textContent = "…";
    try {
      const secret = secretInput.value.trim();
      await postSaveSharing({
        endpoint: endpointInput.value.trim(),
        bucket: bucketInput.value.trim(),
        region: regionInput.value.trim(),
        accessKeyId: accessKeyInput.value.trim(),
        ...(secret ? { secretAccessKey: secret } : {}),
      });
      secretInput.value = "";
      current = (await fetchSharing()).sharing;
      setSecretPlaceholder();
      checkButton.hidden = false;
      removeButton.hidden = false;
      showMessage("Saved. A file went into the bucket, opened by its link and was deleted.", "success");
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "Save";
    }
  }

  async function onCheck(): Promise<void> {
    messageLine.hidden = true;
    checkButton.disabled = true;
    try {
      await postCheckSharing();
      showMessage("Sharing works. A file went into the bucket, opened by its link and was deleted.", "success");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Couldn't reach the bucket");
    } finally {
      checkButton.disabled = false;
    }
  }

  async function onRemove(): Promise<void> {
    const removed = await deps.dialog().confirm({
      title: "Remove Sharing",
      message:
        "The bucket's settings and its saved secret are deleted. Providers that take references only as links can no longer be sent any.",
      confirmLabel: "Remove",
      busyLabel: "Removing…",
      danger: true,
      action: async () => {
        await postDeleteSharing();
      },
    });
    if (removed) deps.closeSettingsSubpage();
  }

  async function load(): Promise<void> {
    const name = document.createElement("span");
    name.className = "settings-row-name";
    name.textContent = "Sharing";
    const sub = document.createElement("span");
    sub.className = "settings-row-sub";
    try {
      current = (await fetchSharing()).sharing;
      sub.textContent = !current
        ? "Not set up"
        : current.keySource === "stored"
          ? `${current.bucket} · ${hostOf(current.endpoint)}`
          : "no key";
    } catch (error) {
      current = null;
      sub.textContent = error instanceof Error ? error.message : "Couldn't load Sharing";
    }
    const meta = document.createElement("span");
    meta.className = "settings-list-row-meta";
    meta.append(name, sub);
    replaceRows(list, [buildOpenRow("sharing", [meta], openForm)]);
  }

  checkButton.addEventListener("click", () => void onCheck());
  removeButton.addEventListener("click", () => void onRemove());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSave().catch((error: unknown) => {
      showMessage(error instanceof Error ? error.message : "Couldn't save Sharing");
    });
  });

  return load;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
