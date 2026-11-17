const HOUR = 60 * 60 * 1000;
const FREE_TRIES = 5;
const LONGEST_WAIT_SECONDS = 15 * 60;

/** Failed sign-in tries, counted apart for each key. */
export interface LoginThrottle {
  /** 0 when `key` may try now. */
  secondsToWait(key: string): number;
  countFailure(key: string): void;
}

// The first 5 failed tries cost nothing. After each one past that, the next
// try waits twice as long as the last did, from 1 second up to 15 minutes. A
// key's count clears after an hour without a failed try; counts live in
// memory, so a restart clears them too.
export function createLoginThrottle(): LoginThrottle {
  const counts = new Map<string, { failures: number; last: number }>();

  const current = (key: string, now: number) => {
    const count = counts.get(key);
    if (count && now - count.last < HOUR) return count;
    counts.delete(key);
    return undefined;
  };

  return {
    secondsToWait(key) {
      const now = Date.now();
      const count = current(key, now);
      if (!count || count.failures <= FREE_TRIES) return 0;
      const wait = Math.min(2 ** (count.failures - FREE_TRIES - 1), LONGEST_WAIT_SECONDS);
      const until = count.last + wait * 1000;
      return until > now ? Math.ceil((until - now) / 1000) : 0;
    },
    countFailure(key) {
      const now = Date.now();
      for (const [other, count] of counts) if (now - count.last >= HOUR) counts.delete(other);
      counts.set(key, { failures: (current(key, now)?.failures ?? 0) + 1, last: now });
    },
  };
}
