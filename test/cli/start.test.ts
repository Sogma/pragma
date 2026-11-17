import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/index.ts";
import { credentialStore, setCredentialHost } from "../../src/config/credentials.ts";

// `pragma start --external-url` against this test's own config directory:
// what it refuses before anything listens.

let configDir: string;
let errors: string[];

async function pragma(...args: string[]): Promise<void> {
  await createProgram()
    .exitOverride()
    .parseAsync(["node", "pragma", ...args]);
}

const passphraseFile = () => path.join(configDir, "credentials", "plain", "remote-access-passphrase.json");

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "pragma-cli-start-"));
  process.env.PRAGMA_CONFIG_DIR = configDir;
  errors = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(line);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  setCredentialHost("terminal");
  delete process.env.PRAGMA_CONFIG_DIR;
  process.exitCode = undefined;
  await rm(configDir, { recursive: true, force: true });
});

describe("pragma start --external-url", () => {
  it("won't serve other devices without a passphrase record, whatever config.json says", async () => {
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ hostPassphrase: "from-config" }));

    await pragma("start", "--external-url", "https://notes.example.com", "--port", "0");

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([
      `--external-url refuses to start without a remote-access passphrase. No passphrase is saved in ${passphraseFile()}. Save one with \`pragma passphrase\`.`,
    ]);
  });

  it("won't start on a passphrase record without its cookie secret", async () => {
    const slot = { kind: "remote-access-passphrase" } as const;
    await credentialStore().set(slot, { absent: true }, { secrets: { passphrase: "correct horse battery" } });

    await pragma("start", "--external-url", "https://notes.example.com", "--port", "0");

    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([
      `--external-url refuses to start without a remote-access passphrase. The record in ${passphraseFile()} has no cookie secret. Save one with \`pragma passphrase\`.`,
    ]);
  });

  it("says why when the passphrase record can't be read", async () => {
    await mkdir(path.dirname(passphraseFile()), { recursive: true, mode: 0o700 });
    await writeFile(passphraseFile(), "{ not json", { mode: 0o600 });

    await pragma("start", "--external-url", "https://notes.example.com", "--port", "0");

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(`${passphraseFile()} isn't valid JSON.`);
  });
});
