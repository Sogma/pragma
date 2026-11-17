// docs/protocol.md and its Flow node catalog, docs/flow-nodes.md, served to
// models a section at a time by the copilot and both encodings of the agent
// API, so one writing a Flow, Table or Applet works from the format, not
// from an example showing only the node types and fields it happens to use.
//
// Read from the install, never a space: a packaged build carries the files
// only because electron-builder.yml and scripts/pack-npm.mjs list them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "../config/packageRoot.ts";
import { findSection, type MarkdownOutline, outlineOf, sectionText } from "./markdownSections.ts";

const DOCS_DIR = path.join(PACKAGE_ROOT, "docs");

/** One part of protocol.md, a `##` heading, with the anchors of the `###`
 * sections under it. */
export interface SpecPart {
  anchor: string;
  sections: string[];
}

export interface ProtocolSpec {
  /** protocol.md's parts, in order. */
  parts: SpecPart[];
  /** flow-nodes.md's `##` sections' anchors: the node categories. */
  nodeCategories: string[];
  /** One section with its subsections, from either doc, named by any
   * heading's anchor or title; undefined when none matches. */
  read(name: string): string | undefined;
}

const topSections = (doc: MarkdownOutline) => doc.sections.filter((section) => section.level === 2);

const partsOf = (doc: MarkdownOutline): SpecPart[] =>
  topSections(doc).map((part) => ({
    anchor: part.anchor,
    sections: doc.sections
      .filter((section) => section.level === 3 && section.start > part.start && section.start < part.end)
      .map((section) => section.anchor),
  }));

/** Both docs as one spec. A lookup takes the first heading whose anchor
 * matches; scripts/check-docs.mjs keeps an anchor from naming a heading in
 * both. */
export function parseProtocolSpec(protocol: string, flowNodes: string): ProtocolSpec {
  const docs = [outlineOf(protocol), outlineOf(flowNodes)];
  return {
    parts: partsOf(docs[0]),
    nodeCategories: topSections(docs[1]).map((section) => section.anchor),
    read(name) {
      for (const doc of docs) {
        const section = findSection(doc, name);
        if (section) return sectionText(doc, section);
      }
      return undefined;
    },
  };
}

let loading: Promise<ProtocolSpec | undefined> | undefined;

/** The spec this install ships, read once. Undefined when the install lacks
 * either doc, and then no surface offers it. */
export function loadProtocolSpec(): Promise<ProtocolSpec | undefined> {
  const read = (name: string) => readFile(path.join(DOCS_DIR, name), "utf8");
  loading ??= Promise.all([read("protocol.md"), read("flow-nodes.md")]).then(
    ([protocol, flowNodes]) => parseProtocolSpec(protocol, flowNodes),
    () => undefined,
  );
  return loading;
}

/** Every part and section protocol.md has, by anchor, in order. */
export function sectionAnchors(spec: ProtocolSpec): string[] {
  return spec.parts.flatMap((part) => [part.anchor, ...part.sections]);
}

// Each part with the sections under it: a model offered only the parts picks
// a whole part, which can run to tens of thousands of characters.
function sectionMenu(spec: ProtocolSpec): string {
  return spec.parts
    .map((part) => (part.sections.length ? `${part.anchor} (${part.sections.join(", ")})` : part.anchor))
    .join("; ");
}

/** The spec tool's description, one wording for the copilot and MCP alike. */
export function specToolDescription(spec: ProtocolSpec): string {
  return (
    "Read one section of Pragma's spec: the exact file formats of Flows (.flow.html), Tables " +
    "(.table.html) and Applets (.applet.html), the rules every space " +
    "document follows, and each built-in Flow node type. Read the matching section before " +
    "writing or changing one of those files: an existing file is an example, not the format, and " +
    "shows only the node types and fields it happens to use. Sections link to each other by " +
    "anchor, such as (#applet-nodes); pass any such anchor to read just that section. Sections: " +
    `${sectionMenu(spec)}. Node types, by category: ${spec.nodeCategories.join(", ")}; ` +
    "each node type's own section is its type id, such as generateImage."
  );
}

export const specSectionInput = z
  .string()
  .describe(
    'A section\'s anchor, such as "flows"; a node category, such as "text"; or a node type id, such as "templateVariables".',
  );

export function noSuchSection(spec: ProtocolSpec, name: string): string {
  return (
    `No section ${JSON.stringify(name)} in Pragma's spec. Sections: ${sectionMenu(spec)}. ` +
    `Node types, by category: ${spec.nodeCategories.join(", ")}.`
  );
}
