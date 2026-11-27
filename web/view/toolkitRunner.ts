// The toolkit runner: runs a Flow toolkit's buttons (flow/toolkitAction.ts),
// each click a run of its own beside any other going. The document and live
// editor are bound at the click, never read from the active tab, so a
// mid-run tab switch can't retarget a run; its grant prompts are top-level,
// over whatever pane is active.
//
// Each run asks through a broker of its own: a broker denies a prompt whose
// subject moved on, so runs sharing one would deny each other's.
import type { FileResponse } from "../core/apiClient.ts";
import {
  runToolkitAction,
  type ToolkitActionDeps,
  type ToolkitInvocation,
  type ToolkitRow,
  type ToolkitRun,
} from "../flow/toolkitAction.ts";
import { type CapabilityBrokerDeps, createCapabilityBroker } from "../services/capabilityBroker.ts";

export interface ToolkitRunnerDeps extends CapabilityBrokerDeps {
  // The Flow's graph, read fresh at each click.
  loadFile(path: string): Promise<FileResponse>;
  modelConsole: ToolkitActionDeps["modelConsole"];
  notices: ToolkitActionDeps["notices"];
}

/** One click's run. */
export interface StartedToolkitRun {
  // What it shows once it ends; rejects naming the node that failed and why.
  readonly done: Promise<ToolkitRun>;
  // Stops it, failing `done` with `reason`.
  stop(reason: string): void;
}

export interface ToolkitRunner {
  start(invocation: ToolkitInvocation, actionId: string, row?: ToolkitRow): StartedToolkitRun;
  dispose(): void;
}

export function createToolkitRunner(deps: ToolkitRunnerDeps): ToolkitRunner {
  const going = new Set<(reason: string) => void>();

  return {
    start(invocation, actionId, row) {
      const broker = createCapabilityBroker(deps);
      const controller = new AbortController();
      const stop = (reason: string) => {
        if (controller.signal.aborted) return;
        controller.abort(new Error(reason));
        broker.unmount(); // closes a grant prompt the run is waiting on
      };
      going.add(stop);
      const done = runToolkitAction(invocation, actionId, { broker, ...deps }, controller.signal, row).finally(() => {
        going.delete(stop);
        broker.dispose();
      });
      return { done, stop };
    },
    dispose() {
      for (const stop of [...going]) stop("The toolkit runner was disposed");
    },
  };
}
