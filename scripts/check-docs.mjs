#!/usr/bin/env node
// Keeps docs/ honest without a model in the loop, by pure string matching.
// Run: `npm run check:docs` (also a CI step); exit 1 on any failure.
// `--comments` lists every comment counted against check 6.
//
//   1. Every `docs/<name>.md` path cited anywhere in the repo exists.
//   2. Every section reference — `docs/x.md's Foo section`, `[..](x.md#anchor)`,
//      `[..](../x.md#anchor)`, `[..](#anchor)` — resolves to a real heading.
//   3. Spec docs name no implementation files outside their
//      "Reference implementation" section, and share no heading anchor.
//
//   4. No current-state doc carries history narration.
//   5. Each doc stays under its size limit.
//   6. Code comments stay short and history-free (two ratchets — see below).
//   7. Every repo path a doc cites is tracked by git, so a clone has it too.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsDir = path.join(root, "docs");

// Docs whose prose must stay implementation-free (rule 3). Their only
// permitted file paths live under the heading named here.
const SPEC_DOCS = ["protocol.md", "flow-nodes.md"];
const REFERENCE_SECTION = "Reference implementation";

// Bytes. A doc over its limit fails; a doc not listed gets DEFAULT_LIMIT.
// Raise a limit deliberately, in the same change that needs it.
const SIZE_LIMITS = {
  "architecture.md": 28_140,
  "protocol.md": 103_460,
  "flow-nodes.md": 32_200,
  "publishing.md": 17_900,
  "deployment.md": 10_660,
  "README.md": 6_000,
};
const DEFAULT_LIMIT = 24_000;

// Check 6's ratchets. A count over its ceiling fails; lower a ceiling in the
// same change that brings its count down, and never raise one.
const PARAGRAPH_MAX_LINES = 5;
const PARAGRAPHS_MAX = 3;
const LONG_COMMENT_CEILING = 0;
const HISTORY_COMMENT_CEILING = 0;
const COMMENT_ROOTS = ["src", "web", "electron", "scripts", "bin", "test"];

const SKIP_DIRS = new Set(["node_modules", "dist", "release", ".git", "test-results"]);
const SOURCE_EXT = /\.(ts|mjs|js|html|css|md|json|jsonc|yml|yaml)$/;

// Gitignored and created per machine. Check 6 skips them, since they would
// make its counts local; check 7 lets a doc cite them, since the doc marks
// each one gitignored and says where it comes from.
const LOCAL_FILES = new Set(["dev-app-update.yml"]);

