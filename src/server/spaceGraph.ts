// The space as a graph, for the inspector's Graph tab: every entry the tree
// shows, and each path a document's own text holds, resolved by the rules the
// Links tab and backlinks use. A note's links and embeds come from the
// document index; a Table, Class, Flow or Applet is read here, as few spaces
// hold many.
//
// A screenplay's world names are not read: their lines are told apart by the
// screenplay editor's grammar, which only the browser runs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  GraphScope,
  LibraryEntry,
  SpaceGraphResponse,
} from "../protocol/api.ts";
import { parseAppletFile } from "../protocol/appletFile.ts";
import { APPLET_NODE_TYPE, appletNodeConfig } from "../protocol/appletNode.ts";
import { parseClassFile } from "../protocol/classFile.ts";
import { parseFlowFile } from "../protocol/flowFile.ts";
import { computeFlowCapabilities } from "../protocol/flowNodes.ts";
import { createPathIndex, findEntry, type PathIndex, resolveWrittenPath } from "../protocol/pathIndex.ts";
import { type PathForm, readWrittenPath, resolveDeclaredPath } from "../protocol/relativeReference.ts";
import {
  basenameOf,
  dirnameOf,
  formatRootedPath,
  isLibraryRoot,
  type PathRoot,
  parseRootedPath,
  type RootedPath,
} from "../protocol/rootedPath.ts";
import { isAgentsFile, sameScope, scopeOf } from "../protocol/scopes.ts";
import { parseTableFile } from "../protocol/tableFile.ts";
import { type TagDefinition, tagDefinition, tagKey } from "../protocol/tags.ts";
import {
  holdsPath,
  isAppletFile,
  isClassFile,
  isFlowFile,
  isFountainFile,
  isMarkdownFile,
  isTableFile,
  mediaTypeForPath,
  splitDocumentName,
} from "../protocol/types.ts";
import { classRows } from "./classRows.ts";
import { documentIndex } from "./documentIndex.ts";
import { readLibraries } from "./libraries.ts";
import { presetPaths } from "./presets.ts";
import { readSpaceTags } from "./spaceTags.ts";
import { isTreeVisibleFile, listRootPaths } from "./tree.ts";

// A path a document holds, read in one pass and resolved in the next, once
// the libraries the space names are listed. A declared path (an Applet's
// import, a Flow's Applet) is read from the document's folder; an address (a
// Flow's capability) is already rooted.
interface Held {
  from: string;
  docDir: string;
  written: string;
  read: PathForm | "declared" | "address";
  kind: GraphEdgeKind;
}

interface Listing {
  files: string[];
  folders: string[];
}

function fileKind(file: string): GraphNodeKind {
  if (isMarkdownFile(file)) return "note";
  if (isFountainFile(file)) return "screenplay";
  if (isTableFile(file)) return "table";
  if (isClassFile(file)) return "class";
  if (isFlowFile(file)) return "flow";
  if (isAppletFile(file)) return "applet";
  const media = mediaTypeForPath(file);
  if (media?.startsWith("image/")) return "image";
  if (media?.startsWith("video/")) return "video";
  if (media === "application/pdf") return "pdf";
  return "file";
}

