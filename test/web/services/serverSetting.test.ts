import { describe, expect, it, vi } from "vitest";
import { createServerSetting } from "../../../web/services/serverSetting.ts";

function setup(initial: boolean, stored: boolean) {
  const fetch = vi.fn(async () => stored);
  const save = vi.fn(async (_value: boolean) => undefined);
  const onSaveFailed = vi.fn();
  return { setting: createServerSetting({ initial, fetch, save, onSaveFailed }), fetch, save, onSaveFailed };
}

describe("server setting", () => {
  it("holds its safe value until the server answers, then follows it", async () => {
    const { setting } = setup(true, false);
    const seen: boolean[] = [];
    setting.subscribe((value) => seen.push(value));
    expect(setting.get()).toBe(true);
    await setting.refresh();
    expect(setting.get()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("keeps the last value when the server can't be reached", async () => {
    const { setting, fetch } = setup(true, false);
    await setting.refresh();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await setting.refresh();
    expect(setting.get()).toBe(false);
  });

  it("saves a change to the server", () => {
    const { setting, save } = setup(false, false);
    setting.set(true);
    expect(setting.get()).toBe(true);
    expect(save).toHaveBeenCalledWith(true);
  });

  it("flips back and reports when the server refuses the save", async () => {
    const { setting, save, onSaveFailed } = setup(true, true);
    const refused = new Error("Couldn't save the trash setting");
    save.mockRejectedValueOnce(refused);
    setting.set(false);
    await vi.waitFor(() => expect(onSaveFailed).toHaveBeenCalledWith(refused));
    expect(setting.get()).toBe(true);
  });
});
