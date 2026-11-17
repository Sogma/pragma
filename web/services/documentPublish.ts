// Publishing a document without racing its own autosave. The server reads
// the file, spends seconds with the service, then writes `id` and `pushed`
// back — so the pending save goes first, the document's saves wait while the
// publish runs, and every file it wrote is rebased onto that write after.
// Without the rebase, the next save names a stale revision and is refused.
import type { PublishDocumentResponse, PublishWriteBack } from "../../src/protocol/api.ts";
import { editFrontmatter, parseFrontmatter, publishWriteBackKeys } from "../../src/protocol/frontmatter.ts";
import { PublishDocumentError, postPublishDocument } from "../core/apiClient.ts";
import type { DocumentsService } from "./documents.ts";
import { describeUnsaved, type SaveQueue } from "./saveQueue.ts";

export interface DocumentPublishDeps {
  queue: Pick<SaveQueue, "flush" | "pause" | "rebase" | "state">;
  documents: Pick<DocumentsService, "get">;
  post?: (path: string) => Promise<PublishDocumentResponse>;
}

// The write-back applied to content the queue still holds.
function withWriteBack(content: string, writeBack: PublishWriteBack): string {
  const { data } = parseFrontmatter(content);
  return editFrontmatter(content, { ...data, ...publishWriteBackKeys(data, writeBack) });
}

/** Publishes `path`. Rejects with a PublishDocumentError, the message ready
 * to show, when the document's own edits can't be saved first or the
 * publish fails. */
export async function publishDocument(path: string, deps: DocumentPublishDeps): Promise<PublishDocumentResponse> {
  // The server publishes the file on disk, so what is on screen has to be there.
  if (!(await deps.queue.flush(path))) {
    throw new PublishDocumentError(describeUnsaved(deps.queue.state(), "publishing", path));
  }
  const resume = deps.queue.pause(path);
  try {
    const result = await (deps.post ?? postPublishDocument)(path);
    // A section `index.md` published first is rebased too: it may be open,
    // though it was never paused, which rebase's wait on a write in flight covers.
    for (const writeBack of result.writeBacks) {
      const model = deps.documents.get(writeBack.path);
      const properties = model?.properties();
      if (model && properties) model.adoptWrittenProperties(publishWriteBackKeys(properties, writeBack));
      await deps.queue.rebase(writeBack.path, writeBack.revision, (content) => withWriteBack(content, writeBack));
    }
    return result;
  } finally {
    resume();
  }
}
