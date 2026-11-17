import { expect, type Locator, test } from "@playwright/test";
import { treeRow } from "./tree.ts";

// The number of the first "Line N" row under the editor's top edge, two
// frames on, once the editor has drawn the lines a scroll showed.
async function topLine(group: Locator): Promise<number> {
  return group.evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scroller = element.querySelector(".editor-document.has-title") ?? element.querySelector(".cm-scroller");
    if (!scroller) return 0;
    const edge = scroller.getBoundingClientRect().top;
    for (const row of element.querySelectorAll(".cm-line")) {
      const match = row.textContent?.match(/^Line (\d+)/);
      if (match && row.getBoundingClientRect().top >= edge - 1) return Number(match[1]);
    }
    return 0;
  });
}

test("reopens a note where it was left, the keyboard in it at the caret", async ({ page, request }) => {
  const name = `launch-${Date.now()}.md`;
  const lines = Array.from({ length: 150 }, (_, index) => `Line ${index + 1}`).join("\n\n");
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: `# Long\n\n${lines}\n` },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const group = page.locator("#editor-groups > .editor-group").first();
  await expect(group.locator(".cm-line", { hasText: /^Line 1$/ })).toBeVisible();
  await group.locator(".editor-document").evaluate((scroller) => {
    scroller.scrollTop = 2400;
  });
  const top = await topLine(group);
  expect(top).toBeGreaterThan(20);
  const caretLine = `Line ${top + 3}`;
  await group.locator(".cm-line", { hasText: new RegExp(`^${caretLine}$`) }).click();
  await page.keyboard.press("End");

  // Written to the saved layout once the scroll and caret have settled.
  await expect
    .poll(async () => {
      const layout = await (await request.get("/api/space/layout")).json();
      const tabs = layout.groups.flatMap((saved: { tabs: { path?: string; place?: unknown }[] }) => saved.tabs);
      return tabs.find((tab: { path?: string }) => tab.path === name)?.place?.caret?.column;
    })
    .toBe(caretLine.length);

  await page.reload();
  await expect(group.locator(".cm-content")).toBeFocused();
  await expect.poll(() => topLine(group)).toBe(top);
  await page.keyboard.type("!");
  await expect(group.locator(".cm-line", { hasText: `${caretLine}!` })).toBeVisible();
});
