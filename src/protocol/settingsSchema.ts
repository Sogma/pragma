// Turning a publisher's own settings schema into a flat list of fields a
// form can draw (docs/publishing.md's Site settings section). The field set
// is never hardcoded: the schema is generated from the validation the API
// enforces, so what the service accepts is what gets rendered.
//
// Nesting is flattened into JSON Pointer ids (`/analytics/ga_id`, RFC 6901)
// for one loop and a stable identity per control; the patch builder below
// rebuilds the nesting for the write.

/** One editable setting, as a form needs it — already resolved from the
 * schema, so a renderer never re-interprets JSON Schema itself. The
 * vocabulary widens here when the form grows controls to match (see the
 * drawability check below). */
export interface SettingsFieldDescriptor {
  // JSON Pointer into the settings object, e.g. "/analytics/ga_id".
  pointer: string;
  label: string;
  description?: string;
  placeholder?: string;
  // The heading this field sits under, when the schema names one.
  group?: string;
  // An image the site holds, named by its `public_id`, or an on/off switch,
  // rather than text.
  kind?: "image" | "toggle";
}

interface RawSchema {
  type?: string | string[];
  properties?: Record<string, RawSchema>;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  "x-sogma-group"?: string;
  "x-sogma-placeholder"?: string;
  "x-sogma-ref"?: string;
}

// A schema's `type` may be a union with "null" (the shape Sogma uses for a
// nullable string), so the meaningful type is whatever isn't "null".
function baseType(schema: RawSchema): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((entry) => entry !== "null");
  return undefined;
}

// Whether this client can draw the field at all. Anything else is left out
// rather than failing the whole form — Sogma's spec requires that a new kind
// of control not break installed clients — and the caller is told how many
// fields were lost.
//
// Drawn: a plain string, a boolean (as a switch), and a string naming a site
// file (`x-sogma-ref: "file"`, as an image picker). Not: other refs, a string
// with a `format` a bare text box may not satisfy, numbers and enums.
function isDrawable(schema: RawSchema): boolean {
  if (Array.isArray(schema.enum)) return false;
  if (baseType(schema) === "boolean") return true;
  const ref = schema["x-sogma-ref"];
  if (ref !== undefined && ref !== "file") return false;
  return baseType(schema) === "string" && schema.format === undefined;
}

// RFC 6901: "~" and "/" are the only characters needing an escape, as "~0"
// and "~1", and the order matters — "~" first, or an escaped "/" would be
// re-escaped.
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Walks a settings schema into the fields a form can draw, in schema
 * order. An object nests; anything else is a leaf, kept when this client can
 * draw it and counted in `skipped` when it can't. */
export function flattenSettingsSchema(schema: unknown): { fields: SettingsFieldDescriptor[]; skipped: number } {
  const fields: SettingsFieldDescriptor[] = [];
  let skipped = 0;

  function walk(node: RawSchema, pointer: string): void {
    if (baseType(node) === "object" || node.properties) {
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        walk(child, `${pointer}/${escapePointerSegment(key)}`);
      }
      return;
    }
    if (!isDrawable(node)) {
      skipped += 1;
      return;
    }
    fields.push({
      pointer,
      // A schema with no `title` falls back to the key itself: an unlabelled
      // control is worse than an ugly one.
      label: node.title ?? pointer.slice(pointer.lastIndexOf("/") + 1),
      ...(node.description ? { description: node.description } : {}),
      ...(node["x-sogma-placeholder"] ? { placeholder: node["x-sogma-placeholder"] } : {}),
      ...(node["x-sogma-group"] ? { group: node["x-sogma-group"] } : {}),
      ...(node["x-sogma-ref"] === "file" ? { kind: "image" as const } : {}),
      ...(baseType(node) === "boolean" ? { kind: "toggle" as const } : {}),
    });
  }

  if (schema && typeof schema === "object") walk(schema as RawSchema, "");
  return { fields, skipped };
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function lookup(settings: unknown, pointer: string): unknown {
  let node: unknown = settings;
  for (const segment of pointerSegments(pointer)) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Reads one pointer's current value out of a settings object, as the text
 * a form control holds. An unset field comes back as `null` from the
 * service and as `""` here — a control has no third state. */
export function readSettingsValue(settings: unknown, pointer: string): string {
  const node = lookup(settings, pointer);
  if (node === null || node === undefined) return "";
  return String(node);
}

/** Reads a toggle's current state. Only `true` is on: an unset toggle reads
 * back as `false`, and a service that reports one as `null` means the
 * same. */
export function readSettingsToggle(settings: unknown, pointer: string): boolean {
  return lookup(settings, pointer) === true;
}

/** Rebuilds the service's own nesting from pointer-keyed edits, as the
 * merge patch to send: a key present replaces, a key absent is left alone,
 * and an explicit `null` clears (RFC 7396). Only changed fields belong in
 * `edits` — that is what keeps a write from touching anything else. */
export function toSettingsPatch(edits: Record<string, string | boolean | null>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [pointer, value] of Object.entries(edits)) {
    const segments = pointerSegments(pointer);
    if (segments.length === 0) continue;
    let node = patch;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      // A non-object already sitting here would be an edit to a parent and
      // a child at once, which the flattener can't produce.
      node[segment] = next && typeof next === "object" ? next : {};
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = value;
  }
  return patch;
}
