// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchImageModels, fetchModels, postDefaultImageModel, postDefaultModel } from "../../../web/core/apiClient.ts";
import { createModelFields, effortFieldOf } from "../../../web/flow/modelOptions.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { ContextMenuService, MenuOpenOptions } from "../../../web/services/menus.ts";
import { createModelLists } from "../../../web/services/modelLists.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchModels: vi.fn(),
  fetchImageModels: vi.fn(),
  postDefaultModel: vi.fn(),
  postDefaultImageModel: vi.fn(),
}));

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

const textList = {
  models: [
    {
      id: "anthropic/claude-sonnet-5",
      label: "claude-sonnet-5 (Anthropic)",
      provider: "anthropic",
      model: "claude-sonnet-5",
    },
    { id: "lmstudio/qwen", label: "qwen (LM Studio)", provider: "lmstudio", model: "qwen" },
  ],
  providers: [
    { id: "anthropic", label: "Anthropic", vendor: "anthropic" as const },
    { id: "lmstudio", label: "LM Studio" },
  ],
  defaultModel: "anthropic/claude-sonnet-5",
};

const imageList = {
  models: [{ id: "higgsfield/soul_2", label: "Soul 2.0 (Higgsfield)", provider: "higgsfield", model: "Soul 2.0" }],
  providers: [
    { id: "higgsfield", label: "Higgsfield" },
    { id: "replicate", label: "Replicate" },
  ],
  defaultModel: "higgsfield/soul_2",
  failures: [{ server: "replicate", message: "Sign in to Replicate again." }],
};

beforeEach(() => {
  vi.mocked(fetchModels).mockReset().mockResolvedValue(textList);
  vi.mocked(fetchImageModels).mockReset().mockResolvedValue(imageList);
  vi.mocked(postDefaultModel).mockReset().mockResolvedValue();
  vi.mocked(postDefaultImageModel).mockReset().mockResolvedValue();
  document.body.replaceChildren();
});

function setup() {
  const opened: MenuOpenOptions[] = [];
  const contextMenu: ContextMenuService = {
    open: (options) => void opened.push(options),
    close() {},
    isOpen: () => false,
  };
  const modelLists = createModelLists({ modelConsole: { logEntry: vi.fn() } });
  return { fields: createModelFields({ contextMenu, modelLists }), modelLists, opened };
}

const nameOf = (button: HTMLElement) => button.querySelector(".picker-name")?.textContent;

