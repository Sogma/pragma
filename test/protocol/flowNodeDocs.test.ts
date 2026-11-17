import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPLET_NODE_TYPE } from "../../src/protocol/appletNode.ts";
import { FLOW_NODE_REGISTRY } from "../../src/protocol/flowNodes.ts";

// docs/flow-nodes.md against the registry it documents. The copilot and the
// agent API hand the doc to models that write Flows from it, so an entry
// that drifts from the registry gets Flows written that don't load or don't
// run. The rules each entry states in prose stay a reviewer's to check.

const DOC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../docs/flow-nodes.md"), "utf8");

interface Entry {
  heading: string;
  category: string;
  label?: string;
  // What the entry's first line says after the label.
  summary?: string;
  fields: Map<string, string>;
}

interface Port {
  id: string;
  type: string;
  optional: boolean;
  widget?: string;
  newNodeValue?: string;
  options?: string[];
}

function parseEntries(markdown: string): Entry[] {
  const entries: Entry[] = [];
  let category = "";
  for (const line of markdown.split("\n")) {
    const section = /^## (.+)$/.exec(line);
    if (section) {
      category = section[1];
      continue;
    }
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      entries.push({ heading: heading[1], category, fields: new Map() });
      continue;
    }
    const entry = entries.at(-1);
    if (!entry) continue;
    const label = /^\*\*(.+?)\*\*: ?(.*)$/.exec(line);
    if (label && entry.label === undefined) {
      entry.label = label[1];
      entry.summary = label[2];
    }
    const field = /^- \*\*(\w+):\*\* (.+)$/.exec(line);
    if (field) entry.fields.set(field[1], field[2]);
  }
  return entries;
}

// An entry's list, split on the commas outside backticks and parentheses.
function listItems(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inCode = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "`") inCode = !inCode;
    else if (inCode) continue;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      items.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(text.slice(start).trim());
  return items.filter(Boolean);
}

const WIDGETS: Record<string, string> = {
  text: "text",
  select: "select",
  "text-model select": "textModel",
  "image-model select": "imageModel",
  "video-model select": "videoModel",
  checkbox: "checkbox",
};

// A select widget's values, `(select widget: blank, `1:1`, …)`.
function parseOptions(note: string): string[] | undefined {
  const list = /select widget: (.+)$/.exec(note)?.[1];
  return list?.split(", ").map((option) => {
    if (option === "blank") return "";
    const value = /^`([^`]+)`$/.exec(option)?.[1];
    if (value === undefined) throw new Error(`Not a select option: ${option}`);
    return value;
  });
}

function parsePorts(text: string): Port[] {
  return listItems(text).flatMap((item) => {
    const match = /^`(\w+)`–`(\w+): (\w+)`(?: \((.+)\))?$|^`(\w+): (\w+)`(?: \((.+)\))?$/.exec(item);
    if (!match) throw new Error(`Not a port: ${item}`);
    const note = match[4] ?? match[7] ?? "";
    const widget = /(image-model select|video-model select|text-model select|select|text|checkbox) widget/.exec(
      note,
    )?.[1];
    const newNodeValue = /`([^`]*)` in a new node/.exec(note)?.[1];
    const port = (id: string, type: string): Port => ({
      id,
      type,
      optional: /\boptional\b/.test(note),
      widget: widget && WIDGETS[widget],
      newNodeValue: newNodeValue === undefined ? undefined : JSON.parse(newNodeValue),
      options: parseOptions(note),
    });
    if (match[5]) return [port(match[5], match[6])];
    // A numbered run, `image_1`–`image_5: image`, is a port per number.
    const [, first, last, type] = match;
    const prefix = first.replace(/\d+$/, "");
    const from = Number(first.slice(prefix.length));
    const to = Number(last.slice(prefix.length));
    if (!last.startsWith(prefix) || !(to > from)) throw new Error(`Not a numbered run: ${item}`);
    return Array.from({ length: to - from + 1 }, (_, i) => port(`${prefix}${from + i}`, type));
  });
}

