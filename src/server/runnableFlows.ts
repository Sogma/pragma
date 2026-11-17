// What an agent may run: the visible flows a human has allowed to run
// unattended, each with the signature it exposes. Shared by the MCP tool and
// the REST listing so the two encodings answer the same question the same way.
import path from "node:path";
import { capabilityDigest, readFlowFile } from "../protocol/flowFile.ts";
import { type FlowRunInput, type FlowRunOutput, flowRunInputs, flowRunOutputs } from "../protocol/flowInputs.ts";
import { metadataText } from "../protocol/metadata.ts";
import { isFlowFile } from "../protocol/types.ts";
import { visiblePaths } from "./agentSurface.ts";
import { isUnattendedGranted } from "./grants.ts";

export interface RunnableFlow {
  path: string;
  name: string;
  description: string;
  inputs: Omit<FlowRunInput, "nodeId" | "field">[];
  outputs: Omit<FlowRunOutput, "nodeId" | "port">[];
}

export async function runnableFlows(spaceRoot: string): Promise<RunnableFlow[]> {
  const runnable: RunnableFlow[] = [];
  for (const relativePath of (await visiblePaths(spaceRoot)).filter(isFlowFile)) {
    // A flow that will not parse is not runnable; it is not an error in the
    // listing either, which would hide every other flow behind one bad file.
    const flow = await readFlowFile(path.join(spaceRoot, relativePath)).catch(() => undefined);
    if (!flow) continue;
    const subject = { path: relativePath, contentHash: capabilityDigest(flow.graph) };
    if (!(await isUnattendedGranted(spaceRoot, subject))) continue;
    runnable.push({
      path: relativePath,
      name: flow.name ?? "",
      description: metadataText(flow.metadata, "description") ?? "",
      inputs: flowRunInputs(flow.graph).map(({ name, label, type }) => ({ name, label, type })),
      outputs: flowRunOutputs(flow.graph).map(({ name, label }) => ({ name, label })),
    });
  }
  return runnable;
}
