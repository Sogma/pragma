import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadGlobalConfig } from "../../config/loadConfig.ts";
import type { PortValue } from "../../protocol/flowExecutors.ts";
import { isFlowFile } from "../../protocol/types.ts";
import { DEFAULT_RUN_TIMEOUT_MS, type FlowRunOutcome, runFlowHeadless } from "../../server/flowRun.ts";
import { escapesRoot } from "../../server/rootedFiles.ts";
import { moveLibraries } from "../hostSpace.ts";

interface RunOptions {
  space?: string;
  all?: boolean;
  json?: boolean;
  timeout?: string;
}

// A PortValue rendered for a terminal. Image and object values are described
// rather than dumped: a base64 payload on stdout helps nobody, and a reader
// who wants the real value has --json.
function formatValue(value: PortValue): string {
  switch (value.type) {
    case "text":
      return value.value;
    case "number":
      return String(value.value);
    case "boolean":
      return String(value.value);
    case "image":
      return `<${value.mediaType}, ${Math.ceil((value.data.length * 3) / 4)} bytes>`;
    case "video":
      return value.path;
    default:
      return JSON.stringify(value.value);
  }
}

// By default stdout carries the flow's *results* and nothing else — one value
// per line, so a single-output graph is a bare scalar you can redirect or
// pipe. Which values is the flow's own declaration: the output ports marked
// Expose, the same ones App mode publishes, so a flow exposing none prints
// none. `--all` is the debug view; `--json` carries the structure.
function printOutcome(outcome: FlowRunOutcome, all: boolean): void {
  if (all) {
    // The debug view: every node, labelled, because an unlabelled dump of a
    // whole graph says nothing.
    for (const entry of outcome.outputs) {
      const values = Object.entries(entry.values);
      if (values.length === 0) continue;
      console.log(`${entry.nodeType} (${entry.nodeId})`);
      for (const [port, value] of values) console.log(`  ${port}: ${formatValue(value)}`);
    }
  } else {
    for (const { value } of outcome.results) console.log(formatValue(value));
    // Silence with no explanation reads as a broken command. The hint goes to
    // stderr so a redirected or piped stdout still holds results only, and the
    // exit code stays 0 — producing nothing is not a failure.
    if (outcome.results.length === 0 && outcome.errors.length === 0) {
      console.error("This flow exposes no output ports. Use --all to see every node, or right-click a port → Expose.");
    }
  }

  // Failures go to stderr, so a redirected stdout holds results only.
  for (const { nodeId, message } of outcome.errors) console.error(`error: ${nodeId}: ${message}`);
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <flow>")
    .description("Run a .flow.html graph without opening the editor")
    .option("--space <path>", "space the flow belongs to (default: the configured space)")
    .option("--all", "print every node's output, labelled, instead of just the results")
    .option("--json", "print the whole run as JSON")
    .option("--timeout <seconds>", "stop the run after this long", String(DEFAULT_RUN_TIMEOUT_MS / 1000))
    .action(async (flow: string, options: RunOptions) => {
      const spaceRoot = path.resolve(options.space ?? loadGlobalConfig().spacePath ?? ".");
      if (!existsSync(spaceRoot) || !statSync(spaceRoot).isDirectory()) {
        console.error(`${spaceRoot} is not a directory.`);
        process.exitCode = 1;
        return;
      }

      // Accepts either a space-relative path or one the shell completed to an
      // absolute or ./-prefixed path, since both are natural to type.
      const absolute = path.resolve(spaceRoot, flow);
      const relative = path.relative(spaceRoot, absolute);
      if (escapesRoot(relative)) {
        console.error(`${flow} is not inside ${spaceRoot}.`);
        process.exitCode = 1;
        return;
      }
      const flowPath = relative.split(path.sep).join("/");
      if (!isFlowFile(flowPath)) {
        console.error(`${flow} is not a .flow.html document.`);
        process.exitCode = 1;
        return;
      }

      const timeoutSeconds = Number(options.timeout);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        console.error(`--timeout must be a positive number of seconds, not "${options.timeout}".`);
        process.exitCode = 1;
        return;
      }

      await moveLibraries();
      let outcome: FlowRunOutcome;
      try {
        outcome = await runFlowHeadless(spaceRoot, flowPath, { timeoutMs: timeoutSeconds * 1000 });
      } catch (error) {
        // A whole-run failure: an unreadable or malformed flow, or a path
        // that escaped the space. Per-node failures are reported below
        // instead, since the rest of the graph still ran.
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }

      if (options.json) console.log(JSON.stringify(outcome, null, 2));
      else printOutcome(outcome, options.all === true);

      // A graph that failed a node did not do what was asked, so the exit
      // code says so even though the other nodes ran.
      if (outcome.errors.length > 0) process.exitCode = 1;
    });
}
