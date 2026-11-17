// The Graph tab's Show switches, kept per browser as one JSON value under
// the module's own key, and the forces its layout always runs with. A value
// this build doesn't know, or one of the wrong type, falls back to its
// default.
import { createSetting } from "../services/settings.ts";
import { EDGE_GROUPS, type ShowOptions } from "./graphData.ts";
import type { Forces } from "./graphSim.worker.ts";

export const SHOW_DEFAULTS: ShowOptions = {
  edges: EDGE_GROUPS.filter((group) => group.key !== "contains").map((group) => group.key),
  missing: true,
  templates: false,
  libraries: true,
};

export const SHOW_SWITCHES: { label: string; key: "missing" | "templates" | "libraries" }[] = [
  { label: "Missing files", key: "missing" },
  { label: "Templates", key: "templates" },
  { label: "Library files", key: "libraries" },
];

// The centre and link strengths are slider positions, 0 to 1, run through
// an exponential curve; repel is cubed. A file is pulled to its scope's
// AGENTS.md at 0.3.
const curve = (slider: number, base = 0.01) => (base ** (1 - slider) - base) / (1 - base);

export const FORCES: Forces = {
  center: curve(0.518713248970312),
  repel: 10 ** 3,
  linkStrength: curve(1),
  linkDistance: 250,
  scopePull: 0.3,
};

const stored = createSetting<string>("pragma:graph", (value) => value ?? "");

export function readShowOptions(): ShowOptions {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(stored.get() || "{}");
    if (value && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const edges = Array.isArray(parsed.edges)
    ? parsed.edges.filter((item): item is string => typeof item === "string")
    : [...SHOW_DEFAULTS.edges];
  const flag = (key: "missing" | "templates" | "libraries") =>
    typeof parsed[key] === "boolean" ? (parsed[key] as boolean) : SHOW_DEFAULTS[key];
  return { edges, missing: flag("missing"), templates: flag("templates"), libraries: flag("libraries") };
}

export function writeShowOptions(options: ShowOptions): void {
  stored.set(JSON.stringify(options));
}
