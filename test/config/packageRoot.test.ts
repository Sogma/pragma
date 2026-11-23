import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_ROOT, packageRootAbove } from "../../src/config/packageRoot.ts";
import { tempDir } from "../support/isolation.ts";

let root: string;

beforeEach(() => {
  root = tempDir("pragma-package-root-");
  writeFileSync(path.join(root, "package.json"), "{}");
});

describe("packageRootAbove", () => {
  it("finds the package from the npm bundle's folder", () => {
    const bundle = path.join(root, "dist", "cli");
    mkdirSync(bundle, { recursive: true });

    expect(packageRootAbove(bundle)).toBe(root);
  });

  it("finds the package from a source module's folder", () => {
    const sources = path.join(root, "src", "server");
    mkdirSync(sources, { recursive: true });

    expect(packageRootAbove(sources)).toBe(root);
  });

  it("stops at the nearest package.json", () => {
    const nested = path.join(root, "node_modules", "@sogma", "pragma");
    mkdirSync(path.join(nested, "dist", "cli"), { recursive: true });
    writeFileSync(path.join(nested, "package.json"), "{}");

    expect(packageRootAbove(path.join(nested, "dist", "cli"))).toBe(nested);
  });
});

describe("PACKAGE_ROOT", () => {
  it("is the repository in a clone", () => {
    expect(PACKAGE_ROOT).toBe(path.resolve(fileURLToPath(new URL("../..", import.meta.url))));
  });
});
