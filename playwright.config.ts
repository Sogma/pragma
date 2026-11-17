import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./test/e2e/port.ts";

// A thin smoke suite, not exhaustive UI coverage — see test/e2e/smoke.spec.ts.
// Assertions stay at the rendered-DOM/user-visible level on purpose: the one
// layer that stays meaningful however the panes are built underneath.
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  // One worker, not one per file: every test drives the one space
  // globalSetup serves, so two files at once would restore each other's tabs.
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
  },
  globalSetup: "./test/e2e/globalSetup.ts",
});
