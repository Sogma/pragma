// What a Search query asks for: `tag:name` terms, each keeping only the
// documents carrying that tag or one nested under it, and the rest of its
// text, matched as written. Read alike by the host that searches and the view
// that marks what it found.
import { unmarkedTagName } from "./tags.ts";

export interface SearchQuery {
  // Each term's tag, a leading `#` dropped.
  tags: string[];
  text: string;
}

const TAG_TERM = /(^|\s+)tag:(\S+)/gi;

export function readSearchQuery(query: string): SearchQuery {
  const tags: string[] = [];
  const text = query.replace(TAG_TERM, (_term, _space: string, written: string) => {
    const name = unmarkedTagName(written);
    if (name) tags.push(name);
    return "";
  });
  return { tags, text: text.trim() };
}
