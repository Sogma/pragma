// A reader over bytes in memory that counts what it was asked for, so a test
// can say how much of a file a walk touched.
import type { ByteReader } from "../../src/server/pixelFormat.ts";

export function countingReader(bytes: Buffer): ByteReader & { requested: number } {
  const read = Object.assign(
    async (offset: number, length: number) => {
      read.requested += Math.max(0, Math.min(length, bytes.length - offset));
      return bytes.subarray(offset, offset + length);
    },
    { requested: 0 },
  );
  return read;
}
