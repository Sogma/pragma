import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DefaultAppHost,
  defaultAppTarget,
  riskyTypeRefusal,
  systemExtension,
  systemTarget,
} from "../../src/server/defaultApp.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

let space: string;

const trusted: DefaultAppHost = { trusted: true, platform: "linux" };

// A library path reads the install's registry, so the config directory is a
// throwaway one rather than the developer's own.
beforeEach(() => {
  space = tempDir("pragma-default-app-");
  isolateConfig();
});

function file(name: string, mode = 0o644, contents: string | Uint8Array = "bytes"): string {
  const target = path.join(space, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  chmodSync(target, mode);
  return target;
}

describe("systemExtension", () => {
  it("reads the last extension in lower case", () => {
    expect(systemExtension("Setup.EXE")).toBe("exe");
    expect(systemExtension("report.pdf.exe")).toBe("exe");
    expect(systemExtension("archive.tar.gz")).toBe("gz");
  });

  it("drops the trailing dots and spaces Windows ignores", () => {
    expect(systemExtension("run.bat.")).toBe("bat");
    expect(systemExtension("run.bat . ")).toBe("bat");
  });

  it("finds none in a dotless name or a dotfile", () => {
    expect(systemExtension("Makefile")).toBe("");
    expect(systemExtension(".bashrc")).toBe("");
  });
});

describe("riskyTypeRefusal", () => {
  it.each([
    "a.exe",
    "a.bat",
    "a.cmd",
    "a.ps1",
    "a.js",
    "a.vbs",
    "a.lnk",
    "a.url",
    "a.msi",
    "a.jar",
    "a.sh",
    "a.command",
    "a.app",
    "a.pkg",
    "a.dmg",
    "a.desktop",
    "a.deb",
    "a.iso",
    "a.hta",
    "a.reg",
    "a.docm",
    "a.xlsm",
    "a.rdp",
    "a.appinstaller",
    "a.vsix",
  ])("blocks %s", (name) => {
    expect(riskyTypeRefusal(name)).toBe(`Blocked: ${name.slice(1)} files can run code`);
  });

  it.each(["a.zip", "a.docx", "a.xlsx", "a.csv", "a.txt", "a.json", "a.html", "a.psd", "a.mp3", "Makefile"])(
    "lets %s through",
    (name) => {
      expect(riskyTypeRefusal(name)).toBeUndefined();
    },
  );

  it("blocks whatever PATHEXT runs, however it is written", () => {
    expect(riskyTypeRefusal("tool.foo", ".COM;.EXE; .FOO ")).toBe("Blocked: .foo files can run code");
    expect(riskyTypeRefusal("notes.txt", ".COM;.EXE")).toBeUndefined();
  });
});

describe("defaultAppTarget", () => {
  it("hands over a file of a safe type in a trusted space", async () => {
    const target = file("data/budget.zip");
    expect(await defaultAppTarget(space, "data/budget.zip", trusted)).toMatchObject({ file: target });
  });

  it("refuses everything in a space nobody trusted", async () => {
    file("budget.zip");
    expect(await defaultAppTarget(space, "budget.zip", { ...trusted, trusted: false })).toEqual({
      refusal: "Only in a trusted space",
    });
  });

  it("names the type before the trust, which trusting wouldn't change", async () => {
    file("setup.exe");
    expect(await defaultAppTarget(space, "setup.exe", { ...trusted, trusted: false })).toEqual({
      refusal: "Blocked: .exe files can run code",
    });
  });

  it("refuses a file set to run as a program, whatever its name", async () => {
    file("tool", 0o755);
    file("notes.txt", 0o744);
    for (const name of ["tool", "notes.txt"]) {
      expect(await defaultAppTarget(space, name, trusted)).toEqual({
        refusal: "Blocked: this file is set to run as a program",
      });
    }
  });

  // Each named so no extension gives it away, the way a system choosing an
  // app by contents still finds the program in it.
  it("refuses a program by its first bytes, whatever its name, on every platform", async () => {
    const programs: Record<string, string | Uint8Array> = {
      "setup.xyz": Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]),
      "tool.dat": Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02]),
      "app.blob": Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x07]),
      "notes.xyz": "#!/bin/sh\nrm -rf ~\n",
      "readme.xyz": Uint8Array.from([0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00, 0x00]),
      "launcher.xyz": "# launcher\n[Desktop Entry]\nExec=run-me\n",
    };
    for (const [name, contents] of Object.entries(programs)) file(name, 0o644, contents);
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const name of Object.keys(programs)) {
        expect(await defaultAppTarget(space, name, { ...trusted, platform })).toEqual({
          refusal: "Blocked: this file holds a program",
        });
      }
    }
  });

  it("refuses on Linux a file without an extension, which it would open by its contents", async () => {
    const target = file("README", 0o644, "Plain words.\n");
    expect(await defaultAppTarget(space, "README", trusted)).toEqual({
      refusal: "Blocked: on Linux, a file without an extension can run code",
    });
    for (const platform of ["darwin", "win32"] as const) {
      expect(await defaultAppTarget(space, "README", { ...trusted, platform })).toMatchObject({ file: target });
    }
  });

  it("reads no execute bits on Windows", async () => {
    const target = file("notes.txt", 0o755);
    expect(await defaultAppTarget(space, "notes.txt", { ...trusted, platform: "win32" })).toMatchObject({
      file: target,
    });
  });

  it("refuses a folder, a missing file, a hidden one and one outside the space", async () => {
    mkdirSync(path.join(space, "drafts"));
    file(".git/config");
    expect(await defaultAppTarget(space, "drafts", trusted)).toEqual({ refusal: 'No file at "drafts"' });
    expect(await defaultAppTarget(space, "gone.zip", trusted)).toEqual({ refusal: 'No file at "gone.zip"' });
    expect(await defaultAppTarget(space, ".git/config", trusted)).toEqual({ refusal: 'No file at ".git/config"' });
    expect("refusal" in (await defaultAppTarget(space, "../outside.zip", trusted))).toBe(true);
    expect("refusal" in (await defaultAppTarget(space, "lib:footage/a.zip", trusted))).toBe(true);
  });

  it("refuses a path through a symbolic link", async () => {
    const outside = tempDir("pragma-default-app-outside-");
    writeFileSync(path.join(outside, "budget.zip"), "bytes");
    symlinkSync(outside, path.join(space, "linked"));
    expect("refusal" in (await defaultAppTarget(space, "linked/budget.zip", trusted))).toBe(true);
  });
});

describe("systemTarget", () => {
  it("finds a folder or a file of any type, for the file manager", async () => {
    mkdirSync(path.join(space, "drafts"));
    const target = file("setup.exe", 0o755);
    expect(await systemTarget(space, "drafts")).toMatchObject({ file: path.join(space, "drafts") });
    expect(await systemTarget(space, "setup.exe")).toMatchObject({ file: target });
  });
});
