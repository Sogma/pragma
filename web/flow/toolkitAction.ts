// A Flow run from a toolkit button (docs/protocol.md, Flows → Actions): the
// clicked action and what it depends on, bound to the document the button
// was clicked in. The graph is read fresh at the click, as every Flow run
// reads it, and a grant is asked for on first use through the toolkit
// runner's broker, as the canvas asks through its own.
import type { FileResponse } from "../../src/protocol/api.ts";
import { actionGraph, flowActions, runAction } from "../../src/protocol/flowActions.ts";
import type { DocumentPort, PortValue } from "../../src/protocol/flowExecutors.ts";
import { flowRunOutputs, nodeLabel } from "../../src/protocol/flowInputs.ts";
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";
import type { RunResult } from "../../src/protocol/flowRuntime.ts";
import { withSetupNeed } from "../../src/protocol/setupNeed.ts";
import type { FlowGraph } from "../../src/protocol/types.ts";
import { proposeReplacement } from "../editProposal.ts";
import type { BrokerSubject, CapabilityBroker } from "../services/capabilityBroker.ts";
import type { DocumentAccess, DocumentSnapshot } from "../services/documentAccess.ts";
import type { FileNotices } from "../services/fileNotices.ts";
import { failedCallEntry, type ModelConsole } from "../services/modelConsole.ts";
import { createFlowContext, type JobStarting } from "./browserEnvironment.ts";
import { brokerCapability, flowBrokerCapabilities } from "./flowPermissions.ts";

export interface ToolkitInvocation {
  flow: { path: string; name: string };
  // The document the button was clicked in, and its live-editor surface.
  path: string;
  access: DocumentAccess;
  // Opens a file beside the group the button was clicked in, focus staying
  // in the document.
  openToSide(path: string): Promise<void>;
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

// The run reads and replaces the document as the writer left it at the
// click, wherever the cursor goes meanwhile. What a Show Result node shows
// is collected into `shown`, drawn under the button when the run ends.
function documentPort({ path, access, flow }: ToolkitInvocation, at: DocumentSnapshot, shown: string[]): DocumentPort {
  const selection = at.text.slice(at.from, at.to);
  return {
    path,
    hasSelection: at.from !== at.to,
    read() {
      access.assertAccessible(path);
      return { content: at.content, selection };
    },
    replaceSelection(alternatives) {
      const range = { base: at.text, from: at.from, to: at.to };
      const shown = proposeReplacement(access.editor(path), range, alternatives, flow.path);
      if (!shown && alternatives.some((text) => text !== selection)) {
        throw new Error("The selected text was edited while the flow ran, so its result wasn't proposed");
      }
    },
    showResult(lines) {
      shown.push(...lines);
    },
  };
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
  jobStarting?: JobStarting,
): Promise<ToolkitRun> {
  const shown: string[] = [];
  const warnings: string[] = [];
  // Taken at the click, before anything awaits.
  const at = invocation.access.snapshot(invocation.path);
  const document = documentPort(invocation, at, shown);
  deps.notices.begin(invocation.path, "toolkit");
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
  // Refused before anything runs or asks: a read-only editor, as reading view
  // makes it, can't accept a proposal, and a selection made in reading view
  // never reaches the run.
  const graph = actionGraph(file.graph, actionId);
  const { replaceSelection } = FLOW_NODE_REGISTRY;
  if (at.readOnly && graph.nodes.some((node) => node.type === replaceSelection.type)) {
    throw new Error(`${replaceSelection.label} requires editing. Switch the document to editing mode.`);
  }
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
    jobStarting,
    document,
    openToSide: invocation.openToSide,
    generations: {
      // A failure is an error on the document until a button runs on it
      // again, its entry written by the notice.
      log: (id, outcome) => {
        const node = graph.nodes.find((each) => each.id === id);
        const label = `${file.name || file.path} · ${node ? nodeLabel(node) : id} on ${invocation.path}`;
        if (outcome.failed) {
          const entry = failedCallEntry(label, outcome);
          deps.notices.add(invocation.path, "toolkit", { level: "error", count: 1, ...entry });
        } else {
          deps.modelConsole.logLlmCall(label, outcome);
        }
      },
      warned: (_id, found) => warnings.push(...found),
    },
  });
  deps.broker.mount(subject);
  try {
    const result = await runAction(graph, actionId, context);
    const failure = rootFailure(graph, result);
    if (failure) throw failure;
    return { lines: [...shown, ...resultRows(graph, result)], warnings };
  } finally {
    deps.broker.unmount();
  }
}
