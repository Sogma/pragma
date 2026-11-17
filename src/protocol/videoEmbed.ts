// A video embed: an image embed (`![alt](url)`) whose destination is a
// recognized video URL, which a reader shows as that host's player rather
// than as a broken image. Reusing that syntax keeps the note readable in other
// Markdown apps. Only an embed qualifies — a plain link to the same URL is
// prose about the video, and stays a link.
//
// Recognition only. How the player is drawn is each reader's own choice.

export interface VideoEmbed {
  provider: "youtube";
  id: string;
  /** Seconds into the video, from the URL's `t` or `start`. */
  start?: number;
}

// Exactly the hosts YouTube serves watch pages and players from. Matched
// whole, never by suffix, so `notyoutube.com` and `youtube.com.evil` stay
// ordinary images.
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

// Path forms that carry the id as their second segment.
const ID_PATH_PREFIXES = new Set(["embed", "shorts", "live", "v"]);

/** `90`, `90s`, `1m30s`, `1h2m3s` → seconds. Undefined for anything else,
 * including zero, which is where a video starts anyway. */
function parseStart(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
  if (!match) return undefined;
  const [, h, m, s] = match;
  const seconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return seconds > 0 ? seconds : undefined;
}

/** The video an embed's destination names, or undefined when it names none. */
export function parseVideoEmbed(href: string): VideoEmbed | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (host === "youtu.be") {
    id = segments.length === 1 ? segments[0] : undefined;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (segments.length === 1 && segments[0] === "watch") id = url.searchParams.get("v") ?? undefined;
    else if (segments.length === 2 && ID_PATH_PREFIXES.has(segments[0])) id = segments[1];
  }
  if (!id || !YOUTUBE_ID.test(id)) return undefined;

  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return start === undefined ? { provider: "youtube", id } : { provider: "youtube", id, start };
}
