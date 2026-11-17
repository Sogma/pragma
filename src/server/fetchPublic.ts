import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { writeFileAtomic } from "./spaceFiles.ts";

export interface PublicFetchOptions {
  maxBytes: number;
  signal?: AbortSignal;
  // Stand-ins for tests: name resolution and the fetch itself.
  resolve?: (host: string) => Promise<string[]>;
  fetchFn?: typeof fetch;
}

export interface PublicFile {
  bytes: Uint8Array;
  mediaType: string;
}

const MAX_REDIRECTS = 3;

/**
 * Downloads a file from the public internet: https only, never from a
 * loopback, private or link-local address, every redirect checked the same
 * way, and at most `maxBytes`.
 *
 * The check resolves the name itself, so a name answering differently a moment
 * later can slip past: it stops a mistaken or naive address, not a resolver
 * under someone's control.
 */
export async function fetchPublic(raw: string, options: PublicFetchOptions): Promise<PublicFile> {
  const response = await openPublic(raw, options);
  return { bytes: await readCapped(response, options.maxBytes), mediaType: mediaTypeOf(response) };
}

/** Downloads as fetchPublic does, into the file `target` names for the
 * answer's media type as the bytes arrive, so a big file is never held whole.
 * Returns that file's path. */
export async function fetchPublicToFile(
  raw: string,
  options: PublicFetchOptions,
  target: (mediaType: string) => string,
): Promise<string> {
  const response = await openPublic(raw, options);
  const filePath = target(mediaTypeOf(response));
  await writeFileAtomic(filePath, capped(response, options.maxBytes));
  return filePath;
}

async function openPublic(raw: string, options: PublicFetchOptions): Promise<Response> {
  const resolve = options.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address));
  const fetchFn = options.fetchFn ?? fetch;
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url, resolve);
    const response = await fetchFn(url, { redirect: "manual", signal: options.signal });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`Downloading ${url} answered ${response.status}.`);
    return response;
  }
  throw new Error(`Downloading ${raw} redirected more than ${MAX_REDIRECTS} times.`);
}

async function assertPublic(raw: string, resolve: (host: string) => Promise<string[]>): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`Refusing to download ${raw}: only https is allowed.`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to download ${raw}: it points at a private address.`);
  }
}

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  // The URL parser writes a mapped IPv4 address in hex (::ffff:7f00:1).
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const [high, low] = [Number.parseInt(hexMapped[1], 16), Number.parseInt(hexMapped[2], 16)];
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function* capped(response: Response, maxBytes: number): AsyncGenerator<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (declared > maxBytes) throw new Error(`The file is ${declared} bytes, over the ${maxBytes}-byte limit.`);
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`The file is over the ${maxBytes}-byte limit.`);
      yield value;
    }
  } finally {
    // Stopped early, by the limit or a failed write, the rest is never read.
    await reader.cancel().catch(() => {});
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of capped(response, maxBytes)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function mediaTypeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
}
