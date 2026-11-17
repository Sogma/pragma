#!/usr/bin/env node
import { createProgram } from "../src/cli/index.ts";
import { HostStateParseError } from "../src/config/hostStateFile.ts";

// Every command reaches the global config, and a file it cannot parse is a
// refusal the operator has to act on rather than a crash: the message already
// names the file and the syntax error, so a stack trace above it only buries
// the part they need.
try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (!(error instanceof HostStateParseError)) throw error;
  console.error(error.message);
  process.exit(1);
}
