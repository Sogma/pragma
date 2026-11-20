// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createModelPickerButton,
  type ModelList,
  type ModelMenu,
  modelMenuItems,
  modelNameOf,
  renderModelPicker,
  toggleModelMenu,
} from "../../../web/lib/modelPicker.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { ContextMenuService, MenuOpenOptions } from "../../../web/services/menus.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

const list: ModelList = {
  providers: [
    { id: "anthropic", label: "Anthropic", vendor: "anthropic" },
    { id: "lmstudio", label: "LM Studio" },
    { id: "idle", label: "Idle" },
  ],
  models: [
    {
      id: "anthropic/claude-sonnet-5",
      label: "claude-sonnet-5 (Anthropic)",
      provider: "anthropic",
      model: "claude-sonnet-5",
    },
    {
      id: "anthropic/claude-opus-5",
      label: "claude-opus-5 (Anthropic)",
      provider: "anthropic",
      model: "claude-opus-5",
    },
    { id: "lmstudio/qwen/q", label: "qwen/q (LM Studio)", provider: "lmstudio", model: "qwen/q" },
  ],
};

const chatMenu = (stored: string, pick = vi.fn()): ModelMenu => ({
  stored,
  pick,
  defaultRow: { fallback: "anthropic/claude-sonnet-5" },
  settingsRow: true,
});

describe("modelMenuItems", () => {
  it("heads each provider's models with its mark, between the default's row and the way to Settings", () => {
    const pick = vi.fn();
    const items = modelMenuItems(list, chatMenu("lmstudio/qwen/q", pick));
    expect(items.map((item) => [item.label, item.group])).toEqual([
      ["Default", "default"],
      ["Anthropic", "anthropic"],
      ["claude-sonnet-5", "anthropic"],
      ["claude-opus-5", "anthropic"],
      ["LM Studio", "lmstudio"],
      ["qwen/q", "lmstudio"],
      ["Go to AI Models settings", "settings"],
    ]);
    expect(items[0].detail).toBe("claude-sonnet-5");
    // A heading is a static row; only the entry on its vendor's own endpoint
    // names that vendor, so LM Studio gets the generic mark.
    expect(items[1].command === undefined && items[1].run === undefined).toBe(true);
    expect(items[1]).toMatchObject({ icon: true, data: { vendor: "anthropic" } });
    expect(items[4].data).toEqual({ vendor: "" });
    expect(items.filter((item) => item.checked?.(context, item.arg)).map((item) => item.label)).toEqual(["qwen/q"]);
    expect(items.at(-1)).toMatchObject({ command: "settings.open", arg: "models" });

    items[3].run?.(context, undefined);
    items[0].run?.(context, undefined);
    expect(pick.mock.calls).toEqual([["anthropic/claude-opus-5"], [""]]);
  });

  it("keeps the models whose name or provider holds the query, under their headings", () => {
    const labels = (query: string) => modelMenuItems(list, chatMenu(""), query).map((item) => item.label);
    expect(labels("OPUS")).toEqual(["Anthropic", "claude-opus-5"]);
    expect(labels("lm studio")).toEqual(["LM Studio", "qwen/q"]);
    expect(labels("default")).toEqual(["Default"]);
    expect(labels("nothing")).toEqual([]);
  });

  it("words the default's row the same for every kind, beside the model the default is now", () => {
    const row = (fallback: string) => modelMenuItems(list, { stored: "", pick: vi.fn(), defaultRow: { fallback } })[0];
    expect(row("lmstudio/qwen/q")).toMatchObject({ label: "Default", detail: "qwen/q" });
    expect(row("higgsfield/soul")).toMatchObject({ label: "Default", detail: "higgsfield/soul" });
    expect(row("")).toMatchObject({ label: "Default", detail: "None" });
  });

  it("keeps a stored model no provider lists as a checked, flagged row", () => {
    const items = modelMenuItems(list, { stored: "gone/model", pick: vi.fn() });
    // With no default's row and no way to Settings, the providers lead.
    expect(items[0].label).toBe("Anthropic");
    expect(items.some((item) => item.command === "settings.open")).toBe(false);
    const unlisted = items.find((item) => item.label === "gone/model (not configured)");
    expect(unlisted?.checked?.(context, undefined)).toBe(true);
  });

  it("says a server's list couldn't be read, under its heading, with the reason on hover", () => {
    const withFailure: ModelList = {
      ...list,
      providers: [...list.providers, { id: "higgsfield", label: "Higgsfield" }],
      failures: [{ server: "higgsfield", message: "Sign in to Higgsfield again." }],
    };
    const items = modelMenuItems(withFailure, { stored: "", pick: vi.fn() });
    expect(items.slice(-2)).toMatchObject([
      { label: "Higgsfield", data: { vendor: "" } },
      {
        label: "Couldn't list its models",
        className: "model-menu-note",
        data: { tooltip: "Sign in to Higgsfield again." },
      },
    ]);
    expect(modelMenuItems(withFailure, { stored: "", pick: vi.fn() }, "qwen").map((item) => item.label)).toEqual([
      "LM Studio",
      "qwen/q",
    ]);
  });
});

