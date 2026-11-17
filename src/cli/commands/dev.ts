import type { Command } from "commander";
import { setCredentialHost } from "../../config/credentials.ts";
import { loadGlobalConfig } from "../../config/loadConfig.ts";
import { isSourceCheckout } from "../../server/builtApp.ts";
import { resumeJobs } from "../../server/jobRunner.ts";
import { createServedSpace } from "../../server/servedSpace.ts";
import { EDITOR_PORT, moveLibraries, openAgentEndpoint, openHostSpace } from "../hostSpace.ts";

interface DevOptions {
  port: string;
}

export function registerDevCommand(program: Command): void {
  program
    .command("dev [spacePath]")
    .description("Start the editor from source, with hot reload, for working on Pragma itself")
    .option("--port <port>", "port to listen on; each port keeps its own browser settings", String(EDITOR_PORT))
    .action(async (spacePathArg: string | undefined, options: DevOptions) => {
      if (!isSourceCheckout()) {
        console.error("pragma dev runs only from a clone of Pragma's source. To open a space, run pragma start.");
        process.exitCode = 1;
        return;
      }
      setCredentialHost("local");
      const target = openHostSpace(loadGlobalConfig(), spacePathArg, false);
      if (!target) return;
      await moveLibraries();
      const served = createServedSpace(target);
      const agentEndpoint = await openAgentEndpoint(served);

      // Loaded here, not imported at the top: Vite is a dev dependency, and
      // every other command must run without it installed.
      const { createEditorServer } = await import("../../server/createServer.ts");
      const server = await createEditorServer(served, { agentEndpoint, port: Number(options.port) });
      await server.listen();
      server.printUrls();
      resumeJobs();
    });
}
