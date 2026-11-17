// The notices every copy of Pragma carries for the packages it bundles, and
// the check that each of their licences may ship inside a GPL-3.0-or-later
// program. The web build calls it with the modules it took in; the
// production dependencies, which the desktop build packs and the npm bundle
// inlines, come from the lockfile.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ShippedPackage {
  name: string;
  version: string;
  /** The SPDX expression from its manifest, or "" when it names none. */
  licence: string;
  author?: string;
  /** Its folder, relative to the app root, with forward slashes. */
  dir: string;
}

// Licences whose code may ship inside a GPL-3.0-or-later program. One outside
// the list stops the build until someone reviews it: a review that finds it
// compatible adds the package to REVIEWED, with the reason.
const COMPATIBLE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

const REVIEWED: Record<string, string> = {};

const LICENCE_FILE = /^(licen[cs]e|copying)/i;
const NOTICE_FILE = /^notice/i;
const RULE = "=".repeat(72);
const THIN_RULE = "-".repeat(72);

/** Whether an SPDX expression lets its code ship in a GPL-3.0-or-later
 * program: one alternative of an OR is enough, and every part of an AND must
 * qualify. An exception (WITH) changes what the licence allows, so it waits
 * for review like any unlisted licence. */
export function licenceAllowed(expression: string): boolean {
  const text = unwrap(expression.trim());
  const alternatives = splitOutside(text, "OR");
  if (alternatives.length > 1) return alternatives.some(licenceAllowed);
  const parts = splitOutside(text, "AND");
  if (parts.length > 1) return parts.every(licenceAllowed);
  return COMPATIBLE.has(text);
}

// The text without parentheses that enclose all of it.
function unwrap(text: string): string {
  let inner = text;
  while (inner.startsWith("(") && closingParen(inner) === inner.length - 1) inner = inner.slice(1, -1).trim();
  return inner;
}

