// A Flow's writes: the debounced save after every change, the awaited one a
// grant, a rename or a run needs first, and the check every save passes.
//
// The check: a save keeps every node the file was opened or last saved with,
// unless Remove or Undo took it out. A save that doesn't was composed from a
// graph that lost nodes some other way, and writing it would delete them from
// the file, so it is refused and the canvas says so.
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import type { FlowGraph, MetadataEntry } from "../../src/protocol/types.ts";
import type { FlowFileResponse } from "../core/apiClient.ts";

export interface FlowSavesDeps {
  // Read fresh: the view replaces both on every render.
  graph(): FlowGraph;
  file(): FlowFileResponse | undefined;
  // A locked file is never saved over.
  locked(): boolean;
  scheduleSave(path: string, content: string): void;
  saveNow(path: string, content: string): Promise<boolean>;
  onGraphChange(path: string, graph: FlowGraph): void;
  // Where a refused save is reported.
  notice: HTMLElement;
}

export interface FlowSaves {
  // After every change: the pane's problem report, then the debounced save.
  //
  // The content is composed now, not when the queue writes it: the view
  // shows every Flow its group opens, so a later compose could write
  // another Flow's graph to this one's path.
  persist(): void;
  // Writes now and resolves whether the content is on disk. A grant right
  // after a config edit needs it: the server checks a grant against the
  // graph on disk, and a save still waiting out the debounce would fail it.
  saveNow(): Promise<boolean>;
  // What a save of `file` writes, or undefined when the check refuses it.
  compose(file: FlowFileResponse): string | undefined;
  // A file was rendered: its nodes are the ones every save must keep. Called
  // before any card is built, since a card may save while it's built.
  opened(graph: FlowGraph): void;
  // Remove or Undo took this node out, so a save may drop it.
  removed(nodeId: string): void;
  // The flow's own name, its `<title>`, with an awaited save, so a rename can
  // say whether it landed.
  rename(name: string): Promise<boolean>;
  // Its metadata block, description included, with the debounced autosave.
  // No Undo step: Undo steps through the graph, and the block is not part
  // of it.
  setMetadata(metadata: MetadataEntry[]): void;
}

export function createFlowSaves(deps: FlowSavesDeps): FlowSaves {
  let kept = new Set<string>();

  // The open file's metadata as the server handed it over, plus the live
  // graph.
  function compose({ version, name, metadata }: FlowFileResponse): string | undefined {
    const graph = deps.graph();
    const present = new Set(graph.nodes.map((node) => node.id));
    const dropped = [...kept].filter((nodeId) => !present.has(nodeId));
    if (dropped.length > 0) {
      deps.notice.textContent = refusal(dropped.length);
      deps.notice.hidden = false;
      return undefined;
    }
    kept = present;
    return serializeFlowFile({ version, name, metadata, graph });
  }

  function persist(): void {
    const file = deps.file();
    if (file) deps.onGraphChange(file.path, deps.graph());
    if (!file || deps.locked()) return;
    const content = compose(file);
    if (content !== undefined) deps.scheduleSave(file.path, content);
  }

  async function saveNow(): Promise<boolean> {
    const file = deps.file();
    if (!file || deps.locked()) return false;
    const content = compose(file);
    return content !== undefined && deps.saveNow(file.path, content);
  }

  return {
    persist,
    saveNow,
    compose,
    opened(graph) {
      kept = new Set(graph.nodes.map((node) => node.id));
    },
    removed(nodeId) {
      kept.delete(nodeId);
    },
    async rename(name) {
      const file = deps.file();
      if (!file) return false;
      file.name = name.trim() || undefined;
      return saveNow();
    },
    setMetadata(metadata) {
      const file = deps.file();
      if (!file || deps.locked()) return;
      file.metadata = metadata;
      persist();
    },
  };
}

function refusal(count: number): string {
  const nodes = count === 1 ? "1 node" : `${count} nodes`;
  return `This Flow stopped saving: its next save would have deleted ${nodes} the file holds. The file is as it was last saved; reopen the Flow to carry on.`;
}
