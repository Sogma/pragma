// Structural ratchets: the rules in docs/architecture.md's Module boundaries
// section, and the tests' own isolation, enforced.
//
// Two files grew back after the last extraction pass because nothing
// stopped them. These ceilings do: each refactor step that moves code out
// lowers its number, and a change that pushes a file over its ceiling fails
// here rather than landing quietly. Lower a ceiling whenever a step lands;
// never raise one.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Line ceilings, counted the way `wc -l` counts (newline characters).
const LINE_CEILINGS: Record<string, number> = {
  "web/main.ts": 837,
  "web/flow/xyflowAdapter.ts": 775,
};

// Mutable state declared directly in web/main.ts's bootstrap closure. Every
// `let` there is a variable some other cluster reads without saying so, and
// a cluster can only move out once its state moves with it, so a file can
// sit at its line ceiling and still be one indivisible closure. Held at zero,
// so the bootstrap only wires things together.
const MAIN_MUTABLE_STATE_CEILING = 0;

function lineCount(relativePath: string): number {
  const content = readFileSync(path.join(root, relativePath), "utf8");
  return (content.match(/\n/g) ?? []).length;
}

// Design tokens: a color literal belongs in `:root` or the dark-theme
// token block of web/styles/tokens.css, never on a component rule. The rules
// that still carry one are counted here; the count only goes down.
const HEX_OUTSIDE_TOKEN_BLOCKS_CEILING = 2;

// The same for a text size or a corner radius written in pixels, where a
// primitive or a token of web/styles/scale.css could carry it. A surface's
// own size still counts; the counts only go down.
const FONT_SIZE_PX_CEILING = 34;
const RADIUS_PX_CEILING = 22;
const SCALE_FILE = "web/styles/scale.css";

// The stylesheet is one file per component under web/styles/, plus a text
// format's own in its folder under web/formats/, and web/style.css is only
// their import list. A file that grows past this is two components sharing a
// name; split it at the component boundary and add the new file to the import
// list at the position its rules need.
const CSS_FILE_LINE_CEILING = 400;
const STYLES_DIR = "web/styles";
const STYLE_DIRS = [STYLES_DIR, "web/formats"];
// Unlayered rules beat every cascade layer. The only files allowed to be one
// are those whose rules exist to beat CodeMirror's runtime-injected
// stylesheet; anything else imported without a layer would silently outrank
// every component. Named as web/style.css imports them.
const UNLAYERED_STYLES = [
  "styles/codemirror.css",
  "formats/screenplay/fountain.css",
  "formats/markdown/formatting.css",
  "styles/selection.css",
];
// Lightning CSS writes the -webkit- copy of `mask` and `appearance` wherever
// Vite's browser targets need one, in dev and the build alike, so a copy in
// a stylesheet only duplicates its output.
const BUILD_PREFIXED = /-webkit-(mask|appearance)\b/;
const TOKEN_BLOCK_SELECTORS = new Set([":root", 'html[data-theme="dark"]']);
// Every glyph is a token in this one file, at one stroke weight; a rule
// carrying its own copy of an SVG, or a heavier copy for a small control, is
// how one surface's glyph drifts from another's.
const ICONS_FILE = "web/styles/icons.css";
const ICON_STROKE = "1.5";
// The --pragma-* palette is read only by stylesheets, which reach it through
// aliases like --view-space, so each theme's value stays in tokens.css alone.
// Matched as a string or a var(), which a comment naming the palette isn't.
const PALETTE_READ = /(["'`]|var\()--pragma-/;

// Hover hints are `data-tooltip`, drawn by web/lib/tooltip.ts; a `title`
// beside one makes the browser draw a second tooltip on top. `title` stays
// only as a frame's accessible name — every frame is built in a variable
// named `frame` — and as the window's `document.title`.
const TITLE_ASSIGNMENT = /([\w$.]+)\.title\s*=(?!=)/g;
const TITLE_RECEIVERS = new Set(["document", "frame"]);

// An icon button's tooltip is its aria-label, so a data-tooltip repeating it
// is a second copy left to drift. Matched by receiver and expression text,
// with the button's icon-button class set within a few lines above: a
// heuristic, and a helper taking its class as a parameter slips past it.
const TOOLTIP_ASSIGNMENT = /(\w+)\.dataset\.tooltip\s*=\s*([^;]+);/g;
const LABEL_ASSIGNMENT = /(\w+)\.setAttribute\(\s*"aria-label",\s*([^;]+)\);/g;
const NEAR_LINES = 8;

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])/g;
const FONT_SIZE_PX = /(?<![\w-])font-size:\s*\d+(\.\d+)?px/g;
const RADIUS_PX = /(?<![\w-])border(-[a-z]+)*-radius:[^;]*\d+(\.\d+)?px/g;

