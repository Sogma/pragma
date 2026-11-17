import { expect, test } from "@playwright/test";
import { treeRow } from "./tree.ts";

// Math in reading view, typeset by the bundled MathJax: its fonts come from
// the app's own server, and nothing asks any other, since no data leaves
// unless the person sets something up.
test("typesets a note's math in reading view from the app's own files", async ({ page, request, baseURL }) => {
  const name = `math-${Date.now()}.md`;
  const content = "Euler: $e^{i\\pi} + 1 = 0$, not $5 or $10.\n\n$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$\n";
  const created = await request.post("/api/space/create", { data: { parentPath: "", name, type: "file", content } });
  expect(created.ok()).toBe(true);

  const elsewhere: string[] = [];
  const fonts: string[] = [];
  page.on("request", (sent) => {
    const url = sent.url();
    if (!url.startsWith(`${baseURL}/`) && !/^(data|blob):/.test(url)) elsewhere.push(url);
    if (/mjx-tex-[a-z0-9]+.*\.woff2/.test(url)) fonts.push(url);
  });

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const toggle = page.locator(".editor-toolbar-reading-toggle");
  await toggle.click();
  const reading = page.locator(".editor-reading-content");
  await expect(reading.locator("span.math > mjx-container")).toHaveCount(1);
  await expect(reading.locator("div.math > mjx-container[display]")).toHaveCount(1);
  await expect(reading.locator("p").first()).toContainText("not $5 or $10.");
  await expect(reading.locator(".math.is-pending")).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some((face) => face.family.includes("MJX-TEX") && face.status === "loaded"),
      ),
    )
    .toBe(true);
  expect(fonts.length).toBeGreaterThan(0);
  expect(elsewhere).toEqual([]);

  // Reading view is the group's, and the suite's later files edit there.
  await toggle.click();
  await expect(page.locator(".editor-cm")).toBeVisible();
});
