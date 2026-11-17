import {
  fetchPublishers,
  type PublisherRow,
  postDeletePublisher,
  postSavePublisher,
  type SavePublisherRequestBody,
} from "../core/apiClient.ts";
import { buildOpenRow, replaceRows } from "../lib/dom.ts";
import { wireChoicePicker } from "../lib/picker.ts";
import type { DialogService } from "../services/dialog.ts";
import type { ContextMenuService } from "../services/menus.ts";

export interface PublishersPanelDeps {
  // Opens the Settings modal's one-level-deep drill-down subpage
  // (openSettingsSubpage in main.ts) — this panel only ever opens
  // "publisher".
  openSettingsSubpage: (id: string) => void;
  // Returns from that subpage to the Publishing category. Closing it re-runs
  // the category's show hook, which is what refreshes the list — so a save
  // never has to reload it on its own.
  closeSettingsSubpage: () => void;
  // A getter, not the service: this panel is wired while Settings' markup is
  // built, which is before the dialog service exists, and nothing here needs
  // it until Remove is clicked.
  dialog(): DialogService;
  contextMenu: ContextMenuService;
}

// The Publishing settings panel — a publisher manager, shown on every target,
// over /api/publishers (docs/publishing.md). The key is stored server-side
// behind its own seam (loadConfig.ts's "Publisher secret storage"); this UI
// never receives a key back, only `keySource`.
//
// Deliberately the same shape as providersPanel.ts down to the class names,
// minus the model checklist: a publisher, like a model provider, is a named
// endpoint with a key.
//
// `root` is the whole `#settings-body`: queries span the list <section> and
// the sibling form subpage.
export function wirePublishersPanel(root: HTMLElement, deps: PublishersPanelDeps): () => Promise<void> {
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const note = q<HTMLParagraphElement>("#publishers-storage-note");
  const list = q<HTMLDivElement>("#publishers-list");
  const addButton = q<HTMLButtonElement>("#publishers-add");
  const form = q<HTMLFormElement>("#publishers-form");
  const presetButton = q<HTMLButtonElement>("#publishers-form-preset");
  const presetRow = presetButton.closest<HTMLElement>(".settings-field")!;
  // Name, Base URL and their note, for a Custom endpoint only. Hidden rather
  // than undisplayed, so the card's dividers skip them.
  const customOnly = Array.from(form.querySelectorAll<HTMLElement>(".settings-custom-only"));
  const showCustom = (on: boolean): void => {
    for (const el of customOnly) el.hidden = !on;
  };
  const nameInput = q<HTMLInputElement>("#publishers-form-name");
  const nameHint = q<HTMLParagraphElement>("#publishers-form-name-hint");
  const baseUrlInput = q<HTMLInputElement>("#publishers-form-baseurl");
  const keyInput = q<HTMLInputElement>("#publishers-form-key");
  const setButton = q<HTMLButtonElement>("#publishers-form-set");
  const messageLine = q<HTMLParagraphElement>("#publishers-form-message");
  const formTitle = q<HTMLHeadingElement>("#publishers-form-title");
  const removeButton = q<HTMLButtonElement>("#publishers-form-remove");

  // `kind` names the protocol an endpoint speaks, not the company running
  // it (docs/publishing.md's Publisher configuration section), so both
  // presets save the same kind — the choice is only whether the endpoint
  // is Sogma's own or one typed in.
  const SOGMA_BASE_URL = "https://api.sogma.com/v1";
  const PRESETS: Record<string, { baseURL: string; label: string }> = {
    sogma: { baseURL: SOGMA_BASE_URL, label: "Sogma" },
    custom: { baseURL: "", label: "" },
  };
  const presetPicker = wireChoicePicker(
    presetButton,
    [
      { value: "sogma", label: PRESETS.sogma.label },
      { value: "custom", label: "Custom" },
    ],
    {
      role: "Service",
      contextMenu: deps.contextMenu,
      pick: () => {
        if (!editing) applyPreset();
      },
    },
  );

  let formPublisherId = "";
  let formLabel = "";
  let editing = false;
  // What load() last read, so the form can name an id that isn't taken and
  // re-read a row's key state after a save.
  let publisherRows: readonly PublisherRow[] = [];

  const slugify = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // A publisher's id is the slug of its name, suffixed -2, -3, … past a
  // collision. Unlike a model provider's, no preset id is reserved: a
  // publisher id is only a config key and a site's `publisherId`, so deriving
  // every one the same way keeps a second connection to the same service
  // from silently upserting over the first.
  function uniquePublisherId(name: string): string {
    const base = slugify(name) || "publisher";
    const taken = new Set(publisherRows.map((row) => row.id));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  // Under the Name field: the id this name resolves to. Live while adding
  // ("Saved as `x`"); static while editing ("ID: `x`" — the id never moves,
  // it names the saved key and is what a site's `_site.json` points at).
  function renderNameHint(): void {
    const custom = presetPicker.value === "custom";
    if (custom && editing) setNameHint("ID:", formPublisherId);
    else if (custom && nameInput.value.trim()) setNameHint("Saved as", uniquePublisherId(nameInput.value.trim()));
    else nameHint.hidden = true;
  }

  function setNameHint(prefix: string, id: string): void {
    const code = document.createElement("code");
    code.textContent = id;
    nameHint.replaceChildren(document.createTextNode(`${prefix} `), code);
    nameHint.hidden = false;
  }

  // The key value never comes back from the server (only `keySource`), so
  // the field is always blank — its placeholder is the only signal of
  // what's already in place.
  function setKeyPlaceholder(source: PublisherRow["keySource"] | undefined): void {
    keyInput.placeholder =
      source === "stored"
        ? "a key is set (enter a new one to replace it)"
        : source === "unreadable"
          ? "the saved key can't be used here: enter it again"
          : "";
  }

  function applyPreset(): void {
    showCustom(presetPicker.value === "custom");
    nameInput.value = "";
    baseUrlInput.value = PRESETS[presetPicker.value]?.baseURL ?? "";
    setKeyPlaceholder("none");
    renderNameHint();
  }

  // Every message in the line goes through here, so each one sets its own
  // level and none keeps the last one's colour.
  function showMessage(message: string, level: "error" | "warning" = "error"): void {
    messageLine.textContent = message;
    messageLine.classList.toggle("inline-error", level === "error");
    messageLine.classList.toggle("inline-warning", level === "warning");
    messageLine.hidden = false;
  }

  // A saved publisher's preset can't change, so the picker is hidden while
  // editing: the subpage title carries the identity.
  function setEditing(on: boolean): void {
    editing = on;
    presetButton.disabled = on;
    presetRow.hidden = on;
    removeButton.hidden = !on;
  }

  function openForm(row?: PublisherRow): void {
    messageLine.hidden = true;
    keyInput.value = "";
    setButton.textContent = "Set";
    formTitle.textContent = row ? row.label : "Add publisher";

    if (row) {
      // Matched by endpoint, never by id: an entry pointing somewhere other
      // than Sogma's own API is a custom connection whatever it is called
      // or keyed by, and opening it as the preset would quietly retarget it
      // at Sogma on the next Set.
      const presetKey = row.baseURL === SOGMA_BASE_URL ? "sogma" : "custom";
      presetPicker.show(presetKey);
      showCustom(presetKey === "custom");
      nameInput.value = row.label;
      baseUrlInput.value = row.baseURL;
      formPublisherId = row.id;
      formLabel = row.label;
      setEditing(true);
      setKeyPlaceholder(row.keySource);
      // Why the saved key can't be used, in the line a failed Set reports in.
      if (row.keyProblem) showMessage(row.keyProblem);
      renderNameHint();
    } else {
      presetPicker.show("sogma");
      formPublisherId = "";
      setEditing(false);
      applyPreset();
    }
    deps.openSettingsSubpage("publisher");
  }

  async function onSet(): Promise<void> {
    messageLine.hidden = true;
    const isCustom = presetPicker.value === "custom";
    const preset = PRESETS[presetPicker.value] ?? PRESETS.custom;

    let id: string;
    let label: string;
    if (isCustom) {
      const name = nameInput.value.trim();
      if (!name) throw new Error("Enter a name");
      // Editing keeps the existing id; only a fresh publisher gets a slug.
      id = editing ? formPublisherId : uniquePublisherId(name);
      label = name;
    } else {
      label = preset.label;
      id = editing ? formPublisherId : uniquePublisherId(label);
    }

    const payload: SavePublisherRequestBody = {
      id,
      kind: "sogma",
      label,
      baseURL: isCustom ? baseUrlInput.value.trim() : preset.baseURL,
    };
    const key = keyInput.value.trim();
    if (key) payload.apiKey = key;

    setButton.disabled = true;
    setButton.textContent = "…";
    try {
      const result = await postSavePublisher(payload);
      keyInput.value = "";
      // A key the publisher couldn't be reached to check is saved all the
      // same ("can't disprove it", src/protocol/publisher.ts). The form stays,
      // now editing what it saved, so a second Set can't add a duplicate.
      if (key && result.error) {
        formPublisherId = id;
        formLabel = label;
        formTitle.textContent = label;
        setEditing(true);
        setKeyPlaceholder("stored");
        renderNameHint();
        showMessage(`Saved, but Pragma couldn't reach ${label} to check the key: ${result.error}`, "warning");
        return;
      }
      // A saved publisher is a finished job — unlike a model provider, whose
      // form grows a model checklist on Set and so has a reason to stay
      // open. Back to the list.
      deps.closeSettingsSubpage();
    } finally {
      setButton.disabled = false;
      setButton.textContent = "Set";
    }
  }

  async function load(): Promise<void> {
    // Runs on every show of the Publishing category (including Back out of
    // the publisher subpage), so the list always reflects the latest saves.
    try {
      const data = await fetchPublishers();
      publisherRows = data.publishers;
      // No standing storage banner — same posture as the provider list's
      // own note: only surface it when a key genuinely can't be saved.
      note.classList.remove("inline-error");
      note.hidden = data.store.kind !== "safe-storage" || data.store.available;
      note.textContent = "Secure storage isn't available on this system, so keys can't be saved here.";
      replaceRows(
        list,
        data.publishers.map((row) => {
          const meta = document.createElement("span");
          meta.className = "settings-list-row-meta";
          const name = document.createElement("span");
          name.className = "settings-row-name";
          name.textContent = row.label;
          meta.append(name);
          // The sub line is an attention marker, not a status readout: a fully
          // set-up publisher reads as a bare name, so the rows carrying text
          // under them are exactly the ones still missing something. Both
          // facts are on its subpage, so neither is only visible here.
          const missing: string[] = [];
          if (!row.baseURL) missing.push("no endpoint");
          if (row.keySource !== "stored") missing.push("no key");
          if (missing.length) {
            const sub = document.createElement("span");
            sub.className = "settings-row-sub";
            sub.textContent = missing.join(" · ");
            meta.append(sub);
          }
          return buildOpenRow(row.id, [meta], () => openForm(row));
        }),
      );
    } catch (error) {
      // The server's reason, such as a config.json it can't read, so the
      // fix can be made by hand.
      note.classList.add("inline-error");
      note.hidden = false;
      note.textContent = error instanceof Error ? error.message : "Couldn't load publishers.";
    }
  }

  async function onRemove(): Promise<void> {
    const id = formPublisherId;
    const removed = await deps.dialog().confirm({
      title: "Remove publisher",
      message: `“${formLabel}” and its stored key are deleted. Sites bound to it can no longer publish until they are pointed at another publisher.`,
      confirmLabel: "Remove",
      busyLabel: "Removing…",
      danger: true,
      action: async () => {
        await postDeletePublisher(id);
      },
    });
    if (removed) deps.closeSettingsSubpage();
  }

  nameInput.addEventListener("input", renderNameHint);
  addButton.addEventListener("click", () => openForm());
  removeButton.addEventListener("click", () => void onRemove());

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSet().catch((error: unknown) => {
      showMessage(error instanceof Error ? error.message : "Couldn't save the publisher");
    });
  });

  return load;
}
