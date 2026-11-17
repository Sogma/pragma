// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { injectAppletRuntime } from "../../../web/services/sandboxHost.ts";

// The document a browser builds from an Applet frame's markup: where the
// parser puts the policy, not where the string does, is what governs.
const framed = (html: string) =>
  new DOMParser().parseFromString(injectAppletRuntime(html, { version: "1" }), "text/html");

const policyFirst = (doc: Document) =>
  doc.head.firstElementChild?.getAttribute("http-equiv") === "Content-Security-Policy" &&
  doc.querySelector("script, meta[http-equiv]")?.tagName === "META";

describe("an Applet frame as the browser parses it", () => {
  it("has the policy first in <head>, ahead of every script, and keeps the guest's own markup", () => {
    const doc = framed('<html lang="fr"><head><title>x</title><script src="x.js"></script></head></html>');
    expect(policyFirst(doc)).toBe(true);
    expect(doc.title).toBe("x");
    expect(doc.documentElement.lang).toBe("fr");
  });

  it("keeps standards mode for a guest that declares a doctype, and quirks mode for one that doesn't", () => {
    expect(framed("<!-- hi -->\n<!DOCTYPE html><html></html>").compatMode).toBe("CSS1Compat");
    expect(framed("<html><body></body></html>").compatMode).toBe("BackCompat");
  });

  // Each prefix reads to a regex as space or a comment before the doctype,
  // while the parser reads it as text that opens <body>, or ends the comment
  // early and runs the script beside it. A policy placed after the prefix
  // would leave <head>, where a browser ignores it, or come too late.
  it.each([
    ["a no-break space", " <!doctype html><html><head></head><body></body></html>"],
    ["a vertical tab", "\u000b<!doctype html><html><head></head><body></body></html>"],
    ["a comment closed by --!>", "<!--a--!><script>leak()</script><plaintext><!-- -->\n<!doctype html><html></html>"],
    ["a comment closed by <!-->", "<!--><script>leak()</script><plaintext><!-- -->\n<!doctype html><html></html>"],
  ])("keeps the policy first in <head> when the guest starts with %s", (_label, html) => {
    expect(policyFirst(framed(html))).toBe(true);
  });
});
