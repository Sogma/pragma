// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryRow, Tab } from "../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../web/core/libraries.ts";
import { wireWindowTitle } from "../../../web/view/windowTitle.ts";

const library = (id: string, label: string) => ({ id, label }) as LibraryRow;

// Wired once, as the app wires it: library names reach every title ever
// wired, so a second wiring would draw over the first.
const focusListeners = new Set<(tab: Tab) => void>();
const showMoved = wireWindowTitle("Pragma", {
  onFocus(listener) {
    focusListeners.add(listener);
    return () => focusListeners.delete(listener);
  },
});
const focus = (tab: Tab) => {
  for (const listener of focusListeners) listener(tab);
};

afterEach(() => setLibraryPermissions([]));

describe("window title", () => {
  it("names a library file by its library and its path inside it", () => {
    setLibraryPermissions([library("03-misc", "Art")]);
    focus({ kind: "image", path: "lib:03-misc/Misc_51/file.jpg" });
    expect(document.title).toBe("Art: Misc_51/file.jpg | Pragma");
    focus({ kind: "gallery", path: "lib:03-misc" });
    expect(document.title).toBe("Art | Pragma");
  });

  it("ends every title in the app's name, which a blank tab shows alone", () => {
    focus({ kind: "image", path: "photos/a.jpg" });
    expect(document.title).toBe("photos/a.jpg | Pragma");
    focus({ kind: "gallery", path: "" });
    expect(document.title).toBe("Space | Pragma");
    focus({ kind: "empty" });
    expect(document.title).toBe("Pragma");
  });

  it("follows the library's name when it arrives or changes after the tab shows", () => {
    focus({ kind: "image", path: "lib:03-misc/Misc_51/file.jpg" });
    expect(document.title).toBe("03-misc: Misc_51/file.jpg | Pragma");
    setLibraryPermissions([library("03-misc", "Art")]);
    expect(document.title).toBe("Art: Misc_51/file.jpg | Pragma");
    setLibraryPermissions([library("03-misc", "Stills")]);
    expect(document.title).toBe("Stills: Misc_51/file.jpg | Pragma");
  });

  it("follows the focused file to where it moved", () => {
    setLibraryPermissions([library("03-misc", "Art")]);
    focus({ kind: "image", path: "lib:03-misc/Misc_51/file.jpg" });
    showMoved("lib:03-misc/Misc_52/file.jpg");
    expect(document.title).toBe("Art: Misc_52/file.jpg | Pragma");
    setLibraryPermissions([library("03-misc", "Stills")]);
    expect(document.title).toBe("Stills: Misc_52/file.jpg | Pragma");
  });
});
