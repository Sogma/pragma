import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { treeRow } from "./tree.ts";

// The History section under the tree, opened whatever state an earlier test
// left it in, and one file's versions there.
async function versionsOf(page: Page, name: string) {
  const toggle = page.locator(".stack-section-header", { hasText: "History" }).locator(".stack-section-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const file = page.locator(".history-file").filter({ has: page.locator(".node-name", { hasText: name }) });
  await file.locator(":scope > .node-label").click();
  return file.locator(".history-version > .node-label");
}

// The suite shares one layout, and the tests after these expect a group of
// one tab: every tab but the active one closes, and the layout has saved.
async function closeOthers(page: Page) {
  await page.locator(".editor-tab.active").click({ button: "right" });
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/space/layout"));
  await page.locator(".context-menu button", { hasText: "Close others" }).click();
  await saved;
}

// A note whose one save kept its first text as a version.
async function noteWithOneVersion(request: APIRequestContext, name: string) {
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name: `${name}.md`, type: "file", content: "# Plan\n\nfirst draft\n" },
  });
  expect(created.ok()).toBe(true);
  const saved = await request.put(`/api/file?path=${name}.md`, { data: { content: "# Plan\n\nsecond draft\n" } });
  expect(saved.ok()).toBe(true);
}

test("compares a version with the file, and restores it as an edit Undo takes back", async ({ page, request }) => {
  const name = `history-${Date.now()}`;
  await noteWithOneVersion(request, name);

  await page.goto("/");
  await (await treeRow(page, `${name}.md`)).click();
  const editor = page.locator(".editor-cm");
  await expect(editor).toContainText("second draft");

  const version = (await versionsOf(page, name)).first();
  await expect(version.locator(".history-source")).toHaveText("Edited");
  await version.click();

  // Beside the file's own tab, the version's lines taken out and the file's put in.
  const labels = page.locator(".editor-tab .editor-tab-label");
  await expect(labels.filter({ hasText: new RegExp(`^${name}( \\(.+\\))?$`) })).toHaveCount(2);
  const pane = page.locator(".editor-version");
  await expect(pane.locator(".diff-line-remove .diff-text")).toHaveText(["first draft"]);
  await expect(pane.locator(".diff-line-add .diff-text")).toHaveText(["second draft"]);

  await page.locator(".version-restore-button").click();
  await expect(page.locator(".editor-tab.active .editor-tab-label")).toHaveText(name);
  await expect(editor).toContainText("first draft");
  // The text the restore replaced is a version of its own, under its name.
  await expect(async () => {
    const { versions } = await (await request.get(`/api/history/file?path=${name}.md`)).json();
    expect(versions.map((each: { source: string }) => each.source)).toEqual(["restored", "edit"]);
  }).toPass();

  await editor.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText("second draft");
  await closeOthers(page);
});

test("brings back a deleted file from its version", async ({ page, request }) => {
  const name = `history-gone-${Date.now()}`;
  await noteWithOneVersion(request, name);
  expect((await request.post("/api/space/delete", { data: { path: `${name}.md` } })).ok()).toBe(true);

  await page.goto("/");
  await (await versionsOf(page, name)).first().click();
  await expect(page.locator(".editor-version .version-note")).toHaveText(
    "The file has been deleted since. Restore brings it back with this text.",
  );

  await page.locator(".version-restore-button").click();
  await expect(page.locator(".editor-tab.active .editor-tab-label")).toHaveText(name);
  await expect(page.locator(".editor-cm")).toContainText("first draft");
  const restored = await (await request.get(`/api/file?path=${name}.md`)).json();
  expect(restored.content).toBe("# Plan\n\nfirst draft\n");
  await closeOthers(page);
});