function closingParen(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

// The text split on an operator standing outside every parenthesis.
function splitOutside(text: string, operator: "AND" | "OR"): string[] {
  const parts: string[] = [];
  const word = new RegExp(`\\s+${operator}\\s+`, "iy");
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") depth--;
    else if (depth === 0) {
      word.lastIndex = index;
      const match = word.exec(text);
      if (match) {
        parts.push(text.slice(start, index));
        start = index + match[0].length;
        index = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => unwrap(part.trim()));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Manifests older than SPDX expressions name a licence as an object, or list
// several, which meant a choice among them.
function licenceOf(manifest: Record<string, unknown>): string {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (isRecord(license) && typeof license.type === "string") return license.type;
  if (!Array.isArray(licenses)) return "";
  const types = licenses.map((entry) => (isRecord(entry) ? entry.type : entry));
  return types.filter((type): type is string => typeof type === "string").join(" OR ");
}

function authorOf(manifest: Record<string, unknown>): string | undefined {
  const { author } = manifest;
  if (typeof author === "string") return author;
  if (!isRecord(author) || typeof author.name !== "string") return undefined;
  return typeof author.email === "string" ? `${author.name} <${author.email}>` : author.name;
}

function readPackage(appRoot: string, dir: string): ShippedPackage {
  const manifest = JSON.parse(readFileSync(path.join(appRoot, dir, "package.json"), "utf8")) as Record<string, unknown>;
  return {
    name: String(manifest.name ?? dir),
    version: String(manifest.version ?? ""),
    licence: licenceOf(manifest),
    author: authorOf(manifest),
    dir,
  };
}

/** Every package a build ships: the lockfile's production dependencies, and
 * whatever package the web bundle took a module from. The bundle's packages
 * are development dependencies, so the lockfile alone would miss them. */
export function shippedPackages(appRoot: string, bundledModuleIds: Iterable<string>): ShippedPackage[] {
  const dirs = new Set<string>();
  const lock = JSON.parse(readFileSync(path.join(appRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { dev?: boolean; devOptional?: boolean; optional?: boolean; link?: boolean }>;
  };
  for (const [dir, entry] of Object.entries(lock.packages ?? {})) {
    if (!dir || entry.dev || entry.devOptional || entry.link) continue;
    // An optional package another platform needs isn't installed here, so
    // this platform's build doesn't carry it.
    if (entry.optional && !existsSync(path.join(appRoot, dir, "package.json"))) continue;
    dirs.add(dir);
  }
  for (const id of bundledModuleIds) {
    const file = (id.split("?")[0] ?? "").replaceAll("\\", "/");
    const folder = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
    if (folder && path.isAbsolute(folder)) dirs.add(path.relative(appRoot, folder).replaceAll("\\", "/"));
  }
  return [...dirs]
    .map((dir) => readPackage(appRoot, dir))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function filesMatching(folder: string, pattern: RegExp): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

const readText = (file: string) => readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trimEnd();

const licenceIds = (expression: string) => expression.split(/[\s()]+/).filter(Boolean);

/** The notices file for `packages`. Each entry is the package's own licence
 * and notice files. One that ships no licence file is covered by its
 * licence's standard text from `textsDir`, which the file appends once for
 * every licence named, since short headers only point to the full text. */
export function noticesText(appRoot: string, packages: ShippedPackage[], textsDir: string): string {
  const standard = new Map(
    readdirSync(textsDir)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => [name.slice(0, -4), readText(path.join(textsDir, name))] as const),
  );
  const lines = [
    "Third-party notices",
    "",
    "Pragma bundles the packages below. Each comes under its own licence, whose",
    "notices follow, then the full text of each licence they name. The fonts",
    "carry their own licence, in OFL.txt beside each family under fonts/.",
  ];
  const named = new Set<string>();
  const uncovered: string[] = [];
  for (const pkg of packages) {
    const folder = path.join(appRoot, pkg.dir);
    lines.push("", RULE, `${pkg.name} ${pkg.version}`, `Licence: ${pkg.licence || "none named"}`, THIN_RULE);
    for (const id of licenceIds(pkg.licence)) if (standard.has(id)) named.add(id);
    const licenceFiles = filesMatching(folder, LICENCE_FILE);
    for (const file of licenceFiles) lines.push("", readText(path.join(folder, file)));
    for (const file of filesMatching(folder, NOTICE_FILE)) lines.push("", readText(path.join(folder, file)));
    if (licenceFiles.length > 0) continue;
    if (!licenceIds(pkg.licence).some((id) => standard.has(id))) {
      uncovered.push(`${pkg.name}@${pkg.version} (${pkg.licence || "no licence named"})`);
      continue;
    }
    lines.push(
      "",
      `This package ships no licence file. Its manifest names ${pkg.licence}${pkg.author ? ` and the author ${pkg.author}` : ""};`,
      "the licence's text is under Licence texts below.",
    );
  }
  if (uncovered.length > 0) {
    throw new Error(
      `These packages ship no licence file, and ${textsDir} holds no standard text for their licence:\n  ${uncovered.join("\n  ")}`,
    );
  }
  lines.push("", RULE, "Licence texts", RULE);
  for (const id of [...named].sort()) lines.push("", id, THIN_RULE, "", standard.get(id) ?? "");
  return `${lines.join("\n")}\n`;
}

/** Writes the notices for everything the build ships to `outFile`, first
 * refusing any package whose licence can't ship in a GPL-3.0-or-later
 * program, so such a dependency fails the build before a release. */
export function writeThirdPartyNotices(
  appRoot: string,
  bundledModuleIds: Iterable<string>,
  outFile: string,
  textsDir = path.join(appRoot, "scripts/licence-texts"),
): void {
  const packages = shippedPackages(appRoot, bundledModuleIds);
  const refused = packages.filter((pkg) => !licenceAllowed(pkg.licence) && !(pkg.name in REVIEWED));
  if (refused.length > 0) {
    const list = refused.map((pkg) => `${pkg.name}@${pkg.version}: ${pkg.licence || "no licence named"}`);
    throw new Error(
      `These packages' licences can't ship in a GPL-3.0-or-later program, or need a review first:\n  ${list.join("\n  ")}\nReplace the package, or review its licence and add it to REVIEWED in scripts/third-party-notices.ts.`,
    );
  }
  writeFileSync(outFile, noticesText(appRoot, packages, textsDir));
}
