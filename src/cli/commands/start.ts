import type { Command } from "commander";
import { remoteAccessPassphrase, setCredentialHost } from "../../config/credentials.ts";
import { loadGlobalConfig } from "../../config/loadConfig.ts";
import { type AuthCheck, alwaysAuthorized } from "../../server/auth.ts";
import { BUILT_APP, builtAppProblem } from "../../server/builtApp.ts";
import { resumeJobs } from "../../server/jobRunner.ts";
import { createPassphraseAuth } from "../../server/passphraseAuth.ts";
import { createProductionServer } from "../../server/productionServer.ts";
import { parseExternalUrl } from "../../server/remoteAccess.ts";
import { createServedSpace } from "../../server/servedSpace.ts";
import { EDITOR_PORT, moveLibraries, openAgentEndpoint, openHostSpace } from "../hostSpace.ts";

interface StartOptions {
  externalUrl?: string;
  port: string;
}

export function registerStartCommand(program: Command): void {
  program
    .command("start [spacePath]")
    .description("Start the Pragma editor for a space directory (defaults to the configured spacePath)")
    .option(
      "--external-url <url>",
      "serve other devices through an HTTPS proxy at this https:// address, behind a passphrase (see docs/deployment.md)",
    )
    .option("--port <port>", "port to listen on, on 127.0.0.1", String(EDITOR_PORT))
    .action(async (spacePathArg: string | undefined, options: StartOptions) => {
      let externalUrl: URL | undefined;
      if (options.externalUrl !== undefined) {
        const parsed = parseExternalUrl(options.externalUrl);
        if (typeof parsed === "string") {
          console.error(`--external-url ${options.externalUrl} ${parsed}.`);
          process.exitCode = 1;
          return;
        }
        externalUrl = parsed;
      }
      const remote = externalUrl !== undefined;
      setCredentialHost(remote ? "remote" : "local");
      const config = loadGlobalConfig();

      // No "the proxy restricts access already" exception: Pragma can't tell
      // a tailnet-only proxy from one a misconfiguration made public, so the
      // passphrase is required whatever stands in front.
      let auth: AuthCheck = alwaysAuthorized;
      if (remote) {
        const saved = await remoteAccessPassphrase();
        if (!saved.ok) {
          console.error(
            `--external-url refuses to start without a remote-access passphrase. ${saved.problem} Save one with \`pragma passphrase\`.`,
          );
          process.exitCode = 1;
          return;
        }
        auth = createPassphraseAuth(saved);
      }

      const buildProblem = builtAppProblem();
      if (buildProblem) {
        console.error(`${buildProblem} Run "npm run build" first.`);
        process.exitCode = 1;
        return;
      }

      const target = openHostSpace(config, spacePathArg, remote);
      if (!target) return;
      await moveLibraries();
      const served = createServedSpace(target);
      const agentEndpoint = await openAgentEndpoint(served);

      const production = createProductionServer({
        port: Number(options.port),
        served,
        staticRoot: BUILT_APP,
        agentEndpoint,
        // The remote-access target serves other devices under a service
        // account; without it the only client is a browser on the writer's
        // own machine (see RouteContext.ownMachine, routes/shared.ts).
        ownMachine: !remote,
        auth,
        externalUrl,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          production.server.once("listening", resolve);
          production.server.once("error", reject);
        });
      } catch (error) {
        console.error(
          `Cannot listen on 127.0.0.1:${options.port}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
      resumeJobs();
      if (externalUrl) {
        console.log(
          `Serving ${target} at ${externalUrl.origin}/ (your HTTPS proxy forwards it to http://127.0.0.1:${options.port}/)`,
        );
        return;
      }
      // `localhost`, as `pragma dev` prints, rather than the 127.0.0.1 bound:
      // they are different origins, and sharing one is what carries
      // localStorage settings between the two.
      console.log(`Serving ${target} at http://localhost:${options.port}/`);
    });
}
