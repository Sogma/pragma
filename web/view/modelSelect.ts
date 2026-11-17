// The chat composer's pickers, its model and the copilot's mode, and Settings'
// default models, over the lists every model picker shares.
// Chat's model menu leads with a row that follows the default; a default's own
// menu leads with None instead. Chat's also pins the effort slider under its
// list, for a model that takes levels.

import { type ChatMode, effortFor } from "../../src/protocol/api.ts";
import type { ChatRequestBody } from "../core/apiClient.ts";
import { must } from "../lib/dom.ts";
import { effortSlider } from "../lib/effort.ts";
import { type ModelKind, type ModelList, NONE_LABEL, renderModelPicker, toggleModelMenu } from "../lib/modelPicker.ts";
import type { ContextMenuService } from "../services/menus.ts";
import type { ModelLists } from "../services/modelLists.ts";
import type { Setting } from "../services/settings.ts";

// The settings these pickers read and write; main.ts hands in the settings
// module itself.
export interface ComposerSettings {
  chatModel: Setting<string>;
  chatEffort: Setting<string>;
  chatMode: Setting<ChatMode>;
}

export interface ModelPickerDeps {
  // Settings → AI Models: its default pickers, and the line under them that says
  // why a save failed.
  settingsModels: HTMLElement;
  // The chat composer: its model and mode chips, and the field typing resumes
  // in once a model is picked.
  chatComposer: HTMLElement;
  settings: ComposerSettings;
  contextMenu: ContextMenuService;
  modelLists: ModelLists;
}

/** What a chat turn names: chat's model, blank to run on the default, the
 * effort that model runs at, and what the copilot may change. */
export interface ChatPick {
  request(): Pick<ChatRequestBody, "model" | "effort" | "mode">;
}

// Settings' defaults: each one's button, what it is called, and what its menu
// says with nothing to pick.
const DEFAULTS: Record<ModelKind, { button: string; role: string; empty: string }> = {
  text: { button: "#setting-default-model", role: "Default text model", empty: "No models yet: add a provider below." },
  image: {
    button: "#setting-default-image-model",
    role: "Default image model",
    empty: "No image models yet: add a provider below, or an MCP server that makes images.",
  },
  video: {
    button: "#setting-default-video-model",
    role: "Default video model",
    empty: "No video models yet: add an MCP server that makes videos.",
  },
};
const KINDS: ModelKind[] = ["text", "image", "video"];

// Each mode as its chip and its menu row name it. The descriptions say what
// connected (MCP) tools do too: Suggesting doesn't hold those back, and the
// name alone would promise that it does.
const CHAT_MODE_TEXT: Record<ChatMode, { label: string; description: string }> = {
  viewing: {
    label: "Viewing",
    description: "Reads and answers, but changes nothing. Uses only connected tools that only read.",
  },
  suggesting: {
    label: "Suggesting",
    description: "Changes to your documents wait for your approval. Connected tools run right away.",
  },
  editing: {
    label: "Editing",
    description: "Changes apply right away, each with an Undo. Connected tools run right away.",
  },
};

/**
 * Wires the pickers to the shared lists, loading them if nothing has yet.
 * Until a list arrives, and after a fetch fails, each menu lists nothing
 * beyond its first row and a stored pick, no picker flags a stored model or
 * names a default, and chat's has no effort slider.
 */
