import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageModelsResponse, ModelsResponse } from "../../../src/protocol/api.ts";
import { fetchImageModels, fetchModels, postDefaultImageModel, postDefaultModel } from "../../../web/core/apiClient.ts";
import { createModelLists } from "../../../web/services/modelLists.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchModels: vi.fn(),
  fetchImageModels: vi.fn(),
  postDefaultModel: vi.fn(),
  postDefaultImageModel: vi.fn(),
}));

const text = (...ids: string[]): ModelsResponse => ({
  models: ids.map((id) => ({ id, label: id, provider: "p", model: id })),
  providers: [{ id: "p", label: "P" }],
  defaultModel: null,
});

const image: ImageModelsResponse = {
  models: [{ id: "h/soul", label: "Soul", provider: "h", model: "Soul" }],
  providers: [{ id: "h", label: "H" }],
  defaultModel: "h/soul",
  failures: [],
};

beforeEach(() => {
  vi.mocked(fetchModels).mockReset().mockResolvedValue(text("p/a"));
  vi.mocked(fetchImageModels).mockReset().mockResolvedValue(image);
  vi.mocked(postDefaultModel).mockReset().mockResolvedValue();
  vi.mocked(postDefaultImageModel).mockReset().mockResolvedValue();
});

function setup() {
  const logEntry = vi.fn();
  const lists = createModelLists({ modelConsole: { logEntry } });
  const heard = vi.fn();
  lists.subscribe(heard);
  return { lists, logEntry, heard };
}

describe("createModelLists", () => {
  it("fetches a list once however many pickers ask, and refreshes only the lists asked for", async () => {
    const { lists, heard } = setup();
    expect(heard).toHaveBeenCalledTimes(1);
    lists.load("text");
    lists.load("text");
    await vi.waitFor(() => expect(lists.get("text")?.models.map((model) => model.id)).toEqual(["p/a"]));
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(2);

    vi.mocked(fetchModels).mockResolvedValue(text("p/a", "p/b"));
    await lists.refresh();
    expect(lists.get("text")?.models.map((model) => model.id)).toEqual(["p/a", "p/b"]);
    expect(fetchImageModels).not.toHaveBeenCalled();
    expect(lists.get("image")).toBeUndefined();

    lists.load("image");
    await vi.waitFor(() => expect(lists.get("image")?.defaultModel).toBe("h/soul"));
    await lists.refresh();
    expect([vi.mocked(fetchModels).mock.calls.length, vi.mocked(fetchImageModels).mock.calls.length]).toEqual([3, 2]);
  });

  it("drops a list whose fetch fails and says why in the Console", async () => {
    const { lists, logEntry } = setup();
    lists.load("text");
    await vi.waitFor(() => expect(lists.get("text")).toBeDefined());

    vi.mocked(fetchModels).mockRejectedValue(new Error("Server unreachable"));
    await lists.refresh();
    expect(lists.get("text")).toBeUndefined();
    expect(logEntry).toHaveBeenCalledWith("warn", "Models", "Couldn't load the model list", "Server unreachable");
  });

  it("never lets an older fetch land over the refresh that followed it", async () => {
    let answerFirst: (list: ModelsResponse) => void = () => {};
    vi.mocked(fetchModels).mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    const { lists } = setup();
    lists.load("text");
    vi.mocked(fetchModels).mockResolvedValue(text("p/new"));
    await lists.refresh();
    answerFirst(text("p/old"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lists.get("text")?.models.map((model) => model.id)).toEqual(["p/new"]);
  });

  it("names a saved default at once, before its list is fetched again, and none as blank", async () => {
    const { lists, heard } = setup();
    lists.load("image");
    await vi.waitFor(() => expect(lists.defaultOf("image")).toBe("h/soul"));
    heard.mockClear();

    // A listing can take seconds; the new default shows without it.
    vi.mocked(fetchImageModels).mockReturnValue(new Promise(() => {}));
    await lists.setDefault("image", "h/other");
    expect(postDefaultImageModel).toHaveBeenCalledWith("h/other");
    expect(lists.defaultOf("image")).toBe("h/other");
    expect(lists.get("image")?.models).toEqual(image.models);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(fetchImageModels).toHaveBeenCalledTimes(2);

    await lists.setDefault("image", "");
    expect(postDefaultImageModel).toHaveBeenLastCalledWith("");
    expect(lists.get("image")?.defaultModel).toBeNull();
    expect(lists.defaultOf("image")).toBe("");
  });

  it("saves the text default through its own route, and names none before its list arrives", async () => {
    const { lists } = setup();
    expect(lists.defaultOf("text")).toBe("");
    lists.load("text");
    await vi.waitFor(() => expect(lists.get("text")).toBeDefined());

    vi.mocked(fetchModels).mockReturnValue(new Promise(() => {}));
    await lists.setDefault("text", "p/a");
    expect(postDefaultModel).toHaveBeenCalledWith("p/a");
    expect(postDefaultImageModel).not.toHaveBeenCalled();
    expect(lists.defaultOf("text")).toBe("p/a");
  });

  it("leaves the list alone when the save is refused, and rejects with the server's reason", async () => {
    const { lists, heard } = setup();
    lists.load("image");
    await vi.waitFor(() => expect(lists.get("image")).toBeDefined());
    heard.mockClear();

    vi.mocked(postDefaultImageModel).mockRejectedValue(new Error('No provider "x" is configured'));
    await expect(lists.setDefault("image", "x/y")).rejects.toThrow('No provider "x" is configured');
    expect(lists.defaultOf("image")).toBe("h/soul");
    expect(heard).not.toHaveBeenCalled();
    expect(fetchImageModels).toHaveBeenCalledTimes(1);
  });

  it("never lets a fetch that read the old default land over a saved one", async () => {
    let answerFirst: (list: ImageModelsResponse) => void = () => {};
    vi.mocked(fetchImageModels).mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    const { lists } = setup();
    lists.load("image");
    vi.mocked(fetchImageModels).mockResolvedValue({ ...image, defaultModel: "h/other" });
    await lists.setDefault("image", "h/other");
    await vi.waitFor(() => expect(lists.defaultOf("image")).toBe("h/other"));
    answerFirst(image);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lists.defaultOf("image")).toBe("h/other");
  });
});
