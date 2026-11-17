import { describe, expect, it } from "vitest";
import type { ClockReading } from "../../src/protocol/datePlaceholders.ts";
import { parseFrontmatter } from "../../src/protocol/frontmatter.ts";
import {
  countTemplates,
  fillTemplate,
  findTemplate,
  isTemplatePath,
  readTemplates,
  startingName,
  type TemplateSource,
  templateEntryName,
  writesDate,
  writesTitle,
} from "../../src/protocol/templates.ts";

// A title alone, as most cases below fill.
const fillTitle = (fileName: string, content: string, title: string) => fillTemplate(fileName, content, { title });

// 09:05:07 on a Wednesday, two hours east of UTC.
const OCT_21: ClockReading = { year: 2026, month: 10, day: 21, hour: 9, minute: 5, second: 7, offset: 120 };

const file = (path: string): TemplateSource => ({ name: path.split("/").pop() ?? path, path, type: "file" });
const folder = (path: string, children: TemplateSource[]): TemplateSource => ({
  name: path.split("/").pop() ?? path,
  path,
  type: "directory",
  children,
});

describe("which paths are templates", () => {
  it("names the space's templates folder and what is in it", () => {
    expect(isTemplatePath("_templates")).toBe(true);
    expect(isTemplatePath("_templates/Scene.fountain")).toBe(true);
    expect(isTemplatePath("space:_templates/Scene.fountain")).toBe(true);
  });

  it("leaves out a folder that only starts the same, and a library's", () => {
    expect(isTemplatePath("_templates-old/Scene.fountain")).toBe(false);
    expect(isTemplatePath("projects/_templates/Scene.fountain")).toBe(false);
    expect(isTemplatePath("lib:shared/_templates/Scene.fountain")).toBe(false);
  });

  it("takes the folder in any case, as every name the protocol defines", () => {
    expect(isTemplatePath("_Templates/Scene.fountain")).toBe(true);
    expect(isTemplatePath("_TEMPLATES")).toBe(true);
  });
});

describe("reading _templates/", () => {
  it("lists files, folders with a README, and groups of either", () => {
    const entries = readTemplates([
      file("_templates/Meeting.md"),
      folder("_templates/Screenplay", [
        file("_templates/Screenplay/Scene.fountain"),
        folder("_templates/Screenplay/Project", [
          file("_templates/Screenplay/Project/README.md"),
          folder("_templates/Screenplay/Project/scenes", [
            file("_templates/Screenplay/Project/scenes/_scene.fountain"),
          ]),
        ]),
      ]),
    ]);
    expect(entries).toEqual([
      { kind: "file", name: "Meeting.md", path: "_templates/Meeting.md" },
      {
        kind: "group",
        name: "Screenplay",
        path: "_templates/Screenplay",
        entries: [
          { kind: "file", name: "Scene.fountain", path: "_templates/Screenplay/Scene.fountain" },
          { kind: "folder", name: "Project", path: "_templates/Screenplay/Project" },
        ],
      },
    ]);
    expect(countTemplates(entries)).toBe(3);
  });

  // The scene skeleton is copied with its project, never offered alone.
  it("ends the walk at the first README, so a template's subfolders are part of it", () => {
    const entries = readTemplates([
      folder("_templates/Project", [
        file("_templates/Project/README.md"),
        folder("_templates/Project/scenes", [file("_templates/Project/scenes/_scene.fountain")]),
      ]),
    ]);
    expect(entries).toEqual([{ kind: "folder", name: "Project", path: "_templates/Project" }]);
    expect(findTemplate(entries, "_templates/Project/scenes/_scene.fountain")).toBeUndefined();
  });

  it("takes no file Pragma reads where it sits for a template", () => {
    const entries = readTemplates([
      { ...file("_templates/_structure.json"), pragmaFile: "order" },
      file("_templates/_notes.json"),
    ]);
    expect(entries).toEqual([{ kind: "file", name: "_notes.json", path: "_templates/_notes.json" }]);
  });

  it("keeps the root's own README out, and leaves out a group with no template", () => {
    const entries = readTemplates([
      file("_templates/README.md"),
      folder("_templates/Empty", []),
      folder("_templates/Nested", [folder("_templates/Nested/Deeper", [])]),
    ]);
    expect(entries).toEqual([]);
  });

  it("finds a file or folder template by path, never a group", () => {
    const entries = readTemplates([folder("_templates/Notes", [file("_templates/Notes/Daily.md")])]);
    expect(findTemplate(entries, "_templates/Notes/Daily.md")).toEqual({
      kind: "file",
      name: "Daily.md",
      path: "_templates/Notes/Daily.md",
    });
    expect(findTemplate(entries, "_templates/Notes")).toBeUndefined();
  });
});

