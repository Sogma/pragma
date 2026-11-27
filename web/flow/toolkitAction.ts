// A Flow run from a toolkit button (docs/protocol.md, Flows → Actions): the
// clicked action and what it depends on, bound to the document the button
// was clicked in. The graph is read fresh at the click, as every Flow run
// reads it, and its grants are asked for as it starts through the toolkit
// runner's broker, as the canvas asks through its own.
import type { FileResponse } from "../../src/protocol/api.ts";
import { actionGraph, flowActions, runAction } from "../../src/protocol/flowActions.ts";
import { buttonStop, type DocumentPort, type PortValue, rowsTableOf } from "../../src/protocol/flowExecutors.ts";
import { flowRunOutputs, nodeLabel } from "../../src/protocol/flowInputs.ts";
import { FLOW_NODE_REGISTRY, runCapabilities, wiredOutputs } from "../../src/protocol/flowNodes.ts";
import type { RunResult } from "../../src/protocol/flowRuntime.ts";
import { withSetupNeed } from "../../src/protocol/setupNeed.ts";
import type { FlowGraph, TableColumn, TableRow } from "../../src/protocol/types.ts";
import { proposeReplacement } from "../editProposal.ts";
import type { BrokerSubject, CapabilityBroker } from "../services/capabilityBroker.ts";
import type { DocumentAccess } from "../services/documentAccess.ts";
import type { FileNotices } from "../services/fileNotices.ts";
import { failedCallEntry, type ModelConsole } from "../services/modelConsole.ts";
import { createFlowContext, type JobStarting } from "./browserEnvironment.ts";
import { flowTreePath } from "./flowPaths.ts";
import { brokerCapability, flowBrokerCapabilities, withColumnsShown } from "./flowPermissions.ts";

/** A Table as a click in it leaves it: the whole file as a save would write
 * it, its columns, the rows ticked, copied in the Table's order, and whether
 * it is private. */
export interface TableAtClick {
  content: string;
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
  private: boolean;
}

/** Where a button was clicked: a text document, read through its live
 * editor, or a Table, as its pane held it at the click. */
export type ToolkitSource = { kind: "text"; access: DocumentAccess } | { kind: "table"; at: TableAtClick };

export interface ToolkitInvocation {
  flow: { path: string; name: string };
  // The document the button was clicked in.
  path: string;
  source: ToolkitSource;
  // Opens a file beside the group the button was clicked in, focus staying
  // in the document.
  openToSide(path: string): Promise<void>;
}

/** The ask after a For Each zone's first generation, as a run's row shows
 * it: what the item made, by tree path, and how many items are left. */
export interface ToolkitAsk {
  title: string;
  files: readonly string[];
  rest: number;
}

/** A run's row in the Tools tab: what hears of its async jobs, and where it
 * asks before a zone's other items start, answering false once `signal`
 * stops the run. */
export interface ToolkitRow {
  jobStarting?: JobStarting;
  ask?(ask: ToolkitAsk, signal: AbortSignal): Promise<boolean>;
}

/** What a click leaves under its button: the lines its Show Result nodes
 * showed and a row per exposed output, then what the model couldn't have as
 * context, which is drawn apart from the result. */
export interface ToolkitRun {
  lines: string[];
  warnings: string[];
}

export interface ToolkitActionDeps {
  broker: CapabilityBroker;
  loadFile(path: string): Promise<FileResponse>;
  modelConsole: Pick<ModelConsole, "logLlmCall" | "beginLlmActivity" | "endLlmActivity">;
  // A model call that failed, as an error on the document the button ran on
  // until a button runs on it again.
  notices: Pick<FileNotices, "begin" | "add">;
}

// The document a run reads, and why a Replace Selection in it is refused
// before anything runs or asks, when it is.
interface BoundDocument {
  port: DocumentPort;
  refusesProposal?: string;
}

