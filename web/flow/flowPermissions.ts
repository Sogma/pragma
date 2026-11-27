// A Flow's capabilities in the permission broker's terms: what its
// Permissions panel lists, and what a run asks for. Shared by the canvas and
// the toolkit runner, so a key is spelled one way wherever it is asked.
import { flowPermissionRows, resolveFlowCapability } from "../../src/protocol/flowNodes.ts";
import { parseRootedPath } from "../../src/protocol/rootedPath.ts";
import {
  type FlowCapabilityDeclaration,
  type FlowGraph,
  flowCapabilityKey,
  isColumnCapability,
  type TableColumn,
} from "../../src/protocol/types.ts";
import { type FlowFileResponse, fetchFile, sandboxSetUnattended } from "../core/apiClient.ts";
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
    ...(isColumnCapability(resolved) && resolved.shown ? { columnShown: resolved.shown } : {}),
    ...("wired" in resolved && resolved.wired ? { description: WIRED } : {}),
  };
}

/** Each column grant with its column as its Table names it, so a prompt
 * draws the column's label and type rather than its id. Read as the person
 * reads the space, not under the Flow's grants, which the prompt is about to
 * ask for; a Table that can't be read leaves the id. */
export async function withColumnsShown(
  capabilities: readonly FlowCapabilityDeclaration[],
  flowPath: string,
): Promise<FlowCapabilityDeclaration[]> {
  const tables = new Map<string, Promise<readonly TableColumn[] | undefined>>();
  const columnsOf = (address: string): Promise<readonly TableColumn[] | undefined> => {
    const read =
      tables.get(address) ??
      (async () => {
        const rooted = parseRootedPath(address);
        if (rooted.root !== "space") return undefined;
        const file = await fetchFile(rooted.path);
        return file.kind === "table" ? file.columns : undefined;
      })().catch(() => undefined);
    tables.set(address, read);
    return read;
  };
  return Promise.all(
    capabilities.map(async (capability) => {
      if (!isColumnCapability(capability)) return capability;
      const resolved = (() => {
        try {
          return resolveFlowCapability(capability, flowPath);
        } catch {
          return undefined;
        }
      })();
      const address = resolved && "path" in resolved ? resolved.path : undefined;
      const columns = address === undefined ? undefined : await columnsOf(address);
      const column = columns?.find((candidate) => candidate.id === capability.column);
      return column ? { ...capability, shown: { label: column.label, type: column.type } } : capability;
    }),
  );
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
