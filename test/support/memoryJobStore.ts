// A job store over a map the test holds, so it can seed and read jobs
// directly while a runner reads and writes the same ones.
import type { JobRecord, JobStore } from "../../src/server/jobs.ts";

export function memoryJobStore(records: Map<string, JobRecord>): JobStore {
  return {
    list: async () => [...records.values()],
    get: async (id) => records.get(id),
    add: async (job) => void records.set(job.id, job),
    update: async (id, change) => {
      const job = records.get(id);
      if (!job) return undefined;
      const next = change(job);
      records.set(id, next);
      return next;
    },
    remove: async (id) => void records.delete(id),
  };
}
