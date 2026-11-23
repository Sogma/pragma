import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PassphraseInput, registerPassphraseCommand } from "../../src/cli/commands/passphrase.ts";
import { credentialStore, remoteAccessPassphrase } from "../../src/config/credentials.ts";
import { isolateConfig } from "../support/isolation.ts";

// `pragma passphrase` against this test's own config directory: what it
// saves from a script's pipe, and from a terminal that never shows it.

let configDir: string;
let printed: string[];
let errors: string[];

beforeEach(() => {
  configDir = isolateConfig();
  printed = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    printed.push(line);
  });
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function passphrase(input: PassphraseInput, output: NodeJS.WritableStream = new PassThrough()): Promise<void> {
  const program = new Command().exitOverride();
  registerPassphraseCommand(program, input, output);
  await program.parseAsync(["node", "pragma", "passphrase"]);
}

// A terminal: raw mode on, and each entry typed once its prompt is shown.
function terminal(entries: string[]): { input: PassphraseInput; output: NodeJS.WritableStream; shown: string[] } {
  const keys = new PassThrough();
  const input: PassphraseInput = Object.assign(keys, { isTTY: true, setRawMode: () => undefined });
  const shown: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      const text = String(chunk);
      shown.push(text);
      if (text.endsWith(": ")) keys.write(`${entries.shift() ?? ""}\r`);
      done();
    },
  });
  return { input, output, shown };
}

const passphraseFile = () => path.join(configDir, "credentials", "plain", "remote-access-passphrase.json");

describe("pragma passphrase", () => {
  it("saves the first line a script pipes in, and replaces it the next time", async () => {
    await passphrase(Readable.from(["correct horse battery\nignored\n"]));
    expect(process.exitCode).toBeUndefined();
    expect(printed).toEqual([
      `Saved the remote-access passphrase in ${passphraseFile()}. A running \`pragma start --external-url\` uses it from its next start, and every device signs in again.`,
    ]);
    await expect(remoteAccessPassphrase()).resolves.toMatchObject({ ok: true, passphrase: "correct horse battery" });

    await passphrase(Readable.from(["battery staple horse\n"]));
    await expect(remoteAccessPassphrase()).resolves.toMatchObject({ ok: true, passphrase: "battery staple horse" });
  });

  it("draws a new cookie secret with every save", async () => {
    const secret = async () => ((await remoteAccessPassphrase()) as { cookieSecret: string }).cookieSecret;
    await passphrase(Readable.from(["correct horse battery\n"]));
    const first = await secret();
    await passphrase(Readable.from(["correct horse battery\n"]));
    expect(first).toMatch(/^[\w-]{43}$/);
    expect(await secret()).not.toBe(first);
  });

  it("saves nothing when the line is empty", async () => {
    await passphrase(Readable.from(["\n"]));
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["No passphrase was entered, so none was saved."]);
    await expect(credentialStore().inspect({ kind: "remote-access-passphrase" })).resolves.toMatchObject({
      state: "absent",
    });
  });

  it("saves nothing under 15 characters, counting each emoji as one", async () => {
    const tooShort = "A passphrase needs at least 15 characters. That one has 14, so none was saved.";
    await passphrase(Readable.from([`${"a".repeat(14)}\n`]));
    await passphrase(Readable.from([`${"🐴".repeat(14)}\n`]));
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([tooShort, tooShort]);
    await expect(credentialStore().inspect({ kind: "remote-access-passphrase" })).resolves.toMatchObject({
      state: "absent",
    });

    process.exitCode = undefined;
    await passphrase(Readable.from([`${"a".repeat(15)}\n`]));
    expect(process.exitCode).toBeUndefined();
    await expect(remoteAccessPassphrase()).resolves.toMatchObject({ ok: true, passphrase: "a".repeat(15) });
  });

  it("asks a terminal twice, shows neither entry, and saves only a match", async () => {
    const differing = terminal(["correct horse battery", "correct horse staple"]);
    await passphrase(differing.input, differing.output);
    expect(errors).toEqual(["The two entries differ, so nothing was saved."]);
    expect(differing.shown.join("")).toBe("Passphrase: \nAgain: \n");
    await expect(remoteAccessPassphrase()).resolves.toMatchObject({ ok: false });

    process.exitCode = undefined;
    const matching = terminal(["correct horse battery", "correct horse battery"]);
    await passphrase(matching.input, matching.output);
    expect(process.exitCode).toBeUndefined();
    await expect(remoteAccessPassphrase()).resolves.toMatchObject({ ok: true, passphrase: "correct horse battery" });
  });

  it("refuses a short first entry in a terminal without asking again", async () => {
    const short = terminal(["short one"]);
    await passphrase(short.input, short.output);
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual(["A passphrase needs at least 15 characters. That one has 9, so none was saved."]);
    expect(short.shown.join("")).toBe("Passphrase: \n");
    await expect(remoteAccessPassphrase()).resolves.toMatchObject({ ok: false });
  });
});
