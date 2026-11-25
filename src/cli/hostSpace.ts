import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  loadGlobalConfig,
  type PragmaGlobalConfig,
  rememberKnownSpace,
  rememberSpace,
  resolveOpenableSpace,
  saveGlobalConfig,
} from "../config/loadConfig.ts";
import { type AgentEndpoint, createAgentEndpoint } from "../server/apiServer.ts";
import type { ServedSpace } from "../server/servedSpace.ts";
import { moveLibrariesOntoSpaces } from "../server/spaceLibraries.ts";
import { askForSpace, isInteractive } from "./askForSpace.ts";

// One default port for `pragma dev` and `pragma start`, so the two share a
// browser origin and, with it, every localStorage setting.
//
// Clear of Vite's 5173 and the ports it falls back to, where other projects'
// dev servers run: on a shared port pragma fails to start, and on a shared
// origin whatever another app left there reaches the space with no login.
export const EDITOR_PORT = 14319;

export const NO_SPACES_YET =
  "No spaces yet. Make one with pragma init <folder>, or add one with pragma space add <folder>.";

/** The space a CLI host serves, resolved, checked and registered; undefined
 * after saying why on stderr. `remote` is `pragma start --external-url`,
 * which serves other machines unattended. */
export async function openHostSpace(
  config: PragmaGlobalConfig,
  spacePathArg: string | undefined,
  remote: boolean,
): Promise<string | undefined> {
  // A path typed on the command line is never second-guessed, and neither
  // is --external-url's configured one: that target serves other machines
  // unattended, so quietly serving a *different* space would hand every
  // device somebody else's documents. Only a local host falls through to
  // another registered space when the configured one has gone.
  const requested = spacePathArg ?? (remote ? config.spacePath : undefined);
  const spacePath = requested ?? resolveOpenableSpace(config);

  let target: string;
  let current = config;
  if (spacePath) {
    target = path.resolve(spacePath);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      console.error(`${target} is not a directory.`);
      process.exitCode = 1;
      return undefined;
    }
    if (!requested && config.spacePath && path.resolve(config.spacePath) !== target) {
      console.warn(`Configured space ${path.resolve(config.spacePath)} is not there. Opening ${target} instead.`);
    }
  } else if (!remote && isInteractive()) {
    const answer = await askForSpace();
    if (!answer) {
      process.exitCode = 1;
      return undefined;
    }
    target = answer;
    // Read again: the answer is saved, and the copy read before the
    // questions would write over it.
    current = loadGlobalConfig();
  } else {
    console.error(noSpaceMessage(config));
    process.exitCode = 1;
    return undefined;
  }

  // Before any host starts: grants are keyed by space id, so a served space
  // missing from the registry is silently ungrantable.
  //
  // Only a local host, whose human typed the path, may *create* the entry.
  // --external-url runs unattended, where minting would let a moved space
  // come back as a new one with its approvals and tokens detached, so it
  // refuses on a miss. See docs/architecture.md's Space identity and state
  // ownership section.
  if (!remote) {
    saveGlobalConfig(rememberSpace(current, target));
    return target;
  }
  const registered = rememberKnownSpace(current, target);
  if (!registered) {
    console.error(
      `${target} is not a registered space.\n\n` +
        "--external-url never registers one itself: a space's id is what its capability approvals and " +
        "API tokens are keyed to, so adopting a path automatically would turn a moved space into a new " +
        "one. Add it to your spaces yourself:\n\n" +
        `    pragma space add ${JSON.stringify(target)}\n\n` +
        "If this space moved, point its existing entry at the new folder instead, which keeps its " +
        "approvals (pragma space list shows the ids):\n\n" +
        `    pragma space locate <id> ${JSON.stringify(target)}\n\n` +
        "See docs/deployment.md.",
    );
    process.exitCode = 1;
    return undefined;
  }
  saveGlobalConfig(registered);
  return target;
}

function noSpaceMessage(config: PragmaGlobalConfig): string {
  if (Object.keys(config.spaces ?? {}).length === 0) return NO_SPACES_YET;
  return (
    "None of your spaces' folders was found. If one moved, point it at its new folder with " +
    "pragma space locate <id> <folder> (pragma space list shows the ids). Or make one with " +
    "pragma init <folder>, or add one with pragma space add <folder>."
  );
}

/** The agent endpoint every CLI host runs: its own listener on its own
 * loopback port, only while the API is switched on (docs/agent-api.md,
 * Posture). It reads the served space on every request, so a switch moves it
 * with the routes. The controller outlives any single listener so Settings
 * can switch it on and off without restarting pragma. */
export async function openAgentEndpoint(served: ServedSpace): Promise<AgentEndpoint> {
  const agentEndpoint = createAgentEndpoint(served.root);
  await agentEndpoint.apply().catch((error: unknown) => {
    console.error(`API endpoint failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
  const agentPort = agentEndpoint.port();
  if (agentPort) console.log(`MCP endpoint at http://127.0.0.1:${agentPort}/mcp`);
  return agentEndpoint;
}

/** Moves an install-wide list of libraries in config.json onto the spaces
 * that name them, before a host serves one. A failure is said on stderr and
 * leaves the list for the next start. */
export async function moveLibraries(): Promise<void> {
  await moveLibrariesOntoSpaces().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
  });
}
