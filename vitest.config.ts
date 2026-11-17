import { defineConfig } from "vitest/config";

// Everything but the Playwright smoke suite (test/e2e), which has its own
// runner and config (playwright.config.ts) so the two never fight over
// test-file naming. Node by default; a test that needs a DOM opts in with a
// `// @vitest-environment jsdom` header.
export default defineConfig({
  test: {
    include: [
      "test/cli/**/*.test.ts",
      "test/config/**/*.test.ts",
      "test/contract/**/*.test.ts",
      "test/electron/**/*.test.ts",
      "test/protocol/**/*.test.ts",
      "test/scripts/**/*.test.ts",
      "test/server/**/*.test.ts",
      "test/web/**/*.test.ts",
    ],
    environment: "node",
    // Vitest blanks every stylesheet it isn't told to process, a `?raw`
    // import's text included; the PDF frame's page takes this one as text.
    css: { include: [/styles\/scrollbars\.css/] },
  },
});
