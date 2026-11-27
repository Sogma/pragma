// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ClassLinkUse } from "../../../src/protocol/class.ts";
import { createLinksPopover, type LinksOwner } from "../../../web/lib/linksPopover.ts";

// The popover a Links button opens on a Class's toolbar or a Table's: each
// link under what it gives, worded by its owner, and a file added or removed.

const USES: Record<string, ClassLinkUse> = { flow: "toolkit", md: "template", png: "reference" };

function setup(owner: LinksOwner, initial: string[] = []) {
  const links = [...initial];
  const change = vi.fn((edit: (links: string[]) => void) => edit(links));
  let picked: ((link: string) => void) | undefined;
  const droppedFile = vi.fn<(event: DragEvent) => { link: string } | { refused: string } | undefined>();
  const panel = createLinksPopover({
    owner,
    links: () => links,
    change,
    pickFile: (_anchor, pick) => {
      picked = pick;
    },
    droppedFile,
    describeLink: (link) => ({
      use: USES[link.split(".").at(-1) ?? ""] ?? "reference",
      icon: { glyph: "file" } as never,
      name: link.replace(/\..*$/, ""),
      path: link,
    }),
    resized: vi.fn(),
  });
  document.body.replaceChildren(panel);
  const pick = (link: string) => {
    panel.querySelector<HTMLButtonElement>(".class-popover-add")?.click();
    picked?.(link);
  };
  const headings = () => [...panel.querySelectorAll(".class-popover-heading")].map((each) => each.textContent);
  const names = () => [...panel.querySelectorAll(".class-link-name")].map((each) => each.textContent);
  return { panel, links, change, pick, droppedFile, headings, names };
}

describe("createLinksPopover", () => {
  it("lists a Class's links under what each gives the notes it holds", () => {
    const { headings, names } = setup("class", ["make.flow", "intro.md", "board.png"]);
    expect(headings()).toEqual([
      "Flows · buttons in each note's Tools tab",
      "Templates · New note starts from one",
      "Files · in each note's Links tab",
    ]);
    expect(names()).toEqual(["make", "intro", "board"]);
  });

  it("words a Table's for the Flows it links, a file of another kind still listed to remove", () => {
    const { panel, headings } = setup("table", ["make.flow", "board.png"]);
    expect(headings()).toEqual(["Flows · buttons in the Tools tab", "Other files · nothing in a Table"]);
    expect(panel.querySelector(".class-popover-add")?.textContent).toBe("+ Add Flow");
    const empty = setup("table");
    expect(empty.panel.textContent).toContain(
      "A Flow's buttons show in the Tools tab while this Table is open, and run on the rows selected.",
    );
  });

  it("adds a picked file once, and removes one, redrawing after each", () => {
    const { links, pick, panel, names } = setup("table", ["make.flow"]);
    pick("cut.flow");
    pick("cut.flow");
    expect(links).toEqual(["make.flow", "cut.flow"]);
    expect(names()).toEqual(["make", "cut"]);
    panel.querySelector<HTMLButtonElement>(".class-link .class-icon-button")?.click();
    expect(links).toEqual(["cut.flow"]);
    expect(names()).toEqual(["cut"]);
  });

  it("adds a file dropped from the tree, and says why one is refused", () => {
    const { panel, links, droppedFile } = setup("table");
    const drop = () => panel.dispatchEvent(new Event("drop", { cancelable: true }));
    droppedFile.mockReturnValueOnce({ link: "make.flow" });
    drop();
    expect(links).toEqual(["make.flow"]);
    droppedFile.mockReturnValueOnce({ refused: "A Table links Flows." });
    drop();
    const refusal = panel.querySelector<HTMLElement>(".class-popover-error");
    expect([refusal?.hidden, refusal?.textContent]).toEqual([false, "A Table links Flows."]);
  });
});
