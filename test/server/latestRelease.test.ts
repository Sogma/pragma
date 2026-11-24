import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLatestRelease, isNewerVersion } from "../../src/server/latestRelease.ts";
import { pragmaRepository, pragmaVersion } from "../../src/server/version.ts";

const PAGE = "https://github.com/sogma/pragma/releases/tag/v999.0.0";
const DMG = "https://github.com/sogma/pragma/releases/download/v999.0.0/Pragma-999.0.0-universal.dmg";

type Asset = { name: string; browser_download_url: string };
const release = (tag: string, assets: Asset[] = [], page: string = PAGE) => ({ tag_name: tag, html_url: page, assets });

// GitHub's answer to every request, until the next call.
function answer(body: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNewerVersion", () => {
  it("compares major, then minor, then patch, as numbers", () => {
    expect(isNewerVersion("0.7.0", "0.6.9")).toBe(true);
    expect(isNewerVersion("0.6.10", "0.6.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.6.4", "0.6.4")).toBe(false);
    expect(isNewerVersion("0.6.3", "0.6.4")).toBe(false);
  });
});

describe("checkLatestRelease", () => {
  it("asks GitHub for the newest published release and says when it is newer", async () => {
    const fetch = answer(release("v999.0.0"));
    expect(await checkLatestRelease()).toEqual({ phase: "available", version: "999.0.0" });
    expect(fetch).toHaveBeenCalledWith(
      `https://api.github.com/repos/${pragmaRepository}/releases/latest`,
      expect.anything(),
    );
  });

  it("says Pragma is up to date when the newest release is this one", async () => {
    answer(release(`v${pragmaVersion}`));
    expect(await checkLatestRelease(".dmg")).toEqual({ phase: "not-available" });
  });

  it("links the installer its extension names, for an app that installs by hand", async () => {
    answer(
      release("v999.0.0", [
        { name: "Pragma-999.0.0-universal-mac.zip", browser_download_url: DMG.replace(".dmg", "-mac.zip") },
        { name: "Pragma-999.0.0-universal.dmg", browser_download_url: DMG },
        { name: "Pragma-999.0.0-universal.dmg.blockmap", browser_download_url: `${DMG}.blockmap` },
      ]),
    );
    expect(await checkLatestRelease(".dmg")).toEqual({ phase: "available", version: "999.0.0", downloadUrl: DMG });
  });

  it("links the release page instead when the release has no such installer", async () => {
    answer(release("v999.0.0", [{ name: "Pragma-Setup-999.0.0.exe", browser_download_url: DMG }]));
    expect(await checkLatestRelease(".dmg")).toMatchObject({ downloadUrl: PAGE });
  });

  it("passes on only https links, since the desktop app has the system open them", async () => {
    answer(
      release(
        "v999.0.0",
        [{ name: "Pragma.dmg", browser_download_url: "file:///System/Applications/Calculator.app" }],
        "javascript:alert(1)",
      ),
    );
    expect(await checkLatestRelease(".dmg")).toMatchObject({
      downloadUrl: `https://github.com/${pragmaRepository}/releases/tag/v999.0.0`,
    });
  });

  it("reports what went wrong in a short reason", async () => {
    answer({ message: "Not Found" }, 404);
    expect(await checkLatestRelease()).toEqual({ phase: "error", message: "GitHub returned 404" });

    answer({ name: "A release with no tag" });
    expect(await checkLatestRelease()).toEqual({ phase: "error", message: "No release tag in GitHub's response" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await checkLatestRelease()).toEqual({ phase: "error", message: "fetch failed" });
  });
});
