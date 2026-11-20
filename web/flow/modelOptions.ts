// A Flow's model fields: a picker per Generate node's model input, over the
// model lists every picker shares (services/modelLists.ts).
import { effortFor, type ModelSetting } from "../../src/protocol/api.ts";
import {
  EFFORT_KEY,
  FLOW_NODE_REGISTRY,
  type FlowNodeInputWidgetType,
  type FrameKind,
} from "../../src/protocol/flowNodes.ts";
import type { FlowNodeInstance } from "../../src/protocol/types.ts";
import { effortSlider } from "../lib/effort.ts";
import { createModelPickerButton, type ModelKind, renderModelPicker, toggleModelMenu } from "../lib/modelPicker.ts";
import type { ContextMenuService } from "../services/menus.ts";
import type { ModelLists } from "../services/modelLists.ts";

/** A Generate node's effort, which its model menu's slider sets. */
export interface EffortField {
  value(): string;
  pick(pick: string): void;
}

export interface ModelFields {
  // A model input's control, naming the model a run will use: the node's
  // own, or on "" the default it falls back to, with the effort it runs at.
  // `onRedraw` runs whenever it redraws, as a list or a default arrives, so
  // what depends on the model can follow it.
  create(
    kind: ModelKind,
    value: () => string,
    onPick: (ref: string) => void,
    options?: { onRedraw?: () => void; effort?: EffortField },
  ): HTMLButtonElement;
  // How many reference images the model a ref names takes, "" for the
  // default; undefined while its list hasn't come, or when nobody says.
  imageReferences(kind: ModelKind, ref: string): number | undefined;
  // How many reference clips it takes, the same way.
  videoReferences(kind: ModelKind, ref: string): number | undefined;
  // Which frames it takes, the same way.
  frames(kind: ModelKind, ref: string): FrameKind[] | undefined;
  // The settings it offers beyond the node's own inputs, the same way.
  settings(kind: ModelKind, ref: string): ModelSetting[] | undefined;
}

export interface ModelFieldsDeps {
  contextMenu: ContextMenuService;
  modelLists: ModelLists;
}

const ROLES: Record<ModelKind, string> = { text: "Model", image: "Image model", video: "Video model" };

const WIDGET_KINDS: Partial<Record<FlowNodeInputWidgetType, ModelKind>> = {
  textModel: "text",
  imageModel: "image",
  videoModel: "video",
};

/** The list a model widget picks from, or undefined for any other widget. */
export function modelKindOf(widget: FlowNodeInputWidgetType): ModelKind | undefined {
  return WIDGET_KINDS[widget];
}

/** A node's effort, kept in its config, for a type that takes one; left out
 * at the default, so a Flow nobody set it on keeps its file as it was. */
export function effortFieldOf(node: FlowNodeInstance, persist: () => void): EffortField | undefined {
  if (!FLOW_NODE_REGISTRY[node.type]?.configKeys.includes(EFFORT_KEY)) return undefined;
  return {
    value: () => (typeof node.config[EFFORT_KEY] === "string" ? (node.config[EFFORT_KEY] as string) : ""),
    pick(pick) {
      if (pick) node.config[EFFORT_KEY] = pick;
      else delete node.config[EFFORT_KEY];
      persist();
    },
  };
}

export function createModelFields({ contextMenu, modelLists }: ModelFieldsDeps): ModelFields {
  // The list's entry for a ref, "" for the kind's default.
  const listed = (kind: ModelKind, ref: string) => {
    const chosen = ref || modelLists.defaultOf(kind);
    return modelLists.get(kind)?.models.find((model) => model.id === chosen);
  };
  // A field names the default it follows and flags a model no list holds,
  // so a new default or a new list redraws them all. Held weakly: a card is
  // rebuilt on every open, and a strong hold would keep each discarded one
  // alive.
  const live = new Set<WeakRef<HTMLButtonElement>>();
  const redraws = new WeakMap<HTMLButtonElement, () => void>();
  const redrawLive = () => {
    for (const ref of live) {
      const button = ref.deref();
      if (button?.isConnected) redraws.get(button)?.();
      else live.delete(ref);
    }
  };
  modelLists.subscribe(redrawLive);

  return {
    create(kind, value, onPick, { onRedraw, effort } = {}) {
      const button = createModelPickerButton("form-input flow-picker");
      const levels = () => listed(kind, value())?.effortLevels;
      const render = () => {
        const ref = value();
        renderModelPicker(button, ref || modelLists.defaultOf(kind), modelLists.get(kind), {
          role: ROLES[kind],
          none: "No model",
          follows: ref ? undefined : kind,
          effort: effort && effortFor(effort.value(), levels()),
        });
        onRedraw?.();
      };
      render();
      modelLists.load(kind);

      button.addEventListener("click", () => {
        const offered = effort ? levels() : undefined;
        const menu = {
          stored: value(),
          pick: (ref: string) => {
            onPick(ref);
            render();
          },
          defaultRow: { fallback: modelLists.defaultOf(kind) },
          settingsRow: true,
          slider:
            effort && offered?.length
              ? effortSlider(offered, effort.value(), (pick) => {
                  effort.pick(pick);
                  render();
                })
              : undefined,
        };
        const list = modelLists.get(kind) ?? { models: [], providers: [] };
        toggleModelMenu(contextMenu, button, list, menu, { ariaLabel: ROLES[kind] });
      });

      for (const ref of live) if (!ref.deref()) live.delete(ref);
      live.add(new WeakRef(button));
      redraws.set(button, render);
      return button;
    },
    imageReferences(kind, ref) {
      return listed(kind, ref)?.references?.image;
    },
    videoReferences(kind, ref) {
      return listed(kind, ref)?.references?.video;
    },
    frames(kind, ref) {
      return listed(kind, ref)?.frames;
    },
    settings(kind, ref) {
      const model = listed(kind, ref);
      return model && (model.settings ?? []);
    },
  };
}
