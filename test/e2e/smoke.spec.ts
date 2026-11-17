import { expect, type Locator, test } from "@playwright/test";
import { openFolder, treeRow } from "./tree.ts";

test("loads a space, opens a markdown document, and edits it", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#tree-space-name-label")).not.toBeEmpty();
  // Where the space is, then what it holds.
  await expect(page.locator("#tree-space-name")).toHaveAttribute(
    "data-tooltip",
    /^.+\n[\d,]+ files?, [\d,]+ folders?$/,
  );
  const readme = page.locator('.node-label[data-path="README.md"]');
  await expect(readme).toBeVisible();

  await readme.click();
  const editor = page.locator(".editor-cm");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("This is a Pragma space");

  // CodeMirror 6 mounts a contenteditable `.cm-content` inside .editor-cm —
  // click into it to focus before typing, rather than assuming the click
  // that opened the tab also placed keyboard focus in the editor.
  await editor.locator(".cm-content").click();
  await page.keyboard.type(" — edited by the smoke test");
  await expect(editor).toContainText("edited by the smoke test");
});

test("opens a .table.html document as a table pane", async ({ page }) => {
  await page.goto("/");

  await openFolder(page, "projects/getting-started");
  const tableEntry = page.locator('.node-label[data-path="projects/getting-started/writing-prompts.table.html"]');
  await expect(tableEntry).toBeVisible();

  await tableEntry.click();
  const tablePane = page.locator(".editor-table");
  await expect(tablePane).toBeVisible();
  await expect(tablePane).toContainText("Prompt"); // column header, plain text
  // Row cells render as editable <input>s (data-table-form), so their
  // content lives in the value property, not text nodes — toContainText
  // above wouldn't see it. Scoped to the data table body specifically:
  // .editor-table also hosts its group's title bar, whose .editor-title-input
  // is an <input> too.
  await expect(tablePane.locator(".data-table tbody input").first()).toHaveValue("A locked door with no key");
});

test("renames a note from its tab's menu, the name typed in a dialog", async ({ page, request }) => {
  const name = `tab-rename-${Date.now()}`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name: `${name}.md`, type: "file", content: "# Tab rename\n\nText.\n" },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  await (await treeRow(page, `${name}.md`)).click();
  const label = page.locator(".editor-tab.active .editor-tab-label");
  await expect(label).toHaveText(name);

  await page.locator(".editor-tab.active").click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "Rename…" }).click();
  const dialog = page.locator(".dialog-panel");
  await expect(dialog.locator(".dialog-title")).toHaveText("Rename file");
  const field = dialog.locator("input");
  await expect(field).toHaveValue(name);
  await field.fill(`${name}-renamed`);
  await field.press("Enter");

  await expect(label).toHaveText(`${name}-renamed`);
  expect((await request.get(`/api/file?path=${name}-renamed.md`)).ok()).toBe(true);
  // The right-click focused the pill; the key that closed the dialog leaves
  // the text holding focus, not a ringed pill.
  await expect(page.locator(".editor-tab.active")).not.toBeFocused();
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("makes a note from an empty tab's New Note, at the space's top, in the tab's place", async ({ page, request }) => {
  const name = `empty-tab-note-${Date.now()}`;
  await page.goto("/");
  const pills = page.locator(".editor-group-tabs").first().locator(".editor-tab");
  await expect(pills.first()).toBeVisible();
  const before = await pills.count();
  await page.locator(".editor-group-new-tab").first().click();
  await expect(pills).toHaveCount(before + 1);

  await page.locator(".editor-empty-action", { hasText: "New Note" }).click();
  const dialog = page.locator(".dialog-panel");
  await expect(dialog.locator(".dialog-title")).toHaveText("New Note");
  const field = dialog.locator("input");
  await expect(field).toHaveAttribute("placeholder", "Note name");
  await field.fill(name);
  await field.press("Enter");

  await expect(page.locator(".editor-tab.active .editor-tab-label")).toHaveText(name);
  await expect(pills).toHaveCount(before + 1);
  await expect(await treeRow(page, `${name}.md`)).toBeVisible();
  expect((await request.get(`/api/file?path=${name}.md`)).ok()).toBe(true);
  // Later tests restore this layout, so the tab "+" opened goes again.
  await page.locator(".editor-tab.active .editor-tab-close").click();
  await expect(pills).toHaveCount(before);
});

// The open file's row is marked only while the focused tab shows that file.
test("unmarks the open file's row while a folder's gallery or a blank tab has focus", async ({ page, request }) => {
  const stamp = Date.now();
  const [folder, note] = [`folder-${stamp}`, `note-${stamp}`];
  for (const data of [
    { parentPath: "", name: folder, type: "directory" },
    { parentPath: folder, name: "inside.md", type: "file", content: "# Inside\n" },
    { parentPath: "", name: `${note}.md`, type: "file", content: "# Marked\n" },
  ]) {
    expect((await request.post("/api/space/create", { data })).ok()).toBe(true);
  }

  await page.goto("/");
  const marked = page.locator("#tree-nodes .node-label.active");
  const row = await treeRow(page, `${note}.md`);
  await row.click();
  await expect(row).toHaveClass(/\bactive\b/);
  const pills = page.locator(".editor-group-tabs").first().locator(".editor-tab");
  const before = await pills.count();

  await (await treeRow(page, folder)).click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "Open in new tab" }).click();
  await expect(page.locator(".editor-gallery")).toBeVisible();
  await expect(marked).toHaveCount(0);

  await pills.filter({ hasText: note }).click();
  await expect(row).toHaveClass(/\bactive\b/);

  await page.locator(".editor-group-new-tab").first().click();
  await expect(page.locator(".editor-empty-action").first()).toBeVisible();
  await expect(marked).toHaveCount(0);

  // Later tests restore this layout, so the tabs opened here go again.
  await page.locator(".editor-tab.active .editor-tab-close").click();
  await pills.filter({ hasText: folder }).click();
  await page.locator(".editor-tab.active .editor-tab-close").click();
  await expect(pills).toHaveCount(before);
});

// Rows Shift selects move together, and go to the Trash on one confirmation.
test("drags a Shift-selected run of rows into a folder, then trashes them from their menu", async ({
  page,
  request,
}) => {
  const folder = `selection-${Date.now()}`;
  const names = ["a", "b", "c"].map((letter) => `${folder} ${letter}.md`);
  const made = await request.post("/api/space/create", { data: { parentPath: "", name: folder, type: "directory" } });
  expect(made.ok()).toBe(true);
  for (const name of names) {
    const created = await request.post("/api/space/create", {
      data: { parentPath: "", name, type: "file", content: "# Note\n" },
    });
    expect(created.ok()).toBe(true);
  }

  await page.goto("/");
  await (await treeRow(page, names[0])).click();
  await (await treeRow(page, names[2])).click({ modifiers: ["Shift"] });
  await expect(page.locator("#tree-nodes .node-label.selected")).toHaveCount(3);

  const into = await treeRow(page, folder);
  await (await treeRow(page, names[1])).dragTo(into);
  const moved: Locator[] = [];
  for (const name of names) moved.push(await treeRow(page, `${folder}/${name}`));
  for (const entry of moved) await expect(entry).toBeVisible();

  await moved[0].click();
  await moved[2].click({ modifiers: ["Shift"] });
  await moved[1].click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "Move 3 Items to Trash" }).click();
  const dialog = page.locator(".dialog-panel");
  await expect(dialog.locator(".dialog-title")).toHaveText("Move 3 Items to Trash");
  await dialog.locator("button.dialog-primary").click();
  for (const entry of moved) await expect(entry).toHaveCount(0);
});
