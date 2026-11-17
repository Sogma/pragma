// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMode, ImageModelsResponse, VideoModelsResponse } from "../../../src/protocol/api.ts";
import {
  type EffortLevel,
  fetchImageModels,
  fetchModels,
  fetchVideoModels,
  postDefaultImageModel,
  postDefaultModel,
  postDefaultVideoModel,
} from "../../../web/core/apiClient.ts";
import { Emitter } from "../../../web/lib/emitter.ts";
import type { ModelList } from "../../../web/lib/modelPicker.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { ContextMenuService, MenuItem, MenuOpenOptions } from "../../../web/services/menus.ts";
import { createModelLists } from "../../../web/services/modelLists.ts";
import { wireModelPickers } from "../../../web/view/modelSelect.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchModels: vi.fn(),
  fetchImageModels: vi.fn(),
  fetchVideoModels: vi.fn(),
  postDefaultModel: vi.fn(),
  postDefaultImageModel: vi.fn(),
  postDefaultVideoModel: vi.fn(),
}));

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

const claudeLevels: EffortLevel[] = ["low", "medium", "high", "xhigh"];

const list: ModelList = {
  providers: [
    { id: "anthropic", label: "Anthropic", vendor: "anthropic" },
    { id: "lmstudio", label: "LM Studio" },
    { id: "gemini", label: "Gemini", vendor: "google" },
  ],
  models: [
    {
      id: "anthropic/claude-sonnet-5",
      label: "claude-sonnet-5 (Anthropic)",
      provider: "anthropic",
      model: "claude-sonnet-5",
      effortLevels: claudeLevels,
    },
    {
      id: "anthropic/claude-opus-5",
      label: "claude-opus-5 (Anthropic)",
      provider: "anthropic",
      model: "claude-opus-5",
      effortLevels: claudeLevels,
    },
    { id: "lmstudio/qwen/q", label: "qwen/q (LM Studio)", provider: "lmstudio", model: "qwen/q" },
    {
      id: "gemini/gemini-pro-latest",
      label: "gemini-pro-latest (Gemini)",
      provider: "gemini",
      model: "gemini-pro-latest",
      effortLevels: ["low", "medium", "high"],
    },
  ],
};

const imageList: ImageModelsResponse = {
  providers: [
    { id: "gemini", label: "Gemini", vendor: "google" },
    { id: "higgsfield", label: "Higgsfield" },
  ],
  models: [
    {
      id: "gemini/gemini-nano-banana-2.1",
      label: "gemini-nano-banana-2.1 (Gemini)",
      provider: "gemini",
      model: "gemini-nano-banana-2.1",
    },
    { id: "higgsfield/soul_2", label: "Soul 2 (Higgsfield)", provider: "higgsfield", model: "Soul 2" },
  ],
  defaultModel: "gemini/gemini-nano-banana-2.1",
  failures: [],
};

const videoList: VideoModelsResponse = {
  providers: [{ id: "higgsfield", label: "Higgsfield" }],
  models: [
    {
      id: "higgsfield/seedance1_5",
      label: "Seedance 1.5 Pro (Higgsfield)",
      provider: "higgsfield",
      model: "Seedance 1.5 Pro",
    },
  ],
  defaultModel: null,
  failures: [],
};

// A menu row picks through its own action.
const pickRow = (items: MenuItem[] | undefined, label: string) =>
  items?.find((item) => item.label === label)?.run?.(context, undefined);

