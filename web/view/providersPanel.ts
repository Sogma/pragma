import { CHATGPT_USAGE_URL } from "../../src/protocol/api.ts";
import {
  type DiscoverModelsResponse,
  fetchMcpServers,
  fetchProviderSignInStatus,
  fetchProviders,
  type ProviderKind,
  type ProviderRow,
  type ProviderSignInStatus,
  postDeleteProvider,
  postDiscoverProviderModels,
  postProviderSignIn,
  postProviderSignOut,
  postSaveProvider,
  postSaveProviderModels,
  type SaveProviderRequestBody,
} from "../core/apiClient.ts";
import { defaultModels, PROVIDER_PRESETS as PRESETS, PROVIDER_PRESET_IDS } from "../core/providerPresets.ts";
import { buildOpenRow, countText, must, replaceRows } from "../lib/dom.ts";
import { markExternalLink, openExternalLink } from "../lib/externalLinks.ts";
import { type PickerChoice, wireChoicePicker } from "../lib/picker.ts";
import { createSettingsMessage } from "../lib/settingsMessage.ts";
import { uniqueSlug } from "../lib/slug.ts";
import type { DialogService } from "../services/dialog.ts";
import type { ContextMenuService } from "../services/menus.ts";

export interface ProvidersPanelDeps {
  // Opens the Settings modal's one-level-deep drill-down subpage
  // (openSettingsSubpage in main.ts) — this panel only ever opens
  // "provider".
  openSettingsSubpage: (id: string) => void;
  // Back to the AI Models category, whose show hook reloads the list.
  closeSettingsSubpage: () => void;
  // Called after every save/delete that could change which models are
  // available, so the model pickers stay current.
  onProvidersChanged: () => void;
  // A getter, not the service: this panel is wired while Settings' markup is
  // built, which is before the dialog service exists, and nothing here needs
  // it until Remove is clicked.
  dialog(): DialogService;
  contextMenu: ContextMenuService;
}

