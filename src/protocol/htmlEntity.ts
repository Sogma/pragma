import { decodeHTMLStrict } from "entities/decode";

/**
 * A Markdown entity, `&eacute;`, `&#233;` or `&#xe9;`, as the character it
 * names by HTML's table. A name HTML doesn't know stays as written, even one
 * that opens with a name it does (`&notit;`).
 */
export function decodeEntity(raw: string): string {
  return decodeHTMLStrict(raw);
}
