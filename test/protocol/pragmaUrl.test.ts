import { describe, expect, it } from "vitest";
import {
  formatPragmaUrl,
  hasPragmaScheme,
  MAX_PRAGMA_URL_LENGTH,
  type PragmaLink,
  parsePragmaUrl,
} from "../../src/protocol/pragmaUrl.ts";

const read = (input: string) => parsePragmaUrl(input);
const linkOf = (input: string) => {
  const result = parsePragmaUrl(input);
  if ("refusal" in result) throw new Error(`refused: ${result.refusal}`);
  return result.link;
};
const refused = (input: string) => "refusal" in parsePragmaUrl(input);

describe("formatting a Pragma link", () => {
  it("names the space, then the path, every name percent-encoded", () => {
    expect(formatPragmaUrl({ space: "Notes", path: "projects/a.md", folder: false })).toBe(
      "pragma://Notes/projects/a.md",
    );
    expect(formatPragmaUrl({ space: "My Notes", path: "projects/My Draft.md", folder: false })).toBe(
      "pragma://My%20Notes/projects/My%20Draft.md",
    );
    expect(formatPragmaUrl({ space: "Mes Notes été", path: "café/#1.md", folder: false })).toBe(
      "pragma://Mes%20Notes%20%C3%A9t%C3%A9/caf%C3%A9/%231.md",
    );
  });

  it("ends a folder with a slash and names the space itself by its name alone", () => {
    expect(formatPragmaUrl({ space: "Notes", path: "projects/translation", folder: true })).toBe(
      "pragma://Notes/projects/translation/",
    );
    expect(formatPragmaUrl({ space: "Notes", path: "", folder: true })).toBe("pragma://Notes");
  });

  // A library path reads as Pragma writes it everywhere else, its colon kept.
  it("keeps a library's address as written", () => {
    expect(formatPragmaUrl({ space: "Notes", path: "lib:refs/Lina/tester.md", folder: false })).toBe(
      "pragma://Notes/lib:refs/Lina/tester.md",
    );
  });

  it("reads back every link it writes", () => {
    const links: PragmaLink[] = [
      { space: "Notes", path: "projects/a.md", folder: false },
      { space: "My Notes", path: "projects/My Draft.md", folder: false },
      { space: "Notes: 2026/27", path: "a+b & c=d;e@f.md", folder: false },
      { space: "日本語ノート", path: "メモ/計画.md", folder: false },
      { space: "Notes", path: "projects/translation", folder: true },
      { space: "Notes", path: "lib:refs/Lina/tester.md", folder: false },
      { space: "Notes", path: "lib:refs", folder: true },
      { space: "spc_0123456789", path: "", folder: true },
    ];
    for (const link of links) expect(parsePragmaUrl(formatPragmaUrl(link)), JSON.stringify(link)).toEqual({ link });
  });
});

