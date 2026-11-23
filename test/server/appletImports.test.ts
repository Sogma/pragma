import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readAppletFile } from "../../src/protocol/appletFile.ts";
import type { AppletManifest } from "../../src/protocol/types.ts";
import { readAppletImports } from "../../src/server/appletImports.ts";
import { tempDir } from "../support/isolation.ts";

let space: string;

beforeEach(() => {
  space = tempDir("pragma-applet-imports-");
  mkdirSync(path.join(space, "lib"));
  mkdirSync(path.join(space, "studio"));
  writeFileSync(path.join(space, "lib", "three.module.js"), "export const REVISION = '186';");
  writeFileSync(path.join(space, "studio", "helpers.mjs"), "export const near = true;");
  writeFileSync(path.join(space, "studio", "notes.md"), "# Not code");
  writeFileSync(path.join(space, "lib", "figure.glb"), MODEL_BYTES);
});

const MODEL_BYTES = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0xff, 0x00, 0x80]);

const manifest = (imports: Record<string, string>) =>
  ({
    version: "1.0",
    imports: Object.entries(imports).map(([specifier, path]) => ({ specifier, path })),
  }) satisfies AppletManifest;

describe("readAppletImports", () => {
  it("reads each import in manifest order, an address by its root and anything else from the Applet's folder", async () => {
    const result = await readAppletImports(
      space,
      "studio",
      manifest({ three: "space:lib/three.module.js", helpers: "helpers.mjs", again: "../lib/three.module.js" }),
    );
    expect(result).toEqual({
      imports: [
        { specifier: "three", path: "lib/three.module.js", source: "export const REVISION = '186';" },
        { specifier: "helpers", path: "studio/helpers.mjs", source: "export const near = true;" },
        { specifier: "again", path: "lib/three.module.js", source: "export const REVISION = '186';" },
      ],
    });
  });

  // A path with a `/` is a folder beside the Applet, as in a Markdown link.
  it("reads a path with a / from the Applet's folder, never from the space root", async () => {
    const result = await readAppletImports(space, "studio", manifest({ three: "lib/three.module.js" }));
    expect(result.error).toBe('Import "three" (lib/three.module.js) isn\'t there.');
  });

  it("reads a .glb as a module whose default export is the file's bytes", async () => {
    const result = await readAppletImports(space, "studio", manifest({ figure: "space:lib/figure.glb" }));
    expect(result.error).toBeUndefined();
    const [model] = result.imports;
    expect(model?.path).toBe("lib/figure.glb");
    const module = await import(`data:text/javascript;base64,${Buffer.from(model?.source ?? "").toString("base64")}`);
    expect(module.default).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(module.default)).toEqual(MODEL_BYTES);
  });

  it("reads nothing when the manifest declares no imports", async () => {
    expect(await readAppletImports(space, "studio", manifest({}))).toEqual({ imports: [] });
  });

  // An Applet in a folder has no other way to import a file at the space
  // root: there, a bare name is the file beside it.
  it("reads a space: import from the space root, wherever the Applet sits", async () => {
    writeFileSync(path.join(space, "shared.js"), "export const shared = true;");
    const result = await readAppletImports(space, "studio", manifest({ shared: "space:shared.js" }));
    expect(result).toEqual({
      imports: [{ specifier: "shared", path: "shared.js", source: "export const shared = true;" }],
    });
    const error = async (importPath: string) =>
      (await readAppletImports(space, "studio", manifest({ x: importPath }))).error;
    expect(await error("space:../outside.js")).toMatch(
      /^Import "x" \(space:\.\.\/outside\.js\) isn't a path Pragma can read: /,
    );
  });

  it("refuses anything but a space .js, .mjs or .glb file, naming the import and why", async () => {
    const error = async (importPath: string) =>
      (await readAppletImports(space, "studio", manifest({ x: importPath }))).error;
    expect(await error("notes.md")).toBe('Import "x" (notes.md) must be a .js, .mjs or .glb file.');
    expect(await error("figure.gltf")).toBe('Import "x" (figure.gltf) must be a .js, .mjs or .glb file.');
    expect(await error("lib:shared/three.js")).toBe('Import "x" (lib:shared/three.js) must be a file in the space.');
    expect(await error("missing.js")).toBe('Import "x" (missing.js) isn\'t there.');
    // A `..` past the root names nothing, as a link's does.
    expect(await error("../../outside.js")).toBe(
      'Import "x" (../../outside.js) isn\'t a path Pragma can read: "../../outside.js" climbs above its root.',
    );
  });

  it("refuses an import reached through a symbolic link", async () => {
    symlinkSync(path.join(space, "lib", "three.module.js"), path.join(space, "studio", "linked.js"));
    const result = await readAppletImports(space, "studio", manifest({ three: "linked.js" }));
    expect(result.imports).toEqual([]);
    expect(result.error).toMatch(/^Import "three" \(linked\.js\) can't be read: /);
  });

  it("is read from the manifest's imports object, in its own order", async () => {
    const file = path.join(space, "studio", "stage.applet.html");
    writeFileSync(
      file,
      `<script type="application/json" data-role="manifest">${JSON.stringify({
        imports: { three: "lib/three.module.js", "": "ignored.js", bad: 3, helpers: "helpers.mjs" },
      })}</script>`,
    );
    expect((await readAppletFile(file)).manifest.imports).toEqual([
      { specifier: "three", path: "lib/three.module.js" },
      { specifier: "helpers", path: "helpers.mjs" },
    ]);
  });

  it("marks a manifest that still lists capabilities, which no Applet has", async () => {
    const file = path.join(space, "studio", "old.applet.html");
    const write = (capabilities: unknown) =>
      writeFileSync(
        file,
        `<script type="application/json" data-role="manifest">${JSON.stringify({ capabilities })}</script>`,
      );
    write([{ type: "generate" }]);
    expect((await readAppletFile(file)).manifest.declaresCapabilities).toBe(true);
    write([]);
    expect((await readAppletFile(file)).manifest.declaresCapabilities).toBeUndefined();
  });
});
