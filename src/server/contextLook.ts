// docs/protocol.md's Context of a path, past the files a run starts from:
// the tools a generation's model may call to look further in the scope the
// person allowed, and what it did with them, for whoever started the run.
// The tools are spaceReader.ts's, held to a look's budget.
import { APICallError, RetryError, tool } from "ai";
import { z } from "zod";
import type { EffortLevel, RootPathsResponse } from "../protocol/api.ts";
import type { GenerationLook } from "../protocol/dispatchAction.ts";
import { CONTEXT_FILE_LIMIT, type ContextPlace, fromRoot } from "./pathContext.ts";
import { scopeTree } from "./scopedReads.ts";
import { createSpaceReader, entriesOf, type ReadTrace, toolSet } from "./spaceReader.ts";

/** How far a look goes at each effort: rounds of tool calls, the characters
 * its tool results may hold together, and how long it may look, before its
 * answer is asked for. A model's own default reaches as medium does. */
export interface LookReach {
  rounds: number;
  total: number;
  timeMs: number;
}

export const LOOK_REACH: Record<EffortLevel, LookReach> = {
  low: { rounds: 4, total: 16_000, timeMs: 30_000 },
  medium: { rounds: 8, total: 32_000, timeMs: 60_000 },
  high: { rounds: 12, total: 64_000, timeMs: 120_000 },
  xhigh: { rounds: 16, total: 128_000, timeMs: 180_000 },
};

/** The characters of the list of the scope's files a look starts with. */
const LOOK_LIST_LIMIT = 6000;

// Enough of a search to choose what to read, never a file's worth.
const SEARCH_MATCHES = 30;
const LINE_CHARS = 200;

export interface ContextLook extends GenerationLook {
  trace: ReadTrace;
}

const shownCount = (count: number) => count.toLocaleString("en-US");

/** The tools for a look from `place`, and the trace they fill. `sent` holds
 * the files the run starts with, as a context shows them, which a read
 * answers as already given; `effort` is the level the generation runs at. */
export async function lookFurther(
  spaceRoot: string,
  listing: RootPathsResponse,
  place: ContextPlace,
  sent: readonly string[],
  { effort, now = Date.now }: { effort?: EffortLevel; now?: () => number } = {},
): Promise<ContextLook> {
  const reach = LOOK_REACH[effort ?? "medium"];
  const scope = place.scope;
  const where = scope ? fromRoot(scope, true) : "the writer's space";
  const reader = createSpaceReader({
    spaceRoot,
    scope,
    listing,
    rooted: true,
    where,
    limits: {
      answer: CONTEXT_FILE_LIMIT,
      file: CONTEXT_FILE_LIMIT,
      total: reach.total,
      matches: SEARCH_MATCHES,
      line: LINE_CHARS,
    },
    descriptions: true,
    given: sent,
    withheld: place.path,
    once: true,
    // A model answering from these lines alone would answer from nothing:
    // only what it reads goes with its reply.
    afterSearch: "(Only files you read go with your reply. Read the ones you need.)",
  });
  const started = now();
  const set = {
    ...toolSet(reader.tools),
    // Nothing to run, so calling it ends the looking.
    ready: tool({
      description:
        "Call once you have read what you need, instead of replying. You are then asked for your reply, " +
        "with the files you read in front of you.",
      inputSchema: z.object({}),
    }),
  };

  // Asked only while the model still calls tools: a stop here cut its
  // looking short, which the trace says.
  function mustStop(steps: number): boolean {
    if (reader.full()) return true;
    if (steps >= reach.rounds) {
      reader.trace.messages.push({
        level: "warn",
        text: `Stopped looking after ${reach.rounds} rounds of searching and reading.`,
      });
      return true;
    }
    if (now() - started > reach.timeMs) {
      reader.trace.messages.push({
        level: "warn",
        text: `Stopped looking after ${Math.round(reach.timeMs / 1000)} seconds.`,
      });
      return true;
    }
    return false;
  }

  // The scope's files come first, so the model knows what there is to look
  // at before it decides whether to look.
  const files = entriesOf(await scopeTree(spaceRoot, scope)).map((file) => fromRoot(file.path));
  const listed: string[] = [];
  let length = 0;
  for (const file of files) {
    length += file.length + 1;
    if (length > LOOK_LIST_LIMIT) break;
    listed.push(file);
  }
  if (listed.length < files.length) {
    listed.push(`…and ${shownCount(files.length - listed.length)} more. List a folder to see them.`);
  }

  const guidance =
    `Before you reply you may look further in ${where}, the part of the writer's space this request ` +
    "comes from. You can list a folder with each file's description, search the files' text, read a file " +
    "or, for a long note, the sections of it you need, and see what a file links to and what links to it. " +
    "Look when the instruction depends on something " +
    "there you weren't given, such as facts, style or earlier events it sets out. If you need nothing " +
    "more, reply now. If you look, read each file you will draw on, then call ready instead of replying: " +
    "you are then asked for your reply with the files you read in front of you, and only those, since a " +
    "search shows lines, not files." +
    `\n\nThe files in ${where}:\n${listed.join("\n") || "(none)"}`;

  return { tools: { set, guidance, mustStop }, found: () => reader.taken(), trace: reader.trace };
}

/** Whether a model call failed because the model takes no tools, as a local
 * server says of a model it can't give them to; a retry may have wrapped it. */
export function refusesTools(error: unknown): boolean {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(cause) || ![400, 422, 500, 501].includes(cause.statusCode ?? 0)) return false;
  return /\btools?\b/i.test(`${cause.message} ${cause.responseBody ?? ""}`);
}
