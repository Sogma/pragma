// @vitest-environment jsdom
// jsdom because splitting off the properties lifts the leading heading
// through markdownRender.ts, which builds a DOM node to do it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishDocumentResponse } from "../../../src/protocol/api.ts";
import { type PutFileResponse, SaveConflictError, type TextFileResponse } from "../../../web/core/apiClient.ts";
import { publishDocument } from "../../../web/services/documentPublish.ts";
import { createDocuments } from "../../../web/services/documents.ts";
import { createSaveQueue } from "../../../web/services/saveQueue.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PATH = "blog/post.md";

function post(overrides: Partial<TextFileResponse> = {}): TextFileResponse {
  return {
    kind: "text",
    path: PATH,
    revision: "rev-read",
    documentType: "note",
    content: "---\ntags:\n  - a\n---\n\n# Post\n\nfirst line\n",
    toolkits: [],
    classLinks: [],
    fields: [],
    ...overrides,
  };
}

const PUBLISHED: PublishDocumentResponse = {
  id: "doc_1",
  url: "https://site.example/post",
  pushed: "2026-09-30T17:10:19Z",
  date: "2026-09-30",
  notes: [],
  writeBacks: [
    { path: PATH, revision: "rev-published", id: "doc_1", pushed: "2026-09-30T17:10:19Z", date: "2026-09-30" },
  ],
};

function setup(file: TextFileResponse = post()) {
  const events: string[] = [];
  const putFile = vi.fn(async (path: string, _content: string, _base?: string): Promise<PutFileResponse> => {
    events.push(`put ${path}`);
    return { revision: `rev-saved-${putFile.mock.calls.length}` };
  });
  const queue = createSaveQueue({ putFile, delayMs: 500 });
  const documents = createDocuments({ queue, fetchFile: async () => file });
  const model = documents.adopt(file);
  let answer: () => void = () => {};
  const postFn = vi.fn(
    (path: string) =>
      new Promise<PublishDocumentResponse>((resolve) => {
        events.push(`post ${path}`);
        answer = () => resolve(PUBLISHED);
      }),
  );
  const publish = () => publishDocument(PATH, { queue, documents, post: postFn });
  return { queue, putFile, model, postFn, publish, events, answer: () => answer() };
}

describe("publishDocument", () => {
  it("writes the document's pending edit before the server reads the file", async () => {
    const { model, publish, events, answer } = setup();
    model.setBody("first line, edited");

    const publishing = publish();
    await vi.advanceTimersByTimeAsync(0);
    answer();
    await publishing;

    expect(events).toEqual([`put ${PATH}`, `post ${PATH}`]);
  });

  it("refuses to publish over a save conflict, and says which file", async () => {
    const { putFile, model, postFn, publish } = setup();
    putFile.mockRejectedValueOnce(new SaveConflictError("changed", 409));
    model.setBody("mine");
    await vi.advanceTimersByTimeAsync(500);

    await expect(publish()).rejects.toThrow(`${PATH} has a save conflict`);
    expect(postFn).not.toHaveBeenCalled();
  });

  // The reported bug: the write-back replaced the file's revision behind the
  // editor, so its next save named the old one and was refused.
  it("bases the next save on the write-back, with the published keys in it", async () => {
    const { putFile, model, publish, answer } = setup();
    const publishing = publish();
    await vi.advanceTimersByTimeAsync(0);
    answer();
    await publishing;

    expect(model.properties()).toMatchObject({ id: "doc_1", pushed: "2026-09-30T17:10:19Z", date: "2026-09-30" });
    expect(putFile).not.toHaveBeenCalled();

    model.setBody("after publishing");
    await vi.advanceTimersByTimeAsync(500);
    const [, content, base] = putFile.mock.calls[0];
    expect(base).toBe("rev-published");
    expect(content).toContain("id: doc_1");
    expect(content).toContain("after publishing");
  });

  it("holds an edit typed during the publish, then writes it on the write-back's revision", async () => {
    const { putFile, model, publish, answer } = setup();
    const publishing = publish();
    await vi.advanceTimersByTimeAsync(0);
    model.setBody("typed while publishing");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(putFile).not.toHaveBeenCalled();

    answer();
    await publishing;
    await vi.advanceTimersByTimeAsync(0);

    expect(putFile).toHaveBeenCalledTimes(1);
    const [, content, base] = putFile.mock.calls[0];
    expect(base).toBe("rev-published");
    expect(content).toBe(model.content());
    expect(content).toContain("id: doc_1");
    expect(content).toContain("typed while publishing");
  });

  it("keeps a date the writer set during a first publish over the one it seeded", async () => {
    const { putFile, model, publish, answer } = setup();
    const publishing = publish();
    await vi.advanceTimersByTimeAsync(0);
    const properties = model.properties();
    if (properties) properties.date = "2019-11-08";
    model.notePropertiesChanged();

    answer();
    await publishing;
    await vi.advanceTimersByTimeAsync(0);

    expect(model.properties()?.date).toBe("2019-11-08");
    expect(putFile.mock.calls[0][1]).toContain("date: 2019-11-08");
  });
});
