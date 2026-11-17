import { expect, test } from "@playwright/test";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { treeRow } from "./tree.ts";

// A toolkit button whose click ends in Open to the Side (docs/architecture.md's
// Files and views section): the file opens in the other group, and focus stays in the
// document the button was clicked in.
test("opens a file to the side from a toolkit button, leaving focus in the document", async ({ page, request }) => {
  const stamp = Date.now();
  const tag = `opener${stamp}`;
  const create = async (name: string, content: string) => {
    const created = await request.post("/api/space/create", { data: { parentPath: "", name, type: "file", content } });
    expect(created.ok()).toBe(true);
  };
  await create(`guide-${stamp}.md`, "# Guide\n\nThe house style.\n");
  await create(`draft-${stamp}.md`, `---\ntags: [${tag}]\n---\n\n# Draft\n\nSome text.\n`);
  // The Button hands on only its document's path, so the click asks for
  // nothing: no grant prompt stands between it and the open.
  await create(
    `opener-${stamp}.flow.html`,
    serializeFlowFile({
      version: "1.0",
      name: "Opener",
      graph: {
        nodes: [
          { id: "button-1", type: "button", position: { x: 0, y: 0 }, config: {}, label: "Open guide" },
          {
            id: "resolvePath-1",
            type: "resolvePath",
            position: { x: 300, y: 0 },
            config: { path: `guide-${stamp}.md` },
          },
          { id: "openToSide-1", type: "openToSide", position: { x: 600, y: 0 }, config: {} },
        ],
        edges: [
          { id: "e1", source: "button-1", sourcePort: "path", target: "resolvePath-1", targetPort: "base" },
          { id: "e2", source: "resolvePath-1", sourcePort: "path", target: "openToSide-1", targetPort: "path" },
        ],
      },
    }),
  );
  await create(
    `opener-${stamp}.class.html`,
    serializeClassFile({
      version: "1.0",
      filter: [{ property: "tags", test: "has", values: [tag] }],
      fields: [],
      views: [],
      links: [`opener-${stamp}.flow.html`],
    }),
  );

  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  const strips = page.locator("#header-tabs > .editor-group-tabs");
  await (await treeRow(page, `draft-${stamp}.md`)).click();
  if (!(await page.locator("#assistant").isVisible())) await page.locator("#header-assistant-toggle").click();
  await page.locator("#inspector-tab-tools").click();
  await page.locator("#button-list .run-button", { hasText: "Open guide" }).click();

  await expect(groups).toHaveCount(2);
  // Flashed for a moment, so the eye finds where it went.
  await expect(strips.nth(1).locator(".editor-tab.active")).toHaveClass(/flash/);
  await expect(strips.nth(1).locator(".editor-tab.active")).toContainText(`guide-${stamp}`);
  await expect(strips.nth(0).locator(".editor-tab.active")).toContainText(`draft-${stamp}`);
  await expect(strips.nth(0)).not.toHaveClass(/unfocused/);
  await expect(strips.nth(1)).toHaveClass(/unfocused/);

  // Back to one group, as the tests after expect.
  await strips.nth(1).locator(".editor-tab-close").click();
  await expect(groups).toHaveCount(1);
});
