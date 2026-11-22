import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Where a browser sign-in returns: a listener on 127.0.0.1, open only while a
// sign-in is pending, handing each callback to the sign-in its state names.
// Every sign-in goes through it, so none takes a request under another host
// name, which a rebound DNS name sends here, or a state used or expired.

/** How a callback ended: the page the browser shows, and the failure the
 * sign-in's status reports afterwards, none for a success. */
export interface CallbackOutcome {
  status: number;
  page: string;
  failure?: string;
}

interface Target {
  id: string;
}

export interface LoopbackCallbackOptions<Entry> {
  /** 0 takes any free port. */
  port: number;
  /** Listen on any free port when `port` is taken. */
  anyPortIfTaken?: boolean;
  /** The path the redirect URI names. */
  path: string;
  /** Finishes the sign-in a callback's state names. A throw is a failure
   * with its message; `stillPending` turns false once a sign-out or a newer
   * start drops the sign-in. */
  answer(entry: Entry, url: URL, stillPending: () => boolean): Promise<CallbackOutcome>;
}

export interface LoopbackCallbacks<Entry> {
  /** Runs a start with the listener held open, after dropping any sign-in
   * still pending for the target and its last failure. */
  starting<T>(target: Target, run: () => Promise<T>): Promise<T>;
  /** Opens the listener if it isn't open; call it within a start. */
  redirectUri(): Promise<string>;
  /** Waits for the callback naming `state`, failing the sign-in when none
   * comes within ten minutes. */
  add(state: string, entry: Entry): void;
  isPending(target: Target): boolean;
  failure(target: Target): string | undefined;
  fail(target: Target, message: string): void;
  /** Drops any sign-in pending for the target, and its last failure. */
  forget(target: Target): void;
  close(): Promise<void>;
}

const PENDING_TIMEOUT_MS = 10 * 60_000;

export function createLoopbackCallbacks<Entry extends { target: Target }>(
  options: LoopbackCallbackOptions<Entry>,
): LoopbackCallbacks<Entry> {
  const pending = new Map<string, { entry: Entry; timer: NodeJS.Timeout }>();
  const failures = new Map<string, string>();
  let listening: Promise<{ server: Server; port: number }> | undefined;
  let starting = 0;

  function listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  function openListener(): Promise<{ server: Server; port: number }> {
    listening ??= (async () => {
      const server = createServer((req, res) => void onCallback(req, res));
      try {
        return { server, port: await listen(server, options.port) };
      } catch (error) {
        if (!options.anyPortIfTaken || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        return { server, port: await listen(server, 0) };
      }
    })();
    return listening.catch((error: unknown) => {
      listening = undefined;
      throw error;
    });
  }

  function closeIfIdle(): void {
    if (pending.size > 0 || starting > 0 || !listening) return;
    const closing = listening;
    listening = undefined;
    void closing.then(({ server }) => server.close()).catch(() => {});
  }

  function finish(state: string, failure?: string): void {
    const held = pending.get(state);
    if (!held) return;
    clearTimeout(held.timer);
    pending.delete(state);
    if (failure) failures.set(held.entry.target.id, failure);
    closeIfIdle();
  }

  function drop(target: Target): void {
    for (const [state, held] of pending) {
      if (held.entry.target.id !== target.id) continue;
      clearTimeout(held.timer);
      pending.delete(state);
    }
  }

  async function onCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = req.socket.localPort;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    // Only this exact origin: a rebound DNS name reaches 127.0.0.1 too.
    if (req.method !== "GET" || url.pathname !== options.path || req.headers.host !== `127.0.0.1:${port}`) {
      return void res.writeHead(404).end();
    }
    const states = url.searchParams.getAll("state");
    const held = states.length === 1 ? pending.get(states[0]) : undefined;
    if (!held) {
      return page(res, 400, "This sign-in link has expired or was already used. Start signing in again from Pragma.");
    }
    const [state] = states;
    let outcome: CallbackOutcome;
    try {
      outcome = await options.answer(held.entry, url, () => pending.get(state) === held);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { status: 502, page: message, failure: message };
    }
    finish(state, outcome.failure);
    page(res, outcome.status, outcome.page);
  }

  return {
    async starting(target, run) {
      drop(target);
      failures.delete(target.id);
      starting += 1;
      try {
        return await run();
      } finally {
        starting -= 1;
        closeIfIdle();
      }
    },

    async redirectUri() {
      const { port } = await openListener();
      return `http://127.0.0.1:${port}${options.path}`;
    },

    add(state, entry) {
      const timer = setTimeout(() => finish(state, "The sign-in timed out. Start it again."), PENDING_TIMEOUT_MS);
      timer.unref();
      pending.set(state, { entry, timer });
    },

    isPending: (target) => [...pending.values()].some((held) => held.entry.target.id === target.id),

    failure: (target) => failures.get(target.id),

    fail(target, message) {
      failures.set(target.id, message);
    },

    forget(target) {
      drop(target);
      closeIfIdle();
      failures.delete(target.id);
    },

    async close() {
      for (const held of pending.values()) clearTimeout(held.timer);
      pending.clear();
      const closing = listening;
      listening = undefined;
      if (!closing) return;
      const { server } = await closing;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// No cache keeps it, no link from it sends where it was, and nothing on it
// loads or runs: the page answers a URL that carried a sign-in's code.
function page(res: ServerResponse, status: number, text: string): void {
  const escaped = text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Pragma</title>` +
      `<body style="font: 16px/1.5 system-ui, sans-serif; margin: 3rem"><p>${escaped}</p></body>`,
  );
}