describe("wireModelPickers", () => {
  // What the server holds: each kind's default, as the last save left it.
  let saved: { text: string | null; image: string | null };

  beforeEach(() => {
    const picker = (id: string, effort = "") =>
      `<button id="${id}"><span class="provider-mark"></span><span class="picker-name"></span>${effort}</button>`;
    document.body.innerHTML = `
      <section class="settings-category" data-settings-category="models">
        ${picker("setting-default-model")}
        ${picker("setting-default-image-model")}
        ${picker("setting-default-video-model")}
        <p id="setting-default-models-error" hidden></p>
      </section>
      <form id="chat-form">
        <textarea id="chat-input"></textarea>
        ${picker("chat-model-button", '<span class="model-picker-effort" hidden></span>')}
        <button id="chat-mode-button"><span class="chat-mode-name"></span></button>
      </form>`;
    saved = { text: null, image: imageList.defaultModel };
    vi.mocked(fetchModels)
      .mockReset()
      .mockImplementation(async () => ({ ...list, defaultModel: saved.text }));
    vi.mocked(fetchImageModels)
      .mockReset()
      .mockImplementation(async () => ({ ...imageList, defaultModel: saved.image }));
    vi.mocked(postDefaultModel)
      .mockReset()
      .mockImplementation(async (ref) => {
        saved.text = ref || null;
      });
    vi.mocked(postDefaultImageModel)
      .mockReset()
      .mockImplementation(async (ref) => {
        saved.image = ref || null;
      });
    vi.mocked(fetchVideoModels).mockReset().mockResolvedValue(videoList);
    vi.mocked(postDefaultVideoModel).mockReset().mockResolvedValue(undefined);
  });

  // `defaultModel` is the text default the server holds when the pickers load.
  function wire(chatModel: string, defaultModel: string, chatEffort = "", chatMode: ChatMode = "suggesting") {
    saved.text = defaultModel || null;
    const opened: MenuOpenOptions[] = [];
    const contextMenu: ContextMenuService = {
      open: (options) => void opened.push(options),
      close() {},
      isOpen: () => false,
    };
    const settings = {
      chatModel: new Emitter(chatModel),
      chatEffort: new Emitter(chatEffort),
      chatMode: new Emitter<ChatMode>(chatMode),
    };
    const button = (id: string) => document.querySelector<HTMLButtonElement>(id) as HTMLButtonElement;
    const chip = button("#chat-model-button");
    const defaultButton = button("#setting-default-model");
    const imageButton = button("#setting-default-image-model");
    const videoButton = button("#setting-default-video-model");
    const defaultsError = document.querySelector<HTMLElement>("#setting-default-models-error") as HTMLElement;
    const modelLists = createModelLists({ modelConsole: { logEntry: vi.fn() } });
    const chatPick = wireModelPickers({
      settingsModels: document.querySelector<HTMLElement>(".settings-category") as HTMLElement,
      chatComposer: document.querySelector<HTMLElement>("#chat-form") as HTMLElement,
      settings,
      contextMenu,
      modelLists,
    });
    const name = (el: HTMLElement) => el.querySelector(".picker-name")?.textContent;
    const effort = (el: HTMLElement) => el.querySelector<HTMLElement>(".model-picker-effort");
    return {
      chip,
      defaultButton,
      imageButton,
      videoButton,
      defaultsError,
      name,
      effort,
      modelLists,
      settings,
      opened,
      chatPick,
    };
  }

  it("names the model chat will use, its own pick or else the default, with its provider's mark", async () => {
    const { chip, name, modelLists, settings } = wire("", "anthropic/claude-sonnet-5");
    // The default comes with the list, so until then the chip names nothing.
    expect([name(chip), chip.getAttribute("aria-label")]).toEqual(["", "Chat model"]);
    await modelLists.refresh();
    expect(name(chip)).toBe("claude-sonnet-5");
    expect(chip.dataset.vendor).toBe("anthropic");
    expect(chip.dataset.tooltip).toBe("Default model: claude-sonnet-5 (Anthropic)");
    expect(chip.getAttribute("aria-label")).toBe("Chat model: claude-sonnet-5");

    settings.chatModel.set("lmstudio/qwen/q");
    expect(name(chip)).toBe("qwen/q");
    expect(chip.dataset.vendor).toBe("");
    expect(chip.dataset.tooltip).toBe("qwen/q (LM Studio)");

    settings.chatModel.set("");
    await modelLists.setDefault("text", "");
    expect(name(chip)).toBe("No model");
    expect(chip.hasAttribute("data-vendor")).toBe(false);
    expect(chip.hasAttribute("data-tooltip")).toBe(false);
  });

  it("flags a stored model no provider lists, but only once a list has arrived", async () => {
    let answer: (value: Awaited<ReturnType<typeof fetchModels>>) => void = () => {};
    vi.mocked(fetchModels).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { chip, defaultButton, name } = wire("gone/old-model", "");
    expect(name(chip)).toBe("old-model");
    expect(chip.classList.contains("unconfigured")).toBe(false);
    expect(chip.hasAttribute("data-vendor")).toBe(false);

    answer({ ...list, defaultModel: "gone/old-default" });
    await vi.waitFor(() => expect(chip.classList.contains("unconfigured")).toBe(true));
    expect(chip.dataset.tooltip).toBe("gone/old-model (not configured)");
    expect(defaultButton.classList.contains("unconfigured")).toBe(true);
    expect(defaultButton.dataset.tooltip).toBe("gone/old-default (not configured)");
  });

  it("opens the chat menu under the chip, and a pick hands typing back to the composer", async () => {
    const { chip, modelLists, settings, opened } = wire("", "anthropic/claude-sonnet-5");
    await modelLists.refresh();
    chip.click();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ anchor: chip, className: "picker-menu model-menu", ariaLabel: "Chat model" });
    expect(opened[0].align).not.toBe("end");
    expect(opened[0].items?.[0]).toMatchObject({ label: "Default", detail: "claude-sonnet-5" });
    expect(opened[0].items?.some((item) => item.label === "None")).toBe(false);
    expect(opened[0].items?.at(-1)).toMatchObject({ command: "settings.open", arg: "models" });

    pickRow(opened[0].items, "claude-opus-5");
    expect(settings.chatModel.get()).toBe("anthropic/claude-opus-5");
    expect(document.activeElement?.id).toBe("chat-input");
  });

  it("saves the Settings text default to the server, None included, and chat follows it", async () => {
    const { chip, defaultButton, name, modelLists, opened } = wire("", "");
    await modelLists.refresh();
    expect(name(defaultButton)).toBe("None");
    expect(defaultButton.getAttribute("aria-label")).toBe("Default text model: None");
    expect(defaultButton.hasAttribute("data-vendor")).toBe(false);

    defaultButton.click();
    expect(opened[0]).toMatchObject({ anchor: defaultButton, align: "end", ariaLabel: "Default text model" });
    expect(opened[0].empty).toBeUndefined();
    const items = opened[0].items ?? [];
    expect(items.slice(0, 2).map((item) => item.label)).toEqual(["None", "Anthropic"]);
    expect(items[0].checked?.(context, undefined)).toBe(true);
    expect(items.some((item) => item.detail !== undefined || item.command === "settings.open")).toBe(false);

    pickRow(items, "qwen/q");
    await vi.waitFor(() => expect(name(defaultButton)).toBe("qwen/q"));
    expect(postDefaultModel).toHaveBeenCalledWith("lmstudio/qwen/q");
    expect(defaultButton.dataset.vendor).toBe("");
    expect(defaultButton.dataset.tooltip).toBe("qwen/q (LM Studio)");
    // Chat follows the default it has no pick of its own over.
    expect(name(chip)).toBe("qwen/q");

    defaultButton.click();
    pickRow(opened[1].items, "None");
    await vi.waitFor(() => expect(name(defaultButton)).toBe("None"));
    expect(postDefaultModel).toHaveBeenLastCalledWith("");
    expect(name(chip)).toBe("No model");
  });

  it("says there are no models yet when there is nothing to pick", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [], providers: [], defaultModel: null });
    const { defaultButton, modelLists, opened } = wire("", "");
    await modelLists.refresh();
    defaultButton.click();
    expect(opened[0].items).toEqual([]);
    expect(opened[0].empty).toBe("No models yet: add a provider below.");
  });

  it("names the Settings image default with its mark once the image list, which carries it, arrives", async () => {
    const { imageButton, name, modelLists } = wire("", "");
    expect(name(imageButton)).toBe("");
    await modelLists.refresh();
    expect(name(imageButton)).toBe("gemini-nano-banana-2.1");
    expect(imageButton.dataset.vendor).toBe("google");
    expect(imageButton.dataset.tooltip).toBe("gemini-nano-banana-2.1 (Gemini)");
    expect(imageButton.getAttribute("aria-label")).toBe("Default image model: gemini-nano-banana-2.1");
  });

  it("saves an image default picked from its menu, None included, and keeps the old one, saying why, when a save fails", async () => {
    const { imageButton, defaultsError, name, modelLists, opened } = wire("", "");
    await modelLists.refresh();
    imageButton.click();
    expect(opened[0]).toMatchObject({ anchor: imageButton, align: "end", ariaLabel: "Default image model" });
    const items = opened[0].items ?? [];
    expect(items.map((item) => item.label)).toEqual([
      "None",
      "Gemini",
      "gemini-nano-banana-2.1",
      "Higgsfield",
      "Soul 2",
    ]);
    expect(items[2].checked?.(context, undefined)).toBe(true);

    pickRow(items, "Soul 2");
    await vi.waitFor(() => expect(name(imageButton)).toBe("Soul 2"));
    expect(postDefaultImageModel).toHaveBeenCalledWith("higgsfield/soul_2");
    expect(postDefaultModel).not.toHaveBeenCalled();
    expect(imageButton.dataset.vendor).toBe("");
    expect(defaultsError.hidden).toBe(true);

    vi.mocked(postDefaultImageModel).mockRejectedValueOnce(new Error("Higgsfield isn't switched on for Flows."));
    imageButton.click();
    pickRow(opened[1].items, "gemini-nano-banana-2.1");
    await vi.waitFor(() => expect(defaultsError.hidden).toBe(false));
    expect(defaultsError.textContent).toBe("Higgsfield isn't switched on for Flows.");
    expect(name(imageButton)).toBe("Soul 2");

    // The next save that lands clears the line.
    imageButton.click();
    pickRow(opened[2].items, "None");
    await vi.waitFor(() => expect(name(imageButton)).toBe("None"));
    expect(postDefaultImageModel).toHaveBeenLastCalledWith("");
    expect(defaultsError.hidden).toBe(true);
  });

  it("says there are no image models yet when there is nothing to pick", async () => {
    vi.mocked(fetchImageModels).mockResolvedValue({ models: [], providers: [], defaultModel: null, failures: [] });
    const { imageButton, modelLists, opened } = wire("", "");
    await modelLists.refresh();
    imageButton.click();
    expect(opened[0].items).toEqual([]);
    expect(opened[0].empty).toBe("No image models yet: add a provider below, or an MCP server that makes images.");
  });

  it("saves a video default picked from its menu, and says there are none yet when there is nothing to pick", async () => {
    const { videoButton, name, modelLists, opened } = wire("", "");
    await modelLists.refresh();
    videoButton.click();
    expect(opened[0].items?.map((item) => item.label)).toEqual(["None", "Higgsfield", "Seedance 1.5 Pro"]);
    pickRow(opened[0].items, "Seedance 1.5 Pro");
    await vi.waitFor(() => expect(postDefaultVideoModel).toHaveBeenCalledWith("higgsfield/seedance1_5"));
    expect(name(videoButton)).toBe("Seedance 1.5 Pro");

    vi.mocked(fetchVideoModels).mockResolvedValue({ models: [], providers: [], defaultModel: null, failures: [] });
    await modelLists.refresh();
    videoButton.click();
    expect(opened[1].empty).toBe("No video models yet: add an MCP server that makes videos.");
  });

  // A default no provider lists any more can still be cleared, with no
  // models left to pick instead.
  it("offers None beside a stale default even with no models", async () => {
    vi.mocked(fetchImageModels).mockResolvedValue({
      models: [],
      providers: [],
      defaultModel: "gone/old",
      failures: [],
    });
    const { imageButton, modelLists, opened } = wire("", "");
    await modelLists.refresh();
    imageButton.click();
    expect(opened[0].items?.map((item) => item.label)).toEqual(["None", "gone/old (not configured)"]);
  });

  it("names the effort after the model, only once it isn't the default, at the level a turn would send", async () => {
    const { chip, effort, modelLists, settings, chatPick } = wire("", "anthropic/claude-sonnet-5", "xhigh");
    // No list yet, so no levels to name and none to send.
    expect(effort(chip)?.hidden).toBe(true);
    expect(chatPick.request().effort).toBeUndefined();

    await modelLists.refresh();
    expect(effort(chip)?.hidden).toBe(false);
    expect(effort(chip)?.textContent).toBe("· Extra high");
    expect(chip.getAttribute("aria-label")).toBe("Chat model: claude-sonnet-5, Effort Extra high");
    expect(chatPick.request()).toEqual({ model: "", effort: "xhigh", mode: "suggesting" });

    // Gemini stops at high: the pick runs there as its nearest level, and
    // comes back once the model takes it again.
    settings.chatModel.set("gemini/gemini-pro-latest");
    expect(effort(chip)?.textContent).toBe("· High");
    expect(chatPick.request().effort).toBe("high");

    settings.chatModel.set("lmstudio/qwen/q");
    expect(effort(chip)?.hidden).toBe(true);
    expect(chip.getAttribute("aria-label")).toBe("Chat model: qwen/q");
    expect(chatPick.request().effort).toBeUndefined();

    settings.chatModel.set("");
    expect(effort(chip)?.textContent).toBe("· Extra high");
    expect(settings.chatEffort.get()).toBe("xhigh");

    settings.chatEffort.set("");
    expect(effort(chip)?.hidden).toBe(true);
    expect(chatPick.request().effort).toBeUndefined();
  });

  it("pins an effort slider under chat's menu for a model that takes levels, and nowhere else", async () => {
    const { chip, defaultButton, effort, modelLists, settings, opened } = wire("gemini/gemini-pro-latest", "");
    await modelLists.refresh();
    chip.click();
    const slider = opened[0].slider;
    expect(slider?.label).toBe("Effort");
    expect(slider?.stops.map((stop) => stop.label)).toEqual(["Default", "Low", "Medium", "High"]);
    expect(slider?.value).toBe("");

    slider?.change("medium");
    expect(settings.chatEffort.get()).toBe("medium");
    expect(effort(chip)?.textContent).toBe("· Medium");

    settings.chatModel.set("lmstudio/qwen/q");
    chip.click();
    expect(opened[1].slider).toBeUndefined();
    defaultButton.click();
    expect(opened[2].slider).toBeUndefined();
  });

  it("names the copilot's mode on its chip, offers each with what it does, and sends the pick", () => {
    const { settings, opened, chatPick } = wire("", "anthropic/claude-sonnet-5", "", "viewing");
    const modeChip = document.querySelector<HTMLButtonElement>("#chat-mode-button") as HTMLButtonElement;
    expect([modeChip.dataset.chatMode, modeChip.textContent]).toEqual(["viewing", "Viewing"]);
    expect(modeChip.getAttribute("aria-label")).toBe("Copilot mode: Viewing");
    expect(chatPick.request().mode).toBe("viewing");

    modeChip.click();
    expect(opened[0]).toMatchObject({ anchor: modeChip, ariaLabel: "Copilot mode", className: "chat-mode-menu" });
    const items = opened[0].items ?? [];
    expect(items.map((item) => item.label)).toEqual(["Viewing", "Suggesting", "Editing"]);
    expect(items[1].description).toBe(
      "Changes to your documents wait for your approval. Connected tools run right away.",
    );
    expect(items.map((item) => item.data)).toEqual([
      { chatMode: "viewing" },
      { chatMode: "suggesting" },
      { chatMode: "editing" },
    ]);
    expect(items.map((item) => item.checked?.(context, undefined))).toEqual([true, false, false]);

    pickRow(items, "Editing");
    expect(settings.chatMode.get()).toBe("editing");
    expect([modeChip.dataset.chatMode, modeChip.textContent]).toEqual(["editing", "Editing"]);
    expect(chatPick.request().mode).toBe("editing");
    expect(document.activeElement?.id).toBe("chat-input");
  });
});
