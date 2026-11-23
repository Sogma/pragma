import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { licenceAllowed, writeThirdPartyNotices } from "../../scripts/third-party-notices.ts";
import { tempDir } from "../support/isolation.ts";

const TEXTS = path.join(import.meta.dirname, "../../scripts/licence-texts");

describe("licenceAllowed", () => {
  it("takes a licence a GPL-3.0-or-later program can carry, alone or in a choice", () => {
    expect(licenceAllowed("MIT")).toBe(true);
    expect(licenceAllowed("(AFL-2.1 OR BSD-3-Clause)")).toBe(true);
    expect(licenceAllowed("MIT AND Zlib")).toBe(true);
    expect(licenceAllowed("(MIT OR GPL-2.0-only) AND Apache-2.0")).toBe(true);
  });

  it("refuses one it can't carry, an exception, and none at all", () => {
    expect(licenceAllowed("GPL-2.0-only")).toBe(false);
    expect(licenceAllowed("MIT AND GPL-2.0-only")).toBe(false);
    expect(licenceAllowed("Apache-2.0 WITH LLVM-exception")).toBe(false);
    expect(licenceAllowed("UNLICENSED")).toBe(false);
    expect(licenceAllowed("")).toBe(false);
  });
});

interface FakePackage {
  manifest: Record<string, unknown>;
  files?: Record<string, string>;
  dev?: boolean;
}

describe("writeThirdPartyNotices", () => {
  let root = "";

  // An app root holding a lockfile and the packages it lists.
  function fakeApp(packages: Record<string, FakePackage>): string {
    root = tempDir("notices-");
    const lock: Record<string, unknown> = { "": { name: "app" } };
    for (const [dir, { manifest, files = {}, dev }] of Object.entries(packages)) {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(manifest));
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, dir, name), text);
      lock[dir] = dev ? { dev: true } : {};
    }
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: lock }));
    return root;
  }

  const serverLib: FakePackage = {
    manifest: { name: "server-lib", version: "1.0.0", license: "MIT" },
    files: { LICENSE: "Copyright (c) Server Lib authors\nMIT terms" },
  };

  it("lists the production packages and the bundle's, each with its own licence and notice files", () => {
    fakeApp({
      "node_modules/server-lib": serverLib,
      "node_modules/@scope/no-file": {
        manifest: {
          name: "@scope/no-file",
          version: "2.0.0",
          license: "ISC",
          author: { name: "Ada", email: "a@x.org" },
        },
      },
      "node_modules/web-lib": {
        manifest: { name: "web-lib", version: "3.0.0", license: "BSD-3-Clause" },
        files: { "LICENSE.md": "Copyright Web Lib\nBSD terms", NOTICE: "Web Lib notice" },
        dev: true,
      },
      "node_modules/dev-tool": { manifest: { name: "dev-tool", version: "4.0.0", license: "GPL-2.0-only" }, dev: true },
    });
    const out = path.join(root, "notices.txt");
    writeThirdPartyNotices(root, [path.join(root, "node_modules/web-lib/dist/index.js?url")], out, TEXTS);
    const text = readFileSync(out, "utf8");

    expect(text).toContain("server-lib 1.0.0\nLicence: MIT");
    expect(text).toContain("Copyright (c) Server Lib authors");
    expect(text).toContain("web-lib 3.0.0\nLicence: BSD-3-Clause");
    expect(text).toContain("Web Lib notice");
    expect(text).toContain("names ISC and the author Ada <a@x.org>");
    // A development package the bundle never took in ships nowhere.
    expect(text).not.toContain("dev-tool");
    const appendix = text.slice(text.indexOf("Licence texts"));
    expect(appendix).toContain("ISC License");
    expect(appendix).toContain("MIT License");
  });

  it("stops the build on a licence a GPL-3.0-or-later program can't carry", () => {
    fakeApp({
      "node_modules/server-lib": serverLib,
      "node_modules/old-lib": { manifest: { name: "old-lib", version: "0.1.0", license: "GPL-2.0-only" } },
    });
    expect(() => writeThirdPartyNotices(root, [], path.join(root, "notices.txt"), TEXTS)).toThrow(
      /old-lib@0\.1\.0: GPL-2\.0-only/,
    );
  });

  it("stops on a package with no licence file and no standard text for its licence", () => {
    fakeApp({ "node_modules/zlib-lib": { manifest: { name: "zlib-lib", version: "1.2.0", license: "Zlib" } } });
    expect(() => writeThirdPartyNotices(root, [], path.join(root, "notices.txt"), TEXTS)).toThrow(
      /zlib-lib@1\.2\.0 \(Zlib\)/,
    );
  });
});
