import { describe, expect, it, vi } from "vitest";
import type { LibraryRow } from "../../../web/core/apiClient.ts";
import { libraryName, onLibraryNames, setLibraryPermissions } from "../../../web/core/libraries.ts";

const row = (id: string, name: string): LibraryRow => ({
  id,
  label: name,
  path: `/media/${id}`,
  access: "read-only",
  missing: false,
});

describe("library names", () => {
  // Every listing passes through here, and most change no name at all.
  it("tells its listeners only when a listing changes what a library is called", () => {
    const listener = vi.fn();
    const stop = onLibraryNames(listener);
    setLibraryPermissions([row("footage", "Footage")]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(libraryName("footage")).toBe("Footage");

    setLibraryPermissions([row("footage", "Footage")]);
    expect(listener).toHaveBeenCalledTimes(1);

    setLibraryPermissions([row("footage", "Archive")]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(libraryName("footage")).toBe("Archive");

    setLibraryPermissions([]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(libraryName("footage")).toBeUndefined();

    stop();
    setLibraryPermissions([row("footage", "Footage")]);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
