// The copilot's notes on Open Knowledge Format, added to its orientation
// whenever a turn starts inside a declared bundle. They describe one version
// of the spec and change only with a Pragma release, so a bundle declaring
// another is told so rather than refused: most of the notes still hold.
import { localDay } from "../../../protocol/localDay.ts";
import type { ContextSource } from "../../copilotContext.ts";
import { type Bundle, findBundle } from "./bundle.ts";

const OKF_VERSION = "0.2";

export const okfContext: ContextSource = {
  async section(request) {
    const bundle = await findBundle(request);
    if (!bundle) return null;
    const notes = notesOn(bundle, new Date());
    const listing = bundle.index.body.trim();
    // Quoted only when the whole of it fits: the registry would cut a longer
    // one, and a cut listing reads as the whole bundle.
    const quoted = listing
      ? `${notes}\n\nThe bundle's listing, \`${bundle.index.path}\`:\n\n${fenced(listing)}`
      : `${notes}\n\nThe bundle's listing, \`${bundle.index.path}\`, lists nothing yet.`;
    const named = `${notes}\n\nThe bundle's listing is \`${bundle.index.path}\`, too long to quote here: read it before relying on what the bundle holds.`;
    return {
      title: `Open Knowledge Format bundle (${bundle.index.path})`,
      body: quoted.length <= request.limit ? quoted : named,
    };
  },
};

function notesOn(bundle: Bundle, now: Date): string {
  const root = bundle.folder === "" ? "the space root" : `\`${bundle.folder}/\``;
  const lines = [
    `The writer is working inside an Open Knowledge Format (OKF) bundle whose root folder is ${root}: Markdown concept documents with YAML frontmatter, kept for agents to read. Follow OKF ${OKF_VERSION} when you read or change anything in it. Today is ${localDay(now)}.`,
  ];
  if (bundle.version !== undefined && bundle.version !== OKF_VERSION) {
    lines.push(
      "",
      `The bundle declares OKF ${bundle.version}, and these notes describe ${OKF_VERSION}: where the bundle's own files disagree with them, follow the files.`,
    );
  }
  lines.push(
    "",
    "- `index.md` in any folder is that folder's listing, not a concept. It has no frontmatter, except `okf_version` in the bundle root's, and lists entries under headings, one line each: `* [Title](link) - description`, the description taken from the concept's own frontmatter.",
    "- `log.md` in any folder is that folder's update history, not a concept: dates as `YYYY-MM-DD` headings, newest first, one bullet per change.",
    "- Every other `.md` file is a concept. Its YAML frontmatter needs a non-empty `type`, and `title`, `description`, `resource` and `tags` are recommended. Keep every key you don't know when you edit one.",
    "- `sources` says where a concept's content came from, and `stale_after` is the instant it goes stale. Say so when you rely on a concept whose `stale_after` has passed.",
    linkRule(bundle),
    "- When you propose a new concept, also propose its entry in its folder's `index.md` and a line in that folder's `log.md`, where the folder has them.",
  );
  if (bundle.closestListing) {
    lines.push("", `The listing closest to where the writer is working is \`${bundle.closestListing}\`.`);
  }
  return lines.join("\n");
}

// Fenced, so the listing's own headings never read as the prompt's, with a
// fence longer than any run of backticks inside it.
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}markdown\n${text}\n${fence}`;
}

// OKF reads a link starting with `/` from the bundle root, and Pragma from
// the space root, so the two agree only when the bundle is the whole space.
function linkRule(bundle: Bundle): string {
  const markdownLinks =
    "- Link concepts with standard Markdown links that keep the `.md` extension, never `[[wikilinks]]`, which OKF readers don't follow.";
  return bundle.folder === ""
    ? `${markdownLinks} A link starting with \`/\` is read from the bundle root, which is also the space root.`
    : `${markdownLinks} Write each link relative to its document's folder: OKF reads a link starting with \`/\` from the bundle root, but this editor reads it from the space root, so one would break here.`;
}