// The Provider picker's choices, by the preset id each saves as.
const PRESET_CHOICES: PickerChoice[] = [
  { value: "chatgpt", label: "ChatGPT plan" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" },
  { value: "lmstudio", label: "LM Studio (local)" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "vercel", label: "Vercel AI Gateway" },
  { value: "custom", label: "Custom" },
];

// Settings → AI Models' provider list, shown on every target (start, dev,
// Electron), over /api/providers. The key is stored server-side in the
// credential store (a plain file or the OS keychain); this UI never
// receives a key back, only `keySource` (docs/architecture.md's Model
// providers and configuration section).
//
// `root` is the whole `#settings-body`: queries span the list `<section>` and
// the sibling provider-form subpage. The returned refresh runs on every show
// of the category, so the list reflects saves.
// What a Set that worked says over the checkboxes: how many models the
// provider offers, and that the ticked ones are what model menus list.
function setConfirmation(label: string, found: DiscoverModelsResponse, keyed: boolean, ticked: number): string {
  const lead = keyed ? "Key works" : "Connected";
  const counts = [
    [found.textModels.length, "text model"],
    [found.imageModels.length, "image model"],
    [found.videoModels.length, "video model"],
  ] as const;
  const named = counts.filter(([n]) => n > 0).map(([n, noun]) => countText(n, noun));
  const offered = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named.join("");
  if (!offered) return `${lead}, but ${label} lists no models. Add one by id below.`;
  return ticked > 0
    ? `${lead}. ${label} offers ${offered}, and Pragma lists the ticked ones wherever you choose a model.`
    : `${lead}. ${label} offers ${offered}: tick the ones Pragma should list wherever you choose a model.`;
}

export function wireProvidersPanel(root: HTMLElement, deps: ProvidersPanelDeps): () => Promise<void> {
  const note = must<HTMLParagraphElement>("#providers-storage-note", root);
  const list = must<HTMLDivElement>("#providers-list", root);
  const addButton = must<HTMLButtonElement>("#providers-add", root);
  const form = must<HTMLFormElement>("#providers-form", root);
  const presetButton = must<HTMLButtonElement>("#providers-form-preset", root);
  const presetRow = must<HTMLElement>("#providers-form-preset-row", root);
  const presetPicker = wireChoicePicker(presetButton, PRESET_CHOICES, {
    role: "Provider",
    contextMenu: deps.contextMenu,
    pick: () => {
      if (!editing) applyPreset();
    },
  });
  // Name, Base URL and their note, for a Custom provider only. Hidden rather
  // than undisplayed, so the card's dividers skip them.
  const customOnly = Array.from(form.querySelectorAll<HTMLElement>(".settings-custom-only"));
  const showCustom = (on: boolean): void => {
    for (const el of customOnly) el.hidden = !on;
  };
  const nameInput = must<HTMLInputElement>("#providers-form-name", root);
  const nameHint = must<HTMLParagraphElement>("#providers-form-name-hint", root);
  const baseUrlInput = must<HTMLInputElement>("#providers-form-baseurl", root);
  const keyInput = must<HTMLInputElement>("#providers-form-key", root);
  const setButton = must<HTMLButtonElement>("#providers-form-set", root);
  const modelsBlock = must<HTMLDivElement>("#providers-form-models", root);
  const modelsList = must<HTMLDivElement>("#providers-form-models-list", root);
  const modelAddInput = must<HTMLInputElement>("#providers-form-model-add", root);
  const imageModelsBlock = must<HTMLDivElement>("#providers-form-image-models", root);
  const imageModelsList = must<HTMLDivElement>("#providers-form-image-models-list", root);
  const imageModelAddInput = must<HTMLInputElement>("#providers-form-image-model-add", root);
  const videoModelsBlock = must<HTMLDivElement>("#providers-form-video-models", root);
  const videoModelsList = must<HTMLDivElement>("#providers-form-video-models-list", root);
  const videoModelAddInput = must<HTMLInputElement>("#providers-form-video-model-add", root);
  const refreshButton = must<HTMLButtonElement>("#providers-form-refresh", root);
  const message = createSettingsMessage(must<HTMLParagraphElement>("#providers-form-message", root));
  const formTitle = must<HTMLHeadingElement>("#providers-form-title", root);
  const removeButton = must<HTMLButtonElement>("#providers-form-remove", root);
  // A ChatGPT plan signs in where every other provider takes a key.
  const keyRow = must<HTMLDivElement>("#providers-form-key-row", root);
  const signInRow = must<HTMLDivElement>("#providers-form-sign-in-row", root);
  const accountText = must<HTMLSpanElement>("#providers-form-account", root);
  const continueButton = must<HTMLButtonElement>("#providers-form-continue", root);
  const allowPlanButton = must<HTMLButtonElement>("#providers-form-allow-plan", root);
  const signOutButton = must<HTMLButtonElement>("#providers-form-sign-out", root);
  const signInStatus = must<HTMLParagraphElement>("#providers-form-sign-in-status", root);

  // The checklists, each saving only its own config field.
  interface ModelList {
    field: "textModels" | "imageModels" | "videoModels";
    container: HTMLDivElement;
    enabled: string[];
  }
  const textModels: ModelList = { field: "textModels", container: modelsList, enabled: [] };
  const imageModels: ModelList = { field: "imageModels", container: imageModelsList, enabled: [] };
  const videoModels: ModelList = { field: "videoModels", container: videoModelsList, enabled: [] };

  let formProviderId = "";
  let formLabel = "";
  let editing = false;
  let signIn: ProviderSignInStatus = { state: "signed-out" };
  let signInAllowed = false;
  let signInNote: Node[] = [];
  let authorizationUrl: string | undefined;
  let pollTimer: number | undefined;
  // Ids already in use, refreshed by load(). Providers and MCP servers share
  // one id namespace, since an image model ref may name either. The preset option
  // values are always reserved too — a Custom "OpenAI" mustn't be able to
  // take `openai` and later collide with the real preset.
  let knownProviderIds: string[] = [];
  let knownServerIds: string[] = [];
  const reservedIds = PROVIDER_PRESET_IDS;

  function currentPreset(): (typeof PRESETS)[string] {
    return PRESETS[presetPicker.value] ?? PRESETS.custom;
  }

  // A fresh custom provider's id is the slug of its name (falling back to
  // "provider" for a name with nothing sluggable), suffixed -2, -3, … past a
  // collision with another provider or a preset id.
  function uniqueProviderId(name: string): string {
    return uniqueSlug(name, new Set([...reservedIds, ...knownProviderIds, ...knownServerIds]), "provider");
  }

  // Under the Name field: the id this name resolves to. Live while adding
  // ("Saved as `x`"); static while editing ("ID: `x`" — the id never moves,
  // it names the saved key and is the `providerId/model` ref prefix).
  function renderNameHint(): void {
    const custom = presetPicker.value === "custom";
    if (custom && editing) setNameHint("ID:", formProviderId);
    else if (custom && nameInput.value.trim()) setNameHint("Saved as", uniqueProviderId(nameInput.value.trim()));
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
  function setKeyPlaceholder(source: ProviderRow["keySource"], keyless: boolean): void {
    keyInput.placeholder = keyless
      ? "not required"
      : source === "stored"
        ? "a key is set (enter a new one to replace it)"
        : source === "env"
          ? "using an environment key"
          : source === "unreadable"
            ? "the saved key can't be used here: enter it again"
            : "";
  }

  // Resolves to whether the selection was saved.
  async function saveModels(...lists: ModelList[]): Promise<boolean> {
    // The checklist renders from `enabled`, not the reply, so a failed
    // save looks exactly like a good one until the next load drops it.
    try {
      await postSaveProviderModels(formProviderId, Object.fromEntries(lists.map((list) => [list.field, list.enabled])));
    } catch (error) {
      message.show(error instanceof Error ? error.message : "Couldn't save the model selection");
      return false;
    }
    deps.onProvidersChanged();
    return true;
  }

  // The checklist always shows the union of what's discovered and what's
  // already enabled, so a currently-enabled model a Refresh didn't return
  // (an unloaded LM Studio model) stays visible and removable.
  function renderChecklist(list: ModelList, discovered: string[]): void {
    const ids = [...new Set([...discovered, ...list.enabled])];
    list.container.replaceChildren(
      ...ids.map((id) => {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = list.enabled.includes(id);
        box.addEventListener("change", () => {
          list.enabled = box.checked ? [...new Set([...list.enabled, id])] : list.enabled.filter((m) => m !== id);
          void saveModels(list);
        });
        label.append(box, document.createTextNode(id));
        return label;
      }),
    );
  }

  function renderChecklists(
    discovered: DiscoverModelsResponse = { textModels: [], imageModels: [], videoModels: [] },
  ): void {
    renderChecklist(textModels, discovered.textModels);
    renderChecklist(imageModels, discovered.imageModels);
    renderChecklist(videoModels, discovered.videoModels);
  }

  // Anthropic makes no images, and a ChatGPT plan covers text only, so
  // neither form has an image list. Only the gateway makes videos.
  function showMediaModels(kind: ProviderKind): void {
    imageModelsBlock.hidden = kind === "anthropic" || kind === "chatgpt";
    videoModelsBlock.hidden = kind !== "vercel";
  }

  async function discover(): Promise<DiscoverModelsResponse> {
    return postDiscoverProviderModels(formProviderId);
  }

  // A provider's preset can't change once created, so the picker is just
  // hidden while editing — the subpage title carries the identity, and the
  // Name (which is only the label) stays editable, only the derived id is
  // frozen.
  function setEditingMode(on: boolean): void {
    editing = on;
    presetButton.disabled = on;
    presetRow.hidden = on;
    removeButton.hidden = !on;
  }

  const text = (value: string): Node => document.createTextNode(value);

  function link(label: string, href: string): HTMLAnchorElement {
    const anchor = markExternalLink(document.createElement("a"));
    anchor.href = href;
    anchor.textContent = label;
    return anchor;
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function showSignIn(on: boolean): void {
    keyRow.hidden = on;
    signInRow.hidden = !on;
    if (!on) signInStatus.hidden = true;
  }

  // What the sign-in row shows, from `signIn`: a way in while signed out, the
  // account and a way out while signed in, and whether the plan is in use. A
  // failed sign-in is the form's error, so it goes to the top of the form.
  function renderSignIn(): void {
    const signedIn = signIn.state === "signed-in";
    accountText.textContent = signedIn
      ? (signIn.email ?? "Signed in")
      : signIn.state === "pending"
        ? "Signing in…"
        : "Not signed in";
    continueButton.hidden = signedIn;
    continueButton.disabled = !signInAllowed || signIn.state === "pending";
    continueButton.dataset.tooltip = signInAllowed
      ? ""
      : "Signing in needs pragma start without --external-url on the machine this host runs on";
    allowPlanButton.hidden = !signedIn || signIn.planUsage === true;
    allowPlanButton.disabled = !signInAllowed;
    signOutButton.hidden = !signedIn;
    const note: Node[] = [...signInNote];
    if (signIn.state === "pending") {
      note.push(text("Finish signing in in your browser."));
      if (authorizationUrl) note.push(text(" "), link("Open the sign-in page again", authorizationUrl));
    } else if (signedIn && signIn.planUsage) {
      note.push(text("Requests to these models use your ChatGPT plan. "), link("Manage usage", CHATGPT_USAGE_URL));
    } else if (signedIn) {
      note.push(text("Signed in, but Pragma isn't allowed to use your ChatGPT plan, so its models can't run."));
    } else if (signIn.message) {
      message.show(signIn.message);
    }
    signInStatus.replaceChildren(...note);
    signInStatus.hidden = note.length === 0;
  }

  // The checklist once the plan is in use: what the plan lists, and on a
  // first sign-in every one of them ticked.
  async function showPlanModels(): Promise<void> {
    modelsBlock.hidden = false;
    showMediaModels("chatgpt");
    try {
      const discovered = await discover();
      if (textModels.enabled.length === 0) {
        textModels.enabled = defaultModels("all", discovered).textModels;
        await saveModels(textModels);
      }
      renderChecklists(discovered);
    } catch (error) {
      renderChecklists();
      message.show(error instanceof Error ? error.message : "Couldn't list the plan's models.");
    }
  }

  // The browser finishes the sign-in out of the page's sight, so the form asks
  // until it ends, for as long as the server keeps it pending.
  function pollSignIn(id: string, firstTime: boolean): void {
    stopPolling();
    const deadline = Date.now() + 10 * 60_000;
    const tick = async (): Promise<void> => {
      try {
        const latest = await fetchProviderSignInStatus(id);
        if (id !== formProviderId) return;
        signIn = latest;
      } catch {
        // A failed check retries on the next tick.
      }
      if (signIn.state === "pending" && Date.now() < deadline) {
        pollTimer = window.setTimeout(() => void tick(), 1500);
        return;
      }
      pollTimer = undefined;
      authorizationUrl = undefined;
      // OpenAI asks that the first sign-in say plainly the plan is now in use.
      signInNote =
        signIn.state === "signed-in" && signIn.planUsage && firstTime
          ? [text("You're using your ChatGPT plan: eligible AI requests in Pragma count against it. ")]
          : [];
      renderSignIn();
      deps.onProvidersChanged();
      if (signIn.state === "signed-in" && signIn.planUsage) await showPlanModels();
    };
    pollTimer = window.setTimeout(() => void tick(), 1500);
  }

  // Continue with ChatGPT, and Allow plan use after it was declined. A fresh
  // provider is saved first: the sign-in belongs to its entry.
  async function onContinue(planUsage: boolean): Promise<void> {
    signInNote = [];
    const preset = currentPreset();
    const firstTime = !editing;
    if (!editing) {
      await postSaveProvider({ id: presetPicker.value, kind: preset.kind, label: preset.label });
      formProviderId = presetPicker.value;
      formLabel = preset.label;
      formTitle.textContent = formLabel;
      setEditingMode(true);
      deps.onProvidersChanged();
    }
    const url = await postProviderSignIn(formProviderId, { planUsage });
    message.clear();
    authorizationUrl = url;
    openExternalLink(url);
    signIn = { state: "pending" };
    renderSignIn();
    pollSignIn(formProviderId, firstTime);
  }

  async function onSignOut(): Promise<void> {
    stopPolling();
    const { revoked } = await postProviderSignOut(formProviderId);
    signIn = { state: "signed-out" };
    signInNote = revoked
      ? []
      : [
          text(
            "Signed out here, but ChatGPT didn't confirm it ended the session. Disconnect Pragma in ChatGPT's settings.",
          ),
        ];
    renderSignIn();
    deps.onProvidersChanged();
  }

  function applyPreset(): void {
    const preset = currentPreset();
    showCustom(presetPicker.value === "custom");
    showSignIn(Boolean(preset.signIn));
    signIn = { state: "signed-out" };
    signInNote = [];
    if (preset.signIn) renderSignIn();
    nameInput.value = "";
    baseUrlInput.value = preset.baseURL;
    keyInput.disabled = Boolean(preset.keyless);
    // Adding a new provider: no key yet, so the placeholder only says
    // anything for a keyless preset. Editing a provider overrides this
    // with the resolved key state.
    setKeyPlaceholder("none", Boolean(preset.keyless));
    renderNameHint();
    modelsBlock.hidden = true;
  }

  function openForm(row?: ProviderRow): void {
    stopPolling();
    authorizationUrl = undefined;
    signInNote = [];
    message.clear();
    keyInput.value = "";
    keyInput.disabled = false;
    setButton.textContent = "Set";
    formTitle.textContent = row ? row.label : "Add provider";

    if (row) {
      // A provider carrying a preset's own id (`openai`, `anthropic`,
      // `lmstudio`, …) *is* that preset — those ids are reserved, so a
      // custom connection can't hold one. Any other is custom, even at a
      // preset's address: read as that preset, Set would save it under the
      // preset's id, over the preset's own entry.
      const presetKey = PRESETS[row.id] ? row.id : "custom";
      presetPicker.show(presetKey);
      showCustom(presetKey === "custom");
      nameInput.value = row.label;
      baseUrlInput.value = row.baseURL;
      formProviderId = row.id;
      formLabel = row.label;
      textModels.enabled = [...row.textModels];
      imageModels.enabled = [...row.imageModels];
      videoModels.enabled = [...row.videoModels];
      setEditingMode(true);
      modelsBlock.hidden = false;
      showMediaModels(row.kind);
      renderChecklists();
      setKeyPlaceholder(row.keySource, Boolean(PRESETS[presetKey]?.keyless));
      // Why the saved key can't be used, in the line a failed Set reports in.
      if (row.keyProblem) {
        message.show(row.keyProblem);
      }
      renderNameHint();
      showSignIn(Boolean(PRESETS[presetKey]?.signIn));
      signIn = row.signIn ?? { state: "signed-out" };
      if (PRESETS[presetKey]?.signIn) renderSignIn();
      if (signIn.state === "pending") pollSignIn(row.id, false);
    } else {
      presetPicker.show(PRESET_CHOICES[0].value);
      formProviderId = "";
      textModels.enabled = [];
      imageModels.enabled = [];
      videoModels.enabled = [];
      setEditingMode(false);
      applyPreset();
    }
    deps.openSettingsSubpage("provider");
  }

  // Set commits the connection, then the form transitions to an editor for
  // what was just created — the model checklist, populated without a manual
  // pick step wherever the preset allows it. The subpage stays open on that
  // checklist; Back returns to the provider list.
  async function onSet(): Promise<void> {
    const preset = currentPreset();
    // Nothing to set: the sign-in row's buttons save a ChatGPT plan.
    if (preset.signIn) return;
    const isCustom = presetPicker.value === "custom";

    let id: string;
    let label: string | undefined;
    if (isCustom) {
      const name = nameInput.value.trim();
      if (!name) throw new Error("Enter a name");
      // Editing keeps the existing id; only a fresh provider gets a slug.
      id = editing ? formProviderId : uniqueProviderId(name);
      label = name;
    } else {
      id = presetPicker.value;
      label = preset.label;
    }
    formProviderId = id;

    const payload: SaveProviderRequestBody = {
      id,
      kind: preset.kind,
      label: label || undefined,
      baseURL: isCustom ? baseUrlInput.value.trim() : preset.baseURL,
    };
    const key = keyInput.value.trim();
    if (key) payload.apiKey = key;

    await postSaveProvider(payload);
    keyInput.value = "";
    deps.onProvidersChanged();

    // The connection now exists — its resolved models are the checklist's
    // starting point, kept if discovery fails.
    const wasFresh = !editing;
    setEditingMode(true);
    formLabel = label ?? id;
    formTitle.textContent = formLabel;
    renderNameHint();
    modelsBlock.hidden = false;
    showMediaModels(preset.kind);
    let keySource: ProviderRow["keySource"] = key ? "stored" : "none";
    try {
      const all = await fetchProviders();
      const saved = all.providers.find((p) => p.id === id);
      textModels.enabled = saved?.textModels ?? [];
      imageModels.enabled = saved?.imageModels ?? [];
      videoModels.enabled = saved?.videoModels ?? [];
      keySource = saved?.keySource ?? keySource;
    } catch {
      // keep whatever we had
    }
    setKeyPlaceholder(keySource, Boolean(preset.keyless));

    setButton.disabled = true;
    setButton.textContent = "…";
    try {
      const discovered = await discover();
      let saved = true;
      if (wasFresh) {
        const ticked = defaultModels(preset.discover, discovered);
        textModels.enabled = ticked.textModels;
        imageModels.enabled = ticked.imageModels;
        videoModels.enabled = ticked.videoModels;
        saved = await saveModels(
          textModels,
          ...(discovered.imageModels.length ? [imageModels] : []),
          ...(discovered.videoModels.length ? [videoModels] : []),
        );
      }
      renderChecklists(discovered);
      if (saved) {
        const tickedCount = textModels.enabled.length + imageModels.enabled.length + videoModels.enabled.length;
        message.show(setConfirmation(formLabel, discovered, keySource !== "none", tickedCount), "success");
      }
    } catch (error) {
      renderChecklists();
      message.show(error instanceof Error ? error.message : "Couldn't list models. Add them by id below.");
    } finally {
      setButton.disabled = false;
      setButton.textContent = "Set";
    }
  }

  async function load(): Promise<void> {
    // Runs on every show of the AI Models category (including Back out of the
    // provider subpage), so the list always reflects the latest saves.
    // Nothing in the form is unsaved — Set and each checkbox persist as
    // you go.
    try {
      const [data, servers] = await Promise.all([fetchProviders(), fetchMcpServers().catch(() => undefined)]);
      knownProviderIds = data.providers.map((p) => p.id);
      knownServerIds = servers?.servers.map((s) => s.id) ?? [];
      signInAllowed = data.signInAllowed;
      // No standing storage banner — the plaintext-vs-keychain detail is
      // in deployment.md. The one thing worth surfacing is the case where
      // a key genuinely can't be saved.
      note.classList.remove("inline-error");
      note.hidden = data.store.kind !== "safe-storage" || data.store.available;
      note.textContent = "Secure storage isn't available on this system, so keys can't be saved here.";
      replaceRows(
        list,
        data.providers.map((row) => {
          const lead = document.createElement("span");
          lead.className = "providers-row-lead";
          const mark = document.createElement("span");
          mark.className = "provider-mark";
          mark.dataset.vendor = row.vendor ?? "";
          mark.setAttribute("aria-hidden", "true");
          const meta = document.createElement("span");
          meta.className = "providers-row-meta";
          const name = document.createElement("span");
          name.className = "providers-row-name";
          name.textContent = row.label;
          const sub = document.createElement("span");
          sub.className = "providers-row-sub";
          // What the provider contributes, and nothing of its connection:
          // the key's state and the endpoint are its subpage's to show.
          const count = (n: number, noun: string): string[] => (n ? [countText(n, noun)] : []);
          const offered = [
            ...count(row.textModels.length, "text model"),
            ...count(row.imageModels.length, "image model"),
            ...count(row.videoModels.length, "video model"),
          ];
          sub.textContent = offered.join(" · ") || "no models";
          meta.append(name, sub);
          lead.append(mark, meta);
          return buildOpenRow(row.id, [lead], () => openForm(row));
        }),
      );
    } catch (error) {
      // A config.json the server can't read says why, such as an entry
      // missing its kind, so the fix can be made by hand.
      note.classList.add("inline-error");
      note.hidden = false;
      note.textContent = error instanceof Error ? error.message : "Couldn't load providers.";
    }
  }

  async function onRemove(): Promise<void> {
    const id = formProviderId;
    const removed = await deps.dialog().confirm({
      title: "Remove provider",
      message: `“${formLabel}” and its stored key are deleted. Its models stop being offered, and anything still set to one of them stops resolving.`,
      confirmLabel: "Remove",
      busyLabel: "Removing…",
      danger: true,
      action: async () => {
        await postDeleteProvider(id);
      },
    });
    if (!removed) return;
    stopPolling();
    deps.onProvidersChanged();
    deps.closeSettingsSubpage();
  }

  const reportSignInError = (error: unknown): void => {
    message.show(error instanceof Error ? error.message : "Couldn't sign in");
  };
  continueButton.addEventListener("click", () => void onContinue(false).catch(reportSignInError));
  allowPlanButton.addEventListener("click", () => void onContinue(true).catch(reportSignInError));
  signOutButton.addEventListener("click", () => void onSignOut().catch(reportSignInError));
  nameInput.addEventListener("input", renderNameHint);
  addButton.addEventListener("click", () => openForm());
  removeButton.addEventListener("click", () => void onRemove());
  // A Refresh that works says nothing, so it clears what the last attempt
  // said, a Set's confirmation too.
  refreshButton.addEventListener("click", () => {
    void discover()
      .then((discovered) => {
        renderChecklists(discovered);
        message.clear();
      })
      .catch((error: unknown) => message.show(error instanceof Error ? error.message : "Couldn't list models"));
  });

  for (const [input, list] of [
    [modelAddInput, textModels],
    [imageModelAddInput, imageModels],
    [videoModelAddInput, videoModels],
  ] as const) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const id = input.value.trim();
      if (id && !list.enabled.includes(id)) {
        list.enabled = [...list.enabled, id];
        renderChecklist(list, []);
        void saveModels(list);
      }
      input.value = "";
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSet().catch((error: unknown) => {
      message.show(error instanceof Error ? error.message : "Couldn't save the provider");
    });
  });

  return load;
}
