// One `Range: bytes=…` header, resolved against a file's real size.
//
// A video is the reason this exists. A player asks for a file in pieces —
// first a small head, then a tail to find the index an MP4 keeps at the end,
// then a window per seek — and a server that answers each with the whole
// file makes seeking impossible and a multi-gigabyte take unplayable.
//
// The parse is kept here, away from the route, because the interesting cases
// are all in the arithmetic.

export interface ByteRange {
  /** Inclusive, both ends, as the header and `Content-Range` both are. */
  start: number;
  end: number;
}

// A single range only. `bytes=0-9, 20-29` is legal HTTP and no browser sends
// it for media, so it falls to the "not understood" branch below and is
// answered with the whole file rather than a multipart response.
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * `undefined` — no range, or one this server does not understand: send the
 * whole file, which the spec requires of an unrecognized range.
 *
 * `null` — a parsed but unsatisfiable range, the one case that owes a 416.
 * Answering it with the whole file is how a player ends up decoding the
 * wrong bytes instead of being told to start over.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (header === undefined) return undefined;
  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return undefined;

  const [, rawStart, rawEnd] = match;
  // "bytes=-" names neither end and is malformed rather than unsatisfiable.
  if (rawStart === "" && rawEnd === "") return undefined;

  // An empty file satisfies no range at all: there is no byte to name, so
  // every request for one is unsatisfiable rather than an empty success.
  if (size === 0) return null;

  if (rawStart === "") {
    // A suffix range — "the last N bytes" — which is how a player finds an
    // MP4's trailing index without reading what comes before it. More bytes
    // than the file holds is the whole file, not an error.
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return null;
  // An open end, or one past the last byte, both clamp to it. Clamping
  // rather than refusing is what the spec asks for, and it is what a player
  // relies on when it guesses a window larger than what is left.
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return null;
  return { start, end };
}
