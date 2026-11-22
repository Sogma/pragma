// Positional reads for the header readers, of images and of clips: they jump
// between a file's boxes and segments rather than reading it through, so a
// header behind half a megabyte of metadata costs a few small reads.
import { open } from "node:fs/promises";

/** `length` bytes from `offset`, or fewer at the end of the file. */
export type ByteReader = (offset: number, length: number) => Promise<Buffer>;

/** Reads `filePath` through one open handle, closed once `use` settles. */
export async function withHeaderReader<T>(
  filePath: string,
  use: (read: ByteReader, size: number) => Promise<T>,
): Promise<T> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return await use(async (offset, length) => {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
  } finally {
    await handle.close();
  }
}

/** The same over bytes already in memory. */
export function bytesReader(bytes: Uint8Array): ByteReader {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return async (offset, length) => buffer.subarray(offset, offset + length);
}
