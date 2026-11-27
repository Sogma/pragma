// A Flow's capabilities in the permission broker's terms: what its
// Permissions panel lists, and what a run asks for. Shared by the canvas and
// the toolkit runner, so a key is spelled one way wherever it is asked.
import { flowPermissionRows, resolveFlowCapability } from "../../src/protocol/flowNodes.ts";
import {
  type FlowCapabilityDeclaration,
  type FlowGraph,
  flowCapabilityKey,
  isColumnCapability,
} from "../../src/protocol/types.ts";
import { type FlowFileResponse, sandboxSetUnattended } from "../core/apiClient.ts";
import type { BrokerCapability, UnattendedGrant } from "../services/capabilityBroker.ts";

// Said beside a path a wire chose: the Flow computed it, so the next run may
// ask for another file.
const WIRED = "a path from a connected node";

/** A capability of the Flow at `flowPath` as the broker asks for it, its
 * path resolved to the address its key and prompt name. Throws, naming why,
 * for a path that names nothing. */
export function brokerCapability(capability: FlowCapabilityDeclaration, flowPath: string): BrokerCapability {
  const resolved = resolveFlowCapability(capability, flowPath);
  return {
    key: flowCapabilityKey(resolved),
    type: resolved.type,
    ...("path" in resolved ? { path: resolved.path } : {}),
    ...(isColumnCapability(resolved) ? { column: resolved.column } : {}),
    ...("wired" in resolved && resolved.wired ? { description: WIRED } : {}),
  };
}

/** What the graph derives, then each wired path a person has allowed. */
export function flowBrokerCapabilities(
  graph: FlowGraph,
  granted: ReadonlySet<string>,
  flowPath: string,
): BrokerCapability[] {
  return flowPermissionRows(graph, granted, flowPath).map((capability) => brokerCapability(capability, flowPath));
}

/** The Flow's leave to run unattended, as its file was read. */
export function flowUnattendedGrant(file: FlowFileResponse): UnattendedGrant {
  return {
    granted: file.runsUnattended,
    until: file.unattendedUntil,
    set: (allowed, until) => sandboxSetUnattended("flow", file.path, allowed, until),
  };
}
