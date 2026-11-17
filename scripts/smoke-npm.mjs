// Installs the npm package's tarball under a scratch prefix and runs it as a
// user would: --version, init, then start, the app and a route. Everything it
// writes, Pragma's config included, stays in a temporary folder.
//
//   node scripts/smoke-npm.mjs dist/sogma-pragma-<version>.tgz

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const NAME = "@sogma/pragma";
const windows = process.platform === "win32";

// Read only through the agent API and chat, so checked for presence; they
// are found from the same root as the files the steps below read.
const READ_LATER = ["docs/protocol.md", "docs/flow-nodes.md", "src/server/modelSupport.json"];

const [tarballArg] = process.argv.slice(2);
if (!tarballArg) {
  console.error("usage: node scripts/smoke-npm.mjs <tarball>");
  process.exit(1);
}
const tarball = path.resolve(tarballArg);

const scratch = mkdtempSync(path.join(tmpdir(), "pragma-npm-smoke-"));
const prefix = path.join(scratch, "prefix");
const space = path.join(scratch, "space");
const env = { ...process.env, PRAGMA_CONFIG_DIR: path.join(scratch, "config") };

function npm(args) {
  return execFileSync("npm", args, { encoding: "utf8", shell: windows }).trim();
}

// Through the command npm installed for the package's `bin`.
function pragma(args) {
  const bin = windows ? path.join(prefix, "pragma.cmd") : path.join(prefix, "bin", "pragma");
  return execFileSync(bin, args, { encoding: "utf8", shell: windows, env }).trim();
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The response once the server answers, or undefined once it has exited or
// a minute has passed.
async function firstResponse(url, exited) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && !exited(); await sleep(250)) {
    try {
      return await fetch(url);
    } catch {
      // Not listening yet.
    }
  }
  return undefined;
}

let server;
let serverOutput = "";
try {
  npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarball]);
  const installed = path.join(npm(["root", "--global", "--prefix", prefix]), ...NAME.split("/"));
  const { version } = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));

  const printed = pragma(["--version"]);
  check(printed === version, `pragma --version printed "${printed}", not ${version}.`);

  pragma(["init", space]);
  check(
    existsSync(path.join(space, "README.md")) && existsSync(path.join(space, "projects")),
    "pragma init made a space without the template space's files.",
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const entry = path.join(installed, "dist", "cli", "pragma.mjs");
  server = spawn(process.execPath, [entry, "start", space, "--port", String(port)], { env });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });

  const page = await firstResponse(`${base}/`, () => server.exitCode !== null);
  check(page?.ok, `pragma start didn't serve the app (${page ? page.status : "no answer"}).`);
  check(/<!doctype html>/i.test(await page.text()), "pragma start served something other than the app's page.");

  const templates = await fetch(`${base}/api/templates`);
  check(templates.ok, `GET /api/templates answered ${templates.status}.`);
  check((await templates.json()).templates.length > 0, "GET /api/templates listed none of Pragma's own templates.");

  for (const file of READ_LATER) check(existsSync(path.join(installed, file)), `The package has no ${file}.`);

  console.log(`${NAME}@${version} installs, reports its version, makes a space, serves the app and its routes.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (serverOutput) console.error(`pragma start printed:\n${serverOutput}`);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  rmSync(scratch, { recursive: true, force: true });
}
