import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { askForSpace, typedPath } from "../../src/cli/askForSpace.ts";
import { findSpaceId, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const CTRL_C = "\x03";
const CLEAR_LINE = "\x15";

// A terminal that types each answer once its cue shows. A key sent before
// the prompt listens is lost, so each answer waits for text the prompt
// itself draws, never for a line printed before it.
function terminal(answers: [cue: string, keys: string][]) {
  const input = new PassThrough();
  let screen = "";
  let answeredAt = 0;
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        screen += stripVTControlCharacters(String(chunk));
        const next = answers[0];
        if (next && screen.indexOf(next[0], answeredAt) !== -1) {
          answers.shift();
          answeredAt = screen.length;
          setImmediate(() => input.write(next[1]));
        }
        done();
      },
    }),
    { columns: 1000, rows: 50 },
  );
  return { input, output, screen: () => screen, unanswered: () => answers.map(([cue]) => cue) };
}

let cwd: string;

beforeEach(() => {
  isolateConfig();
  cwd = tempDir("pragma-ask-");
});

describe("askForSpace", () => {
  it("creates the space the answer names, with the example projects, and adds it to your spaces", async () => {
    const term = terminal([
      ["No space yet. What would you like to do?", ENTER],
      ["Where should the new space go?", `Notes${ENTER}`],
      ["Add the example projects, Getting started and Translation?", ENTER],
    ]);
    const folder = path.join(cwd, "Notes");

    expect(await askForSpace({ ...term, cwd })).toBe(folder);

    expect(term.unanswered()).toEqual([]);
    expect(existsSync(path.join(folder, "README.md"))).toBe(true);
    expect(existsSync(path.join(folder, "projects", "getting-started"))).toBe(true);
    expect(findSpaceId(loadGlobalConfig(), folder)).toBeDefined();
    expect(term.screen()).toContain(`Created ${folder} and added it to your spaces.`);
  });

  it("asks again for a name that's taken, and leaves the examples out on a no", async () => {
    await mkdir(path.join(cwd, "Taken"));
    const term = terminal([
      ["No space yet. What would you like to do?", ENTER],
      ["Where should the new space go?", `Taken${ENTER}`],
      ["There’s already a folder named “Taken”", `${CLEAR_LINE}Fresh${ENTER}`],
      ["Add the example projects", `${RIGHT}${ENTER}`],
    ]);
    const folder = path.join(cwd, "Fresh");

    expect(await askForSpace({ ...term, cwd })).toBe(folder);

    expect(term.unanswered()).toEqual([]);
    expect(existsSync(path.join(folder, "README.md"))).toBe(true);
    expect(existsSync(path.join(folder, "projects", "getting-started"))).toBe(false);
  });

  it("won't make a missing parent folder for a new space", async () => {
    const term = terminal([
      ["No space yet. What would you like to do?", ENTER],
      ["Where should the new space go?", `missing/Notes${ENTER}`],
      [`${path.join(cwd, "missing")} is not a directory.`, `${CLEAR_LINE}Notes${ENTER}`],
      ["Add the example projects", ENTER],
    ]);

    expect(await askForSpace({ ...term, cwd })).toBe(path.join(cwd, "Notes"));

    expect(term.unanswered()).toEqual([]);
    expect(existsSync(path.join(cwd, "missing"))).toBe(false);
  });

  it("opens the current folder as a space when the answer is left empty", async () => {
    const term = terminal([
      ["No space yet. What would you like to do?", `${DOWN}${ENTER}`],
      ["Which folder should Pragma open as a space?", ENTER],
    ]);

    expect(await askForSpace({ ...term, cwd })).toBe(cwd);

    expect(term.unanswered()).toEqual([]);
    expect(findSpaceId(loadGlobalConfig(), cwd)).toBeDefined();
    expect(term.screen()).toContain(`Added ${cwd} to your spaces.`);
  });

  it("offers to point a moved space at its new folder, keeping its id", async () => {
    const folder = path.join(cwd, "Notes");
    await mkdir(folder);
    saveGlobalConfig({ spaces: { spc_0a1b2c3d: { path: path.join(cwd, "gone", "Notes") } } });
    const term = terminal([
      ["What would you like to do?", ENTER],
      ["Where is Notes now?", `Notes${ENTER}`],
    ]);

    expect(await askForSpace({ ...term, cwd })).toBe(folder);

    expect(term.unanswered()).toEqual([]);
    expect(loadGlobalConfig().spaces?.spc_0a1b2c3d?.path).toBe(folder);
    expect(term.screen()).toContain("None of your spaces' folders was found:");
    expect(term.screen()).toContain(`Notes  ${path.join(cwd, "gone", "Notes")}`);
    expect(term.screen()).toContain("Notes now points to");
  });

  it("changes nothing when cancelled", async () => {
    const term = terminal([["No space yet. What would you like to do?", CTRL_C]]);

    expect(await askForSpace({ ...term, cwd })).toBeUndefined();

    expect(loadGlobalConfig()).toEqual({});
    expect(term.screen()).toContain("Cancelled, so nothing changed.");
  });
});

describe("typedPath", () => {
  it("reads a relative answer from the folder it was typed in", () => {
    expect(typedPath("Notes", path.resolve("/work"))).toBe(path.resolve("/work", "Notes"));
    expect(typedPath("  ../Notes  ", path.resolve("/work/here"))).toBe(path.resolve("/work", "Notes"));
  });

  it("reads ~ as the home folder", () => {
    expect(typedPath("~", path.resolve("/work"))).toBe(homedir());
    expect(typedPath("~/Documents/Notes", path.resolve("/work"))).toBe(path.join(homedir(), "Documents", "Notes"));
  });

  it("takes off the quotes a terminal adds to a folder dropped onto it", () => {
    expect(typedPath("'/srv/My Notes'", path.resolve("/work"))).toBe(path.resolve("/srv/My Notes"));
    expect(typedPath('"/srv/My Notes"', path.resolve("/work"))).toBe(path.resolve("/srv/My Notes"));
  });

  it.skipIf(process.platform === "win32")("takes off the backslash escapes a terminal adds to a dropped folder", () => {
    expect(typedPath("/srv/My\\ Notes\\ \\(old\\)", "/work")).toBe("/srv/My Notes (old)");
  });
});
