// The two site dialogs (docs/publishing.md): New Site, from the space
// tree's menu, and Site Settings, from the Websites list's per-site ⋮ menu —
// both forms over the publishing routes and nothing else.
//
// Site Settings registers its own command and menu item, so its visibility
// rule lives next to the action it guards; New Site's stays with the rest of
// the tree menu in sidebar/space.ts and only calls in here.
import { SITE_ASSETS_FOLDER_FIELD, SITE_NAME_FIELD } from "../../src/protocol/api.ts";
import { basenameOf } from "../../src/protocol/rootedPath.ts";
import {
  CreateSiteError,
  type CreateSiteResponse,
  type ExistingSogmaSite,
  fetchSiteSettings,
  postSiteImage,
  postSiteSettings,
  rawFileUrl,
  type SaveSiteSettingsResponse,
  type SiteImagePreview,
  type SiteImageUploadResponse,
  type SiteSettingsChanges,
  type SiteSettingsField,
  type SiteSettingsResponse,
} from "../core/apiClient.ts";
import { el } from "../lib/dom.ts";
import type { ListItemTarget } from "../lib/listItemMenu.ts";
import { settingsNav } from "../lib/settingsNav.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { DialogService } from "../services/dialog.ts";
import type { MenuRegistry } from "../services/menus.ts";

// The dialog's title: which site, and which service holds the settings
// being edited. The publisher is named because a space's sites can sit on
// more than one, and nothing else in this dialog says which one a given
// site is bound to. Muted so the site reads first; the brackets stay so the
// title still says the same when copied or read aloud.
function titleFor(loaded: SiteSettingsResponse): Node {
  const title = document.createDocumentFragment();
  title.append(`${loaded.siteName} Settings `, el("span", "dialog-title-muted", `[${loaded.publisherLabel}]`));
  return title;
}

// A word about anything the service offers that this pragma is too old to
// draw — better than quietly showing fewer controls than the service has.
function skippedNote(loaded: SiteSettingsResponse): string | undefined {
  if (!loaded.skipped) return undefined;
  const plural = loaded.skipped === 1 ? "setting needs" : "settings need";
  return `${loaded.skipped} ${plural} a newer version of Pragma to edit.`;
}

// Category keys that can't collide with a group the publisher names: General
// holds what the space keeps for the site, and UNGROUPED a publisher field
// whose schema names no group.
const GENERAL = "\0general";
const UNGROUPED = "\0ungrouped";

