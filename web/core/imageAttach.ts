// Getting a file into a note: copying an image from outside the space in
// beside the document, and writing the embed or link that names a file. Each
// is written by the one writing rule a move rewrites with, so it survives the
// note moving; a library file is named outright as `lib:<id>/…`.
import { basenameOf, dirnameOf, parseRootedPath, type RootedPath } from "../../src/protocol/rootedPath.ts";
import { extensionForMediaType, IMAGE_EXTENSIONS, imageMediaTypeForPath } from "../../src/protocol/types.ts";
import { formatWikilink, wikilinkName } from "../../src/protocol/wikilink.ts";
import { postUploadFile } from "./apiClient.ts";
import { stripExtension } from "./paths.ts";
import { scopesOf, writePathFrom } from "./spaceTree.ts";

// A bracket or backslash in a link's text would end it early or escape what
// follows, so each is escaped rather than dropped.
const linkText = (text: string): string => text.replace(/[[\]\\]/g, "\\$&");

/** The Markdown embed for `imagePath`, as written inside the document at
 * `docPath`, or undefined when that document can't name the file — a library
 * document reaching outside its own library. The alt text is the image's own
 * name, which reading view, or an app that can't follow the path, shows in
 * its place. */
export function imageEmbedFor(docPath: string, imagePath: string, scopes = scopesOf(docPath)): string | undefined {
  const reference = writePathFrom(dirnameOf(docPath), parseRootedPath(imagePath), { scopes });
  if (reference === undefined) return undefined;
  return `![${linkText(stripExtension(basenameOf(imagePath)))}](${reference})`;
}

/** What a tree row dropped into the note at `docPath` writes when it isn't an
 * image: a link to it, a wikilink or a Markdown link by `wikilinks`.
 * Undefined when the document can't name it. */
export function droppedLinkFor(
  docPath: string,
  target: RootedPath,
  {
    folder,
    wikilinks,
    scopes = scopesOf(docPath),
  }: { folder: boolean; wikilinks: boolean; scopes?: ReadonlySet<string> },
): string | undefined {
  const form = wikilinks ? "wikilink" : "markdown";
  const path = writePathFrom(dirnameOf(docPath), target, { form, scopes, folder });
  if (path === undefined) return undefined;
  if (wikilinks) return formatWikilink(path, undefined);
  return `[${linkText(wikilinkName(folder ? `${target.path}/` : target.path))}](${path})`;
}

/** The name a pasted image gets. A clipboard image arrives unnamed or as the
 * browser's `image.png`, so keeping that would file every screenshot as
 * `image 2.png`, `image 3.png`. A timestamp is unique without a collision
 * check and sorts chronologically. Local time, not UTC — it is read by the
 * person who pressed the keys. */
export function pastedImageName(mediaType: string): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${extensionForMediaType(mediaType) ?? "png"}`;
}

/** Whether a media type is one the space can hold and reading view can show.
 * A pasted image is identified by its type rather than its name, which the
 * clipboard often leaves blank — the name is minted here anyway. */
export function isSpaceImageMediaType(mediaType: string): boolean {
  return Object.values(IMAGE_EXTENSIONS).includes(mediaType as never);
}

/** Whether a file can be embedded in a note at all, as a message to show or
 * undefined for "yes". Checked here as well as on the route so a file the
 * note could never show is refused before it crosses the wire. */
export function imageAttachRefusal(name: string, byteLength: number): string | undefined {
  if (!imageMediaTypeForPath(name)) return `"${name}" isn't an image Pragma can embed.`;
  if (byteLength === 0) return `"${name}" is empty.`;
  return undefined;
}

/** Copies `file` into `folder` and returns its Markdown embed as written
 * from `docPath`. The folder defaults to `docPath`'s own, so the embed is a
 * bare filename — the one reference form that survives either file moving.
 * The embed uses the name the server reports back, not the one asked for: a
 * name already taken is stepped around. Throws a message meant to be shown. */
export async function attachImageToDocument(
  file: Blob,
  name: string,
  docPath: string,
  folder = dirnameOf(docPath),
): Promise<string> {
  const refusal = imageAttachRefusal(name, file.size);
  if (refusal) throw new Error(refusal);
  const uploaded = await postUploadFile(folder, name, file);
  const embed = imageEmbedFor(docPath, uploaded.path);
  if (embed === undefined) throw new Error(`"${uploaded.path}" can't be embedded from here.`);
  return embed;
}