describe("filling in {{$title}}", () => {
  it("fills a Markdown body and a Fountain file throughout, in any case", () => {
    expect(fillTitle("Note.md", "# {{$title}}\n\nAbout {{$Title}}.\n", "Opening")).toBe(
      "# Opening\n\nAbout Opening.\n",
    );
    expect(fillTitle("Scene.fountain", "Title: {{$TITLE}}\n\nINT. ROOM - DAY\n", "Opening")).toBe(
      "Title: Opening\n\nINT. ROOM - DAY\n",
    );
  });

  it("fills a title only where a $ marks it", () => {
    expect(fillTitle("Note.md", "# {{title}}\n\nAbout {{$title}}.\n", "Opening")).toBe(
      "# {{title}}\n\nAbout Opening.\n",
    );
    expect(fillTitle("Note.md", "---\nname: {{title}}\nalias: {{$title}}\n---\n", "Opening")).toBe(
      "---\nname: {{title}}\nalias: Opening\n---\n",
    );
  });

  it("leaves another placeholder, one with spaces inside, and every other kind as written", () => {
    const text = "{{ $title }} on {{$date}}\n";
    expect(fillTitle("Note.md", text, "Opening")).toBe(text);
    expect(fillTitle("Shots.table.html", "<title>{{$title}}</title>", "Opening")).toBe("<title>{{$title}}</title>");
  });

  it("keeps the title's own characters, `$&` included", () => {
    expect(fillTitle("Note.md", "# {{$title}}\n", "Cost $& $1 Benefit")).toBe("# Cost $& $1 Benefit\n");
  });

  it("fills frontmatter values as YAML, so a colon stays valid", () => {
    const filled = fillTitle(
      "Note.md",
      '---\ntitle: "{{$title}}"\nstatus: draft\n---\n\n# {{$title}}\n',
      "Part 1: Intro",
    );
    expect(parseFrontmatter(filled).data).toEqual({ title: "Part 1: Intro", status: "draft" });
    expect(filled.endsWith("\n\n# Part 1: Intro\n")).toBe(true);
    expect(filled).toContain("status: draft\n");
  });

  // YAML reads an unquoted `{{$title}}` as a map holding a map.
  it("fills a bare value and a bare list item too", () => {
    const filled = fillTitle(
      "Note.md",
      "---\ntitle: {{$title}}  # shown\naliases:\n  - {{$title}}\n---\n\nBody\n",
      "A: B",
    );
    expect(parseFrontmatter(filled).data).toEqual({ title: "A: B", aliases: ["A: B"] });
    expect(filled).toContain("# shown");
  });

  it("leaves frontmatter that doesn't parse as written, and still fills the body", () => {
    const content = "---\ntitle: [unclosed\n---\n\n# {{$title}}\n";
    expect(fillTitle("Note.md", content, "Opening")).toBe("---\ntitle: [unclosed\n---\n\n# Opening\n");
  });

  it("touches nothing outside the placeholders", () => {
    const content = "---\n# kept comment\ncreated: 2026-09-01\nname: {{$title}}\n---\n\n\nBody {{$title}}\n";
    const filled = fillTitle("Note.md", content, "Opening");
    expect(filled).toContain("# kept comment\ncreated: 2026-09-01\n");
    expect(filled.endsWith("---\n\n\nBody Opening\n")).toBe(true);
    expect(fillTitle("Note.md", "---\ncreated: 2026-09-01\n---\n\n\nBody {{$title}}\n", "Opening")).toBe(
      "---\ncreated: 2026-09-01\n---\n\n\nBody Opening\n",
    );
  });

  it("fills {{$date}} with the day, in any case, and leaves a format with no directive as written", () => {
    expect(fillTemplate("Daily.md", "# {{$date}}\n\nOn {{$DATE}}, {{$date:YYYY}}.\n", { date: OCT_21 })).toBe(
      "# 2026-10-21\n\nOn 2026-10-21, {{$date:YYYY}}.\n",
    );
    expect(fillTemplate("Daily.md", "{{$title}} on {{$date}}\n", { date: OCT_21 })).toBe("{{$title}} on 2026-10-21\n");
  });

  it("fills {{$date:FORMAT}} with the writer's moment", () => {
    expect(fillTemplate("Daily.md", "# {{$date:%A, %B %-d}}\n\nAt {{$date:%H:%M}}.\n", { date: OCT_21 })).toBe(
      "# Wednesday, October 21\n\nAt 09:05.\n",
    );
    expect(fillTemplate("Scene.fountain", "Title: {{$date:%G-W%V}}\n", { date: OCT_21 })).toBe("Title: 2026-W43\n");
  });

  it("keeps a placeholder the typed title brings, filling in one pass", () => {
    expect(fillTemplate("Note.md", "# {{$title}}\n", { title: "On {{$date}}", date: OCT_21 })).toBe("# On {{$date}}\n");
  });

  it("writes a frontmatter date as the day itself, bare or quoted", () => {
    for (const value of ["{{$date}}", '"{{$date}}"']) {
      const filled = fillTemplate("Daily.md", `---\ndate: ${value}\n---\n\n# {{$date}}\n`, { date: OCT_21 });
      expect(filled).toBe("---\ndate: 2026-10-21\n---\n\n# 2026-10-21\n");
    }
  });

  it("fills a formatted date in frontmatter, bare or quoted, and keeps one it can't", () => {
    for (const value of ["{{$date:%d %b %Y}}", '"{{$date:%d %b %Y}}"']) {
      const filled = fillTemplate("Daily.md", `---\nday: ${value}\n---\n\nBody\n`, { date: OCT_21 });
      expect(parseFrontmatter(filled).data.day).toBe("21 Oct 2026");
    }
    const kept = "---\nday: {{$date:YYYY}}\nseen: {{$date}}\n---\n\nBody\n";
    expect(fillTemplate("Daily.md", kept, { date: OCT_21 })).toContain("day: {{$date:YYYY}}\n");
  });

  it("says whether a template keeps a title anywhere", () => {
    expect(writesTitle("Note.md", "# {{$title}}\n")).toBe(true);
    expect(writesTitle("Note.md", "---\ntitle: {{$title}}\n---\n\nBody\n")).toBe(true);
    expect(writesTitle("Note.md", "# Untitled\n")).toBe(false);
    expect(writesTitle("Scene.fountain", "Title: {{$title}}\n")).toBe(true);
    expect(writesTitle("Shots.table.html", "<title>{{$title}}</title>")).toBe(false);
    expect(writesDate("Daily.md", "---\ndate: {{$date}}\n---\n\nBody\n")).toBe(true);
    expect(writesDate("Daily.md", "# {{$title}}\n")).toBe(false);
    expect(writesDate("Daily.md", "# {{$date:%A}}\n")).toBe(true);
    expect(writesDate("Daily.md", "# {{$date:dddd}}\n")).toBe(false);
  });

  // A dated template with no title has nothing to ask for but its day.
  it("starts a copy's name at the day only for a template with a date and no title", () => {
    expect(startingName({ title: false, date: true }, "2026-10-21")).toBe("2026-10-21");
    expect(startingName({ title: true, date: true }, "2026-10-21")).toBe("");
    expect(startingName({ title: false, date: false }, "2026-10-21")).toBe("");
  });
});

