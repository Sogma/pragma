// A Generate Video's set-once settings: its model inputs, then what the
// picked model's catalog offers beyond them, under a heading that leads the
// card's separator line, closed by a line below. Folded, the heading reads as
// the settings' summary, and the wires into them end on stacked pins there.
// The fold is the node's `settingsFolded`, so it lasts.
//
// A value is kept in `modelSettings` only while it differs from the model's
// default, so a node nobody set one on keeps its file and its clips' names.
//
// A kept value the picked model doesn't offer stays, shown as unused, until
// it is removed: another model may take it, and a run leaves it out.
import type { ModelSetting, ModelSettingValue } from "../../src/protocol/api.ts";
import { modelSettingValues } from "../../src/protocol/flowNodes.ts";
import type { FlowNodeInstance } from "../../src/protocol/types.ts";
import { isTaskModes, modeConflict, taskMode, type WiredInputs } from "../../src/protocol/videoModes.ts";
import { wireChoicePicker } from "../lib/picker.ts";
import type { ContextMenuService } from "../services/menus.ts";
import { formLabel } from "./controls.ts";
import { type JoinedPin, joinedPins } from "./joinedPins.ts";

export interface ModelSettingsDeps {
  contextMenu: ContextMenuService;
  // The node's own set-once rows, which the group holds first.
  rows: readonly HTMLElement[];
  // The picked model's settings; undefined while its list hasn't come, or
  // while the model comes on a wire.
  offered(): ModelSetting[] | undefined;
  // The model and its standard settings as one line, the folded heading; a
  // line per set-once input, which the folded heading's tooltip lists first;
  // and the wired rows' pins, which it stacks on that heading.
  summary(): string;
  details(): string[];
  // What the node has wired, which a task mode follows on Auto.
  inputs(): WiredInputs;
  joined(): JoinedPin[];
  persist(): void;
  // The card's height changed, so pins below the group moved.
  layoutChanged(): void;
}

export interface ModelSettingsView {
  readonly el: HTMLElement;
  // Draws the rows again, after the picked model or its list changed.
  refresh(): void;
}

// A choice with no default picks nothing: the provider decides. A task mode
// on Auto follows the inputs (videoModes.ts), whatever the catalog's default.
const AUTO = "";

