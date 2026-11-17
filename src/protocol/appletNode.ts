// An Applet as a Flow node: what its config holds, which Applets may be one,
// and how what its frame reports becomes the values a run reads.
import type { PortValue } from "./flowExecutors.ts";
import {
  type AppletManifest,
  type AppletPorts,
  appletRefusal,
  type FlowGraph,
  type FlowPort,
  isBase64,
  RASTER_IMAGE_MEDIA_TYPES,
} from "./types.ts";

export const APPLET_NODE_TYPE = "applet";

// What one node may keep of what its frame reports, as JSON characters. A
// frame grab is the large case: a 768×432 JPEG is about 100 KB.
const MAX_SAVED_LENGTH = 2_000_000;

/** An Applet node's config, all of it written by the host. `appletHash` and
 * `ports` are what the editor last read from the file, kept so a run and the
 * canvas type edges without reading it; `state` is what the Applet last
 * handed back to be restored, and `outputs` the values it last reported. */
export interface AppletNodeConfig {
  appletPath?: string;
  appletHash?: string;
  ports?: AppletPorts;
  state?: unknown;
  outputs?: Record<string, PortValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Named by id, whatever `label` the saved copy carries: the canvas draws a
// node from this copy before it re-reads the Applet. A description that
// isn't text is dropped, since the card shows it as one.
function readSavedPorts(value: unknown): AppletPorts | undefined {
  if (!isRecord(value)) return undefined;
  const list = (ports: unknown): FlowPort[] =>
    Array.isArray(ports)
      ? ports
          .filter(
            (port): port is FlowPort => isRecord(port) && typeof port.id === "string" && typeof port.type === "string",
          )
          .map(({ description, ...port }) => ({
            ...port,
            label: port.id,
            ...(typeof description === "string" && description.trim() ? { description } : {}),
          }))
      : [];
  return { inputs: list(value.inputs), outputs: list(value.outputs) };
}

export function appletNodeConfig(config: Record<string, unknown>): AppletNodeConfig {
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : undefined);
  return {
    appletPath: text("appletPath"),
    appletHash: text("appletHash"),
    ports: readSavedPorts(config.ports),
    state: config.state,
    outputs: isRecord(config.outputs) ? (config.outputs as Record<string, PortValue>) : undefined,
  };
}

/** Why an Applet can't be a Flow node, or undefined when it can. A run never
 * executes an Applet, so one that took inputs and gave outputs would hand on
 * values computed from the previous run's inputs. */
export function appletNodeProblem(manifest: AppletManifest): string | undefined {
  const refusal = appletRefusal(manifest);
  if (refusal) return refusal;
  if (manifest.ports && manifest.ports.inputs.length > 0 && manifest.ports.outputs.length > 0) {
    return "An Applet node takes inputs or gives outputs, not both.";
  }
  return undefined;
}

const DATA_URL = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

function portValue(port: FlowPort, raw: unknown): PortValue | string {
  switch (port.type) {
    case "text":
      return typeof raw === "string" ? { type: "text", value: raw } : `"${port.id}" takes text`;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw)
        ? { type: "number", value: raw }
        : `"${port.id}" takes a number`;
    case "boolean":
      return typeof raw === "boolean" ? { type: "boolean", value: raw } : `"${port.id}" takes true or false`;
    case "object":
      return raw === undefined ? `"${port.id}" takes a value` : { type: "object", value: raw };
    case "image": {
      // A data URL, which is what a canvas gives, or the port value itself.
      const match = typeof raw === "string" ? DATA_URL.exec(raw) : undefined;
      const image = match
        ? { mediaType: match[1], data: match[2] }
        : isRecord(raw) && typeof raw.mediaType === "string" && typeof raw.data === "string" && isBase64(raw.data)
          ? { mediaType: raw.mediaType, data: raw.data }
          : undefined;
      if (!image) return `"${port.id}" takes an image as a base64 data URL`;
      if (!(RASTER_IMAGE_MEDIA_TYPES as readonly string[]).includes(image.mediaType)) {
        return `"${port.id}" takes JPEG, PNG, GIF or WebP, not ${image.mediaType}`;
      }
      return { type: "image", ...image };
    }
  }
}

/** The outputs a frame reported, checked against the node's declared output
 * ports: a port it doesn't declare, or a value of the wrong type, refuses the
 * whole report rather than saving part of it. */
export function appletOutputsFrom(
  ports: AppletPorts,
  raw: unknown,
): { outputs: Record<string, PortValue> } | { error: string } {
  if (!isRecord(raw)) return { error: "Outputs must be an object keyed by output port" };
  const outputs: Record<string, PortValue> = {};
  for (const [id, value] of Object.entries(raw)) {
    const port = ports.outputs.find((candidate) => candidate.id === id);
    if (!port) {
      const known = ports.outputs.map((candidate) => candidate.id);
      return { error: `No output port "${id}"${known.length > 0 ? ` (it has ${known.join(", ")})` : ""}` };
    }
    const converted = portValue(port, value);
    if (typeof converted === "string") return { error: converted };
    outputs[id] = converted;
  }
  return JSON.stringify(outputs).length > MAX_SAVED_LENGTH ? { error: "Outputs are too large to save" } : { outputs };
}

/** The state a frame handed back, kept only if it survives a round trip
 * through JSON at a size the Flow file can carry. */
export function appletStateFrom(raw: unknown): { state: unknown } | { error: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return { error: "State must be plain data" };
  }
  if (json === undefined) return { error: "State must be plain data" };
  if (json.length > MAX_SAVED_LENGTH) return { error: "State is too large to save" };
  return { state: JSON.parse(json) };
}

/** Whether an Applet node in both graphs now records a different hash for its
 * file: its code changed, so what it reports can no longer be vouched for by
 * the approval the Flow's grants record. A node first added is the person's
 * own drag, and doesn't count. */
export function appletCodeChanged(before: FlowGraph, after: FlowGraph): boolean {
  const hashes = new Map(
    before.nodes
      .filter((node) => node.type === APPLET_NODE_TYPE)
      .map((node) => [node.id, appletNodeConfig(node.config).appletHash]),
  );
  return after.nodes.some((node) => {
    if (node.type !== APPLET_NODE_TYPE || !hashes.has(node.id)) return false;
    const was = hashes.get(node.id);
    return was !== undefined && was !== appletNodeConfig(node.config).appletHash;
  });
}
