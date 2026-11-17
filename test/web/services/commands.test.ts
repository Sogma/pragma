import { describe, expect, it, vi } from "vitest";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

describe("commands", () => {
  it("registers once per id, looks up, and runs with the context and argument", async () => {
    const commands = createCommands();
    const run = vi.fn();
    commands.register({ id: "a", label: "A", run });
    expect(commands.get("a")?.label).toBe("A");
    expect(() => commands.register({ id: "a", label: "again", run })).toThrow("already registered");

    await expect(commands.run("a", context, { x: 1 })).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(context, { x: 1 });
    await expect(commands.run("missing", context)).resolves.toBe(false);
  });

  it("`when` gates both isEnabled and run", async () => {
    const commands = createCommands();
    const run = vi.fn();
    commands.register({ id: "dir", label: "Dir only", run, when: (_, arg: { dir: boolean }) => arg.dir });
    expect(commands.isEnabled("dir", context, { dir: true })).toBe(true);
    expect(commands.isEnabled("dir", context, { dir: false })).toBe(false);
    expect(commands.isEnabled("missing", context)).toBe(false);
    await expect(commands.run("dir", context, { dir: false })).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("disposing a registration removes it, and only it", () => {
    const commands = createCommands();
    const first = commands.register({ id: "a", label: "A", run: () => undefined });
    first.dispose();
    expect(commands.get("a")).toBeUndefined();
    commands.register({ id: "a", label: "A2", run: () => undefined });
    first.dispose(); // stale: must not remove the newer registration
    expect(commands.get("a")?.label).toBe("A2");
  });
});
