/** Bytes as base64, for a JSON body or a data URL. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a large file into one call overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