function literalsOutsideTokenBlocks(css: string, literal: RegExp): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => "\n".repeat(comment.split("\n").length - 1));
  const found: string[] = [];
  let depth = 0;
  let inTokens = false;
  noComments.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (depth === 0 && trimmed.endsWith("{") && TOKEN_BLOCK_SELECTORS.has(trimmed.slice(0, -1).trim())) inTokens = true;
    if (!inTokens) {
      for (const match of line.matchAll(literal)) found.push(`${index + 1}: ${match[0]}`);
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) inTokens = false;
  });
  return found;
}

function stylesheetLiterals(literal: RegExp): string[] {
  return styleFiles().flatMap((file) =>
    literalsOutsideTokenBlocks(readFileSync(file, "utf8"), literal).map((hit) => `${path.relative(root, file)}:${hit}`),
  );
}

function walk(dir: string, extension: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extension, out);
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

function styleFiles(): string[] {
  return STYLE_DIRS.flatMap((dir) => walk(path.join(root, dir), ".css"));
}

describe("ratchet: file size", () => {
  for (const [relativePath, ceiling] of Object.entries(LINE_CEILINGS)) {
    it(`${relativePath} stays at or under ${ceiling} lines`, () => {
      const lines = lineCount(relativePath);
      expect(
        lines,
        `${relativePath} is ${lines} lines, over its ${ceiling}-line ceiling. Move code out into a module rather than raising the number (docs/architecture.md's Module boundaries section).`,
      ).toBeLessThanOrEqual(ceiling);
    });
  }
});

describe("ratchet: bootstrap state", () => {
  it(`web/main.ts declares at most ${MAIN_MUTABLE_STATE_CEILING} mutable bindings in main()`, () => {
    // Indentation, not a parser: every `let` inside main() sits at exactly
    // one level, and one nested deeper belongs to a function that is already
    // small enough to move on its own.
    const found = readFileSync(path.join(root, "web/main.ts"), "utf8")
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /^ {2}let /.test(line))
      .map(({ line, number }) => `${number}: ${line.trim()}`);
    expect(
      found.length,
      `main() declares ${found.length} mutable bindings:\n${found.join("\n")}\nMove one out with the code that reads it (docs/architecture.md's Module boundaries section) rather than raising the ceiling.`,
    ).toBeLessThanOrEqual(MAIN_MUTABLE_STATE_CEILING);
  });
});

