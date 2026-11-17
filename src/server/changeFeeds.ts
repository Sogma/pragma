// Whether a folder tree changed, without walking it on request. Each root a
// client asks about is followed — watched where the filesystem sends events,
// its folders' modified times polled where it sends none — until nobody has
// asked for a while. A version names one stretch of following, so a restart
// reads as a change and a client re-reads whatever it may have missed.

import { type FSWatcher, watch } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { isHiddenName } from "../protocol/entryName.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";

export interface ChangeFeeds {
  /** The version of the tree at `root`, following it from now on if it was
   * not already. Two equal versions mean nothing the tree lists changed in
   * between; a different one means something may have. */
  version(root: string): string;
}

export interface LocalChangeFeedOptions {
  /** How long a root is followed after it was last asked about. */
  idleMs?: number;
  /** How often a root that sends no events has its folders' times read. */
  pollMs?: number;
  /** Polls even where events would arrive. */
  poll?: boolean;
}

// A Windows drive under WSL: 9p delivers no change events at all, from
// either side, while its folders' modified times are current.
const V9FS_MAGIC = 0x01021997;

// The tree never lists a dot entry, so nothing under one is a change to it:
// a `.git` busy with a commit, or the space's own `.pragma` state.
function isHidden(relativePath: string): boolean {
  return isHiddenPath(relativePath.replace(/\\/g, "/"));
}

async function sendsNoEvents(root: string): Promise<boolean> {
  try {
    return (await statfs(root)).type === V9FS_MAGIC;
  } catch {
    return false;
  }
}

/** Every visible folder under `root` with its modified time, which moves
 * whenever an entry is added, removed or renamed in it. */
async function folderTimes(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const [info, entries] = await Promise.all([stat(dir), readdir(dir, { withFileTypes: true })]);
    lines.push(`${dir}\t${info.mtimeMs}`);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !isHiddenName(entry.name))
        .map((entry) => walk(path.join(dir, entry.name))),
    );
  };
  await walk(root);
  return lines.sort().join("\n");
}

interface Feed {
  id: string;
  count: number;
  stop: () => void;
  idle?: ReturnType<typeof setTimeout>;
}

let feedsStarted = 0;

export function createLocalChangeFeeds(options: LocalChangeFeedOptions = {}): ChangeFeeds {
  const idleMs = options.idleMs ?? 60_000;
  const pollMs = options.pollMs ?? 3_000;
  const feeds = new Map<string, Feed>();

  function follow(root: string): Feed {
    feedsStarted += 1;
    const feed: Feed = { id: feedsStarted.toString(36), count: 0, stop: () => undefined };
    let stopped = false;
    let teardown = () => {};
    feed.stop = () => {
      stopped = true;
      teardown();
    };

    // A missing root reads as unchanged until it is back.
    const poll = () => {
      let last: string | undefined;
      let reading = false;
      const read = async () => {
        if (reading) return;
        reading = true;
        try {
          const times = await folderTimes(root);
          if (last !== undefined && times !== last) feed.count += 1;
          last = times;
        } catch {
          // see above
        } finally {
          reading = false;
        }
      };
      void read();
      const timer = setInterval(read, pollMs);
      timer.unref();
      teardown = () => clearInterval(timer);
    };

    void (async () => {
      const polled = options.poll || (await sendsNoEvents(root));
      if (stopped) return;
      if (polled) return poll();
      let watcher: FSWatcher;
      try {
        watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename && isHidden(filename.toString())) return;
          feed.count += 1;
        });
      } catch {
        return poll();
      }
      // A watcher that fails later (the root removed, the watch limit hit)
      // falls back to polling rather than going quiet.
      watcher.on("error", () => {
        watcher.close();
        if (!stopped) poll();
      });
      teardown = () => watcher.close();
    })();
    return feed;
  }

  return {
    version(root) {
      const key = path.resolve(root);
      let feed = feeds.get(key);
      if (!feed) {
        feed = follow(key);
        feeds.set(key, feed);
      }
      const followed = feed;
      clearTimeout(followed.idle);
      followed.idle = setTimeout(() => {
        followed.stop();
        if (feeds.get(key) === followed) feeds.delete(key);
      }, idleMs);
      followed.idle.unref();
      return `${followed.id}.${followed.count}`;
    },
  };
}