describe("modelNameOf", () => {
  it("names a model by its list's name, else by its ref past the provider, before the list comes too", () => {
    const listed: ModelList = {
      ...list,
      models: [
        {
          id: "higgsfield/seedance_2_5",
          label: "Seedance 2.5 (Higgsfield)",
          provider: "higgsfield",
          model: "Seedance 2.5",
        },
      ],
    };
    expect(modelNameOf("higgsfield/seedance_2_5", listed)).toBe("Seedance 2.5");
    expect(modelNameOf("higgsfield/kling3_0", listed)).toBe("kling3_0");
    expect(modelNameOf("lmstudio/qwen/q", undefined)).toBe("qwen/q");
  });
});

describe("renderModelPicker", () => {
  it("names a ref by its model and mark, and flags one no provider lists only once a list is in", () => {
    const button = createModelPickerButton("extra");
    expect(button.className).toBe("picker model-picker extra");
    expect([...button.children].map((part) => part.className)).toEqual([
      "provider-mark",
      "picker-name",
      "model-picker-effort",
      "picker-chevron",
    ]);
    const name = () => button.querySelector(".picker-name")?.textContent;
    const text = { role: "Model", none: "No model", follows: "text" as const };

    renderModelPicker(button, "anthropic/claude-opus-5", list, text);
    expect([name(), button.dataset.vendor, button.dataset.tooltip]).toEqual([
      "claude-opus-5",
      "anthropic",
      "Default model: claude-opus-5 (Anthropic)",
    ]);
    expect(button.getAttribute("aria-label")).toBe("Model: claude-opus-5");
    renderModelPicker(button, "anthropic/claude-opus-5", list, { ...text, follows: "image" });
    expect(button.dataset.tooltip).toBe("Default image model: claude-opus-5 (Anthropic)");
    renderModelPicker(button, "anthropic/claude-opus-5", list, { ...text, follows: undefined });
    expect(button.dataset.tooltip).toBe("claude-opus-5 (Anthropic)");

    renderModelPicker(button, "gone/old", undefined, text);
    expect([name(), button.classList.contains("unconfigured"), button.hasAttribute("data-vendor")]).toEqual([
      "old",
      false,
      false,
    ]);
    renderModelPicker(button, "gone/old", list, text);
    expect([button.classList.contains("unconfigured"), button.dataset.vendor]).toEqual([true, ""]);

    renderModelPicker(button, "", list, text);
    expect([name(), button.hasAttribute("data-tooltip")]).toEqual(["No model", false]);
  });
});

describe("toggleModelMenu", () => {
  it("opens the searchable menu under its button, and closes it when open there", () => {
    const opened: MenuOpenOptions[] = [];
    let open = false;
    const contextMenu: ContextMenuService = {
      open: (options) => {
        opened.push(options);
        open = true;
      },
      close: () => {
        open = false;
      },
      isOpen: () => open,
    };
    const button = createModelPickerButton("");
    toggleModelMenu(contextMenu, button, list, chatMenu(""), { ariaLabel: "Model", align: "end" });
    expect(opened[0]).toMatchObject({
      anchor: button,
      align: "end",
      ariaLabel: "Model",
      className: "picker-menu model-menu",
      picker: true,
    });
    expect(opened[0].search?.placeholder).toBe("Search models…");
    expect(opened[0].search?.filter("opus").map((item) => item.label)).toEqual(["Anthropic", "claude-opus-5"]);

    toggleModelMenu(contextMenu, button, list, chatMenu(""), { ariaLabel: "Model" });
    expect([opened.length, open]).toEqual([1, false]);
  });
});
