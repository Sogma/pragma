// Quick Open's ranking. A file is named by its stem, kind suffix stripped,
// so the file the query names outright ranks first and a name match
// outranks any folder match. Ranking on the full path would sink `songs`
// below every file under a `songs/` folder.
import { createNameIndex, matchName } from "../../src/protocol/nameIndex.ts";
import { wikilinkStem } from "../../src/protocol/wikilink.ts";

const NAMED = 10_000;
const EXACT = 1_000;
const PREFIX = 800;
const WORD_START = 600;
const CONTAINS = 500;
const FUZZY = 300;
// Characters skipped between two subsequence hits each cost this much, so a
// tight fuzzy match beats a scattered one.
const GAP_COST = 5;
// A path match can never reach a name match's floor.
const PATH_SCALE = 0.25;
const RECENT_BONUS = 50;
// A preferred file wins among matches of about the same quality, never
// over a clearly better one.
const PREFERRED_BONUS = 150;

function subsequenceScore(haystack: string, needle: string): number | undefined {
  let at = 0;
  let gaps = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found === -1) return undefined;
    if (at > 0) gaps += found - at;
    at = found + 1;
  }
  return Math.max(1, FUZZY - gaps * GAP_COST);
}

function tokenScore(text: string, token: string): number | undefined {
  if (text === token) return EXACT;
  if (text.startsWith(token)) return PREFIX;
  const index = text.indexOf(token);
  if (index !== -1) return /[\s\-_./]/.test(text[index - 1] ?? "") ? WORD_START : CONTAINS;
  return subsequenceScore(text, token);
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** How well `label` matches every word of `query`, or undefined when one
 * word doesn't match at all. */
export function scoreLabel(label: string, query: string): number | undefined {
  const text = label.toLowerCase();
  let score = 0;
  for (const token of queryTokens(query)) {
    const found = tokenScore(text, token);
    if (found === undefined) return undefined;
    score += found;
  }
  return score;
}

/** `paths`, filtered to the ones `query` matches and best first. Every
 * space-separated word must match, in the name or else in the path; a
 * recently opened file wins a tie, then the shorter path. A `preferred` file
 * outranks a slightly better match elsewhere. */
export function rankPaths(
  paths: readonly string[],
  query: string,
  recent: readonly string[] = [],
  preferred: (path: string) => boolean = () => false,
): string[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const target = matchName(createNameIndex(paths), query);
  const recency = new Map(recent.map((path, index) => [path, recent.length - index]));

  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const stem = wikilinkStem(path).toLowerCase();
    const lower = path.toLowerCase();
    let score = path === target ? NAMED : 0;
    for (const token of tokens) {
      const inName = tokenScore(stem, token);
      // A path is long enough that scattered letters match nearly anything,
      // so a word matches in the folders only as one unbroken run.
      const inPath = inName === undefined && lower.includes(token) ? tokenScore(lower, token) : undefined;
      if (inName === undefined && inPath === undefined) {
        score = -1;
        break;
      }
      score += inName ?? (inPath ?? 0) * PATH_SCALE;
    }
    if (score < 0) continue;
    const seen = recency.get(path);
    if (seen !== undefined) score += RECENT_BONUS * (seen / recent.length);
    if (preferred(path)) score += PREFERRED_BONUS;
    scored.push({ path, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .map(({ path }) => path);
}
