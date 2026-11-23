import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HostStateParseError,
  readHostStateFile,
  withHostStateLock,
  writeHostStateFile,
} from "../../src/config/hostStateFile.ts";
import { globalConfigPath, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { isCapabilityGranted } from "../../src/server/grants.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

let dir: string;

beforeEach(() => {
  dir = isolateConfig();
});

describe("readHostStateFile", () => {
  it("reads a file back and reports a missing one as undefined", async () => {
    const target = path.join(dir, "state.json");

    expect(readHostStateFile(target)).toBeUndefined();

    writeHostStateFile(target, { hello: "world" });
    expect(readHostStateFile(target)).toEqual({ hello: "world" });
  });

  it("throws on a file that exists but is not parseable JSON", async () => {
    const target = path.join(dir, "state.json");
    writeFileSync(target, '{ "spaces": { "main": ');

    expect(() => readHostStateFile(target)).toThrow(HostStateParseError);
  });

  it("throws on JSON that is not an object", async () => {
    const target = path.join(dir, "state.json");
    writeFileSync(target, "[1, 2, 3]");

    expect(() => readHostStateFile(target)).toThrow(HostStateParseError);
  });
});

describe("writeHostStateFile", () => {
  it("leaves no temp file behind", async () => {
    writeHostStateFile(path.join(dir, "state.json"), { a: 1 });

    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  // The failure this exists for: a plain writeFileSync truncates first, so a
  // write that dies partway leaves a file that parses as nothing — which is
  // the input to the next start.
  it("keeps the previous contents when the write fails", async () => {
    const target = path.join(dir, "state.json");
    writeHostStateFile(target, { keep: true });

    // A file where the temp file's directory should be makes the write fail
    // the same way a full disk would, without needing one.
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "");

    expect(() => writeHostStateFile(path.join(blocked, "state.json"), { lost: true })).toThrow();
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ keep: true });
  });
});

// The whole point of the throw: callers mutate the loaded config by spreading
// it back into the next save, so a `{}` here is indistinguishable from a
// first run and that save persists it over the registry.
describe.skipIf(process.platform === "win32")("config.json's permissions", () => {
  // On the CLI targets it holds keys and sign-in tokens in plaintext.
  it("are owner-only after every save, whatever the file had before", async () => {
    writeFileSync(globalConfigPath(), "{}", { mode: 0o644 });
    saveGlobalConfig({ spacePath: "x" });
    expect(statSync(globalConfigPath()).mode & 0o777).toBe(0o600);
  });
});

describe("withHostStateLock", () => {
  it("runs one holder at a time", async () => {
    const target = path.join(dir, "work");
    const order: string[] = [];
    const run = (name: string) =>
      withHostStateLock(target, async () => {
        order.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`${name} out`);
      });

    await Promise.all([run("a"), run("b")]);

    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
  });

  // The OS holds the lock, so a file left beside the target says nothing.
  it("runs at once beside a stray work.lock, however new", async () => {
    const target = path.join(dir, "work");
    writeFileSync(`${target}.lock`, "");

    expect(await withHostStateLock(target, async () => "ran")).toBe("ran");
  });
});

describe("an unreadable config.json", () => {
  it("is never reported as an empty config", async () => {
    saveGlobalConfig({ spaces: { main: { path: "/spaces/main" } }, defaultTextModel: "anthropic/x" });
    writeFileSync(globalConfigPath(), '{ "spaces": ');

    expect(() => loadGlobalConfig()).toThrow(HostStateParseError);
  });

  it("names the file in its message", async () => {
    writeFileSync(globalConfigPath(), "not json");

    expect(() => loadGlobalConfig()).toThrow(globalConfigPath());
  });
});

// Grants are the one file a *read* may degrade on: denying re-prompts, and
// re-prompting recovers. The write side is covered in grants.test.ts.
describe("an unreadable grants.json", () => {
  it("is reported as nothing granted rather than thrown", async () => {
    const space = tempDir("pragma-space-");
    saveGlobalConfig({ spaces: { main: { path: space } } });
    writeFileSync(path.join(dir, "grants.json"), "{ broken");

    expect(await isCapabilityGranted(space, { path: "a.applet.html", contentHash: "h" }, "read")).toBe(false);
  });
});
