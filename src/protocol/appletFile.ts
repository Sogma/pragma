import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "node-html-parser";
import type { AppletImport, AppletManifest, AppletPorts, FlowPort, FlowPortType, ManifestInfo } from "./types.ts";

function emptyManifest(): AppletManifest {
  return { version: "1.0" };
}

export interface ParsedAppletFile {
  manifest: AppletManifest;
  // The full raw file text — script tags and all. This is what becomes the
  // sandboxed iframe's srcdoc; parsing it here (node-html-parser) never
  // executes it, only reads the inert manifest block out of it.
  html: string;
}

// Loose-validate-don't-throw treatment: a `meta` block with the wrong shape
// (or absent) just means no header renders, not an error.
function readManifestInfo(value: unknown): ManifestInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ManifestInfo>;
  return {
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    version: typeof candidate.version === "string" ? candidate.version : undefined,
    description: typeof candidate.description === "string" ? candidate.description : undefined,
  };
}

// The manifest's `imports` object, specifier → path, in its own order.
// Whether a path names a file an import may come from is the reader's call at
// open (src/server/appletImports.ts), where a refusal can say why.
function readImports(value: unknown): AppletImport[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const imports = Object.entries(value)
    .filter((entry): entry is [string, string] => entry[0] !== "" && typeof entry[1] === "string")
    .map(([specifier, path]) => ({ specifier, path }));
  return imports.length > 0 ? imports : undefined;
}

const PORT_TYPES: readonly FlowPortType[] = ["text", "image", "boolean", "object", "number"];

// A port with no usable id or type is dropped, as is a repeated id. An input
// is optional: an Applet that shows its inputs has nothing to show without
// one, which is not a failure.
//
// A pin is named by its id, as a built-in's is: a manifest's `label` is
// ignored, so a pin never has one name on the canvas and another on the wire.
function readPortList(value: unknown, direction: "inputs" | "outputs"): FlowPort[] {
  if (!Array.isArray(value)) return [];
  const ports: FlowPort[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, type, description } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || ports.some((port) => port.id === id)) continue;
    if (!PORT_TYPES.includes(type as FlowPortType)) continue;
    const port: FlowPort = {
      id,
      type: type as FlowPortType,
      label: id,
      ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}),
    };
    ports.push(direction === "inputs" ? { ...port, required: false } : port);
  }
  return ports;
}

function readPorts(value: unknown): AppletPorts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { inputs, outputs } = value as Record<string, unknown>;
  const ports = { inputs: readPortList(inputs, "inputs"), outputs: readPortList(outputs, "outputs") };
  return ports.inputs.length + ports.outputs.length > 0 ? ports : undefined;
}

/** Graceful-fallback reader: a missing, empty, or malformed `.applet.html`
 * file — or one with no manifest block — reads as an Applet with an empty
 * manifest rather than throwing. */
export async function readAppletFile(filePath: string): Promise<ParsedAppletFile> {
  let html: string;
  try {
    html = await readFile(filePath, "utf8");
  } catch (error) {
    // Only a missing file is the graceful "new/empty applet" case; anything
    // else (EBUSY, EACCES, a mid-write race) must propagate. Swallowing it
    // would return empty html as a fake success, which the client renders as
    // a silently blank applet pane with no error to explain why.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { manifest: emptyManifest(), html: "" };
    throw error;
  }
  return parseAppletFile(html);
}

/** The same graceful reading, of an Applet's text already in hand. */
export function parseAppletFile(html: string): ParsedAppletFile {
  if (!html.trim()) return { manifest: emptyManifest(), html };

  try {
    const root = parse(html);
    const script = root.querySelector('script[data-role="manifest"]');
    if (!script) return { manifest: emptyManifest(), html };

    const parsed = JSON.parse(script.textContent) as Partial<AppletManifest> & { capabilities?: unknown };
    const manifest: AppletManifest = {
      version: typeof parsed.version === "string" ? parsed.version : "1.0",
      meta: readManifestInfo(parsed.meta),
      style: typeof parsed.style === "string" ? parsed.style : undefined,
      imports: readImports(parsed.imports),
      ports: readPorts(parsed.ports),
    };
    if (Array.isArray(parsed.capabilities) && parsed.capabilities.length > 0) manifest.declaresCapabilities = true;
    return { manifest, html };
  } catch {
    return { manifest: emptyManifest(), html };
  }
}

/** What an Applet node records of its Applet, so a Flow saved after the
 * Applet's code changed asks for its grants again (docs/protocol.md's
 * "Capability digest").
 *
 * Hashes the whole raw file and every import it loads: manifest, logic and
 * imports aren't separable, since editing any one changes what runs. With
 * no imports, the hash is the file's alone. */
export function contentHashFor(html: string, importSources: readonly string[] = []): string {
  const hash = createHash("sha256").update(html);
  for (const source of importSources) hash.update("\0").update(source);
  return hash.digest("hex");
}
