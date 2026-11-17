import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_SECTION_LIMIT,
  type ContextSection,
  type ContextSourceRegistry,
  createContextSources,
} from "../../../../src/server/copilotContext.ts";
import { okfContext } from "../../../../src/server/modules/okf/context.ts";
import { shippedContextSources } from "../../../../src/server/modules.ts";

const ROOT_INDEX =
  '---\nokf_version: "0.2"\n---\n# Knowledge\n\n## Tables\n\n* [Orders](tables/orders.md) - Every order placed\n';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pragma-okf-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 29, 12));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, relativePath)), { recursive: true });
  writeFileSync(path.join(dir, relativePath), content);
}

// The OKF section for a turn starting in `folder`, read through the
// registry so every read goes through the reader a turn's do.
async function sectionFor(folder: string, sources?: ContextSourceRegistry): Promise<ContextSection | undefined> {
  const registry = sources ?? createContextSources();
  if (!sources) registry.register("okf", okfContext);
  const sections = await registry.sections(dir, path.join(dir, folder));
  return sections[0];
}

describe("the OKF context source", () => {
  it("adds nothing where no folder declares a bundle", async () => {
    write("knowledge/index.md", "# Knowledge\n\n* [Orders](orders.md) - Every order placed\n");
    write("knowledge/orders.md", "---\ntype: BigQuery Table\n---\n# Orders\n");

    expect(await sectionFor("knowledge")).toBeUndefined();
  });

  it("finds the bundle from a folder below its root, quoting the root's listing", async () => {
    write("knowledge/index.md", ROOT_INDEX);
    write("knowledge/tables/index.md", "# Tables\n\n* [Orders](orders.md) - Every order placed\n");
    write("knowledge/tables/orders.md", "---\ntype: BigQuery Table\n---\n# Orders\n");

    const section = await sectionFor("knowledge/tables");

    expect(section?.title).toBe("Open Knowledge Format bundle (knowledge/index.md)");
    expect(section?.body).toContain("whose root folder is `knowledge/`");
    expect(section?.body).toContain(
      "The bundle's listing, `knowledge/index.md`:\n\n```markdown\n# Knowledge\n\n## Tables\n\n* [Orders](tables/orders.md) - Every order placed\n```",
    );
    expect(section?.body).not.toContain('okf_version: "0.2"');
    expect(section?.body).toContain(
      "The listing closest to where the writer is working is `knowledge/tables/index.md`.",
    );
  });

  it("is among the sources Pragma ships", async () => {
    write("knowledge/index.md", ROOT_INDEX);

    const section = await sectionFor("knowledge", shippedContextSources());

    expect(section?.title).toBe("Open Knowledge Format bundle (knowledge/index.md)");
  });

  it("has links written relative in a bundle nested in the space", async () => {
    write("knowledge/index.md", ROOT_INDEX);

    const body = (await sectionFor("knowledge"))?.body;

    expect(body).toContain("Write each link relative to its document's folder");
    expect(body).not.toContain("which is also the space root");
  });

  it("reads a link from the bundle root when the bundle is the whole space", async () => {
    write("index.md", ROOT_INDEX);

    const section = await sectionFor("");

    expect(section?.title).toBe("Open Knowledge Format bundle (index.md)");
    expect(section?.body).toContain("whose root folder is the space root");
    expect(section?.body).toContain("which is also the space root");
    expect(section?.body).not.toContain("Write each link relative");
  });

  it("takes the nearest declared root", async () => {
    write("outer/index.md", ROOT_INDEX);
    write("outer/inner/index.md", '---\nokf_version: "0.2"\n---\n# Inner\n');
    write("outer/inner/notes/idea.md", "---\ntype: Idea\n---\n# Idea\n");

    expect((await sectionFor("outer/inner/notes"))?.title).toBe("Open Knowledge Format bundle (outer/inner/index.md)");
  });

  it("finds a declaring listing in any case", async () => {
    write("Knowledge/INDEX.MD", ROOT_INDEX);

    expect((await sectionFor("Knowledge"))?.title).toBe("Open Knowledge Format bundle (Knowledge/INDEX.MD)");
  });

  it("finds no bundle through a private listing", async () => {
    write("knowledge/index.md", '---\nokf_version: "0.2"\nvisibility: private\n---\n# Secret listing\n');

    expect(await sectionFor("knowledge")).toBeUndefined();
  });

  it("never names a private listing below the root", async () => {
    write("knowledge/index.md", ROOT_INDEX);
    write("knowledge/tables/index.md", "---\nvisibility: private\n---\n# Secret tables\n");

    expect((await sectionFor("knowledge/tables"))?.body).not.toContain("tables/index.md");
  });

  it("names a listing too long to quote rather than cutting it", async () => {
    const lines = Array.from(
      { length: 200 },
      (_, n) => `* [Concept ${n}](concept-${n}.md) - The concept numbered ${n}`,
    );
    write("knowledge/index.md", `---\nokf_version: "0.2"\n---\n# Knowledge\n\n${lines.join("\n")}\n`);

    const body = (await sectionFor("knowledge"))?.body ?? "";

    expect(body).toContain("The bundle's listing is `knowledge/index.md`, too long to quote here");
    expect(body).not.toContain("Concept 0");
    expect(body.length).toBeLessThanOrEqual(CONTEXT_SECTION_LIMIT);
  });

  it("fences the listing past any run of backticks inside it", async () => {
    write("knowledge/index.md", '---\nokf_version: "0.2"\n---\n# Knowledge\n\n```sql\nSELECT 1\n```\n');

    expect((await sectionFor("knowledge"))?.body).toContain("````markdown\n# Knowledge\n\n```sql\nSELECT 1\n```\n````");
  });

  it("says when the listing lists nothing", async () => {
    write("knowledge/index.md", '---\nokf_version: "0.2"\n---\n');

    expect((await sectionFor("knowledge"))?.body).toContain(
      "The bundle's listing, `knowledge/index.md`, lists nothing yet.",
    );
  });

  it("tells the model when the bundle declares another version", async () => {
    write("knowledge/index.md", '---\nokf_version: "0.3"\n---\n# Knowledge\n');

    expect((await sectionFor("knowledge"))?.body).toContain(
      "The bundle declares OKF 0.3, and these notes describe 0.2: where the bundle's own files disagree with them, follow the files.",
    );
  });

  it("reads an unquoted version as the same one", async () => {
    write("knowledge/index.md", "---\nokf_version: 0.2\n---\n# Knowledge\n");

    const body = (await sectionFor("knowledge"))?.body;

    expect(body).toContain("Follow OKF 0.2");
    expect(body).not.toContain("The bundle declares OKF");
  });

  it("dates its notes with the writer's own day", async () => {
    write("knowledge/index.md", ROOT_INDEX);

    expect((await sectionFor("knowledge"))?.body).toContain("Today is 2026-10-29.");
  });
});
