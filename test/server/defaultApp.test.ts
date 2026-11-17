import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DefaultAppHost,
  defaultAppTarget,
  riskyTypeRefusal,
  systemExtension,
  systemTarget,
} from "../../src/server/defaultApp.ts";

let space: string;
let configDir: string;

const trusted: DefaultAppHost = { trusted: true, platform: "linux" };

// A library path reads the install's registry, so the config directory is a
// throwaway one rather than the developer's own.
beforeEach(() => {
  space = mkdtempSync(path.join(tmpdir(), "pragma-default-app-"));
  configDir = mkdtempSync(path.join(tmpdir(), "pragma-default-app-config-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
});

afterEach(() => {
  delete process.env.PRAGMA_CONFIG_DIR;
  rmSync(space, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

function file(name: string, mode = 0o644): string {
  const target = path.join(space, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "bytes");
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
    const outside = mkdtempSync(path.join(tmpdir(), "pragma-default-app-outside-"));
    try {
      writeFileSync(path.join(outside, "budget.zip"), "bytes");
      symlinkSync(outside, path.join(space, "linked"));
      expect("refusal" in (await defaultAppTarget(space, "linked/budget.zip", trusted))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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
