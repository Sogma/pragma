// Writing a document, and the publishing bookkeeping every write of one
// owes the site it sits in.
import path from "node:path";
import type { HistorySource, PutFileResponse, SavedDocumentDates } from "../protocol/api.ts";
import { appletCodeChanged } from "../protocol/appletNode.ts";
import { capabilityDigest, readFlowFile } from "../protocol/flowFile.ts";
import { editFrontmatter, isPrivate, parseFrontmatter } from "../protocol/frontmatter.ts";
import { isFlowFile, isMarkdownFile } from "../protocol/types.ts";
import { grantPath, remapGrantHash } from "./grants.ts";
import { noteKnown, writeDocument } from "./history.ts";
import { addPendingEntry, resolveSiteForPath } from "./sites.ts";
import { revisionOf, writeFileAtomic } from "./spaceFiles.ts";

/** Writes `content` over the document at `filePath`, carrying a flow's
 * grants across and doing the publishing bookkeeping below. The returned
 * revision is minted from the bytes written, not re-read, so a write landing
 * just after this one can't be passed off as this save's result.
 *
 * Only for a save a human performed — an editor save, or the copilot's edit
 * to the open document. A granted `writeDocument` owes the site the same
 * bookkeeping, but carrying a flow's grants across it is not its to do. */
export async function saveDocument(
  spaceRoot: string,
  { filePath, relativePath }: { filePath: string; relativePath: string },
  content: string,
  source: HistorySource = "edit",
): Promise<PutFileResponse> {
  // A flow's grants are pinned to its capability digest, so a save that
  // changes the graph would drop them — including the edits that *are* the
  // consent (wiring the node a human just dragged in). Carrying them across
  // pragma's own saves keeps first-use consent from re-firing on every edit.
  //
  // The pre-write digest is read here, never taken from the client. That is
  // also the gate: a file replaced behind pragma's back hashes to a digest no
  // record sits at, so the remap is a no-op and the grants stay stranded.
  //
  // Not across a save where an Applet node's code changed: what it reports
  // then comes from code no one approved, so the next run asks again.
  const graphBefore = isFlowFile(filePath) ? (await readFlowFile(filePath)).graph : undefined;

  await writeDocument(spaceRoot, filePath, content, { source });

  if (graphBefore !== undefined) {
    const graphAfter = (await readFlowFile(filePath)).graph;
    const digestBefore = capabilityDigest(graphBefore);
    const digestAfter = capabilityDigest(graphAfter);
    if (digestAfter !== digestBefore && !appletCodeChanged(graphBefore, graphAfter)) {
      await remapGrantHash(spaceRoot, grantPath(spaceRoot, filePath), digestBefore, digestAfter);
    }
  }

  const stamped = await recordDocumentChange(spaceRoot, { filePath, relativePath }, content);
  return { revision: revisionOf(stamped?.content ?? content), dates: stamped?.dates };
}

/** The publishing bookkeeping a changed document owes: an eligible `.md`
 * (not private, inside a site) is queued for republish and its
 * `created`/`updated` dates stamped in place; best-effort. Every path that
 * changes a document calls it, except the post-publish frontmatter
 * write-back (publishHandler.ts), which would re-queue what it just cleared.
 *
 * The dates and stamped content come back so a caller's working copy folds
 * them in — or its next autosave erases them — and so the revision names the
 * stamped bytes. */
export async function recordDocumentChange(
  spaceRoot: string,
  { filePath, relativePath }: { filePath: string; relativePath: string },
  content: string,
): Promise<{ dates: SavedDocumentDates; content: string } | undefined> {
  if (!isMarkdownFile(filePath)) return undefined;

  try {
    const { data } = parseFrontmatter(content);
    if (isPrivate(data)) return undefined;

    const target = resolveSiteForPath(spaceRoot, relativePath);
    if (!target) return undefined;

    addPendingEntry(
      path.join(spaceRoot, target.siteDir),
      typeof data.id === "string" ? { op: "publish", id: data.id } : { op: "publish", path: relativePath },
    );

    const now = new Date().toISOString();
    const created = typeof data.created === "string" ? data.created : now;
    const stamped = editFrontmatter(content, { ...data, created, updated: now });
    noteKnown(spaceRoot, filePath, stamped);
    await writeFileAtomic(filePath, stamped);
    return { dates: { created, updated: now }, content: stamped };
  } catch {
    // best-effort only — the write this follows already succeeded
    return undefined;
  }
}
