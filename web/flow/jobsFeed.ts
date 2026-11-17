// The window's one poll of /api/jobs per Flow, shared by the Tools tab's
// lists and the runs waiting on a clip: a Flow's jobs cost one request every
// few seconds however many runs wait. Each poll names the jobs a run here
// waits on, so the host counts an outcome reached meanwhile as delivered, and
// each says which ended jobs this window showed or a run here took.
//
// A hidden window asks only for its waiting runs; showing it asks at once.
import type { JobView } from "../../src/protocol/api.ts";
import { fetchJobs, markJobsShown } from "../core/apiClient.ts";

const POLL_MS = 5000;
// How long after a run starts to keep asking for the job it may start.
const WATCH_MS = 60_000;
// Polls a waited-on job may be missing from before its run hears it is gone.
const MISSES = 3;

export interface JobsFeedDeps {
  fetchJobs: typeof fetchJobs;
  markJobsShown: typeof markJobsShown;
}

/** Handed each poll's jobs; returns the ended ones it showed, or nothing
 * when it showed them all. Only a job shown is said to be. */
export type JobsListener = (jobs: readonly JobView[]) => readonly string[] | undefined;

export interface JobsFeed {
  /** Hands `listener` each poll's jobs of `path`, from a first poll at once.
   * Returns the unfollow. */
  follow(path: string, listener: JobsListener): () => void;
  /** The job `id` of `path` once it ends. `signal` ends only this wait. */
  wait(path: string, id: string, signal?: AbortSignal): Promise<JobView>;
  /** A run began on `path`: ask soon, and keep asking a while. */
  poke(path: string): void;
}

interface Waiter {
  id: string;
  misses: number;
  resolve(job: JobView): void;
  reject(error: unknown): void;
}

interface PathFeed {
  listeners: Set<JobsListener>;
  waiters: Set<Waiter>;
  live: boolean;
  watchUntil: number;
  timer?: number;
  polling: boolean;
  again: boolean;
}

const isLive = (job: JobView) => job.stage === "starting" || job.stage === "running";

export function createJobsFeed(deps: JobsFeedDeps = { fetchJobs, markJobsShown }): JobsFeed {
  const feeds = new Map<string, PathFeed>();

  function feedOf(path: string): PathFeed {
    let feed = feeds.get(path);
    if (!feed) {
      feed = { listeners: new Set(), waiters: new Set(), live: false, watchUntil: 0, polling: false, again: false };
      feeds.set(path, feed);
    }
    return feed;
  }

  const wanted = (feed: PathFeed) =>
    feed.waiters.size > 0 || (feed.listeners.size > 0 && (feed.live || Date.now() < feed.watchUntil));

  function schedule(path: string, feed: PathFeed, ms = POLL_MS): void {
    window.clearTimeout(feed.timer);
    feed.timer = undefined;
    if (!wanted(feed)) {
      if (feed.listeners.size === 0 && feed.waiters.size === 0) feeds.delete(path);
      return;
    }
    feed.timer = window.setTimeout(() => void poll(path), ms);
  }

  async function poll(path: string): Promise<void> {
    const feed = feeds.get(path);
    if (!feed) return;
    if (feed.polling) {
      feed.again = true;
      return;
    }
    if (document.visibilityState === "hidden" && feed.waiters.size === 0) return;
    feed.polling = true;
    try {
      const waiting = [...feed.waiters].map((waiter) => waiter.id);
      const { jobs } = await deps.fetchJobs(path, waiting);
      feed.live = jobs.some(isLive);
      const taken: string[] = [];
      for (const waiter of [...feed.waiters]) {
        const job = jobs.find((each) => each.id === waiter.id);
        if (job && !isLive(job)) {
          feed.waiters.delete(waiter);
          taken.push(job.id);
          waiter.resolve(job);
        } else if (!job && ++waiter.misses >= MISSES) {
          feed.waiters.delete(waiter);
          waiter.reject(new Error("The job is no longer recorded, so its clip can't be collected here."));
        }
      }
      const shown = new Set<string>();
      for (const listener of feed.listeners) {
        const listed = listener(jobs) ?? jobs.filter((job) => !isLive(job)).map((job) => job.id);
        for (const id of listed) shown.add(id);
      }
      if (shown.size > 0 || taken.length > 0) void deps.markJobsShown([...shown], taken).catch(() => undefined);
    } catch {
      // Asked again at the next poll.
    } finally {
      feed.polling = false;
      if (feed.again) {
        feed.again = false;
        void poll(path);
      } else schedule(path, feed);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const path of feeds.keys()) void poll(path);
  });

  return {
    follow(path, listener) {
      const feed = feedOf(path);
      feed.listeners.add(listener);
      void poll(path);
      return () => {
        feed.listeners.delete(listener);
        if (!wanted(feed)) schedule(path, feed);
      };
    },
    wait(path, id, signal) {
      return new Promise<JobView>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const feed = feedOf(path);
        const waiter: Waiter = { id, misses: 0, resolve, reject };
        feed.waiters.add(waiter);
        signal?.addEventListener(
          "abort",
          () => {
            feed.waiters.delete(waiter);
            reject(signal.reason);
          },
          { once: true },
        );
        if (feed.timer === undefined && !feed.polling) schedule(path, feed);
      });
    },
    poke(path) {
      const feed = feedOf(path);
      feed.watchUntil = Date.now() + WATCH_MS;
      schedule(path, feed, 1500);
    },
  };
}

let feed: JobsFeed | undefined;

/** This window's feed. */
export function jobsFeed(): JobsFeed {
  feed ??= createJobsFeed();
  return feed;
}
