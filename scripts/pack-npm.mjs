// Builds the npm package into dist/npm/ and packs it as
// dist/sogma-pragma-<version>.tgz: the command line bundled with its
// dependencies, the built app and the files the engine reads at run time.
//
// The package gets a manifest of its own, so the repo's package.json stays
// the desktop app's: Electron names its data folder after `name`, and
// electron-builder packs `dependencies` into the app.
//
//   npm run build && npm run pack:npm

import { execFileSync } from "node:child_process";
import { cpSync, globSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { builtAppProblem } from "../src/server/builtApp.ts";

const NAME = "@sogma/pragma";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "npm");

// What the engine reads at run time, at its path from the package root;
// electron-builder.yml's `files` ships the same in the desktop app. Then the
// readme and the licence files.
const SHIPPED = [
  "dist/web",
  "templates/space",
  "templates/builtin",
  "docs/protocol.md",
  "docs/flow-nodes.md",
  "src/server/modelSupport.json",
  "README.md",
  "LICENSE",
  "COPYRIGHT",
];

const problem = builtAppProblem(root);
if (problem) {
  console.error(`${problem} Run "npm run build" first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "bin", "pragma.ts")],
  outdir: path.join(out, "dist", "cli"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  // Vite stays out: only `pragma dev` loads it, from a clone. In a single
  // file its import would run first and fail every command, so splitting
  // keeps it in the dev server's own chunk.
  external: ["vite"],
  splitting: true,
  // Bundled CommonJS dependencies call require() for Node's own modules,
  // which an ES module doesn't define.
  banner: { js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' },
  logLevel: "warning",
});

for (const file of SHIPPED) cpSync(path.join(root, file), path.join(out, file), { recursive: true });

const packageJson = {
  name: NAME,
  version: manifest.version,
  description: manifest.description,
  author: manifest.author,
  license: manifest.license,
  repository: manifest.repository,
  homepage: manifest.homepage,
  bugs: manifest.bugs,
  type: "module",
  bin: { pragma: "dist/cli/pragma.mjs" },
  engines: manifest.engines,
  files: [...new Set(["dist", ...SHIPPED.map((file) => file.split("/")[0])])],
  publishConfig: { access: "public" },
};
writeFileSync(path.join(out, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

for (const old of globSync("dist/sogma-pragma-*.tgz", { cwd: root })) rmSync(path.join(root, old));
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", out, "--pack-destination", path.join(root, "dist"), "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }),
);
const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
console.log(
  `dist/${packed.filename}: ${packed.entryCount} files, ${megabytes(packed.size)} packed, ${megabytes(packed.unpackedSize)} unpacked`,
);
