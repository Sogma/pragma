// Which permission a frame in a Pragma window may have. The window's own page
// is the app, so it gets what it asks for; a frame inside it, an Applet's or
// one added later, gets fullscreen alone, which an embedded video's player
// asks for, instead of Electron's default of granting every request.
export function framePermits(permission: string, ownPage: boolean): boolean {
  return ownPage || permission === "fullscreen";
}
