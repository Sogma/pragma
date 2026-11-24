// A Pragma link, `pragma://<space>/<path>`: a file or folder named from
// outside Pragma by its space's name and its path there. A folder ends with
// `/`; a library's entry keeps its `lib:<id>/…` address.
//
// Read with this pattern, never the standard URL parser: that one refuses a
// hand-typed space and drops `.` and `..` segments without a word, so a
// malformed link would open a different file. The path splits at `/` before
// its percent codes are decoded, and every check runs on the decoded names,
// so an encoded `..` or slash can't slip past.

import { isHiddenPath } from "./relativeReference.ts";
import { formatRootedPath, parseRootedPath, type RootedPath } from "./rootedPath.ts";

/** The longest link read: one from a web page is untrusted, so its size is
 * bounded before any work is done on it. */
export const MAX_PRAGMA_URL_LENGTH = 4096;

export interface PragmaLink {
  /** The space as the link names it: its name, or its id. */
  space: string;
  /** A space path or a `lib:<id>/…` address; "" for the space itself. */
  path: string;
  /** Whether the path names a folder, which the link marks with a `/`. */
  folder: boolean;
}

export type PragmaLinkRead = { link: PragmaLink } | { refusal: string };

const SCHEME = /^pragma:\/\//i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character in a link is what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether `input` claims the Pragma scheme: a link to hand to the parser,
 * which may still refuse it. */
export function hasPragmaScheme(input: string): boolean {
  return /^pragma:/i.test(input);
}

/** The link to `link`, every name percent-encoded. A path keeps its `:`, so a
 * library's address reads as Pragma writes it everywhere else. */
export function formatPragmaUrl(link: PragmaLink): string {
  const space = `pragma://${encodeURIComponent(link.space)}`;
  if (link.path === "") return space;
  const names = link.path.split("/").map((name) => encodeURIComponent(name).replaceAll("%3A", ":"));
  return `${space}/${names.join("/")}${link.folder ? "/" : ""}`;
}

/** What `input` links to, or why it links to nothing Pragma opens. */
export function parsePragmaUrl(input: string): PragmaLinkRead {
  if (input.length > MAX_PRAGMA_URL_LENGTH) {
    return { refusal: `A Pragma link can't be longer than ${MAX_PRAGMA_URL_LENGTH} characters` };
  }
  if (!SCHEME.test(input)) return { refusal: `Not a Pragma link: "${input}"` };
  const rest = input.replace(SCHEME, "");
  if (/[?#]/.test(rest)) return { refusal: `A Pragma link carries no query or fragment: "${input}"` };

  const slash = rest.indexOf("/");
  const pathPart = slash === -1 ? "" : rest.slice(slash + 1);
  const raws = pathPart === "" ? [] : pathPart.split("/");
  // The last piece is empty only after a folder's `/`; any other empty piece
  // is an empty name, refused below.
  const folder = raws.length === 0 || raws.at(-1) === "";
  if (raws.length > 0 && folder) raws.pop();
  const space = decoded(slash === -1 ? rest : rest.slice(0, slash));
  const names: string[] = [];
  for (const raw of raws) {
    const name = decoded(raw);
    if (name === undefined) return { refusal: `A Pragma link holds a broken % code: "${input}"` };
    names.push(name);
  }

  if (space === undefined) return { refusal: `A Pragma link holds a broken % code: "${input}"` };
  if (space === "") return { refusal: `A Pragma link names no space: "${input}"` };
  if ([space, ...names].some((name) => CONTROL.test(name))) {
    return { refusal: `A Pragma link holds a control character: "${input}"` };
  }
  if (names.includes("")) return { refusal: `A Pragma link has an empty name: "${input}"` };
  if (names.some((name) => name.includes("/") || name.includes("\\"))) {
    return { refusal: `A Pragma link can't hold "/" or "\\" inside a name: "${input}"` };
  }

  let rooted: RootedPath;
  try {
    rooted = parseRootedPath(names.join("/"));
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : `Not a Pragma link: "${input}"` };
  }
  if (isHiddenPath(rooted.path)) return { refusal: `A Pragma link can't name a hidden entry: "${input}"` };
  return { link: { space, path: formatRootedPath(rooted), folder } };
}

function decoded(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}
