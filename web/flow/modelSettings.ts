// A Generate Video's model settings: what the picked model's catalog offers
// beyond the node's own inputs, folded under one header on the card.
//
// A value is kept in `modelSettings` only while it differs from the model's
// default, so a node nobody set one on keeps its file and its clips' names.
//
// A kept value the picked model doesn't offer stays, shown as unused, until
// it is removed: another model may take it, and a run leaves it out.
import type { ModelSetting, ModelSettingValue } from "../../src/protocol/api.ts";
import { modelSettingValues } from "../../src/protocol/flowNodes.ts";
import type { FlowNodeInstance } from "../../src/protocol/types.ts";
import { wireChoicePicker } from "../lib/picker.ts";
import type { ContextMenuService } from "../services/menus.ts";
import { formLabel } from "./controls.ts";

export interface ModelSettingsDeps {
  contextMenu: ContextMenuService;
  // The picked model's settings; undefined while its list hasn't come, or
  // while the model comes on a wire.
  offered(): ModelSetting[] | undefined;
  persist(): void;
}

export interface ModelSettingsView {
  readonly el: HTMLElement;
  // Draws the rows again, after the picked model or its list changed.
  refresh(): void;
}

// A choice with no default picks nothing: the provider decides.
const AUTO = "";

export function createModelSettings(node: FlowNodeInstance, deps: ModelSettingsDeps): ModelSettingsView {
  const el = document.createElement("div");
  el.className = "flow-model-settings";
  const header = document.createElement("button");
  header.type = "button";
  header.className = "flow-model-settings-header nodrag";
  header.setAttribute("aria-expanded", "false");
  const title = document.createElement("span");
  title.textContent = "Model settings";
  const count = document.createElement("span");
  count.className = "flow-model-settings-count";
  header.append(title, count);
  const body = document.createElement("div");
  body.className = "flow-node-config flow-model-settings-body";
  body.hidden = true;
  header.addEventListener("click", () => {
    body.hidden = !body.hidden;
    header.setAttribute("aria-expanded", String(!body.hidden));
  });
  el.append(header, body);

  const stored = () => modelSettingValues(node.config.modelSettings);
  const save = (name: string, value: ModelSettingValue | undefined) => {
    const next = stored();
    if (value === undefined) delete next[name];
    else next[name] = value;
    if (Object.keys(next).length) node.config.modelSettings = next;
    else delete node.config.modelSettings;
    deps.persist();
    render();
  };

  function labelled(name: string, extra = ""): { wrap: HTMLDivElement; label: HTMLLabelElement } {
    const wrap = document.createElement("div");
    wrap.className = `flow-config-field${extra}`;
    const label = document.createElement("label");
    label.className = "flow-config-label";
    label.textContent = formLabel(name);
    return { wrap, label };
  }

  function choiceControl(setting: ModelSetting, value: ModelSettingValue | undefined): HTMLButtonElement {
    const options = setting.options ?? [];
    const fallback = setting.default === undefined ? AUTO : String(setting.default);
    const shown = value === undefined ? fallback : String(value);
    const values = [...(setting.default === undefined ? [AUTO] : []), ...options.map(String)];
    if (!values.includes(shown)) values.push(shown);
    const button = document.createElement("button");
    button.className = "form-input flow-picker nodrag";
    const choices = values.map((each) => ({ value: each, label: each === AUTO ? "Auto" : each }));
    wireChoicePicker(button, choices, {
      role: formLabel(setting.name),
      contextMenu: deps.contextMenu,
      pick: (picked) => {
        const option = options.find((each) => String(each) === picked) ?? picked;
        save(setting.name, picked === fallback ? undefined : option);
      },
    }).show(shown);
    return button;
  }

  function numberControl(setting: ModelSetting, value: ModelSettingValue | undefined): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "form-input nodrag";
    input.value = String(value ?? setting.default ?? "");
    input.placeholder = `${setting.min} to ${setting.max}`;
    input.addEventListener("change", () => {
      const typed = input.value.trim();
      const number = Number(typed);
      if (typed === "") return save(setting.name, undefined);
      if (!Number.isFinite(number)) return render();
      const held = Math.min(setting.max ?? number, Math.max(setting.min ?? number, number));
      save(setting.name, held === setting.default ? undefined : held);
    });
    return input;
  }

  function field(setting: ModelSetting, value: ModelSettingValue | undefined): HTMLDivElement {
    if (setting.kind === "switch") {
      const { wrap, label } = labelled(setting.name, " checkbox");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "nodrag";
      const byDefault = setting.default === true;
      input.checked = value === undefined ? byDefault : value === true;
      input.addEventListener("change", () =>
        save(setting.name, input.checked === byDefault ? undefined : input.checked),
      );
      wrap.append(input, label);
      if (setting.description) wrap.dataset.tooltip = setting.description;
      return wrap;
    }
    const { wrap, label } = labelled(setting.name);
    const control = setting.kind === "number" ? numberControl(setting, value) : choiceControl(setting, value);
    wrap.append(label, control);
    if (setting.description) wrap.dataset.tooltip = setting.description;
    return wrap;
  }

  function unusedField(name: string, value: ModelSettingValue): HTMLDivElement {
    const { wrap, label } = labelled(name, " flow-model-setting-unused");
    wrap.dataset.tooltip = "This model doesn't take it, so a run leaves it out.";
    const row = document.createElement("div");
    row.className = "flow-model-setting-unused-row";
    const text = document.createElement("span");
    text.textContent = `${value} · not taken by this model`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button flow-remove-variable-button nodrag";
    remove.setAttribute("aria-label", `Remove ${formLabel(name)}`);
    const icon = document.createElement("span");
    icon.className = "flow-remove-variable-icon";
    remove.appendChild(icon);
    remove.addEventListener("click", () => save(name, undefined));
    row.append(text, remove);
    wrap.append(label, row);
    return wrap;
  }

  function render(): void {
    const offered = deps.offered();
    const values = stored();
    const rows = offered
      ? [
          ...offered.map((setting) => field(setting, values[setting.name])),
          ...Object.entries(values)
            .filter(([name]) => !offered.some((setting) => setting.name === name))
            .map(([name, value]) => unusedField(name, value)),
        ]
      : [];
    body.replaceChildren(...rows);
    el.hidden = rows.length === 0;
    const set = Object.keys(values).length;
    count.textContent = set ? `${set} set` : "";
  }

  render();
  return { el, refresh: render };
}