describe("naming a copy", () => {
  const scene = { name: "Scene.fountain", type: "file" as const };
  const shots = { name: "Shot list.table.html", type: "file" as const };
  const project = { name: "Project", type: "directory" as const };

  it("adds the template's whole extension, once", () => {
    expect(templateEntryName("Opening", scene, false)).toEqual({ name: "Opening.fountain", title: "Opening" });
    expect(templateEntryName(" Opening.fountain ", scene, false)).toEqual({
      name: "Opening.fountain",
      title: "Opening",
    });
    expect(templateEntryName("Ep 1", shots, false)).toEqual({ name: "Ep 1.table.html", title: "Ep 1" });
    expect(templateEntryName("Forbidden", project, false)).toEqual({ name: "Forbidden", title: "Forbidden" });
  });

  it("derives a name from a title no file can carry, only where the template keeps the title", () => {
    expect(templateEntryName("Part 1: Intro", scene, true)).toEqual({
      name: "Part 1 - Intro.fountain",
      title: "Part 1: Intro",
    });
    expect(templateEntryName("Part 1: Intro", scene, false)).toEqual({
      refused: "A name can't contain < > : \" | ? * or control characters",
    });
  });

  it("refuses an empty name and one holding a path", () => {
    for (const typed of ["", "   ", ".", "..", "a/b", "a\\b"]) {
      expect(templateEntryName(typed, project, true)).toEqual({ refused: "Invalid name" });
    }
  });
});
