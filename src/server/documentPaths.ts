// The paths each kind of space document holds, rewritten in place for a
// move: a Table's `media` and `path` values and drop folders, a Class's
// links, drop folders and Folder values, and an AGENTS.md's folder settings.
//
// A Flow's and an Applet's paths are left as written: grants are pinned to
// that code, and a rewrite no one made there would leave them behind.

import { isFolderRule } from "../protocol/class.ts";
import { parseClassFile } from "../protocol/classFile.ts";
import { serializeClassFile } from "../protocol/classHtml.ts";
import { editFrontmatter, parseFrontmatter } from "../protocol/frontmatter.ts";
import { isSettingsBlock, SCOPE_SETTINGS, settingValue, writeSetting } from "../protocol/scopeSettings.ts";
import { isAgentsFile } from "../protocol/scopes.ts";
import { parseTableFile } from "../protocol/tableFile.ts";
import { serializeTableFile } from "../protocol/tableHtml.ts";
import type { ClassRule, TableColumn } from "../protocol/types.ts";
import { holdsPath, isClassFile, isTableFile } from "../protocol/types.ts";

/** A path's replacement, or undefined to leave it as written. */
export type PathRewrite = (written: string) => string | undefined;

/** Rewrites the paths `docPath`'s own content holds by `rewrite`, and a
 * Class's Folder values, written from its scope rather than its folder, by
 * `rewriteFolder`: the new content, or undefined when no path changed or
 * the kind holds none here. Markdown links are the caller's, being edits at
 * offsets in the text. */
export function rewriteDocumentPaths(
  docPath: string,
  content: string,
  rewrite: PathRewrite,
  rewriteFolder: PathRewrite = () => undefined,
): string | undefined {
  let changed = false;
  const by =
    (each: PathRewrite) =>
    (value: string | undefined): string | undefined => {
      if (value === undefined || value.trim() === "") return value;
      const replacement = each(value);
      if (replacement === undefined || replacement === value) return value;
      changed = true;
      return replacement;
    };
  const next = by(rewrite);
  const folder = by(rewriteFolder);
  const folders = (rules: readonly ClassRule[]) =>
    rules.map((rule) =>
      isFolderRule(rule) ? { ...rule, values: rule.values.map((value) => folder(value) ?? value) } : rule,
    );
  const written = (serialized: string | undefined) => (changed ? serialized : undefined);

  if (isTableFile(docPath)) {
    const file = parseTableFile(content);
    if (!file) return undefined;
    const paths = new Set(file.columns.filter((column) => holdsPath(column.type)).map((column) => column.id));
    const columns = file.columns.map((column) => withMediaFolder(column, next));
    const rows = file.rows.map((row) => ({
      ...row,
      values: Object.fromEntries(
        Object.entries(row.values).map(([id, value]) => [id, paths.has(id) ? (next(value) ?? value) : value]),
      ),
    }));
    return written(serializeTableFile({ ...file, columns, rows }));
  }
  if (isClassFile(docPath)) {
    const file = parseClassFile(content);
    if (!file) return undefined;
    const filter = folders(file.filter);
    const views = file.views.map((view) => ({ ...view, filter: folders(view.filter) }));
    const fields = file.fields.map((each) => withMediaFolder(each, next));
    const links = file.links.map((each) => next(each) ?? each);
    return written(serializeClassFile({ ...file, filter, views, fields, links }));
  }
  if (isAgentsFile(docPath)) {
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(content).data;
    } catch {
      return undefined;
    }
    if (!isSettingsBlock(data.pragma)) return undefined;
    const settings = { ...data };
    for (const setting of SCOPE_SETTINGS) {
      const value = settingValue(settings.pragma, setting);
      if (typeof value === "string") writeSetting(settings, setting, next(value));
    }
    return changed ? editFrontmatter(content, settings) : undefined;
  }
  return undefined;
}

function withMediaFolder(each: TableColumn, next: (value: string | undefined) => string | undefined): TableColumn {
  return each.type === "media" && each.mediaFolder ? { ...each, mediaFolder: next(each.mediaFolder) } : each;
}

/** Whether a move's rewrite reads `docPath` at all. */
export function holdsPaths(docPath: string): boolean {
  return isTableFile(docPath) || isClassFile(docPath);
}
