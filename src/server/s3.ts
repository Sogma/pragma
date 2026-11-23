// Requests to an S3-compatible bucket, signed with Signature Version 4, the
// scheme every S3-compatible store accepts. Buckets are reached by path
// (`<endpoint>/<bucket>/<key>`), which works for any endpoint and bucket name.
import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface S3Bucket extends S3Credentials {
  endpoint: string;
  bucket: string;
}

export interface S3Object {
  key: string;
  lastModified: number;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

// Percent-encoding as the signature reads it: every byte but letters, digits
// and `-._~`, so `!*'()`, which encodeURIComponent leaves alone, are encoded.
function encode(text: string, keepSlash = false): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// A path as signed and sent: each segment decoded once, then encoded once.
function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function stamps(now: Date): { amzDate: string; day: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

function signature(credentials: S3Credentials, day: string, stringToSign: string): string {
  const date = hmac(`AWS4${credentials.secretAccessKey}`, day);
  const key = hmac(hmac(hmac(date, credentials.region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
}

function signed(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
  credentials: S3Credentials,
  amzDate: string,
  day: string,
): { signature: string; signedHeaders: string; scope: string } {
  const all: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${credentials.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  return { signature: signature(credentials, day, stringToSign), signedHeaders, scope };
}

/** The headers that sign a request, `headers` among them: the date, the
 * payload's hash and the Authorization line. The host is signed from `url`,
 * as fetch sends it. */
export function signRequest(request: {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  payloadHash: string;
  credentials: S3Credentials;
  now: Date;
}): Record<string, string> {
  const { amzDate, day } = stamps(request.now);
  const headers = { ...request.headers, "x-amz-content-sha256": request.payloadHash, "x-amz-date": amzDate };
  const result = signed(request.method, request.url, headers, request.payloadHash, request.credentials, amzDate, day);
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${request.credentials.accessKeyId}/${result.scope}, SignedHeaders=${result.signedHeaders}, Signature=${result.signature}`,
  };
}

/** A link that reads `url` without credentials until `expiresSeconds` after
 * `now`. Anyone holding it can read the object until then. */
export function presignUrl(request: {
  url: URL;
  credentials: S3Credentials;
  now: Date;
  expiresSeconds: number;
}): string {
  const { amzDate, day } = stamps(request.now);
  const url = new URL(request.url);
  const scope = `${day}/${request.credentials.region}/s3/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${request.credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(request.expiresSeconds));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const result = signed("GET", url, {}, "UNSIGNED-PAYLOAD", request.credentials, amzDate, day);
  return `${url.origin}${canonicalPath(url.pathname)}?${canonicalQuery(url.searchParams)}&X-Amz-Signature=${result.signature}`;
}

/** The region an endpoint's name carries, `s3.<region>.<domain>`, where it
 * names one; otherwise us-east-1, which stores with a single region accept. */
export function regionOf(endpoint: string, region?: string): string {
  if (region) return region;
  try {
    const named = /^s3[.-]([a-z0-9-]+)\.[^.]+\.[^.]+$/i.exec(new URL(endpoint).hostname);
    if (named) return named[1].toLowerCase();
  } catch {
    // A malformed endpoint fails when it is used.
  }
  return "us-east-1";
}

/** Why a bucket refused a request, in its own words where it gave any. */
export class BucketError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
    const said = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
    super(
      code || said
        ? `The bucket answered ${status}: ${[code, said].filter(Boolean).join(". ")}`
        : `The bucket answered ${status}.`,
    );
    this.name = "BucketError";
    this.status = status;
  }
}

export interface S3Client {
  put(key: string, data: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<void>;
  /** A link that reads the object without credentials for `expiresSeconds`. */
  link(key: string, expiresSeconds: number): string;
  delete(key: string): Promise<void>;
  /** The objects whose keys start with `prefix`, the first thousand. */
  list(prefix: string): Promise<S3Object[]>;
}

export function s3Client(bucket: S3Bucket, deps: { fetch?: typeof fetch; now?: () => Date } = {}): S3Client {
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const objectUrl = (key = ""): URL => {
    const base = bucket.endpoint.replace(/\/+$/, "");
    return new URL(`${base}/${encode(bucket.bucket)}/${encode(key, true)}`);
  };

  async function call(
    method: string,
    url: URL,
    body?: Uint8Array,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    const signedHeaders = signRequest({
      method,
      url,
      headers,
      payloadHash: sha256Hex(body ?? ""),
      credentials: bucket,
      now: now(),
    });
    const response = await send(url, {
      method,
      headers: signedHeaders,
      // Sent as they are, never copied: a clip can run to hundreds of MB.
      ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new BucketError(response.status, await response.text().catch(() => ""));
    return response;
  }

  return {
    async put(key, data, mediaType, signal) {
      await call("PUT", objectUrl(key), data, { "content-type": mediaType }, signal);
    },
    link(key, expiresSeconds) {
      return presignUrl({ url: objectUrl(key), credentials: bucket, now: now(), expiresSeconds });
    },
    async delete(key) {
      await call("DELETE", objectUrl(key));
    },
    async list(prefix) {
      const url = objectUrl();
      url.pathname = url.pathname.replace(/\/$/, "");
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      const text = await (await call("GET", url)).text();
      const objects: S3Object[] = [];
      for (const [, entry] of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(entry)?.[1];
        const modified = Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(entry)?.[1] ?? "");
        if (key !== undefined && Number.isFinite(modified))
          objects.push({ key: unescapeXml(key), lastModified: modified });
      }
      return objects;
    },
  };
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