// The run reads and replaces the document as the writer left it at the
// click, wherever the cursor goes meanwhile. What a Show Result node shows
// is collected into `shown`, drawn under the button when the run ends. A
// read-only editor, as reading view makes it, can't accept a proposal, and a
// selection made in reading view never reaches the run.
function textPort(path: string, flowPath: string, access: DocumentAccess, shown: string[]): BoundDocument {
  const at = access.snapshot(path);
  const selection = at.text.slice(at.from, at.to);
  const port: DocumentPort = {
    path,
    hasSelection: at.from !== at.to,
    read() {
      access.assertAccessible(path);
      return { content: at.content, selection };
    },
    replaceSelection(alternatives) {
      const range = { base: at.text, from: at.from, to: at.to };
      const shown = proposeReplacement(access.editor(path), range, alternatives, flowPath);
      if (!shown && alternatives.some((text) => text !== selection)) {
        throw new Error("The selected text was edited while the flow ran, so its result wasn't proposed");
      }
    },
    showResult(lines) {
      shown.push(...lines);
    },
  };
  return at.readOnly ? { port, refusesProposal: "requires editing. Switch the document to editing mode." } : { port };
}

// A Table holds no text to select or replace: a run reads its file and the
// rows ticked, as they stood at the click.
function tablePort(path: string, at: TableAtClick, shown: string[]): BoundDocument {
  const port: DocumentPort = {
    path,
    hasSelection: false,
    rows: { columns: at.columns, rows: at.rows },
    read() {
      if (at.private) throw new Error("This Table is `visibility: private`, so a toolkit can't read or change it.");
      return { content: at.content, selection: "" };
    },
    replaceSelection() {
      throw new Error("A Table has no selected text to replace");
    },
    showResult(lines) {
      shown.push(...lines);
    },
  };
  return { port, refusesProposal: "needs a text document, and this button is a Table's." };
}

// A node whose own inputs all ran is where the run went wrong; everything
// downstream of it only repeats that something upstream failed. The error
// names the setting the first such failure needs, when one would fix it.
function rootFailure(graph: FlowGraph, result: RunResult): Error | undefined {
  const failedInput = (nodeId: string) =>
    graph.edges.some((edge) => edge.target === nodeId && result.errors.has(edge.source));
  const roots = graph.nodes.filter((node) => result.errors.has(node.id) && !failedInput(node.id));
  if (roots.length === 0) return undefined;
  const messages = new Set(roots.map((node) => `${nodeLabel(node)}: ${result.errors.get(node.id)}`));
  const need = roots.map((node) => result.needs.get(node.id)).find((each) => each !== undefined);
  return withSetupNeed(new Error([...messages].join("\n")), need);
}

function display(value: PortValue): string {
  if (value.type === "text") return value.value;
  if (value.type === "image") return "(image)";
  if (value.type === "video") return value.path;
  if (value.type === "object") return JSON.stringify(value.value, null, 2);
  return String(value.value);
}

// What the flow exposes, as App mode would show it, from the part that ran.
function resultRows(graph: FlowGraph, result: RunResult): string[] {
  return flowRunOutputs(graph).flatMap(({ nodeId, port, label }) => {
    const value = result.outputs.get(nodeId)?.[port];
    return value ? [`${label}: ${display(value)}`] : [];
  });
}

/** Runs one action of a flow toolkit. Resolves with the lines its Show Result
 * nodes showed, then a row per exposed output the run produced, and what the
 * model couldn't have as context; rejects naming the node that failed and
 * why. */
