// What a module adds to the copilot's orientation, after the project README.
// A source reads the space only through the reader it is handed, which keeps
// back whatever the model may not see, and its section is held to a size
// limit, so no module can leak a private file into the prompt or crowd the
// turn out.
import path from "node:path";
import { escapesRoot } from "./rootedFiles.ts";
import { readNamedForPrompt } from "./spaceFiles.ts";

/** A section body's longest, in characters. A model running on the writer's
 * own machine may have a few thousand tokens for the whole turn. */
export const CONTEXT_SECTION_LIMIT = 8000;

/** What a source is handed for one turn. */
export interface ContextRequest {
  /** The space folder the turn starts from, written with `/`: the open
   * file's, the gallery's, or "" for the space root. */
  readonly folder: string;
  /** The longest body a section may have. */
  readonly limit: number;
  /** The entry `name` in the space folder `folder`, its name in any case:
   * null when it is absent, a link, or not for the model. */
  readNamed(folder: string, name: string): Promise<{ path: string; content: string } | null>;
}

export interface ContextSection {
  /** The section's heading. */
  readonly title: string;
  readonly body: string;
}

export interface ContextSource {
  section(request: ContextRequest): Promise<ContextSection | null>;
}

export interface ContextSourceRegistry {
  // Registering an id twice throws: two sources under one id is a bug, not a
  // merge.
  register(id: string, source: ContextSource): void;
  // Each source's section for a turn starting in `startDir`, in registration
  // order.
  sections(spaceRoot: string, startDir: string): Promise<ContextSection[]>;
}

export function createContextSources(): ContextSourceRegistry {
  const sources = new Map<string, ContextSource>();
  return {
    register(id, source) {
      if (sources.has(id)) throw new Error(`a context source "${id}" is already registered`);
      sources.set(id, source);
    },
    async sections(spaceRoot, startDir) {
      const relative = path.relative(spaceRoot, startDir);
      if (escapesRoot(relative)) return [];
      const request: ContextRequest = {
        folder: relative.split(path.sep).join("/"),
        limit: CONTEXT_SECTION_LIMIT,
        readNamed: (folder, name) => readNamedForPrompt(spaceRoot, folder, name),
      };
      // A source that fails is left out of the turn: a section orients the
      // model, and none is worth failing a turn over.
      const sections = await Promise.all(
        [...sources.values()].map((source) =>
          Promise.resolve()
            .then(() => source.section(request))
            .catch(() => null),
        ),
      );
      return sections.flatMap((section) => (section ? [withinLimit(section)] : []));
    },
  };
}

// Cut rather than dropped, since what fits is still worth having, and never
// between the halves of a surrogate pair, which would hand the model half a
// character.
function withinLimit(section: ContextSection): ContextSection {
  if (section.body.length <= CONTEXT_SECTION_LIMIT) return section;
  const end = /[\uD800-\uDBFF]/.test(section.body[CONTEXT_SECTION_LIMIT - 1])
    ? CONTEXT_SECTION_LIMIT - 1
    : CONTEXT_SECTION_LIMIT;
  return { ...section, body: `${section.body.slice(0, end)}\n\n[Cut short at the copilot's size limit.]` };
}