export function wireModelPickers(deps: ModelPickerDeps): ChatPick {
  const { settings, modelLists } = deps;
  const chatModelButton = must<HTMLButtonElement>("#chat-model-button", deps.chatComposer);
  const chatModeButton = must<HTMLButtonElement>("#chat-mode-button", deps.chatComposer);
  const chatInput = must<HTMLElement>("#chat-input", deps.chatComposer);
  const defaultButtons: Record<ModelKind, HTMLButtonElement> = {
    text: must<HTMLButtonElement>(DEFAULTS.text.button, deps.settingsModels),
    image: must<HTMLButtonElement>(DEFAULTS.image.button, deps.settingsModels),
    video: must<HTMLButtonElement>(DEFAULTS.video.button, deps.settingsModels),
  };
  const defaultsError = must<HTMLElement>("#setting-default-models-error", deps.settingsModels);
  const listOf = (kind: ModelKind): ModelList => modelLists.get(kind) ?? { models: [], providers: [] };
  // The levels of the model chat sends, which its slider offers.
  const chatLevels = () => {
    const ref = settings.chatModel.get() || modelLists.defaultOf("text");
    return modelLists.get("text")?.models.find((model) => model.id === ref)?.effortLevels;
  };
  const chatEffortLevel = () => effortFor(settings.chatEffort.get(), chatLevels());

  // Chat sends its own pick, else the default, so that is the model its chip
  // names, with the effort it runs at.
  function renderPickers(): void {
    const stored = settings.chatModel.get();
    renderModelPicker(chatModelButton, stored || modelLists.defaultOf("text"), modelLists.get("text"), {
      role: "Chat model",
      none: "No model",
      follows: stored ? undefined : "text",
      effort: chatEffortLevel(),
    });
    for (const kind of KINDS) {
      renderModelPicker(defaultButtons[kind], modelLists.defaultOf(kind), modelLists.get(kind), {
        role: DEFAULTS[kind].role,
        none: NONE_LABEL,
      });
    }
  }

  chatModelButton.addEventListener("click", () => {
    const levels = chatLevels();
    const menu = {
      stored: settings.chatModel.get(),
      pick: (ref: string) => {
        settings.chatModel.set(ref);
        chatInput.focus();
      },
      defaultRow: { fallback: modelLists.defaultOf("text") },
      settingsRow: true,
      slider: levels?.length
        ? effortSlider(levels, settings.chatEffort.get(), (pick) => settings.chatEffort.set(pick))
        : undefined,
    };
    toggleModelMenu(deps.contextMenu, chatModelButton, listOf("text"), menu, { ariaLabel: "Chat model" });
  });

  // The defaults are config.json's, not this browser's: a run with no one
  // present uses them too. A failed save keeps the default it had and says
  // why under the rows.
  async function saveDefault(kind: ModelKind, ref: string): Promise<void> {
    defaultsError.hidden = true;
    try {
      await modelLists.setDefault(kind, ref);
    } catch (error) {
      defaultsError.textContent = error instanceof Error ? error.message : String(error);
      defaultsError.hidden = false;
    }
  }
  for (const kind of KINDS) {
    const button = defaultButtons[kind];
    // At the end of its row, so the menu's right edge meets the button's.
    button.addEventListener("click", () => {
      const list = listOf(kind);
      const menu = {
        stored: modelLists.defaultOf(kind),
        pick: (ref: string) => void saveDefault(kind, ref),
        noneRow: true,
        // Only with no models: under a query that matches nothing, the menu's
        // own "No matches" is the truer line.
        ...(list.models.length === 0 && { empty: DEFAULTS[kind].empty }),
      };
      toggleModelMenu(deps.contextMenu, button, list, menu, { ariaLabel: DEFAULTS[kind].role, align: "end" });
    });
  }

  settings.chatModel.subscribe(renderPickers);
  settings.chatEffort.subscribe(renderPickers);
  modelLists.subscribe(renderPickers);
  modelLists.load("text");
  modelLists.load("image");
  modelLists.load("video");

  settings.chatMode.subscribe((mode) => {
    chatModeButton.dataset.chatMode = mode;
    must<HTMLElement>(".chat-mode-name", chatModeButton).textContent = CHAT_MODE_TEXT[mode].label;
    chatModeButton.setAttribute("aria-label", `Copilot mode: ${CHAT_MODE_TEXT[mode].label}`);
  });
  chatModeButton.addEventListener("click", () => {
    if (deps.contextMenu.isOpen(chatModeButton)) {
      deps.contextMenu.close();
      return;
    }
    deps.contextMenu.open({
      items: (Object.keys(CHAT_MODE_TEXT) as ChatMode[]).map((mode) => ({
        label: CHAT_MODE_TEXT[mode].label,
        description: CHAT_MODE_TEXT[mode].description,
        icon: true,
        data: { chatMode: mode },
        checked: () => settings.chatMode.get() === mode,
        run: () => {
          settings.chatMode.set(mode);
          chatInput.focus();
        },
      })),
      anchor: chatModeButton,
      ariaLabel: "Copilot mode",
      className: "chat-mode-menu",
    });
  });

  return {
    request: () => ({
      model: settings.chatModel.get(),
      effort: chatEffortLevel(),
      mode: settings.chatMode.get(),
    }),
  };
}
