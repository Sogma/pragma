import { beforeEach, describe, expect, it } from "vitest";
import { activitySince, recordActivity, resetActivityLog } from "../../src/server/activityLog.ts";

beforeEach(() => {
  resetActivityLog();
});

describe("the activity log's cursor", () => {
  it("answers a first read with a cursor and no entries", () => {
    recordActivity("info", "MCP", "Connected — Claude Desktop", "token “x”");

    // The no-backlog rule, enforced here rather than in the client: the
    // Console is a window onto what happens while it is open.
    expect(activitySince()).toEqual({ cursor: 1, entries: [] });
  });

  it("returns only what arrived after the cursor", () => {
    recordActivity("info", "MCP", "first", "");
    const { cursor } = activitySince();
    recordActivity("info", "MCP", "second", "");
    recordActivity("warn", "API", "third", "");

    const next = activitySince(cursor);
    expect(next.entries.map((entry) => entry.label)).toEqual(["second", "third"]);
    expect(next.cursor).toBe(3);
  });

  it("returns nothing when nothing has happened since", () => {
    recordActivity("info", "FLOW", "Ran a.flow.html", "");
    const { cursor } = activitySince(0);
    expect(activitySince(cursor).entries).toEqual([]);
  });

  it("starts from zero when the log is empty", () => {
    expect(activitySince(0)).toEqual({ cursor: 0, entries: [] });
  });
});

describe("the activity log's buffer", () => {
  it("keeps the newest entries and drops the oldest", () => {
    for (let i = 1; i <= 260; i++) recordActivity("info", "API", `call ${i}`, "");

    // A reader that fell behind gets what survives, not an error: the log
    // promises a tail, never a complete record.
    const { entries } = activitySince(0);
    expect(entries).toHaveLength(200);
    expect(entries[0].label).toBe("call 61");
    expect(entries.at(-1)?.label).toBe("call 260");
  });

  it("keeps the cursor monotonic across eviction", () => {
    for (let i = 0; i < 260; i++) recordActivity("info", "API", "call", "");
    expect(activitySince().cursor).toBe(260);
  });

  it("carries the level and kind through unchanged", () => {
    recordActivity("warn", "API", "Refused — Unknown token", "GET /space");
    expect(activitySince(0).entries[0]).toEqual({
      seq: 1,
      level: "warn",
      kind: "API",
      label: "Refused — Unknown token",
      content: "GET /space",
    });
  });
});
