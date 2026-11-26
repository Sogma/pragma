// What every route family shares: the context a mount is built for, and
// the error shapes.
import type { Context } from "hono";
import type { ErrorBody } from "../../protocol/api.ts";
import { setupNeedOf } from "../../protocol/setupNeed.ts";
import type { AgentEndpoint } from "../apiServer.ts";
import type { ChangeFeeds } from "../changeFeeds.ts";
import type { ContextSourceRegistry } from "../copilotContext.ts";
import { EntryListFileError } from "../entryListFile.ts";
import { PathAccessError } from "../rootedFiles.ts";
import type { ThumbnailStore } from "../thumbnailStore.ts";

// Lets a route hand "switch which space this process serves" to whoever owns
// the running server; routes hold only the spaceRoot they were built for,
// never the listener. Undefined where no host stands behind the routes, as
// in a test that builds them alone, so /api/space/switch 501s there.
export interface SpaceSwitcher {
  switchTo(newSpaceRoot: string): void;
}

export interface RouteContext {
  spaceRoot: string;
  spaceSwitcher?: SpaceSwitcher;
  /** The agent endpoint, when this host runs one. A route may read its port and
   * ask it to re-read config; it can never open a listener itself, and a host
   * that should not offer live control simply passes nothing — the same shape
   * as SpaceSwitcher above. */
  agentEndpoint?: AgentEndpoint;
  // Whether this host is the writer's own machine: the desktop app,
  // `pragma start` and `pragma dev`, not the remote-access target, which
  // serves other devices under a service account. An OAuth sign-in needs it,
  // since its redirect to 127.0.0.1 reaches only a browser on this machine.
  ownMachine: boolean;
  thumbnails: ThumbnailStore;
  /** Whether the space's or a library's folders changed: the host's to
   * supply, since what can follow a tree depends on where it is stored. */
  changes: ChangeFeeds;
  /** What modules add to the copilot's orientation. */
  contextSources: ContextSourceRegistry;
}

// RouteContext's host-supplied fields: what this host is allowed or able to
// offer, never per-request state. A host that names no thumbnail store gets
// one on this machine's disk, one that names no change feeds follows this
// machine's folders, and one that names no context sources gets those of the
// modules Pragma ships.
export interface RouteOptions {
  agentEndpoint?: AgentEndpoint;
  ownMachine: boolean;
  thumbnails?: ThumbnailStore;
  changes?: ChangeFeeds;
  contextSources?: ContextSourceRegistry;
}

// The generate routes' error shape.
export function sendDispatchError(c: Context, error: unknown): Response {
  return c.json<ErrorBody>(
    { message: error instanceof Error ? error.message : "Internal error", need: setupNeedOf(error) },
    500,
  );
}

// A refusal a setting fixes goes as JSON, or its need would never reach the
// client.
export function sendTextError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "Internal error";
  const need = setupNeedOf(error);
  return need ? c.json<ErrorBody>({ message, need }, 500) : c.text(message, 500);
}

/** What a route answers for whatever it throws: a refused path with the
 * status that says which thing to fix, a file that isn't there as 404 (a
 * pane reads it to say a file has gone, not failed), a list file that
 * doesn't parse as 409, anything else as sendTextError does. A route
 * catches only what has a status of its own. */
export function answerError(error: unknown, c: Context): Response {
  if (error instanceof PathAccessError) return c.text(error.message, error.status);
  if (error instanceof EntryListFileError) return c.text(error.message, 409);
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
  return sendTextError(c, error);
}

// A request body as it arrives, for a handler that validates before it
// trusts: the contract's field names, each `unknown` until narrowed.
export type Incoming<T> = { [K in keyof T]?: unknown };

// A body as a handler hands it on, naming every field of the contract: one
// added to the contract fails to compile until the handler reads it, rather
// than being dropped from every request without a sound.
export type EveryField<T> = { [K in keyof Required<T>]: T[K] };