describe("createModelFields", () => {
  it("names the default a text field follows, then the node's own pick, and redraws when the default moves", async () => {
    const { fields, modelLists, opened } = setup();
    const config = { model: "" };
    const onPick = vi.fn((ref: string) => {
      config.model = ref;
    });
    const button = fields.create("text", () => config.model, onPick);
    document.body.append(button);
    await vi.waitFor(() => expect(button.dataset.vendor).toBe("anthropic"));
    expect(nameOf(button)).toBe("claude-sonnet-5");
    expect(button.dataset.tooltip).toBe("Default model: claude-sonnet-5 (Anthropic)");

    button.click();
    const items = opened[0].items ?? [];
    expect(opened[0]).toMatchObject({ anchor: button, className: "picker-menu model-menu", ariaLabel: "Model" });
    expect(items[0]).toMatchObject({ label: "Default", detail: "claude-sonnet-5" });
    expect(items.at(-1)).toMatchObject({ command: "settings.open", arg: "models" });
    items.find((item) => item.label === "qwen")?.run?.(context, undefined);
    expect(onPick).toHaveBeenCalledWith("lmstudio/qwen");
    expect([nameOf(button), button.dataset.vendor, button.dataset.tooltip]).toEqual(["qwen", "", "qwen (LM Studio)"]);

    config.model = "";
    vi.mocked(fetchModels).mockReturnValue(new Promise(() => {}));
    await modelLists.setDefault("text", "lmstudio/qwen");
    expect(button.dataset.tooltip).toBe("Default model: qwen (LM Studio)");
  });

  // A Generate node's effort is set where its model is, as chat's is.
  it("pins an effort slider under a node's menu for a model that takes levels, and names the level it runs at", async () => {
    const levels = ["low", "medium", "high", "xhigh"] as const;
    vi.mocked(fetchModels).mockResolvedValue({
      ...textList,
      models: [{ ...textList.models[0], effortLevels: [...levels] }, textList.models[1]],
    });
    const { fields, opened } = setup();
    const config: { model: string; effort?: string } = { model: "" };
    const effort = {
      value: () => config.effort ?? "",
      pick: vi.fn((pick: string) => {
        config.effort = pick || undefined;
      }),
    };
    const button = fields.create("text", () => config.model, vi.fn(), { effort });
    document.body.append(button);
    await vi.waitFor(() => expect(button.dataset.vendor).toBe("anthropic"));
    const effortName = () => button.querySelector(".model-picker-effort");

    button.click();
    const slider = opened[0].slider;
    expect(slider?.stops.map((stop) => stop.label)).toEqual(["Default", "Low", "Medium", "High", "Extra high"]);
    expect(slider?.value).toBe("");
    expect(effortName()?.hasAttribute("hidden")).toBe(true);
    slider?.change("high");
    expect(effort.pick).toHaveBeenCalledWith("high");
    expect(effortName()?.textContent).toBe("· High");
    expect(button.getAttribute("aria-label")).toBe("Model: claude-sonnet-5, Effort High");

    config.model = "lmstudio/qwen";
    button.click();
    expect(opened[1].slider).toBeUndefined();
  });

  // A Flow nobody set an effort on keeps its file as it was.
  it("keeps a node's effort in its config, and drops the key at the default", () => {
    const persist = vi.fn();
    const node = { id: "gen", type: "generateText", position: { x: 0, y: 0 }, config: {} as Record<string, unknown> };
    const field = effortFieldOf(node, persist);
    field?.pick("high");
    expect(node.config).toEqual({ effort: "high" });
    field?.pick("");
    expect(node.config).toEqual({});
    expect(persist).toHaveBeenCalledTimes(2);
    expect(effortFieldOf({ ...node, type: "generateImage" }, persist)).toBeUndefined();
  });

  it("falls an image field back to config's default image model, and says which server couldn't list", async () => {
    const { fields, opened } = setup();
    const button = fields.create("image", () => "", vi.fn());
    document.body.append(button);
    await vi.waitFor(() => expect(nameOf(button)).toBe("Soul 2.0"));
    expect(button.dataset.tooltip).toBe("Default image model: Soul 2.0 (Higgsfield)");
    expect(button.getAttribute("aria-label")).toBe("Image model: Soul 2.0");

    button.click();
    const items = opened[0].items ?? [];
    expect(items[0]).toMatchObject({ label: "Default", detail: "Soul 2.0" });
    const note = items.find((item) => item.label === "Couldn't list its models");
    expect(note?.data).toEqual({ tooltip: "Sign in to Replicate again." });
  });

  it("names a new default image model the moment Settings saves it", async () => {
    const soul1 = {
      id: "higgsfield/soul_1",
      label: "Soul 1.0 (Higgsfield)",
      provider: "higgsfield",
      model: "Soul 1.0",
    };
    vi.mocked(fetchImageModels).mockResolvedValue({ ...imageList, models: [...imageList.models, soul1] });
    const { fields, modelLists } = setup();
    const follows = fields.create("image", () => "", vi.fn());
    const pinned = fields.create("image", () => "higgsfield/soul_2", vi.fn());
    document.body.append(follows, pinned);
    await vi.waitFor(() => expect(nameOf(follows)).toBe("Soul 2.0"));

    // The listing that follows a save never answers here: the save alone redraws.
    vi.mocked(fetchImageModels).mockReturnValue(new Promise(() => {}));
    await modelLists.setDefault("image", "higgsfield/soul_1");
    expect(nameOf(follows)).toBe("Soul 1.0");
    expect(follows.dataset.tooltip).toBe("Default image model: Soul 1.0 (Higgsfield)");
    expect(nameOf(pinned)).toBe("Soul 2.0");
  });

  it("redraws every field when a provider change refreshes the lists", async () => {
    const { fields, modelLists, opened } = setup();
    const button = fields.create("text", () => "openai/gpt-6", vi.fn());
    document.body.append(button);
    await vi.waitFor(() => expect(button.classList.contains("unconfigured")).toBe(true));

    const openai = { id: "openai/gpt-6", label: "gpt-6 (OpenAI)", provider: "openai", model: "gpt-6" };
    vi.mocked(fetchModels).mockResolvedValue({
      ...textList,
      models: [...textList.models, openai],
      providers: [...textList.providers, { id: "openai", label: "OpenAI", vendor: "openai" as const }],
    });
    await modelLists.refresh();
    expect([nameOf(button), button.classList.contains("unconfigured"), button.dataset.vendor]).toEqual([
      "gpt-6",
      false,
      "openai",
    ]);
    button.click();
    expect(opened[0].items?.map((item) => item.label)).toContain("OpenAI");
  });

  it("fetches each list once for every field, and flags nothing when one fails", async () => {
    vi.mocked(fetchModels).mockRejectedValue(new Error("offline"));
    const { fields } = setup();
    const first = fields.create("text", () => "gone/old", vi.fn());
    const follows = fields.create("text", () => "", vi.fn());
    fields.create("image", () => "", vi.fn());
    await vi.waitFor(() => expect(fetchImageModels).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect([nameOf(first), first.classList.contains("unconfigured")]).toEqual(["old", false]);
    // The default comes with the list, so with no list there is none to name.
    expect([nameOf(follows), follows.getAttribute("aria-label")]).toEqual(["", "Model"]);
  });
});