describe("reading a Pragma link", () => {
  it("reads the space and the path, decoding each name", () => {
    expect(linkOf("pragma://My%20Notes/projects/My%20Draft.md")).toEqual({
      space: "My Notes",
      path: "projects/My Draft.md",
      folder: false,
    });
  });

  // Typed by hand, the link a URL parser would refuse.
  it("reads a raw space as a space, and the scheme in any case", () => {
    expect(linkOf("pragma://My Notes/projects/My Draft.md")).toEqual({
      space: "My Notes",
      path: "projects/My Draft.md",
      folder: false,
    });
    expect(linkOf("PRAGMA://Notes/a.md")).toEqual({ space: "Notes", path: "a.md", folder: false });
  });

  it("reads a trailing slash as a folder, and a link with no path as the space itself", () => {
    expect(linkOf("pragma://Notes/projects/")).toEqual({ space: "Notes", path: "projects", folder: true });
    expect(linkOf("pragma://Notes")).toEqual({ space: "Notes", path: "", folder: true });
    expect(linkOf("pragma://Notes/")).toEqual({ space: "Notes", path: "", folder: true });
  });

  it("reads a library's address, its colon written or encoded, and drops a space: prefix", () => {
    const tester = { space: "Notes", path: "lib:refs/Lina/tester.md", folder: false };
    expect(linkOf("pragma://Notes/lib:refs/Lina/tester.md")).toEqual(tester);
    expect(linkOf("pragma://Notes/lib%3Arefs/Lina/tester.md")).toEqual(tester);
    expect(linkOf("pragma://Notes/space:projects/a.md")).toEqual({
      space: "Notes",
      path: "projects/a.md",
      folder: false,
    });
  });

  // The standard URL parser would turn the first into `secret.md`.
  it("refuses a dot segment, written or encoded, rather than walking it", () => {
    for (const input of [
      "pragma://Notes/projects/../secret.md",
      "pragma://Notes/projects/%2E%2E/secret.md",
      "pragma://Notes/projects/%2e%2E/secret.md",
      "pragma://Notes/./a.md",
      "pragma://Notes/%2E/a.md",
      "pragma://Notes/../../etc/passwd",
    ]) {
      expect(refused(input), input).toBe(true);
    }
  });

  it("refuses an empty name and a separator inside a name", () => {
    for (const input of [
      "pragma://Notes/projects//a.md",
      "pragma://Notes/projects//",
      "pragma://Notes//",
      "pragma://Notes/projects%2Fa.md",
      "pragma://Notes/projects%2fa.md",
      "pragma://Notes/projects\\a.md",
      "pragma://Notes/projects%5Ca.md",
    ]) {
      expect(refused(input), input).toBe(true);
    }
  });

  it("refuses a hidden entry, in the space or a library", () => {
    expect(read("pragma://Notes/.git/config")).toEqual({
      refusal: 'A Pragma link can\'t name a hidden entry: "pragma://Notes/.git/config"',
    });
    expect(refused("pragma://Notes/%2Epragma/bookmarks.json")).toBe(true);
    expect(refused("pragma://Notes/lib:refs/.trash/a.md")).toBe(true);
  });

  it("refuses another scheme, a link naming no space, and a query or fragment", () => {
    expect(read("https://example.com/a.md")).toEqual({ refusal: 'Not a Pragma link: "https://example.com/a.md"' });
    for (const input of [
      "pragma:Notes/a.md",
      "pragma:///a.md",
      "pragma://",
      "pragma://Notes/a.md?action=new",
      "pragma://Notes/a.md#Heading",
      "pragma://Notes?x",
    ]) {
      expect(refused(input), input).toBe(true);
    }
  });

  it("refuses a broken % code and a control character", () => {
    for (const input of [
      "pragma://Notes/%zz.md",
      "pragma://Notes/%E0%A4%A.md",
      "pragma://No%tes/a.md",
      "pragma://Notes/a%00.md",
      "pragma://Notes/a%0A.md",
      "pragma://No%0Ates/a.md",
    ]) {
      expect(refused(input), input).toBe(true);
    }
  });

  it("refuses a path the address grammar refuses: another scheme, a bad library id", () => {
    expect(refused("pragma://Notes/foo:bar/a.md")).toBe(true);
    expect(refused("pragma://Notes/lib:Bad_Id/a.md")).toBe(true);
    expect(refused("pragma://Notes/Lib:refs/a.md")).toBe(true);
  });

  it("refuses an overlong link before reading it", () => {
    const long = `pragma://Notes/${"a".repeat(MAX_PRAGMA_URL_LENGTH)}.md`;
    expect(read(long)).toEqual({ refusal: `A Pragma link can't be longer than ${MAX_PRAGMA_URL_LENGTH} characters` });
    expect(refused(`pragma://Notes/${"a".repeat(MAX_PRAGMA_URL_LENGTH - 20)}`)).toBe(false);
  });
});

describe("telling a Pragma link from other text", () => {
  // Any link claiming the scheme goes to the parser, which says why it refuses one.
  it("claims a link by its scheme alone, in any case", () => {
    expect(["pragma://Notes/a.md", "PRAGMA://Notes", "pragma:Notes/a.md"].every(hasPragmaScheme)).toBe(true);
    expect(
      ["https://a.com", "pragma-app://app/welcome.html", " pragma://Notes", "notes/pragma:a.md"].some(hasPragmaScheme),
    ).toBe(false);
  });
});
