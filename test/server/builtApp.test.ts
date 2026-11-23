import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { builtAppProblem, isSourceCheckout } from "../../src/server/builtApp.ts";
import { tempDir } from "../support/isolation.ts";

let root: string;

function write(relativePath: string, content: string, mtime?: Date): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtime) utimesSync(file, mtime, mtime);
}

// A build that started at `builtAt` and read the given inputs.
function build(builtAt: Date, inputs: string[]): void {
  write("dist/web/index.html", "<!doctype html>");
  write("dist/web-inputs.json", JSON.stringify({ builtAt: builtAt.getTime(), inputs }));
}

beforeEach(() => {
  root = tempDir("pragma-built-app-");
});

describe("builtAppProblem", () => {
  const before = new Date("2026-01-01T00:00:00Z");
  const builtAt = new Date("2026-01-02T00:00:00Z");
  const after = new Date("2026-01-03T00:00:00Z");

  it("passes a build newer than every input", () => {
    write("web/main.ts", "", before);
    write("src/protocol/types.ts", "", before);
    build(builtAt, ["web/main.ts", "src/protocol/types.ts"]);

    expect(builtAppProblem(root)).toBeUndefined();
  });

  it("names an input changed since the build", () => {
    write("web/main.ts", "", before);
    write("src/protocol/types.ts", "", after);
    build(builtAt, ["web/main.ts", "src/protocol/types.ts"]);

    expect(builtAppProblem(root)).toBe("src/protocol/types.ts has changed since dist/web was built.");
  });

  it("names an input deleted since the build", () => {
    write("web/main.ts", "", before);
    build(builtAt, ["web/main.ts", "web/gone.ts"]);

    expect(builtAppProblem(root)).toBe("web/gone.ts has changed since dist/web was built.");
  });

  it("refuses a build with no record of its inputs", () => {
    write("web/main.ts", "", before);
    write("dist/web/index.html", "<!doctype html>");

    expect(builtAppProblem(root)).toBe("No built app in dist/web.");
  });

  it("refuses a record whose build output is gone", () => {
    write("web/main.ts", "", before);
    write("dist/web-inputs.json", JSON.stringify({ builtAt: builtAt.getTime(), inputs: ["web/main.ts"] }));

    expect(builtAppProblem(root)).toBe("No built app in dist/web.");
  });

  it("serves a package's build, which ships without its sources or a record", () => {
    write("dist/web/index.html", "<!doctype html>");

    expect(isSourceCheckout(root)).toBe(false);
    expect(builtAppProblem(root)).toBeUndefined();
  });

  it("refuses a package with no built app", () => {
    write("templates/space/README.md", "");

    expect(builtAppProblem(root)).toBe("No built app in dist/web.");
  });
});