describe("ratchet: design tokens", () => {
  it(`the stylesheets have at most ${HEX_OUTSIDE_TOKEN_BLOCKS_CEILING} color literals outside their token blocks`, () => {
    const found = stylesheetLiterals(HEX_LITERAL);
    expect(
      found.length,
      `Color literals outside :root / the dark token block: ${found.join(", ")}. Use a token (var(--…)) instead of raising the ceiling.`,
    ).toBeLessThanOrEqual(HEX_OUTSIDE_TOKEN_BLOCKS_CEILING);
  });

  it(`the stylesheets write at most ${FONT_SIZE_PX_CEILING} font sizes and ${RADIUS_PX_CEILING} corner radii in pixels`, () => {
    const sizes = stylesheetLiterals(FONT_SIZE_PX);
    const radii = stylesheetLiterals(RADIUS_PX);
    const advice = `Give the element a primitive (.caption, .section-label, .card, .btn, …) or read a ${SCALE_FILE} token instead of raising the ceiling.`;
    expect(sizes.length, `Pixel font sizes: ${sizes.join(", ")}. ${advice}`).toBeLessThanOrEqual(FONT_SIZE_PX_CEILING);
    expect(radii.length, `Pixel radii: ${radii.join(", ")}. ${advice}`).toBeLessThanOrEqual(RADIUS_PX_CEILING);
  });

  it(`the stylesheets have no inline SVG outside ${ICONS_FILE}`, () => {
    const found = styleFiles()
      .filter((file) => file !== path.join(root, ICONS_FILE))
      .filter((file) => readFileSync(file, "utf8").includes("data:image/svg+xml"))
      .map((file) => path.relative(root, file));
    expect(found, `Add the glyph to ${ICONS_FILE} as an --icon-* token and reference it with var().`).toEqual([]);
  });

  it("web/ reads the --pragma-* palette only from its stylesheets", () => {
    const found = [...walk(path.join(root, "web"), ".ts"), ...walk(path.join(root, "web"), ".html")]
      .filter((file) => PALETTE_READ.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(found, "Style it in a stylesheet, through an alias like --view-space.").toEqual([]);
  });

  it(`every glyph in ${ICONS_FILE} strokes at ${ICON_STROKE}`, () => {
    const css = readFileSync(path.join(root, ICONS_FILE), "utf8");
    const off = [...css.matchAll(/--(icon-[\w-]+): url\("data:image\/svg\+xml,([^"]+)"\)/g)]
      .filter(([, , svg]) =>
        [...decodeURIComponent(svg).matchAll(/stroke-width='([\d.]+)'/g)].some(([, width]) => width !== ICON_STROKE),
      )
      .map(([, name]) => name);
    expect(off, "A glyph too faint at its size is drawn larger there, never given a heavier copy.").toEqual([]);
  });
});

describe("ratchet: stylesheet files", () => {
  it(`every stylesheet stays at or under ${CSS_FILE_LINE_CEILING} lines`, () => {
    const over = styleFiles()
      .map((file) => ({ file: path.relative(root, file), lines: lineCount(path.relative(root, file)) }))
      .filter(({ lines }) => lines > CSS_FILE_LINE_CEILING);
    expect(
      over.map(({ file, lines }) => `${file} (${lines})`),
      `Over the ${CSS_FILE_LINE_CEILING}-line ceiling. Split at a component boundary and add the new file to web/style.css's import list where its rules need to sit.`,
    ).toEqual([]);
  });

  it("the stylesheets leave the mask and appearance prefixes to the build", () => {
    const found = styleFiles()
      .filter((file) => BUILD_PREFIXED.test(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")))
      .map((file) => path.relative(root, file));
    expect(
      found,
      "Write the unprefixed property; Lightning CSS adds the -webkit- copy where a target needs it.",
    ).toEqual([]);
  });

  it("web/style.css is only a layer order and an import list", () => {
    const entry = readFileSync(path.join(root, "web/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = entry
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const stray = lines.filter((line) => !line.startsWith("@import ") && !line.startsWith("@layer "));
    expect(
      stray,
      "A rule in the entry sits outside every component file and outside the ceiling above. Put it in the file it belongs to.",
    ).toEqual([]);
    const unlayered = lines
      .filter((line) => line.startsWith("@import ") && !/ layer\([a-z]+\);$/.test(line))
      .map((line) => line.match(/"\.\/([^"]+)"/)?.[1]);
    expect(unlayered, "Every import names its layer; see UNLAYERED_STYLES for the one exception and why.").toEqual(
      UNLAYERED_STYLES,
    );
  });
});

describe("ratchet: tooltips", () => {
  it("web/ sets no title except a frame's accessible name", () => {
    const webDir = path.join(root, "web");
    const found: string[] = [];
    for (const file of walk(webDir, ".ts")) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const receivers = [...line.matchAll(TITLE_ASSIGNMENT)].map(([, receiver]) => receiver.split(".").pop() ?? "");
          const attribute = /setAttribute\(\s*["']title["']|\stitle="/.test(line);
          if (attribute || receivers.some((receiver) => !TITLE_RECEIVERS.has(receiver))) {
            found.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    for (const file of walk(webDir, ".html")) {
      const html = readFileSync(file, "utf8");
      for (const tag of html.matchAll(/<(\w+)\b[^>]*\stitle="[^>]*>/g)) {
        if (tag[1] === "iframe") continue;
        const line = html.slice(0, tag.index).split("\n").length;
        found.push(`${path.relative(root, file)}:${line}: <${tag[1]} … title=…>`);
      }
    }
    expect(
      found,
      "Hover hints are `data-tooltip` (docs/architecture.md's Frontend layers). A frame's accessible name is the one `title`, set on a variable named `frame`.",
    ).toEqual([]);
  });
});

function repeatedIconButtonTooltips(source: string): number[] {
  const lineOf = (index: number): number => source.slice(0, index).split("\n").length;
  const lines = source.split("\n");
  const found: number[] = [];
  for (const tip of source.matchAll(TOOLTIP_ASSIGNMENT)) {
    const [, receiver, expression] = tip;
    const line = lineOf(tip.index);
    const labelled = [...source.matchAll(LABEL_ASSIGNMENT)].some(
      (label) =>
        label[1] === receiver &&
        label[2].trim() === expression.trim() &&
        Math.abs(lineOf(label.index) - line) <= NEAR_LINES,
    );
    const iconClass = new RegExp(`\\b${receiver}\\b.*icon-button`);
    const isIconButton = lines.slice(Math.max(0, line - NEAR_LINES - 1), line).some((text) => iconClass.test(text));
    if (labelled && isIconButton) found.push(line);
  }
  return found;
}

describe("ratchet: icon-button tooltips", () => {
  it("no icon button repeats its aria-label in a data-tooltip", () => {
    const webDir = path.join(root, "web");
    const found: string[] = [];
    for (const file of walk(webDir, ".ts")) {
      for (const line of repeatedIconButtonTooltips(readFileSync(file, "utf8"))) {
        found.push(`${path.relative(root, file)}:${line}`);
      }
    }
    for (const file of walk(webDir, ".html")) {
      const html = readFileSync(file, "utf8");
      for (const tag of html.matchAll(/<\w+\b[^>]*>/g)) {
        const attribute = (name: string): string | undefined => tag[0].match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
        const classes = attribute("class")?.split(/\s+/) ?? [];
        const tooltip = attribute("data-tooltip");
        if (classes.includes("icon-button") && tooltip !== undefined && tooltip === attribute("aria-label")) {
          found.push(`${path.relative(root, file)}:${html.slice(0, tag.index).split("\n").length}`);
        }
      }
    }
    expect(
      found,
      "An icon button's tooltip is its aria-label (web/lib/tooltip.ts); keep data-tooltip for text that differs.",
    ).toEqual([]);
  });
});

describe("ratchet: links out", () => {
  it("opens every link out of Pragma through web/lib/externalLinks.ts", () => {
    const helper = path.join(root, "web", "lib", "externalLinks.ts");
    const found: string[] = [];
    for (const file of walk(path.join(root, "web"), ".ts")) {
      if (file === helper) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/window\.open\(|["']_blank["']/.test(line)) found.push(`${path.relative(root, file)}:${index + 1}`);
        });
    }
    expect(
      found,
      "A link out of Pragma sends no referrer and gets no opener: web/lib/externalLinks.ts sets both.",
    ).toEqual([]);
  });
});

describe("ratchet: layering", () => {
  it("no file under web/view/ imports another file under web/view/", () => {
    const viewDir = path.join(root, "web/view");
    const violations: string[] = [];

    for (const file of walk(viewDir, ".ts")) {
      const source = readFileSync(file, "utf8");
      // `import type` is erased at compile time and carries no behavior, so
      // it doesn't count as one view depending on another.
      for (const match of source.matchAll(/^import\s+([^;]+?)\s+from\s+"(\.[^"]+)"/gm)) {
        if (match[1].startsWith("type ")) continue;
        const resolved = path.resolve(path.dirname(file), match[2]);
        if (resolved.startsWith(viewDir) && resolved !== file) {
          violations.push(`${path.relative(root, file)} → ${match[2]}`);
        }
      }
    }

    expect(
      violations,
      "A view must not import another view. Data flows down (core → services → views); a shared piece belongs in core/, services/, or lib/.",
    ).toEqual([]);
  });
});

// Every rule about paths and scopes is one function in src/protocol/
// (docs/architecture.md's Protocol, server and packaging): a second copy is where the
// server and the browser drift apart. What still splits at a slash by hand
// is a JSON pointer or a module URL, never a space path.
const HAND_SPLIT_CEILING = 3;

describe("ratchet: protocol rules", () => {
  const sources = ["src", "web"].flatMap((dir) =>
    walk(path.join(root, dir), ".ts").map((file) => ({
      file: path.relative(root, file).split(path.sep).join("/"),
      text: readFileSync(file, "utf8"),
    })),
  );
  const hits = (pattern: RegExp, home: string) =>
    sources
      .filter(({ file }) => file !== home)
      .flatMap(({ file, text }) => (text.match(pattern) ?? []).map(() => file));

  it(`splits a path at a slash only in src/protocol/rootedPath.ts, ${HAND_SPLIT_CEILING} non-paths aside`, () => {
    const found = hits(/lastIndexOf\("\/"\)/g, "src/protocol/rootedPath.ts");
    expect(found.length, found.join("\n")).toBeLessThanOrEqual(HAND_SPLIT_CEILING);
  });

  // The one left tests Fountain's forced scene heading, a line, not a name.
  it("tests a name for a leading dot only in src/protocol/entryName.ts", () => {
    const found = hits(/\.startsWith\("\."\)/g, "src/protocol/entryName.ts");
    expect(found.length, found.join("\n")).toBeLessThanOrEqual(1);
  });

  it("tests a path for a hidden segment only in src/protocol/relativeReference.ts", () => {
    expect(hits(/\.some\(isHiddenName\)/g, "src/protocol/relativeReference.ts")).toEqual([]);
  });

  it("reads a scope set only in src/protocol/scopes.ts", () => {
    expect(hits(/\bscopes\.has\(/g, "src/protocol/scopes.ts")).toEqual([]);
  });

  it("writes a path in the browser only through the space tree's one writer", () => {
    expect(hits(/\bformatWrittenPath\(/g, "web/core/spaceTree.ts").filter((file) => file.startsWith("web/"))).toEqual(
      [],
    );
  });
});

// A feature reaches host state and caches through an installed store, so a
// host with other storage swaps a store without touching a feature: only a
// store's own module, and the config loader, name a path in the config or
// cache directory. `config.json`, which people edit by hand, is the exception.
const HOST_STATE_PATHS =
  /\b(globalConfigDir|globalCacheDir|globalGrantsPath|globalLayoutPath|globalHistoryDir|globalJobsDir)\b/;
const STORE_MODULES = [
  "src/config/credentials.ts",
  "src/config/loadConfig.ts",
  "src/server/grantStore.ts",
  "src/server/historyStore.ts",
  "src/server/jobs.ts",
  "src/server/layoutStore.ts",
  "src/server/thumbnailStore.ts",
  "src/server/uploadIds.ts",
];
// Named apart, each for a reason of its own.
const HOST_STATE_EXCEPTIONS: Record<string, string> = {
  "electron/main.ts": "opens the folder for the person, and writes nothing",
};

describe("ratchet: host state", () => {
  it("names a path in the config or cache directory only in a store's module or the config loader", () => {
    const found = ["src", "electron", "bin", "web"]
      .flatMap((dir) => walk(path.join(root, dir), ".ts"))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((file) => HOST_STATE_PATHS.test(readFileSync(path.join(root, file), "utf8")))
      .filter((file) => !STORE_MODULES.includes(file) && !(file in HOST_STATE_EXCEPTIONS));
    expect(found).toEqual([]);
  });
});

// A test makes a temp folder or sets the config folder only through
// test/support/, whose helpers undo both when the test finishes, so no
// folder outlives its test and no test inherits another's config.
const HAND_ISOLATION =
  /\bmkdtemp(Sync)?\(|process\.env\.PRAGMA_CONFIG_DIR\s*=[^=]|delete process\.env\.PRAGMA_CONFIG_DIR|stubEnv\(\s*["']PRAGMA_CONFIG_DIR/;
// How many each file may keep, each for a reason of its own.
const HAND_ISOLATION_KEPT: Record<string, number> = {
  // The libraries suite's folder, made once for every test in it.
  "test/contract/api.test.ts": 1,
};

describe("ratchet: test isolation", () => {
  it("makes a temp folder or sets the config folder only through test/support/", () => {
    const self = fileURLToPath(import.meta.url);
    const found = walk(path.join(root, "test"), ".ts")
      .filter((file) => file !== self)
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((file) => !file.startsWith("test/support/"))
      .flatMap((file) =>
        readFileSync(path.join(root, file), "utf8")
          .split("\n")
          .flatMap((line, index) => (HAND_ISOLATION.test(line) ? [`${file}:${index + 1}`] : []))
          .slice(HAND_ISOLATION_KEPT[file] ?? 0),
      );
    expect(found, "Use tempDir, isolateConfig or tempSpace from test/support/isolation.ts.").toEqual([]);
  });
});
