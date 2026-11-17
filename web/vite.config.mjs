import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { writeThirdPartyNotices } from "../scripts/third-party-notices.ts";

// Records when a build started and every file it read, for the freshness
// check in src/server/builtApp.ts. The module graph alone misses files the
// build copies rather than imports (public/, CSS url() assets), so every file
// under web/ is listed too.
function recordBuildInputs() {
  let root = "";
  let builtAt = 0;
  return {
    name: "pragma-build-inputs",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      builtAt = Date.now();
    },
    writeBundle() {
      const appRoot = path.dirname(root);
      const modules = [...this.getModuleIds()].map((id) => id.split("?")[0]).filter((id) => path.isAbsolute(id));
      const webFiles = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      const inputs = [...new Set([...modules, ...webFiles].map((file) => path.relative(appRoot, file)))].sort();
      writeFileSync(path.join(appRoot, "dist/web-inputs.json"), `${JSON.stringify({ builtAt, inputs }, null, 2)}\n`);
    },
  };
}

// A worker is bundled on its own, without the page's plugins, so its modules
// are gathered here for the notices; every worker finishes before the page
// is written.
const workerModuleIds = new Set();
function gatherWorkerModules() {
  return {
    name: "pragma-worker-modules",
    buildEnd() {
      for (const id of this.getModuleIds()) workerModuleIds.add(id);
    },
  };
}

// Writes third-party-notices.txt into the build, which both the desktop app
// and the npm package ship, and fails the build on a licence a GPL program
// can't carry. Only this build knows which packages the bundle took in.
function thirdPartyNotices() {
  let root = "";
  return {
    name: "pragma-third-party-notices",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    writeBundle(options) {
      const outFile = path.join(options.dir ?? path.dirname(options.file ?? ""), "third-party-notices.txt");
      writeThirdPartyNotices(path.dirname(root), [...this.getModuleIds(), ...workerModuleIds], outFile);
    },
  };
}

// Auto-discovered by both `vite build web` and the editor server's
// programmatic Vite instance (src/server/createServer.ts), each merging it
// with inline options — the one place a setting covers dev and the build.
//
// Deliberately .mjs, not .ts: Vite bundles a TS config into a temp file it
// imports then deletes, and Node's --watch (the VS Code debug launch) treats
// the deletion as a change and restarts — an infinite restart loop.
export default defineConfig({
  plugins: [recordBuildInputs(), thirdPartyNotices()],
  worker: { plugins: () => [gatherWorkerModules()] },
  // MathJax's HTML output imports its default font, New Computer Modern, by
  // this name whatever font it is given; math here is in the TeX font
  // (web/mathJax.ts), so the default is that one and the 3 MB font stays out.
  resolve: {
    alias: [{ find: /^#default-font\//, replacement: "@mathjax/mathjax-tex-font/js/" }],
  },
  css: {
    transformer: "lightningcss",
  },
  build: {
    // The editor, and the desktop app's first-run and About windows, which
    // load from the build: no server runs before a space exists.
    rolldownOptions: {
      input: {
        main: path.join(import.meta.dirname, "index.html"),
        welcome: path.join(import.meta.dirname, "welcome.html"),
        about: path.join(import.meta.dirname, "about.html"),
      },
    },
    cssMinify: "lightningcss",
    // PDF.js's data files are fetched by URL only when a document needs
    // one (web/services/pdfRuntime.ts), and MathJax's fonts only when math
    // uses a face; inlined, the small ones would land as base64 in the main
    // bundle instead.
    assetsInlineLimit: (filePath) =>
      filePath.includes("/pdfjs-dist/") || filePath.includes("/@mathjax/") ? false : undefined,
  },
});
