import { expect, it } from "vitest";
import { framePermits } from "../../electron/permissions.ts";

it("grants the window's own page what it asks for", () => {
  for (const permission of ["clipboard-read", "clipboard-sanitized-write", "local-fonts", "fullscreen"]) {
    expect(framePermits(permission, true)).toBe(true);
  }
});

it("grants a frame inside the page fullscreen and nothing else", () => {
  expect(framePermits("fullscreen", false)).toBe(true);
  for (const permission of ["media", "geolocation", "clipboard-read", "notifications", "openExternal", "unknown"]) {
    expect(framePermits(permission, false)).toBe(false);
  }
});
