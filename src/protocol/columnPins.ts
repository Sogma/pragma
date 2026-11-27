// The pins a Table's columns give a Make Object or an Add Row node: what the
// node's config keeps of the Table, the pins, and the value a field takes.
import type { PortValue } from "./flowExecutors.ts";
import { type FlowPort, fieldPortType, isScoreMax, parseFieldValueType, type TableColumn } from "./types.ts";

/** The config of a node whose pins are a Table's columns. `columns` are the
 * Table's as the editor last read them, kept so a run and the canvas type
 * edges without reading it. `values` are what the card's own controls hold,
 * by column id: apart from the node's own keys, since a column's id is
 * whatever the Table says. */
export interface ColumnPinsConfig {
  tablePath: string;
  columns: TableColumn[];
  values: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the node keeps of a Table's columns: enough to type a pin and draw
 * its control. A column without an id has no pin to give, and a repeated id
 * would give two pins one wire identifier, so both are dropped. */
export function recordColumns(columns: readonly TableColumn[]): TableColumn[] {
  const seen = new Set<string>();
  const kept: TableColumn[] = [];
  for (const { id, type, label, options, default: fill, max, reject } of columns) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    kept.push({
      id,
      type,
      label: label || id,
      ...(type === "select" && options?.length ? { options } : {}),
      ...(type === "timestamp" && fill ? { default: fill } : {}),
      ...(type === "score" && max !== undefined && isScoreMax(max) ? { max } : {}),
      ...(type === "score" && reject ? { reject } : {}),
    });
  }
  return kept;
}

// The saved columns, re-checked: a hand-edited graph is trusted here no more
// than anywhere else.
function readSavedColumns(value: unknown): TableColumn[] {
  if (!Array.isArray(value)) return [];
  return recordColumns(
    value.filter(isRecord).map((raw) => ({
      id: typeof raw.id === "string" ? raw.id : "",
      type: parseFieldValueType(typeof raw.type === "string" ? raw.type : undefined),
      label: typeof raw.label === "string" ? raw.label : "",
      ...(Array.isArray(raw.options)
        ? { options: raw.options.filter((option): option is string => typeof option === "string") }
        : {}),
      ...(raw.default === "now" ? { default: "now" as const } : {}),
      ...(typeof raw.max === "number" ? { max: raw.max } : {}),
      ...(raw.reject === true ? { reject: true as const } : {}),
    })),
  );
}

export function columnPinsConfig(config: Record<string, unknown>): ColumnPinsConfig {
  const values: Record<string, string> = {};
  if (isRecord(config.values)) {
    for (const [id, value] of Object.entries(config.values)) if (typeof value === "string") values[id] = value;
  }
  return {
    tablePath: typeof config.tablePath === "string" ? config.tablePath : "",
    columns: readSavedColumns(config.columns),
    values,
  };
}

/** A pin per column, each optional. */
export function columnInputs(columns: readonly TableColumn[]): FlowPort[] {
  return columns.map((column) => ({
    id: column.id,
    type: fieldPortType(column.type),
    label: column.label,
    required: false,
  }));
}

/** A wired value as a field holds it: text, a number or a boolean as it
 * arrives. */
export function wiredFieldValue(column: TableColumn, value: PortValue): string | number | boolean {
  switch (value.type) {
    case "text":
    case "number":
    case "boolean":
      return value.value;
    default:
      throw new Error(`"${column.label}" can't hold ${value.type === "video" ? "a" : "an"} ${value.type}`);
  }
}

/** Text typed on the node as a field holds it, as its pin would take it: a
 * checkbox's as a boolean, an integer's or a score's as a number. A number
 * that isn't one fails, as an Int's does, rather than handing on text. */
export function typedFieldValue(column: TableColumn, text: string): string | number | boolean {
  switch (fieldPortType(column.type)) {
    case "boolean":
      return text === "true";
    case "number": {
      const trimmed = text.trim();
      const number = Number(trimmed);
      if (trimmed === "" || !Number.isSafeInteger(number)) throw new Error(`"${column.label}" isn't a whole number`);
      return number;
    }
    default:
      return text;
  }
}
