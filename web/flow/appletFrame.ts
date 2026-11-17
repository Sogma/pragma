// An Applet running as a Flow node, in its card or its App Mode field: one
// sandboxed frame, what it reports saved into the node's config, and the
// node's inputs handed to it after a run.
import { appletNodeProblem, appletOutputsFrom, appletStateFrom } from "../../src/protocol/appletNode.ts";
import type { PortValue } from "../../src/protocol/flowExecutors.ts";
import type { AppletManifest, AppletPorts, FlowGraph, FlowNodeInstance } from "../../src/protocol/types.ts";
import type { AppletFileResponse, AppletImportSource, FileResponse } from "../core/apiClient.ts";
import { createInlineError } from "../lib/inlineError.ts";

export interface AppletFrameDeps {
  loadFile(path: string): Promise<FileResponse>;
  injectRuntime(html: string, manifest: AppletManifest, imports: readonly AppletImportSource[], state: unknown): string;
  // The node's config changed: state or outputs the frame reported.
  persist(): void;
  // The file as read, before the frame mounts, so the caller can bring the
  // node's recorded hash, ports and title up to date with it.
  onLoaded?(file: AppletFileResponse): void;
  // App Mode's frame is its tile's height, so the content height the Applet
  // reports is never applied there.
  fillsTile?: boolean;
}

export interface AppletFrame {
  readonly el: HTMLDivElement;
  // The values wired into the node on the last run, for an Applet that
  // shows them; kept, and handed on again if the frame reloads.
  deliverInputs(inputs: Record<string, PortValue>): void;
  dispose(): void;
}

const NO_PORTS: AppletPorts = { inputs: [], outputs: [] };

/** The values wired into one node on a run, by its input port. */
export function runInputs(
  graph: FlowGraph,
  outcome: { outputs: Map<string, Record<string, PortValue | undefined>> },
  nodeId: string,
): Record<string, PortValue> {
  const inputs: Record<string, PortValue> = {};
  for (const edge of graph.edges) {
    if (edge.target !== nodeId) continue;
    const value = outcome.outputs.get(edge.source)?.[edge.sourcePort];
    if (value) inputs[edge.targetPort] = value;
  }
  return inputs;
}

export function createAppletFrame(node: FlowNodeInstance, deps: AppletFrameDeps): AppletFrame {
  const el = document.createElement("div");
  el.className = "flow-applet";
  const status = document.createElement("div");
  status.className = "flow-applet-status";
  el.appendChild(status);

  let frame: HTMLIFrameElement | undefined;
  let ports = NO_PORTS;
  let lastInputs: Record<string, PortValue> | undefined;
  let disposed = false;

  function showStatus(message: string, error = false): void {
    status.replaceChildren(error ? createInlineError({ message }) : message);
    status.classList.toggle("error", error);
    status.classList.toggle("nodrag", error);
    status.hidden = message === "";
  }

  function post(message: unknown): void {
    frame?.contentWindow?.postMessage(message, "*");
  }

  // Only this frame's own messages: every Applet frame on the page posts to
  // the same window, and an opaque origin can't be told apart by origin.
  function onMessage(event: MessageEvent): void {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { source?: string; type?: string; height?: unknown; value?: unknown; outputs?: unknown };
    if (data?.source !== "pragma-applet") return;
    if (data.type === "resize") {
      if (deps.fillsTile || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
      frame.style.height = `${Math.max(40, Math.round(data.height))}px`;
    } else if (data.type === "state") {
      const result = appletStateFrom(data.value);
      if ("error" in result) {
        showStatus(result.error, true);
        return;
      }
      node.config.state = result.state;
      deps.persist();
    } else if (data.type === "outputs") {
      const result = appletOutputsFrom(ports, data.outputs);
      if ("error" in result) {
        showStatus(result.error, true);
        return;
      }
      const saved = (node.config.outputs ?? {}) as Record<string, PortValue>;
      node.config.outputs = { ...saved, ...result.outputs };
      showStatus("");
      deps.persist();
    }
  }
  window.addEventListener("message", onMessage);

  async function load(path: string): Promise<void> {
    showStatus("Loading…");
    let file: FileResponse;
    try {
      file = await deps.loadFile(path);
    } catch (error) {
      showStatus(`Couldn't open ${path}: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    if (disposed) return;
    if (file.kind !== "applet") {
      showStatus(`${path} isn't an Applet`, true);
      return;
    }
    const problem = file.importError ?? appletNodeProblem(file.manifest);
    if (problem) {
      showStatus(problem, true);
      return;
    }
    ports = file.manifest.ports ?? NO_PORTS;
    deps.onLoaded?.(file);

    // Every drag and wheel over the live frame is the Applet's, at any zoom,
    // never the canvas's: an Applet may orbit or zoom on them, as a 3D stage
    // does. Nothing may cover the frame or turn its pointer events off for the
    // canvas's sake.
    frame = document.createElement("iframe");
    frame.className = "flow-applet-frame";
    frame.title = file.manifest.meta?.name ?? "Applet";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.addEventListener("load", () => {
      if (lastInputs) post({ source: "pragma-host", type: "inputs", inputs: lastInputs });
    });
    frame.srcdoc = deps.injectRuntime(file.html, file.manifest, file.imports, node.config.state);
    showStatus("");
    el.appendChild(frame);
  }

  const path = typeof node.config.appletPath === "string" ? node.config.appletPath : "";
  if (path) void load(path);
  else showStatus("");

  return {
    el,
    deliverInputs(inputs) {
      lastInputs = inputs;
      post({ source: "pragma-host", type: "inputs", inputs });
    },
    dispose() {
      disposed = true;
      window.removeEventListener("message", onMessage);
      el.remove();
    },
  };
}
