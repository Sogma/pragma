import type { ModelSetting } from "../../../src/protocol/api.ts";
import type { FrameKind } from "../../../src/protocol/flowNodes.ts";
import type { EffortField, ModelFields } from "../../../web/flow/modelOptions.ts";
import type { ModelKind } from "../../../web/lib/modelPicker.ts";

// A Flow's model fields as a card or App Mode sees them: each create is
// recorded, and returns a plain picker-classed button. The pickers' own
// drawing and menu are modelOptions.test.ts's.
//
// `references` holds how many reference images a ref's model takes,
// `videoCounts` how many clips, `frameLists` which frames, and
// `settingLists` the settings it offers, as its list would say.
export interface FakeField {
  kind: ModelKind;
  value(): string;
  onPick(ref: string): void;
  onRedraw?: () => void;
  effort?: EffortField;
  button: HTMLButtonElement;
}

export function fakeModelFields(): ModelFields & {
  fields: FakeField[];
  references: Map<string, number>;
  videoCounts: Map<string, number>;
  frameLists: Map<string, FrameKind[]>;
  settingLists: Map<string, ModelSetting[]>;
} {
  const fields: FakeField[] = [];
  const references = new Map<string, number>();
  const videoCounts = new Map<string, number>();
  const frameLists = new Map<string, FrameKind[]>();
  const settingLists = new Map<string, ModelSetting[]>();
  return {
    fields,
    references,
    videoCounts,
    frameLists,
    settingLists,
    create(kind, value, onPick, options = {}) {
      const button = document.createElement("button");
      button.className = "model-picker";
      fields.push({ kind, value, onPick, onRedraw: options.onRedraw, effort: options.effort, button });
      return button;
    },
    imageReferences: (_kind, ref) => references.get(ref),
    videoReferences: (_kind, ref) => videoCounts.get(ref),
    frames: (_kind, ref) => frameLists.get(ref),
    settings: (_kind, ref) => settingLists.get(ref),
  };
}