function textInput(id: string, value: string, placeholder?: string): HTMLInputElement {
  const input = el("input", "form-input settings-input");
  input.id = id;
  input.type = "text";
  input.autocomplete = "off";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function toggleInput(id: string, checked: boolean): HTMLInputElement {
  const input = el("input", "toggle-switch");
  input.id = id;
  input.type = "checkbox";
  input.checked = checked;
  return input;
}

// A description as text, with its code spans drawn as <code>. Schema
// descriptions are CommonMark, but nothing else in one is drawn: what the
// service sends never becomes markup.
function describedText(className: string, text: string): HTMLElement {
  const node = el("div", className);
  text.split("`").forEach((part, index) => {
    if (index % 2 === 1) node.append(el("code", "", part));
    else if (part) node.append(part);
  });
  return node;
}

// One Settings-style row: the title on the left, labelling the control on
// the right, with the description under the title when there is one.
function fieldRow(
  title: string,
  control: HTMLElement,
  labelled: HTMLElement = control,
  description?: string,
): HTMLElement {
  const row = el("div", "field-row");
  const label = el("label", "field-row-title", title);
  label.htmlFor = labelled.id;
  if (description) {
    const text = el("div", "field-row-text");
    text.append(label, describedText("field-row-description", description));
    row.append(text, control);
  } else {
    row.append(label, control);
  }
  return row;
}

function controlValue(input: HTMLInputElement): string | boolean {
  return input.type === "checkbox" ? input.checked : input.value;
}

const IMAGE_GLYPH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
const CLEAR_GLYPH =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>';

interface ImageControlSpec {
  // Holds the file's `public_id`, so Save diffs an image field like any other.
  input: HTMLInputElement;
  preview?: SiteImagePreview;
  // Offers the space images to choose from and uploads the chosen one,
  // resolving to what to show, or undefined when nothing was chosen.
  choose(): Promise<{ id: string; url: string; label: string } | undefined>;
}

// An image setting: its thumbnail and name, Choose to upload a space image
// in its place, and a clear. The value is a `public_id` the publisher
// assigned, so the only way to set one is through Choose.
function imageControl(id: string, spec: ImageControlSpec): { root: HTMLElement; choose: HTMLButtonElement } {
  const root = el("div", "site-image-field");
  const thumb = el("span", "site-image-thumb");
  const name = el("span", "site-image-name");
  const choose = el("button", "btn", "Choose…");
  choose.type = "button";
  choose.id = id;
  const clear = el("button", "icon-button site-image-clear");
  clear.type = "button";
  clear.setAttribute("aria-label", "Clear");
  clear.innerHTML = CLEAR_GLYPH;
  root.append(thumb, name, choose, clear);

  function render(url: string | null, label: string): void {
    thumb.replaceChildren();
    if (url) {
      const img = el("img", "site-image-picture");
      img.alt = "";
      img.src = url;
      thumb.append(img);
    } else {
      thumb.innerHTML = IMAGE_GLYPH;
    }
    name.textContent = label;
    clear.hidden = spec.input.value === "";
    root.classList.toggle("is-empty", spec.input.value === "");
  }

  choose.addEventListener("click", () => {
    void (async () => {
      choose.disabled = true;
      try {
        const chosen = await spec.choose();
        if (!chosen) return;
        spec.input.value = chosen.id;
        render(chosen.url, chosen.label);
      } finally {
        choose.disabled = false;
      }
    })();
  });
  clear.addEventListener("click", () => {
    spec.input.value = "";
    render(null, "None");
  });

  if (spec.input.value) render(spec.preview?.url ?? null, spec.preview?.label ?? "Image");
  else render(null, "None");
  return { root, choose };
}

// A field's own label, falling back to the last segment of its pointer for
// a service that declared none.
function labelFor(field: SiteSettingsField): string {
  return field.label || field.pointer.slice(field.pointer.lastIndexOf("/") + 1);
}

// The pointer a rejected write blamed, when it blamed one. Read structurally
// rather than by importing SiteSettingsError, so any thrown shape carrying a
// `field` works and a plain Error still falls through to the whole-form
// message.
function fieldPointer(error: unknown): string | undefined {
  const field = (error as { field?: unknown } | null)?.field;
  return typeof field === "string" ? field : undefined;
}

export interface SiteDialogsDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  dialog: DialogService;
  settings: SiteSettingsApi;
  // The views that read `_site.json` (the tree, which pastes resolve a
  // site's assets folder against, and the Websites list, which shows its
  // name), reloaded after the dialog changes it.
  onSiteFileChanged(): void;
  // The space images under a site's folder, for an image setting to offer.
  siteImages(sitePath: string): string[];
  createSite(
    parentPath: string,
    input: ({ name: string; domain?: string } | { existingSite: ExistingSogmaSite }) & { publisherId?: string },
  ): Promise<CreateSiteResponse>;
  // The publishers a site can actually be created on — those with a key
  // stored. Empty is the same gate New Site's own menu item uses, and both
  // read it per open rather than capturing it, since it changes while the
  // app is running.
  publishers(): readonly { id: string; label: string }[];
  // Reveals and opens the new site's `index.md` once it exists.
  onSiteCreated(sitePath: string): Promise<void>;
  // Brings the Space view up with the site's folder open and its row in
  // view, as a folder bookmark does.
  showInSpace(sitePath: string): void;
}

/** The routes Site Settings reads and writes through. */
export interface SiteSettingsApi {
  // The publisher's own settings schema and current values for one site.
  load(sitePath: string): Promise<SiteSettingsResponse>;
  // One Save, all or nothing: only what changed, the name and settings to the
  // publisher in one request, then `_site.json`. Rejects with a
  // SiteSettingsError whose `field` names the control to blame, where it can.
  save(sitePath: string, changes: SiteSettingsChanges): Promise<SaveSiteSettingsResponse>;
  // Uploads a space image to the site's publisher for an image setting,
  // which changes only when Save sends the returned `publicId`.
  uploadImage(sitePath: string, image: string): Promise<SiteImageUploadResponse>;
}

