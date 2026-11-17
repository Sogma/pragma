import type { Context, Hono } from "hono";
import type { GitActionResponse, GitCommitRequestBody } from "../../protocol/api.ts";
import { commitAll, getGitStatus, gitPull, gitPush, syncAll, UntrustedSpaceError } from "../gitHandler.ts";
import { type RouteContext, sendTextError } from "./shared.ts";

function sendGitError(c: Context, error: unknown): Response {
  if (error instanceof UntrustedSpaceError) return c.text(error.message, 403);
  return sendTextError(c, error);
}

export function mountGitRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  app.all("/api/git/status", async (c) => {
    try {
      const status = await getGitStatus(spaceRoot, { fetch: c.req.query("fetch") !== "0" });
      return c.json(status);
    } catch (error) {
      return sendGitError(c, error);
    }
  });

  app.all("/api/git/commit", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const body = (await c.req.json()) as GitCommitRequestBody;
      await commitAll(spaceRoot, body.message);
      return c.json<GitActionResponse>({ status: await getGitStatus(spaceRoot) });
    } catch (error) {
      return sendGitError(c, error);
    }
  });

  app.all("/api/git/pull", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      const pulled = await gitPull(spaceRoot);
      return c.json<GitActionResponse>({ ...pulled, status: await getGitStatus(spaceRoot) });
    } catch (error) {
      return sendGitError(c, error);
    }
  });

  app.all("/api/git/push", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      await gitPush(spaceRoot);
      return c.json<GitActionResponse>({ status: await getGitStatus(spaceRoot) });
    } catch (error) {
      return sendGitError(c, error);
    }
  });

  app.all("/api/git/sync", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);

    try {
      return c.json<GitActionResponse>(await syncAll(spaceRoot));
    } catch (error) {
      return sendGitError(c, error);
    }
  });
}
