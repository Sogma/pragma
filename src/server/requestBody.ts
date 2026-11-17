import type { IncomingMessage } from "node:http";

/** The request's whole body, or undefined once it runs past `maxBytes`.
 *
 * Past the cap nothing more is kept, but reading goes on and drops what
 * arrives. Stopping instead would lose the caller's refusal: a destroyed
 * socket can't carry it, and one closed with data unread is reset. */
export function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > maxBytes) {
      req.resume();
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      resolve(undefined);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => reject(new Error("The request closed before its body ended")));
  });
}
