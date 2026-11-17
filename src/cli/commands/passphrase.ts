import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { credentialStore } from "../../config/credentials.ts";

// NIST SP 800-63B-4's floor for a password that is the only factor, as this
// one is. Counted in code points, as NIST counts them, so eight emoji can't
// pass as sixteen.
const MINIMUM_LENGTH = 15;

/** Where a passphrase is read from: a terminal, or a pipe from a script. */
export interface PassphraseInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export function registerPassphraseCommand(
  program: Command,
  input: PassphraseInput = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  program
    .command("passphrase")
    .description("Save the passphrase other devices sign in with, for start --external-url")
    .action(async () => {
      let passphrase: string;
      try {
        passphrase = input.isTTY ? await askTwice(input, output) : await firstLine(input);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
      const problem = refusal(passphrase);
      if (problem) {
        console.error(problem);
        process.exitCode = 1;
        return;
      }
      const store = credentialStore();
      const slot = { kind: "remote-access-passphrase" } as const;
      const { observation } = await store.inspect(slot);
      // A new cookie secret with every save, so a new passphrase also ends
      // every session and device cookie signed before it.
      const cookieSecret = randomBytes(32).toString("base64url");
      const saved = await store.set(slot, observation, { secrets: { passphrase, cookieSecret } });
      if (!saved.ok) {
        console.error(
          "refused" in saved
            ? saved.refused.message
            : "The passphrase changed while this one was saved. Run the command again.",
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `Saved the remote-access passphrase in ${store.where(slot)}. A running \`pragma start --external-url\` uses it from its next start, and every device signs in again.`,
      );
    });
}

function refusal(passphrase: string): string | undefined {
  if (!passphrase) return "No passphrase was entered, so none was saved.";
  const length = Array.from(passphrase).length;
  if (length < MINIMUM_LENGTH) {
    return `A passphrase needs at least ${MINIMUM_LENGTH} characters. That one has ${length}, so none was saved.`;
  }
  return undefined;
}

async function askTwice(input: PassphraseInput, output: NodeJS.WritableStream): Promise<string> {
  const first = await readHidden(input, output, "Passphrase: ");
  if (refusal(first)) return first;
  if ((await readHidden(input, output, "Again: ")) !== first) {
    throw new Error("The two entries differ, so nothing was saved.");
  }
  return first;
}

// One line from a terminal, never echoed: raw mode hands over each key as it
// is pressed, so nothing reaches the screen unless written. Ctrl-C and
// Ctrl-D cancel.
function readHidden(input: PassphraseInput, output: NodeJS.WritableStream, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (settle: () => void) => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      settle();
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003" || char === "\u0004") {
          return finish(() => reject(new Error("Cancelled, so nothing was saved.")));
        }
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    output.write(prompt);
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

// A script's pipe: the first line, as written.
async function firstLine(input: PassphraseInput): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += String(chunk);
    const end = text.search(/\r?\n/);
    if (end !== -1) return text.slice(0, end);
  }
  return text;
}
