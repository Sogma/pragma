import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askForSpace, isInteractive } from "../../src/cli/askForSpace.ts";
import { NO_SPACES_YET, openHostSpace } from "../../src/cli/hostSpace.ts";
import { findSpaceId, loadGlobalConfig, registerSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

vi.mock("../../src/cli/askForSpace.ts", () => ({ askForSpace: vi.fn(), isInteractive: vi.fn() }));

let root: string;
let errors: string[];
let warnings: string[];

beforeEach(() => {
  isolateConfig();
  root = tempDir("pragma-host-");
  errors = [];
  warnings = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(line);
  });
  vi.spyOn(console, "warn").mockImplementation((line: string) => {
    warnings.push(line);
  });
  vi.mocked(askForSpace).mockReset();
  vi.mocked(isInteractive).mockReset().mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function folder(name: string): Promise<string> {
  const target = path.join(root, name);
  await mkdir(target, { recursive: true });
  return target;
}

describe("openHostSpace with no space to open", () => {
  it("says how to make or add one when nobody is there to ask", async () => {
    expect(await openHostSpace({}, undefined, false)).toBeUndefined();

    expect(askForSpace).not.toHaveBeenCalled();
    expect(errors).toEqual([NO_SPACES_YET]);
    expect(process.exitCode).toBe(1);
  });

  it("names pragma space locate when every registered folder is gone", async () => {
    await openHostSpace({ spaces: { spc_0a1b2c3d: { path: path.join(root, "gone") } } }, undefined, false);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("None of your spaces' folders was found.");
    expect(errors[0]).toContain("pragma space locate <id> <folder>");
  });

  it("never asks for --external-url, even with a person there", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);

    expect(await openHostSpace({}, undefined, true)).toBeUndefined();

    expect(askForSpace).not.toHaveBeenCalled();
    expect(errors).toEqual([NO_SPACES_YET]);
  });

  it("asks a person at the terminal, and opens the space they chose under the id it was given", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    const chosen = await folder("Notes");
    let id: string | undefined;
    vi.mocked(askForSpace).mockImplementation(async () => {
      saveGlobalConfig(registerSpace(loadGlobalConfig(), chosen));
      id = findSpaceId(loadGlobalConfig(), chosen);
      return chosen;
    });

    expect(await openHostSpace({}, undefined, false)).toBe(chosen);

    const saved = loadGlobalConfig();
    expect(id).toBeDefined();
    expect(findSpaceId(saved, chosen)).toBe(id);
    expect(saved.spacePath).toBe(chosen);
    expect(saved.recentSpaceIds).toEqual([id]);
  });

  it("fails when the person cancels", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askForSpace).mockResolvedValue(undefined);

    expect(await openHostSpace({}, undefined, false)).toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(loadGlobalConfig()).toEqual({});
  });
});

describe("openHostSpace's notice about the configured space", () => {
  it("says so when it falls back from a configured space that's gone", async () => {
    const gone = path.join(root, "gone");
    const other = await folder("other");

    const opened = await openHostSpace(
      { spacePath: gone, spaces: { spc_00000001: { path: gone }, spc_00000002: { path: other } } },
      undefined,
      false,
    );

    expect(opened).toBe(other);
    expect(warnings).toEqual([`Configured space ${gone} is not there. Opening ${other} instead.`]);
  });

  it("stays quiet for a folder typed on the command line", async () => {
    const configured = await folder("configured");
    const typed = await folder("typed");

    expect(await openHostSpace({ spacePath: configured }, typed, false)).toBe(typed);

    expect(warnings).toEqual([]);
  });
});