export function createModelSettings(node: FlowNodeInstance, deps: ModelSettingsDeps): ModelSettingsView {
  const el = document.createElement("div");
  el.className = "flow-model-settings";
  const line = document.createElement("div");
  line.className = "flow-model-settings-line";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "flow-model-settings-toggle nodrag";
  const chevron = document.createElement("span");
  chevron.className = "disclosure";
  chevron.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "flow-model-settings-label";
  toggle.append(chevron, label);
  line.appendChild(toggle);
  const problem = document.createElement("div");
  problem.className = "inline-warning flow-model-settings-problem";
  const body = document.createElement("div");
  body.className = "flow-model-settings-body";
  toggle.addEventListener("click", () => {
    if (node.settingsFolded) delete node.settingsFolded;
    else node.settingsFolded = true;
    deps.persist();
    render();
    deps.layoutChanged();
  });
  el.append(line, problem, body);

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

  // A row as the node's own inputs draw theirs, label then control, with no
  // pin: a setting is never wired.
  function row(name: string, extra = ""): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `flow-port-row input has-widget flow-model-setting${extra}`;
    const label = document.createElement("span");
    label.className = "flow-port-label";
    label.textContent = formLabel(name);
    el.appendChild(label);
    return el;
  }

  // A mode that is a task, whose Auto follows the inputs.
  const isTask = (setting: ModelSetting) =>
    setting.name === "mode" && setting.kind === "choice" && isTaskModes((setting.options ?? []).map(String));

  // Auto, named with what it comes to now where that is known.
  function autoLabel(setting: ModelSetting): string {
    const asked = isTask(setting) ? taskMode((setting.options ?? []).map(String), deps.inputs()) : undefined;
    return asked ? `Auto · ${asked}` : "Auto";
  }

  function choiceControl(setting: ModelSetting, value: ModelSettingValue | undefined): HTMLButtonElement {
    const options = setting.options ?? [];
    const task = isTask(setting);
    const fallback = task || setting.default === undefined ? AUTO : String(setting.default);
    const shown = value === undefined ? fallback : String(value);
    const values = [...(fallback === AUTO ? [AUTO] : []), ...options.map(String)];
    if (!values.includes(shown)) values.push(shown);
    const button = document.createElement("button");
    button.className = "form-input flow-picker nodrag";
    const choices = values.map((each) => ({
      value: each,
      label: each === AUTO ? autoLabel(setting) : each,
      ...(task && each !== AUTO ? { detail: modeConflict(each, deps.inputs())?.hint } : {}),
    }));
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
    const el = row(setting.name);
    if (setting.description) el.dataset.tooltip = setting.description;
    if (setting.kind === "switch") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "nodrag";
      input.setAttribute("aria-label", formLabel(setting.name));
      const byDefault = setting.default === true;
      input.checked = value === undefined ? byDefault : value === true;
      input.addEventListener("change", () =>
        save(setting.name, input.checked === byDefault ? undefined : input.checked),
      );
      el.appendChild(input);
      return el;
    }
    el.appendChild(setting.kind === "number" ? numberControl(setting, value) : choiceControl(setting, value));
    return el;
  }

  function unusedField(name: string, value: ModelSettingValue): HTMLDivElement {
    const el = row(name, " unused");
    el.dataset.tooltip = "This model doesn't take it, so a run leaves it out.";
    const text = document.createElement("span");
    text.className = "flow-model-setting-unused-value";
    text.textContent = `${value} · not taken by this model`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button flow-remove-variable-button nodrag";
    remove.setAttribute("aria-label", `Remove ${formLabel(name)}`);
    const icon = document.createElement("span");
    icon.className = "flow-remove-variable-icon";
    remove.appendChild(icon);
    remove.addEventListener("click", () => save(name, undefined));
    el.append(text, remove);
    return el;
  }

  // The folded heading's tooltip: each set-once input, then each of the
  // model's own settings at its value or default, then any it doesn't take.
  function everySetting(offered: readonly ModelSetting[], values: Record<string, ModelSettingValue>): string[] {
    const shown = (setting: ModelSetting) => {
      const value = values[setting.name] ?? (isTask(setting) ? undefined : setting.default);
      if (setting.kind === "switch") return value === true ? "on" : "off";
      return value === undefined ? autoLabel(setting) : String(value);
    };
    return [
      ...deps.details(),
      ...offered.map((setting) => `${formLabel(setting.name)}: ${shown(setting)}`),
      ...Object.entries(values)
        .filter(([name]) => !offered.some((setting) => setting.name === name))
        .map(([name, value]) => `${formLabel(name)}: ${value} (not taken by this model)`),
    ];
  }

  function render(): void {
    const offered = deps.offered();
    const values = stored();
    const settings = offered
      ? [
          ...offered.map((setting) => field(setting, values[setting.name])),
          ...Object.entries(values)
            .filter(([name]) => !offered.some((setting) => setting.name === name))
            .map(([name, value]) => unusedField(name, value)),
        ]
      : [];
    body.replaceChildren(...deps.rows, ...settings);
    el.hidden = body.childElementCount === 0;
    const folded = node.settingsFolded === true;
    body.hidden = folded;
    el.classList.toggle("folded", folded);
    toggle.setAttribute("aria-expanded", String(!folded));
    const mode = typeof values.mode === "string" ? values.mode : undefined;
    const conflict = modeConflict(mode, deps.inputs());
    problem.hidden = conflict === undefined;
    problem.textContent = conflict?.message ?? "";
    label.textContent = folded ? deps.summary() || "Model settings" : "Model settings";
    toggle.setAttribute("aria-label", `${folded ? "Show" : "Fold"} settings: ${label.textContent}`);
    toggle.dataset.tooltip = folded ? everySetting(offered ?? [], values).join("\n") : "Fold settings";
    for (const pin of line.querySelectorAll(".flow-joined-pin")) pin.remove();
    if (folded) line.append(...joinedPins(deps.joined(), "target"));
  }

  render();
  return {
    el,
    refresh() {
      render();
      deps.layoutChanged();
    },
  };
}