export async function runToolkitAction(
  invocation: ToolkitInvocation,
  actionId: string,
  deps: ToolkitActionDeps,
  signal: AbortSignal,
  row: ToolkitRow = {},
): Promise<ToolkitRun> {
  const shown: string[] = [];
  const warnings: string[] = [];
  // Taken at the click, before anything awaits.
  const { path, source } = invocation;
  const { ask } = row;
  const bound =
    source.kind === "text"
      ? textPort(path, invocation.flow.path, source.access, shown)
      : tablePort(path, source.at, shown);
  const document = bound.port;
  deps.notices.begin(path, "toolkit");
  const file = await deps.loadFile(invocation.flow.path);
  // Stopped while the file loaded: the shared broker may belong to whatever
  // started since, so this run must not mount on it.
  signal.throwIfAborted();
  if (file.kind !== "flow") throw new Error(`"${invocation.flow.path}" is no longer a Flow`);
  if (file.locked === "newer-format")
    throw new Error("This Flow was saved by a newer version of Pragma, so it can't run here");
  if (file.locked === "unreadable") throw new Error("This Flow's file couldn't be read, so it can't run");
  const action = flowActions(file.graph).find((each) => each.nodeId === actionId);
  if (!action) {
    throw new Error("This Flow no longer has that button. Reopen the document to refresh its buttons.");
  }
  const graph = actionGraph(file.graph, actionId);
  const { replaceSelection } = FLOW_NODE_REGISTRY;
  if (bound.refusesProposal && graph.nodes.some((node) => node.type === replaceSelection.type)) {
    throw new Error(`${replaceSelection.label} ${bound.refusesProposal}`);
  }
  // A click about to stop asks for nothing, as the Button checks before any grant.
  const clicked = graph.nodes.find((node) => node.id === actionId);
  const stop = clicked && buttonStop(clicked, document, wiredOutputs(graph).get(actionId) ?? new Set());
  if (clicked && stop) throw new Error(`${nodeLabel(clicked)}: ${stop}`);
  const granted = new Set(file.grantedCapabilities);
  const subject: BrokerSubject = {
    kind: "flow",
    path: file.path,
    name: file.name ?? "",
    capabilities: () => flowBrokerCapabilities(file.graph, granted, file.path),
    grantedCapabilities: granted,
  };
  const context = createFlowContext({
    flowPath: file.path,
    pickedImages: new Map(),
    ensureCapability: async (capability) => deps.broker.ensure(brokerCapability(capability, file.path), subject),
    beginLlmActivity: (model) => deps.modelConsole.beginLlmActivity(model),
    endLlmActivity: (model) => deps.modelConsole.endLlmActivity(model),
    signal,
    jobStarting: row.jobStarting,
    document,
    openToSide: invocation.openToSide,
    confirmRest:
      ask &&
      (({ done, rest, word, files }) => {
        const made = files.map((each) => flowTreePath(file.path, each));
        return ask({ title: `${word} ${done} done`, files: made, rest }, signal);
      }),
    generations: {
      // A failure is an error on the document until a button runs on it
      // again, its entry written by the notice.
      log: (id, outcome) => {
        const node = graph.nodes.find((each) => each.id === id);
        const label = `${file.name || file.path} · ${node ? nodeLabel(node) : id} on ${path}`;
        if (outcome.failed) {
          const entry = failedCallEntry(label, outcome);
          deps.notices.add(path, "toolkit", { level: "error", count: 1, ...entry });
        } else {
          deps.modelConsole.logLlmCall(label, outcome);
        }
      },
      warned: (_id, found) => warnings.push(...found),
    },
  });
  deps.broker.mount(subject);
  try {
    // Asked for together, before the Button runs: a refusal leaves nothing
    // spent or written. A Table's column grants name the Table clicked in.
    const needs = runCapabilities(graph, file.path, undefined, rowsTableOf(document));
    const described = await withColumnsShown(
      needs.map((need) => need.capability),
      file.path,
    );
    signal.throwIfAborted();
    const asked = described.map((capability) => brokerCapability(capability, file.path));
    if (!(await deps.broker.ensureAll(asked, subject)).allowed) throw new Error("Permission denied, so nothing ran.");
    const result = await runAction(graph, actionId, context);
    const failure = rootFailure(graph, result);
    if (failure) throw failure;
    return { lines: [...shown, ...resultRows(graph, result)], warnings };
  } finally {
    deps.broker.unmount();
  }
}
