import { readFile } from "node:fs/promises";
import type { AppletImportSource } from "../protocol/api.ts";
import { resolveDeclaredPath } from "../protocol/relativeReference.ts";
import { isLibraryRoot } from "../protocol/rootedPath.ts";
import type { AppletManifest } from "../protocol/types.ts";
import { resolveHeldPath } from "./rootedFiles.ts";

const MODULE_FILE = /\.m?js$/i;
// glTF's one-file form: a .gltf names its buffers and textures by relative
// URI, which the frame has no location to resolve against.
const MODEL_FILE = /\.glb$/i;

/** The imports an Applet's manifest names, read for its frame, or why one
 * can't be: an Applet never runs on part of its code.
 *
 * Space `.js`, `.mjs` and `.glb` files only. An import needs no grant, so it
 * must never read a document into the frame, nor a library's file, which
 * reaches a Flow only under a `readFile` grant. */
export async function readAppletImports(
  spaceRoot: string,
  appletDir: string,
  manifest: AppletManifest,
): Promise<{ imports: AppletImportSource[]; error?: string }> {
  const declared = manifest.imports ?? [];
  if (declared.length === 0) return { imports: [] };
  const imports: AppletImportSource[] = [];
  for (const { specifier, path: declaredPath } of declared) {
    const refuse = (why: string) => ({ imports: [], error: `Import "${specifier}" (${declaredPath}) ${why}.` });
    let relativePath: string;
    try {
      const rooted = resolveDeclaredPath(appletDir, declaredPath);
      if (isLibraryRoot(rooted.root)) return refuse("must be a file in the space");
      relativePath = rooted.path;
    } catch (error) {
      return refuse(`isn't a path Pragma can read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const isModel = MODEL_FILE.test(relativePath);
    if (!isModel && !MODULE_FILE.test(relativePath)) return refuse("must be a .js, .mjs or .glb file");
    try {
      const { filePath, rooted } = resolveHeldPath(spaceRoot, relativePath, "read");
      const source = isModel ? bytesModule(await readFile(filePath)) : await readFile(filePath, "utf8");
      imports.push({ specifier, path: rooted.path, source });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return refuse("isn't there");
      return refuse(`can't be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imports };
}

// A model imports as a module whose default export is its bytes, an
// ArrayBuffer: what a glTF loader parses. Its source carries those bytes, so
// the Applet's content hash covers the model too.
function bytesModule(bytes: Buffer): string {
  return [
    `const binary = atob("${bytes.toString("base64")}");`,
    "const bytes = new Uint8Array(binary.length);",
    "for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);",
    "export default bytes.buffer;",
  ].join("\n");
}
