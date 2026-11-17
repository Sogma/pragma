import { expect, type Locator, type Page } from "@playwright/test";

// The space tree draws only the rows near its viewport (fileTreeView.ts), so
// a row far down a long tree is not on the page at all, and a click has
// nothing to scroll to. The tree is scrolled a screen at a time from the top,
// as a person looks for a row, until the row is drawn.
export async function treeRow(page: Page, path: string): Promise<Locator> {
  const selector = `.node-label[data-path="${path}"]`;
  await expect
    .poll(
      () =>
        page.locator("#tree-nodes").evaluate(async (tree, selector) => {
          if (tree.querySelector(selector)) return true;
          if (tree.clientHeight === 0) return false;
          for (let top = 0; top < tree.scrollHeight; top += tree.clientHeight) {
            tree.scrollTop = top;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (tree.querySelector(selector)) return true;
          }
          return false;
        }, selector),
      { message: `the tree draws ${path}` },
    )
    .toBe(true);
  return page.locator(`#tree-nodes ${selector}`);
}

// A space opens with only its top-level folders open, and a fold one test
// makes is saved for the next, so a folder is clicked only while it is shut:
// a click on an open one folds it.
export async function openFolder(page: Page, path: string): Promise<void> {
  const label = await treeRow(page, path);
  const row = label.locator("..");
  if (await row.evaluate((item) => item.classList.contains("collapsed"))) await label.click();
  await expect(row).not.toHaveClass(/\bcollapsed\b/);
}