export const siteSettingsApi: SiteSettingsApi = {
  load: fetchSiteSettings,
  save: postSiteSettings,
  uploadImage: postSiteImage,
};

export interface SiteDialogs {
  openNewSite(parentPath: string): void;
}

export function createSiteDialogs(deps: SiteDialogsDeps): SiteDialogs {
  // New Site. `pendingRetry` holds the {id, slug, ...} Sogma already
  // returned once local scaffolding fails and the rollback delete itself
  // can't confirm the site is gone (see apiClient.ts): a
  // second submit while it's set retries only the local steps against that
  // same site, per the doc's "Rollback if step 3, 4, or 5 fails".
  function openNewSite(parentPath: string): void {
    let pendingRetry: ExistingSogmaSite | undefined;
    let created: CreateSiteResponse | undefined;
    // Which service the site is created on, and stays bound to for every
    // later publish — the picker only appears once there is a choice to
    // make, but the id is always sent, so the site never inherits whichever
    // publisher happens to be listed first.
    const publishers = deps.publishers();
    void deps.dialog
      .form({
        title: "New Site",
        icon: { glyph: "site" },
        fields: [
          ...(publishers.length > 1
            ? [
                {
                  id: "publisher",
                  label: "Publisher",
                  choices: publishers.map((row) => ({ value: row.id, label: row.label })),
                },
              ]
            : []),
          { id: "name", placeholder: "Site name" },
          { id: "domain", placeholder: "Custom domain (optional)" },
        ],
        focus: "name",
        submitLabel: "Create Site",
        busyLabel: "Creating…",
        failureMessage: "Failed to create site.",
        validate: (values) => (pendingRetry || values.name.trim() ? undefined : "Enter a site name."),
        submit: async (values) => {
          const publisherId = values.publisher || publishers[0]?.id;
          try {
            created = pendingRetry
              ? await deps.createSite(parentPath, { existingSite: pendingRetry, publisherId })
              : await deps.createSite(parentPath, {
                  name: values.name.trim(),
                  domain: values.domain.trim() || undefined,
                  publisherId,
                });
            pendingRetry = undefined;
          } catch (error) {
            // existingSite present → the site survived on Sogma (delete
            // rollback itself failed) → a retry should redo only local
            // steps, not restart from a fresh POST /v1/sites. Absent →
            // either nothing was created or the rollback delete succeeded,
            // so a retry is a full restart from the typed name/domain.
            pendingRetry = error instanceof CreateSiteError ? error.existingSite : undefined;
            return {
              message: error instanceof Error ? error.message : "Failed to create site.",
              submitLabel: pendingRetry ? "Retry" : "Create Site",
            };
          }
        },
      })
      .then(async (values) => {
        if (!values || !created) return;
        await deps.onSiteCreated(created.path);
      });
  }

  // Site Settings. The publisher is the store for all but the assets folder:
  // fields, labels and current values come from the service's settings
  // schema plus a read, and the write is a merge patch of what changed —
  // nothing hardcoded, so a setting the service adds shows up without a release.
  //
  // No local validation, deliberately: the service answers a rejected value
  // with the pointer of the field to blame, and a rule restated here could drift.
  async function openSiteSettings(sitePath: string): Promise<void> {
    let loaded: SiteSettingsResponse;
    try {
      loaded = await deps.settings.load(sitePath);
    } catch (error) {
      await deps.dialog.confirm({
        title: "Site Settings",
        icon: { glyph: "site" },
        message: error instanceof Error ? error.message : "Couldn't load this site's settings.",
        confirmLabel: "OK",
      });
      return;
    }
    if (loaded.siteNameUpdated) deps.onSiteFileChanged();

    // What the service currently holds — the baseline every Save diffs
    // against, so an untouched control is never sent and therefore never
    // overwrites a value changed elsewhere meanwhile.
    const current = new Map(loaded.fields.map((field) => [field.pointer, field.value]));

    // The same two-pane shape as Settings: General first, then one category
    // per group the publisher names.
    const categories = new Map<string, { label: string; rows: HTMLElement[] }>([
      [GENERAL, { label: "General", rows: [] }],
    ]);
    const controls = new Map<string, HTMLInputElement>();
    // Keyed as a refusal blames a control: a setting by its pointer, General's
    // two fields by their own names.
    const categoryOf = new Map<string, string>();
    const labelOf = new Map<string, string>();
    function addRow(
      key: string,
      label: string,
      control: HTMLElement,
      labelled: HTMLElement = control,
      description?: string,
    ): void {
      const category = categories.get(key) ?? {
        label: key === UNGROUPED ? loaded.publisherLabel : key,
        rows: [],
      };
      categories.set(key, category);
      category.rows.push(fieldRow(label, control, labelled, description));
    }

    // An image setting's Choose: the images in the site's folder, the one
    // picked uploaded to the publisher. Its preview is the space file, since
    // the publisher's own copy has no URL until it finishes checking it.
    async function chooseImage(label: string): Promise<{ id: string; url: string; label: string } | undefined> {
      const images = deps.siteImages(sitePath);
      if (images.length === 0) {
        await deps.dialog.confirm({
          title: `Choose ${label}`,
          message: "There are no images in this site's folder yet. Add one there, then choose it here.",
          confirmLabel: "OK",
        });
        return undefined;
      }
      const picked = await deps.dialog.pick({
        title: `Choose ${label}`,
        options: images.map((image) => ({
          id: image,
          label: basenameOf(image),
          description: image.slice(sitePath.length + 1),
        })),
      });
      if (!picked) return undefined;
      error.hidden = true;
      try {
        const uploaded = await deps.settings.uploadImage(sitePath, picked);
        return { id: uploaded.publicId, url: rawFileUrl(picked), label: basenameOf(picked) };
      } catch (thrown) {
        error.textContent = thrown instanceof Error ? thrown.message : "Failed to upload the image.";
        error.hidden = false;
        return undefined;
      }
    }

    function addGeneralRow(key: string, label: string, input: HTMLInputElement): void {
      addRow(GENERAL, label, input);
      categoryOf.set(key, GENERAL);
      labelOf.set(key, label);
    }
    const nameInput = textInput("site-setting-name", loaded.siteName);
    addGeneralRow(SITE_NAME_FIELD, "Name", nameInput);
    const assetsInput = textInput("site-setting-assets-folder", loaded.assetsFolder, "assets");
    addGeneralRow(SITE_ASSETS_FOLDER_FIELD, "Assets folder", assetsInput);
    for (const field of loaded.fields) {
      const key = field.group ?? UNGROUPED;
      const id = `site-setting-${field.pointer}`;
      let input: HTMLInputElement;
      if (field.kind === "toggle") {
        // A switch's description is shown, unlike a text field's: what a
        // switch can't do is the part its label has no room to say.
        input = toggleInput(id, field.value);
        addRow(key, labelFor(field), input, input, field.description);
      } else if (field.kind === "image") {
        input = el("input", "");
        input.type = "hidden";
        input.value = field.value;
        const control = imageControl(id, {
          input,
          preview: field.preview,
          choose: () => chooseImage(labelFor(field)),
        });
        addRow(key, labelFor(field), control.root, control.choose);
      } else {
        input = textInput(id, field.value, field.placeholder);
        addRow(key, labelFor(field), input);
      }
      controls.set(field.pointer, input);
      categoryOf.set(field.pointer, key);
      labelOf.set(field.pointer, labelFor(field));
    }

    const main = el("div", "settings-main");
    const nav = el("nav", "settings-nav");
    nav.setAttribute("aria-label", "Site settings categories");
    const body = el("div", "settings-body");
    const note = skippedNote(loaded);
    if (note) body.append(el("p", "dialog-message site-settings-message", note));
    const sections = new Map<string, HTMLElement>();
    for (const [key, category] of categories) {
      const item = el("button", "settings-nav-item", category.label);
      item.type = "button";
      item.dataset.settingsCategory = key;
      nav.append(item);
      const section = el("section", "settings-category");
      const group = el("div", "settings-group");
      const card = el("div", "settings-card");
      card.append(...category.rows);
      group.append(card);
      section.append(group);
      sections.set(key, section);
      body.append(section);
    }
    main.append(nav, body);
    const navList = settingsNav(nav, show);

    // One Save on every page, for every change in the dialog, General's
    // included: a site's name is the publisher's, so it waits for Save like
    // the rest. The header's close discards unsaved edits.
    const actions = el("div", "site-settings-actions");
    const error = el("div", "inline-error");
    error.hidden = true;
    const save = el("button", "btn primary", "Save");
    save.type = "button";
    actions.append(error, save);
    body.append(actions);

    function show(key: string): void {
      navList.select(key);
      for (const [id, section] of sections) section.hidden = id !== key;
    }
    show(GENERAL);

    const handle = deps.dialog.open({
      title: titleFor(loaded),
      icon: { glyph: "site" },
      content: main,
      className: "dialog-settings dialog-flush dialog-site-settings",
      initialFocus: nameInput,
    });

    async function submit(): Promise<void> {
      // Emptying a text control clears the setting, which a merge patch
      // says with an explicit null — not with "", a value the service would
      // have to accept as a string. A switch is always true or false.
      const edits: Record<string, string | boolean | null> = {};
      for (const [pointer, was] of current) {
        const input = controls.get(pointer);
        const now = input ? controlValue(input) : "";
        if (now !== was) edits[pointer] = now === "" ? null : now;
      }
      const name = nameInput.value.trim();
      const assetsFolder = assetsInput.value.trim();
      const changes: SiteSettingsChanges = {
        edits,
        ...(name !== loaded.siteName ? { name } : {}),
        ...(assetsFolder !== loaded.assetsFolder ? { assetsFolder } : {}),
      };
      const changesSiteFile = changes.name !== undefined || changes.assetsFolder !== undefined;
      if (Object.keys(edits).length === 0 && !changesSiteFile) {
        handle.close(); // nothing to say, nothing to send
        return;
      }

      save.disabled = true;
      save.textContent = "Saving…";
      error.hidden = true;
      try {
        await deps.settings.save(sitePath, changes);
        if (changesSiteFile) deps.onSiteFileChanged();
        handle.close();
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : "Failed to save settings.";
        // A refusal names the control to blame, keyed as the dialog keys it,
        // so the message can say which one and the dialog turns to its page.
        const blamed = fieldPointer(thrown);
        const category = blamed === undefined ? undefined : categoryOf.get(blamed);
        if (category) show(category);
        const label = blamed === undefined ? undefined : labelOf.get(blamed);
        error.textContent = label ? `${label}: ${message}` : message;
        error.hidden = false;
      } finally {
        save.disabled = false;
        save.textContent = "Save";
      }
    }
    save.addEventListener("click", () => void submit());
    for (const input of [nameInput, assetsInput, ...controls.values()]) {
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || save.disabled) return;
        event.preventDefault();
        void submit();
      });
    }
  }

  deps.commands.register({
    id: "site.settings",
    label: "Settings",
    // Same publisher gate as New Site: with nothing stored in Settings >
    // Publishing there is nowhere to sync these to. One
    // menu id serves every accordion list, so the `kind` check is what keeps
    // this off a library's own ⋮ menu.
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "site" && deps.publishers().length > 0,
    // `when` already narrowed this to a site row; the cast keeps that
    // narrowing, since a command's arg arrives untyped from the menu.
    run: (_, arg: ListItemTarget) => void openSiteSettings((arg as { kind: "site"; path: string }).path),
  });
  // Local, so unlike Settings it needs no publisher key.
  deps.commands.register({
    id: "site.showInSpace",
    label: "Show in space",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "site",
    run: (_, arg: ListItemTarget) => deps.showInSpace((arg as { kind: "site"; path: string }).path),
  });
  deps.menus.register("listItem", [{ command: "site.settings" }, { command: "site.showInSpace" }]);

  return { openNewSite };
}
