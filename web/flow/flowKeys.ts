// The Flow canvas's keys: Undo, Redo, and removing or disabling the
// selected node. Each command acts on whichever Flow view the keyboard is
// in, and only while focus is on its canvas, so the same key anywhere else
// keeps its own job.
import type { CommandRegistry } from "../services/commands.ts";
import { currentPlatform, type KeybindingRegistry } from "../services/keybindings.ts";
import type { CanvasEdit, FlowView } from "./xyflowAdapter.ts";

export function registerFlowKeys(
  commands: CommandRegistry,
  keybindings: KeybindingRegistry,
  activeFlowView: () => FlowView | undefined,
): void {
  const edits: { id: string; label: string; edit: CanvasEdit; keys: string[] }[] = [
    { id: "flow.undo", label: "Undo", edit: "undo", keys: ["Mod+Z"] },
    // Ctrl+Y is Redo only off the Mac.
    {
      id: "flow.redo",
      label: "Redo",
      edit: "redo",
      keys: ["Mod+Shift+Z", ...(currentPlatform() === "mac" ? [] : ["Ctrl+Y"])],
    },
    // Backspace is what a Mac's Delete key sends.
    { id: "flow.removeNode", label: "Remove node", edit: "remove", keys: ["Delete", "Backspace"] },
    { id: "flow.disableNode", label: "Disable or enable node", edit: "disable", keys: ["Mod+M"] },
  ];
  for (const { id, label, edit, keys } of edits) {
    commands.register({
      id,
      label,
      when: () => activeFlowView()?.canEdit(edit) ?? false,
      run: () => activeFlowView()?.edit(edit),
    });
    for (const key of keys) keybindings.register({ key, command: id });
  }
}
