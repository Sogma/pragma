// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { GitStatus } from "../../../../web/core/apiClient.ts";
import { railStatusOf } from "../../../../web/view/sidebar/sourceControl.ts";

const repo = (files: number, ahead = 0, behind = 0): GitStatus => ({
  isRepo: true,
  branch: "main",
  ahead,
  behind,
  files: Array.from({ length: files }, (_, i) => ({ path: `${i}.md`, statusCode: " M" })),
});

describe("railStatusOf", () => {
  it("counts uncommitted files on the badge, with the branch and sync state in the detail", () => {
    expect(railStatusOf({ phase: "ready", status: repo(3, 1) })).toEqual({
      badge: { text: "3", tone: "count" },
      detail: "On main · 3 uncommitted changes · 1 to push",
    });
  });

  it("shows no badge for a clean tree, and still says where it stands", () => {
    expect(railStatusOf({ phase: "ready", status: repo(0) })).toEqual({
      badge: undefined,
      detail: "On main · working tree clean, in sync",
    });
    expect(railStatusOf({ phase: "ready", status: repo(0, 0, 2) }).detail).toBe("On main · 2 to pull");
  });

  it("caps the count so the pill fits the rail", () => {
    expect(railStatusOf({ phase: "ready", status: repo(120) }).badge?.text).toBe("99+");
  });

  it("marks restricted mode as a warning", () => {
    const status = railStatusOf({ phase: "ready", status: { isRepo: true, restricted: true, trust: "undecided" } });
    expect(status.badge).toEqual({ text: "!", tone: "warning" });
    expect(status.detail).toMatch(/Restricted mode/);
  });

  it("shows nothing outside a repo or before the first read, and the last status after a failed one", () => {
    expect(railStatusOf({ phase: "ready", status: { isRepo: false } })).toEqual({});
    expect(railStatusOf({ phase: "loading" })).toEqual({});
    expect(railStatusOf({ phase: "error", message: "offline", last: repo(2) }).badge?.text).toBe("2");
  });
});