const failures = [];
function fail(file, line, message) {
  failures.push(`${path.relative(root, file)}${line ? `:${line}` : ""}: ${message}`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

// GitHub-style heading slug: lowercase, drop punctuation, spaces to hyphens.
function slug(text) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[`"“”'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Recursive, and every doc is named by its path under docs/ ("sub/x.md")
// rather than its bare filename — otherwise a doc in a subfolder silently
// falls out of the heading, size and history checks below instead of
// failing them.
function docsUnder(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...docsUnder(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function headingsOf(file) {
  const headings = [];
  let inFence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) headings.push({ text: m[1], slug: slug(m[1]), norm: normalize(m[1]) });
  }
  return headings;
}

const docFiles = docsUnder(docsDir);
const headingsByDoc = new Map(docFiles.map((name) => [name, headingsOf(path.join(docsDir, name))]));

function headingExists(doc, ref) {
  const headings = headingsByDoc.get(doc);
  if (!headings) return false;
  // "Text documents → Toolkit resolution" cites the leaf; "Applets > Manifest" too.
  const leaf = normalize(ref.split(/→|>|›/).pop());
  if (!leaf) return true;
  return headings.some((h) => h.norm === leaf || h.norm.includes(leaf));
}

function anchorExists(doc, anchor) {
  const headings = headingsByDoc.get(doc);
  if (!headings) return false;
  return headings.some((h) => h.slug === anchor.toLowerCase());
}

const sourceFiles = walk(root).filter((f) => path.relative(root, f) !== "scripts/check-docs.mjs");
let citations = 0;

for (const file of sourceFiles) {
  const rel = path.relative(root, file);
  const isDoc = rel.startsWith("docs/") && rel.endsWith(".md");
  const selfDoc = isDoc ? path.relative(docsDir, file).split(path.sep).join("/") : undefined;
  const lines = readFileSync(file, "utf8").split("\n");
  let inFence = false;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    if (isDoc && /^```/.test(rawLine)) inFence = !inFence;
    if (inFence) return;
    // A comment that wraps right after `docs/` continues on the next line;
    // join the two so the reference is still checked.
    const line =
      /docs\/\s*$/.test(rawLine) && lines[index + 1] !== undefined
        ? rawLine.trimEnd() + lines[index + 1].replace(/^\s*(\/\/|\*|\/\*|#|<!--)?\s*/, "")
        : rawLine;

    // 1. `docs/<path>.md` anywhere.
    for (const m of line.matchAll(/(?<![\w/.~-])docs\/([A-Za-z0-9_\-/]+\.md)\b/g)) {
      citations++;
      if (!existsSync(path.join(docsDir, m[1]))) fail(file, lineNo, `cites missing doc docs/${m[1]}`);
    }

    // 1b. Inside docs: backticked `name.md` followed by a possessive is the
    //     citation idiom ("`protocol.md`'s Tags section"), and markdown links.
    if (isDoc) {
      for (const m of line.matchAll(/`((?:[a-z0-9-]+\/)*[a-z][a-z0-9-]*\.md)`(?=['’]s\b)/g)) {
        citations++;
        if (!existsSync(path.join(docsDir, m[1]))) fail(file, lineNo, `cites missing doc ${m[1]}`);
      }
      for (const m of line.matchAll(/\]\(((?:[a-z0-9-]+\/)*[a-z][a-z0-9-]*\.md)(#[^)]+)?\)/g)) {
        citations++;
        if (!existsSync(path.join(docsDir, m[1]))) {
          fail(file, lineNo, `links to missing doc ${m[1]}`);
        } else if (m[2] && !anchorExists(m[1], m[2].slice(1))) {
          fail(file, lineNo, `links to missing section ${m[1]}${m[2]}`);
        }
      }
      // A link out of docs/, such as `../README.md#from-source`, resolves from
      // the doc's folder, and its anchor against the file it lands on.
      for (const m of line.matchAll(/\]\((\.\.\/[^)\s#]+\.md)(#[^)]+)?\)/g)) {
        citations++;
        const target = path.resolve(path.dirname(file), m[1]);
        if (!existsSync(target)) {
          fail(file, lineNo, `links to missing file ${m[1]}`);
        } else if (m[2] && !headingsOf(target).some((h) => h.slug === m[2].slice(1).toLowerCase())) {
          fail(file, lineNo, `links to missing section ${m[1]}${m[2]}`);
        }
      }
      for (const m of line.matchAll(/\]\(#([^)]+)\)/g)) {
        citations++;
        if (selfDoc && !anchorExists(selfDoc, m[1])) fail(file, lineNo, `links to missing section #${m[1]}`);
      }
    }

    // 2. "<doc>'s Foo section" / "<doc>'s "Foo"" — in code comments and docs.
    const sectionRefs = [
      ...line.matchAll(
        /docs\/((?:[a-z0-9-]+\/)*[a-z][a-z0-9-]*\.md)['’]s\s+(?:"([^"]+)"|“([^”]+)”|([A-Z][^.,;:()"“”]*?)\s+section)/g,
      ),
      ...line.matchAll(
        /`((?:[a-z0-9-]+\/)*[a-z][a-z0-9-]*\.md)`['’]s\s+(?:"([^"]+)"|“([^”]+)”|([A-Z][^.,;:()"“”]*?)\s+section)/g,
      ),
    ];
    for (const m of sectionRefs) {
      const doc = m[1];
      const ref = m[2] ?? m[3] ?? m[4];
      if (!existsSync(path.join(docsDir, doc))) continue; // reported by check 1
      citations++;
      if (!headingExists(doc, ref)) fail(file, lineNo, `cites section "${ref}" not found in docs/${doc}`);
    }
  });
}

// 3. Spec purity.
for (const name of SPEC_DOCS) {
  const file = path.join(docsDir, name);
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  let inReference = false;
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) inReference = normalize(h2[1]) === normalize(REFERENCE_SECTION);
    if (inReference) return;
    const paths = line.match(/\b(src|web|electron|bin|scripts|test)\/[A-Za-z0-9_\-/.]+/g) ?? [];
    const modules = line.match(/\b[A-Za-z][A-Za-z0-9]*\.(ts|mjs|css)\b/g) ?? [];
    for (const hit of [...paths, ...modules]) {
      fail(file, index + 1, `spec prose names implementation file ${hit} — move it under "${REFERENCE_SECTION}"`);
    }
  });
}

// 3, continued. The spec tool reads the spec docs as one set of sections, by
// anchor, so an anchor repeated in a second doc would hide that doc's heading.
const anchorOwners = new Map();
for (const name of SPEC_DOCS) {
  for (const { slug: anchor } of headingsByDoc.get(name) ?? []) {
    const owner = anchorOwners.get(anchor);
    if (owner === undefined) anchorOwners.set(anchor, name);
    else if (owner !== name) fail(path.join(docsDir, name), 0, `heading #${anchor} repeats one in ${owner}`);
  }
}

// 4. History narration in current-state docs.
const HISTORY =
  /\b(previously|used to|formerly|originally|superseded|no longer|was renamed|has since|as of \d{4}-\d{2}-\d{2}|\(\d{4}-\d{2}-\d{2}\))\b/i;
for (const name of docFiles) {
  if (name === "README.md") continue;
  const lines = readFileSync(path.join(docsDir, name), "utf8").split("\n");
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = HISTORY.exec(line);
    if (m) fail(path.join(docsDir, name), index + 1, `history narration ("${m[0]}") in a current-state doc`);
  });
}

// 5. Size limits.
for (const name of docFiles) {
  const size = statSync(path.join(docsDir, name)).size;
  const limit = SIZE_LIMITS[name] ?? DEFAULT_LIMIT;
  if (size > limit) {
    fail(
      path.join(docsDir, name),
      0,
      `is ${size} bytes, over its ${limit}-byte limit (raise SIZE_LIMITS deliberately)`,
    );
  }
}

// 6. Comment ratchets, enforcing AGENTS.md's comment rule by count. A block
// is a run of `//` lines or one `/* */`, and a paragraph a run of its
// non-blank lines. Length is judged per paragraph, not per block, so a comment
// guarding three traps can split them rather than cram them into one wall.
//
// The history pattern skips the senses that aren't history: "is used to
// <verb>", "the previously selected card", "set to today". "currently" stays
// out — it mostly names runtime state.
const HISTORY_IN_COMMENT = new RegExp(
  [
    String.raw`(?<!\b(?:is|are|be|been|being|was|were)\s)\bused to\b`,
    String.raw`\bpreviously\b(?!\s+(?:selected|open|opened|focused|active|shown)\b)`,
    String.raw`\bformerly\b`,
    String.raw`\bfor now\b`,
    String.raw`(?<!\b(?:to|on|in|with)\s)\btoday\b`,
  ].join("|"),
  "i",
);

function commentBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; ) {
    const start = lines[i].trim();
    let end = i;
    if (start.startsWith("//")) {
      while (end + 1 < lines.length && lines[end + 1].trim().startsWith("//")) end++;
    } else if (start.startsWith("/*")) {
      while (end + 1 < lines.length && !lines[end].includes("*/")) end++;
    } else {
      i++;
      continue;
    }
    blocks.push({ line: i + 1, text: lines.slice(i, end + 1) });
    i = end + 1;
  }
  return blocks;
}

// Line counts of a block's paragraphs, comment markers stripped.
function paragraphLengths(text) {
  const lengths = [0];
  for (const line of text) {
    const content = line
      .trim()
      .replace(/^\/\*\*?|\*\/$/g, "")
      .replace(/^\/\/|^\*/, "")
      .trim();
    if (content) lengths[lengths.length - 1]++;
    else if (lengths[lengths.length - 1]) lengths.push(0);
  }
  return lengths.filter(Boolean);
}

const longComments = [];
const historyComments = [];
const commentFiles = [
  ...COMMENT_ROOTS.flatMap((dir) => walk(path.join(root, dir))),
  // Root-level config modules (vitest.config.ts, playwright.config.ts).
  ...readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(root, entry.name)),
];
for (const file of commentFiles) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (!/\.(ts|mjs|js|css)$/.test(rel) || LOCAL_FILES.has(rel)) continue;
  for (const block of commentBlocks(readFileSync(file, "utf8").split("\n"))) {
    const paragraphs = paragraphLengths(block.text);
    if (paragraphs.length > PARAGRAPHS_MAX || paragraphs.some((n) => n > PARAGRAPH_MAX_LINES)) {
      longComments.push(`${rel}:${block.line} (paragraphs of ${paragraphs.join(" + ")} lines)`);
    }
    block.text.forEach((text, k) => {
      if (HISTORY_IN_COMMENT.test(text)) historyComments.push(`${rel}:${block.line + k}: ${text.trim()}`);
    });
  }
}

if (process.argv.includes("--comments")) {
  console.log(
    `Comment blocks with a paragraph over ${PARAGRAPH_MAX_LINES} lines or over ${PARAGRAPHS_MAX} paragraphs (${longComments.length}):`,
  );
  for (const c of longComments) console.log(`  ${c}`);
  console.log(`History narration (${historyComments.length}):`);
  for (const c of historyComments) console.log(`  ${c}`);
}

const ratchets = [
  { count: longComments.length, ceiling: LONG_COMMENT_CEILING, name: "LONG_COMMENT_CEILING" },
  { count: historyComments.length, ceiling: HISTORY_COMMENT_CEILING, name: "HISTORY_COMMENT_CEILING" },
];
for (const { count, ceiling, name } of ratchets) {
  if (count > ceiling) {
    fail(
      path.join(root, "scripts/check-docs.mjs"),
      0,
      `${count} comments counted, over ${name} (${ceiling}). A comment states the decision and the trap — ` +
        `see AGENTS.md; \`node scripts/check-docs.mjs --comments\` lists them.`,
    );
  }
}

// Null outside a git checkout, where there is nothing to compare against.
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

// 7. A repo path a doc cites must be tracked. One that exists here only
// because it is gitignored or uncommitted resolves for its author and
// dangles in every clone, so an on-disk check passes on exactly the machine
// that has the private file. A path that exists nowhere is an example, not
// a citation, and is left alone; one under SKIP_DIRS is build output.
const REPO_PATH = /^[\w.@-][\w.@/-]*$/;
const tracked = trackedFiles();
let trackedCitations = 0;
if (tracked) {
  const trackedDirs = new Set();
  for (const file of tracked) {
    for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) trackedDirs.add(dir);
  }
  // A tracked doc can be deleted in the working tree before the deletion is committed.
  for (const doc of [...tracked].filter((file) => file.endsWith(".md") && existsSync(path.join(root, file)))) {
    const docDir = path.posix.dirname(doc);
    let inFence = false;
    readFileSync(path.join(root, doc), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^```/.test(line)) inFence = !inFence;
        if (inFence) return;
        for (const m of line.matchAll(/`([^`\s]+)`|\]\(([^)\s#]+)/g)) {
          const cited = m[1] ?? m[2];
          if (!REPO_PATH.test(cited) || !/[/.]/.test(cited) || /^\.+$/.test(cited)) continue;
          const target = cited.replace(/\/+$/, "");
          const resolved = [...new Set([path.posix.join(docDir, target), path.posix.normalize(target)])].filter(
            (rel) => rel !== "." && !rel.startsWith("../") && existsSync(path.join(root, rel)),
          );
          const exempt = resolved.some((rel) => LOCAL_FILES.has(rel) || SKIP_DIRS.has(rel.split("/")[0]));
          if (resolved.length === 0 || exempt) continue;
          trackedCitations++;
          if (!resolved.some((rel) => tracked.has(rel) || trackedDirs.has(rel))) {
            fail(path.join(root, doc), index + 1, `cites ${cited}, which exists here but not in git — no clone has it`);
          }
        }
      });
  }
}

if (failures.length > 0) {
  console.error(`check-docs: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
const lower = ratchets
  .filter(({ count, ceiling }) => count < ceiling)
  .map(({ count, name }) => ` — lower ${name} to ${count}`)
  .join("");
const trackedSummary = tracked ? `${trackedCitations} cited paths tracked` : "cited paths unchecked outside git";
console.log(
  `check-docs: ok — ${docFiles.length} docs, ${citations} citations verified, ${trackedSummary}, ` +
    `${sourceFiles.length} files scanned, ${longComments.length} long and ${historyComments.length} history comments${lower}`,
);
