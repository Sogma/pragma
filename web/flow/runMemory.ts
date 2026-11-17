// What a Flow view remembers of each Flow's runs: every node's last outputs,
// given back to Regenerate, and beside a node that reuses on request the
// fingerprint its outputs answer, for Reuse result on repeat.
import type { PortValue } from "../../src/protocol/flowExecutors.ts";
import type { Recall, RunResult } from "../../src/protocol/flowRuntime.ts";

type Outputs = Record<string, PortValue>;

interface Remembered {
  outputs: Outputs;
  fingerprint?: string;
  // A blank model falls back to the default text model, so a run under
  // another default may have received something else: nothing recalls
  // across one.
  defaultModel: string;
}

/** One run's view of its Flow's memory, taken as the run starts. A node the
 * run regenerates is `fresh`: never recalled, and not among what it's given. */
export interface FlowRunMemory {
  // The Flow's last outputs, but the fresh node's: what Regenerate is given.
  known(): Map<string, Outputs>;
  recall: Recall;
  // Keeps what the run produced. A node the run was given keeps its entry.
  record(ran: RunResult, given?: ReadonlyMap<string, Outputs>): void;
}

// Keyed by Flow path, then node id: one view shows every Flow its group
// opens, and node ids repeat across Flows.
export function createRunMemory(defaultModel: () => string): (flowPath: string, fresh?: string) => FlowRunMemory {
  const byFlow = new Map<string, Map<string, Remembered>>();
  return (flowPath, fresh) => {
    const nodes = byFlow.get(flowPath) ?? new Map<string, Remembered>();
    byFlow.set(flowPath, nodes);
    const model = defaultModel();
    return {
      known: () =>
        new Map([...nodes].filter(([id]) => id !== fresh).map(([id, entry]): [string, Outputs] => [id, entry.outputs])),
      recall: (nodeId, fingerprint) => {
        const entry = nodeId === fresh ? undefined : nodes.get(nodeId);
        return entry?.fingerprint === fingerprint && entry.defaultModel === model ? entry.outputs : undefined;
      },
      record(ran, given) {
        for (const [id, outputs] of ran.outputs) {
          if (!given?.has(id)) nodes.set(id, { outputs, fingerprint: ran.fingerprints.get(id), defaultModel: model });
        }
      },
    };
  };
}