function parseConfigKeys(text: string): string[] {
  return listItems(text).map((item) => {
    const key = /^`([\w{}]+)`/.exec(item)?.[1];
    if (!key) throw new Error(`Not a config key: ${item}`);
    return key;
  });
}

const CAPABILITY =
  /\b(readCurrentDocument|readFile|writeDocument|generateImage|generateVideo|generateText)\b(?:\(`(\w+)`\))?/g;
const FIELDS = ["Inputs", "Outputs", "Config", "Capability", "Action"];
const entries = parseEntries(DOC);
const typeOf = (entry: Entry) => /^`(\w+)`$/.exec(entry.heading)?.[1];

describe("docs/flow-nodes.md", () => {
  it("has an entry, headed by its type id, for every built-in type but the Applet node", () => {
    const types = Object.keys(FLOW_NODE_REGISTRY).filter((type) => type !== APPLET_NODE_TYPE);
    expect(entries.map((entry) => typeOf(entry) ?? entry.heading).sort()).toEqual(types.sort());
  });

  for (const entry of entries) {
    const type = typeOf(entry);
    const definition = type ? FLOW_NODE_REGISTRY[type] : undefined;
    if (!type || !definition) continue;

    describe(type, () => {
      it("sits under its category, with its label", () => {
        expect(entry.category).toBe(definition.category);
        expect(entry.label).toBe(definition.label);
      });

      // The doc writes it after the label's colon, from a small letter, its
      // code in backticks; a host shows the registry's as a sentence.
      it("opens with the registry's description", () => {
        const summary = (entry.summary ?? "").replaceAll("`", "");
        expect(summary.charAt(0).toUpperCase() + summary.slice(1)).toBe(definition.description);
      });

      it("uses only an entry's fields", () => {
        for (const field of entry.fields.keys()) expect(FIELDS).toContain(field);
      });

      // A type whose ports come from a file says so in prose instead.
      if (!definition.portsFrom) {
        it("lists the registry's inputs, with their widgets, a select's options and which are optional", () => {
          const inputs = definition.inputs.map((port): Port => {
            const widget = definition.inputWidgets?.find((candidate) => candidate.portId === port.id);
            return {
              id: port.id,
              type: port.type,
              optional: port.required === false,
              widget: widget?.type,
              newNodeValue: widget?.defaultValue,
              options: widget?.options && [...widget.options],
            };
          });
          expect(parsePorts(entry.fields.get("Inputs") ?? "")).toEqual(inputs);
        });

        it("lists the registry's outputs", () => {
          const outputs = parsePorts(entry.fields.get("Outputs") ?? "").map(({ id, type }) => ({ id, type }));
          expect(outputs).toEqual(definition.outputs.map(({ id, type }) => ({ id, type })));
        });
      }

      // The doc writes a key per slot, `var1Name` to `var10Name`, as `var{N}Name`.
      it("lists the config keys the registry declares", () => {
        const declared = [...new Set(definition.configKeys.map((key) => key.replace(/\d+/, "{N}")))];
        expect(parseConfigKeys(entry.fields.get("Config") ?? "").sort()).toEqual(declared.sort());
      });

      it("claims the capability the registry derives, from the key it names", () => {
        const line = entry.fields.get("Capability");
        if (!definition.capabilityFor) {
          expect(line).toBeUndefined();
          return;
        }
        const claims = [...(line ?? "").matchAll(CAPABILITY)];
        expect(claims).not.toHaveLength(0);
        for (const [, kind, key] of claims) {
          if (!key) {
            expect(definition.capabilityFor({})).toEqual({ type: kind });
            continue;
          }
          const path = "probe/probe.md";
          expect(definition.capabilityFor({ [key]: path })).toEqual({ type: kind, path });
        }
      });

      it("is an action exactly when the registry marks one", () => {
        expect(entry.fields.has("Action")).toBe(definition.action === true);
      });
    });
  }
});
