import type { AddressInfo, Server } from "node:net";

/** The port `server` ends up on, called right after it was told to listen.
 * Any failure gets one retry on a free port, not only EADDRINUSE: Windows
 * refuses a port inside a reserved range with EACCES. A second failure
 * rejects. */
export function listeningPort(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let retried = false;
    const onError = (error: Error) => {
      if (retried) {
        server.off("error", onError);
        server.off("listening", onListening);
        reject(error);
        return;
      }
      retried = true;
      server.listen(0, host);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.on("error", onError);
    server.once("listening", onListening);
  });
}