export async function buildSpaceGraph(spaceRoot: string): Promise<SpaceGraphResponse> {
  const index = documentIndex();
  const space = await listRootPaths(spaceRoot, "space");
  const scopeFolders = new Set(space.scopes);
  const scopes = { has: (folder: string) => scopeFolders.has(folder) };
  const spaceRootIndex = { dir: spaceRoot, root: "space" as const };
  await index.check(spaceRootIndex);
  const isPreset = presetPaths(spaceRoot);

  const libraryListings = new Map<string, { entry: LibraryEntry; listing: Listing; paths: PathIndex }>();
  const spacePaths = createPathIndex(space);
  const indexOf = (root: PathRoot): PathIndex | undefined =>
    isLibraryRoot(root) ? libraryListings.get(root.library)?.paths : spacePaths;

  let vocabulary: readonly TagDefinition[] = [];
  try {
    vocabulary = readSpaceTags(spaceRoot).tags;
  } catch {
    vocabulary = [];
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, { from: string; to: string; kind: GraphEdgeKind; weight: number }>();
  const rootedOf = new Map<string, RootedPath>();
  const held: Held[] = [];

  const scopeKey = (rooted: RootedPath): string =>
    isLibraryRoot(rooted.root) ? `lib:${rooted.root.library}` : scopeOf(scopes, rooted.path);

  function entryNode(rooted: RootedPath, type: "file" | "directory"): GraphNode {
    const folder = type === "directory";
    const id = folder ? `${formatRootedPath(rooted)}/` : formatRootedPath(rooted);
    const known = nodes.get(id);
    if (known) return known;
    const library = isLibraryRoot(rooted.root);
    const name = basenameOf(rooted.path);
    const node: GraphNode = {
      id,
      kind: folder ? "folder" : fileKind(rooted.path),
      label: folder ? `${name}/` : splitDocumentName(name).stem,
      scope: scopeKey(rooted),
    };
    if (isPreset(formatRootedPath(rooted))) node.preset = true;
    if (library) node.library = true;
    if (!library && !folder && isAgentsFile(rooted.path) && scopeFolders.has(dirnameOf(rooted.path)))
      node.opensScope = true;
    nodes.set(id, node);
    rootedOf.set(id, rooted);
    return node;
  }

  function missingNode(rooted: RootedPath): GraphNode {
    const id = `?${formatRootedPath(rooted)}`;
    const known = nodes.get(id);
    if (known) return known;
    const node: GraphNode = {
      id,
      kind: "missing",
      label: splitDocumentName(basenameOf(rooted.path)).stem,
      scope: scopeKey(rooted),
    };
    if (isLibraryRoot(rooted.root)) node.library = true;
    nodes.set(id, node);
    rootedOf.set(id, rooted);
    return node;
  }

  function tagNode(name: string): GraphNode {
    const id = `#${tagKey(name)}`;
    const known = nodes.get(id);
    if (known) return known;
    const node: GraphNode = { id, kind: "tag", label: `#${name}`, scope: null };
    const color = tagDefinition(vocabulary, name)?.color;
    if (color) node.color = color;
    nodes.set(id, node);
    return node;
  }

  function addEdge(from: string, to: string, kind: GraphEdgeKind, weight = 1): void {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    const known = edges.get(key);
    if (known) known.weight += weight;
    else edges.set(key, { from, to, kind, weight });
  }

  const spaceFile = (file: string) => entryNode({ root: "space", path: file }, "file");

  for (const file of space.files) if (isTreeVisibleFile(basenameOf(file))) spaceFile(file);
  for (const folder of space.folders) entryNode({ root: "space", path: folder }, "directory");

  // A document's own tags, each once whatever case it is written in.
  for (const tagged of await index.tagged(spaceRootIndex)) {
    if (!nodes.has(tagged.path)) continue;
    const seen = new Set<string>();
    for (const tag of tagged.tags) {
      if (seen.has(tagKey(tag.name))) continue;
      seen.add(tagKey(tag.name));
      addEdge(tagged.path, tagNode(tag.name).id, "tag");
    }
  }

  const classFiles: string[] = [];
  async function readDocument(file: string): Promise<void> {
    const node = nodes.get(file);
    if (!node) return;
    const docDir = dirnameOf(file);
    const absolute = path.join(spaceRoot, ...file.split("/"));
    if (node.kind === "note") {
      const title = index.noteHead(absolute).title;
      if (title) node.label = title;
      const paths = index.notePaths(absolute);
      for (const link of paths.links)
        held.push({ from: file, docDir, written: link.raw, read: link.form, kind: "link" });
      for (const embed of paths.embeds)
        held.push({ from: file, docDir, written: embed, read: "markdown", kind: "embed" });
      return;
    }
    if (!["table", "class", "flow", "applet"].includes(node.kind)) return;
    const text = await readFile(absolute, "utf8");
    if (node.kind === "table") {
      const table = parseTableFile(text);
      if (!table) return;
      if (table.name) node.label = table.name;
      const columns = table.columns.filter((column) => holdsPath(column.type)).map((column) => column.id);
      for (const row of table.rows) {
        for (const column of columns) {
          const value = row.values[column]?.trim();
          if (value) held.push({ from: file, docDir, written: value, read: "markdown", kind: "tablePath" });
        }
      }
      return;
    }
    if (node.kind === "class") {
      const definition = parseClassFile(text);
      if (!definition) return;
      if (definition.name) node.label = definition.name;
      for (const link of definition.links)
        held.push({ from: file, docDir, written: link, read: "markdown", kind: "classLink" });
      classFiles.push(file);
      return;
    }
    if (node.kind === "flow") {
      const flow = parseFlowFile(text);
      if (!flow) return;
      if (flow.name) node.label = flow.name;
      for (const capability of computeFlowCapabilities(flow.graph, file)) {
        if (!("path" in capability)) continue;
        const kind = capability.type === "readFile" ? "flowRead" : "flowWrite";
        held.push({ from: file, docDir, written: capability.path, read: "address", kind });
      }
      for (const flowNode of flow.graph.nodes) {
        if (flowNode.type !== APPLET_NODE_TYPE) continue;
        const appletPath = appletNodeConfig(flowNode.config).appletPath;
        if (appletPath) held.push({ from: file, docDir, written: appletPath, read: "declared", kind: "flowApplet" });
      }
      return;
    }
    const applet = parseAppletFile(text);
    if (applet.manifest.meta?.name) node.label = applet.manifest.meta.name;
    for (const entry of applet.manifest.imports ?? []) {
      held.push({ from: file, docDir, written: entry.path, read: "declared", kind: "appletImport" });
    }
  }

  // A file that can't be read or parsed holds no paths, as for one with none.
  const documents = [...nodes.keys()].filter((id) => !id.endsWith("/") && !id.startsWith("#"));
  for (let at = 0; at < documents.length; at += 64) {
    await Promise.all(documents.slice(at, at + 64).map((file) => readDocument(file).catch(() => undefined)));
  }

  // Each Class's rows, as its toolkit and Links reach them, kept by its filter.
  const memberRows: { from: string; path: string }[] = [];
  for (const file of classFiles) {
    try {
      for (const row of await classRows(spaceRoot, file)) memberRows.push({ from: file, path: row.path });
    } catch {
      // A Class whose rows can't be read reaches none.
    }
  }

  // Only the libraries the space names are listed: one may be large, or on a
  // slow drive.
  const named = new Set<string>();
  for (const { written } of held) {
    const scheme = /^\s*lib:([^/\s]+)/.exec(written);
    if (scheme) named.add(scheme[1]);
  }
  for (const row of memberRows) {
    const root = parseRootedPath(row.path).root;
    if (isLibraryRoot(root)) named.add(root.library);
  }
  const registered = readLibraries(spaceRoot);
  for (const id of named) {
    const entry = registered.find((library) => library.id === id);
    if (!entry) continue;
    try {
      const listing = await listRootPaths(entry.path, "library");
      libraryListings.set(id, { entry, listing, paths: createPathIndex(listing) });
    } catch {
      // A library that can't be listed resolves nothing, so its paths read as missing.
    }
  }

  for (const row of memberRows) {
    const rooted = parseRootedPath(row.path);
    const paths = indexOf(rooted.root);
    const found = paths && findEntry(paths, rooted.path, "any");
    if (found) addEdge(row.from, entryNode({ root: rooted.root, path: found.path }, found.type).id, "member");
  }

  for (const reference of held) {
    const target = resolveHeld(reference, indexOf);
    if (!target) continue;
    const node = "type" in target ? entryNode(target.rooted, target.type) : missingNode(target);
    addEdge(reference.from, node.id, reference.kind);
  }

  for (const folder of space.folders) {
    const parent = dirnameOf(folder);
    if (parent !== "") addEdge(`${parent}/`, `${folder}/`, "contains");
  }
  for (const file of space.files) {
    const parent = dirnameOf(file);
    if (parent !== "" && nodes.has(file)) addEdge(`${parent}/`, file, "contains");
  }

  // Scopes, parents before children, then each library the graph reaches.
  const scopeList: GraphScope[] = [{ id: "", name: basenameOf(spaceRoot.split(path.sep).join("/")), parent: null }];
  const byDepth = [...scopeFolders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const folder of byDepth) {
    scopeList.push({ id: folder, name: basenameOf(folder), parent: scopeOf(scopes, dirnameOf(folder)) });
  }
  const reached = new Set([...nodes.values()].flatMap((node) => (node.scope?.startsWith("lib:") ? [node.scope] : [])));
  for (const id of [...reached].sort()) {
    const name = registered.find((library) => `lib:${library.id}` === id)?.label || id.slice("lib:".length);
    scopeList.push({ id, name, parent: null, library: true });
  }

  const nodeList = [...nodes.values()];
  const position = new Map(nodeList.map((node, at) => [node.id, at]));
  const edgeList: GraphEdge[] = [];
  for (const edge of edges.values()) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const out: GraphEdge = { from, to, kind: edge.kind };
    const a = rootedOf.get(edge.from);
    const b = rootedOf.get(edge.to);
    if (edge.kind !== "tag" && a && b && !sameScope(scopes, a, b)) out.crosses = true;
    if (edge.weight > 1) out.weight = edge.weight;
    edgeList.push(out);
  }
  return { scopes: scopeList, nodes: nodeList, edges: edgeList };
}

// The entry a held path lands on, or the rooted path it spells when it lands
// on nothing; undefined when it spells no path at all.
function resolveHeld(
  reference: Held,
  indexOf: (root: PathRoot) => PathIndex | undefined,
): { rooted: RootedPath; type: "file" | "directory" } | RootedPath | undefined {
  if (reference.read === "markdown" || reference.read === "wikilink") {
    const found = resolveWrittenPath(reference.docDir, reference.written, reference.read, indexOf);
    if (found) return { rooted: parseRootedPath(found.path), type: found.type };
    return readWrittenPath(reference.docDir, reference.written, reference.read)?.target;
  }
  let rooted: RootedPath;
  try {
    rooted =
      reference.read === "address"
        ? parseRootedPath(reference.written)
        : resolveDeclaredPath(reference.docDir, reference.written);
  } catch {
    return undefined;
  }
  const paths = indexOf(rooted.root);
  const found = paths && findEntry(paths, rooted.path, "any");
  return found ? { rooted: { root: rooted.root, path: found.path }, type: found.type } : rooted;
}
