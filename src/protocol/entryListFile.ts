// A JSON file Pragma keeps a list of entries in, as it writes one: each entry
// on its own line, so adding, changing or removing one is a one-line diff.
// Any other key keeps its value.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const entryLine = (entry: unknown): string =>
  isRecord(entry)
    ? `{ ${Object.entries(entry)
        .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
        .join(", ")} }`
    : JSON.stringify(entry);

/** `file` as Pragma writes it, its `listKey` array one entry a line. */
export function serializeEntryListFile(file: Record<string, unknown>, listKey: string): string {
  const members = Object.entries(file).map(([key, value]) => {
    if (key === listKey && Array.isArray(value)) {
      const lines = value.map((entry) => `    ${entryLine(entry)}`).join(",\n");
      return `  ${JSON.stringify(key)}: [${value.length > 0 ? `\n${lines}\n  ` : ""}]`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, "\n  ")}`;
  });
  return `{\n${members.join(",\n")}\n}\n`;
}
