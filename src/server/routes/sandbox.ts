import type { Context, Hono } from "hono";
import type {
  AddRowResponse,
  GenerateImageRouteResponse,
  GenerateOptionsRequestBody,
  GenerateOptionsResponse,
  GenerateRequestBody,
  GenerateResponse,
  GenerateVideoRouteResponse,
  ReferenceImagePayload,
  SandboxAddRowRequestBody,
  SandboxAddToNoteRequestBody,
  SandboxGenerateImageRequestBody,
  SandboxGenerateOptionsRequestBody,
  SandboxGenerateVideoRequestBody,
  SandboxGrantRequestBody,
  SandboxReadResult,
  SandboxUnattendedRequestBody,
  SandboxWriteRequestBody,
  VideoReferencePayload,
} from "../../protocol/api.ts";
import { VIDEO_REFERENCES_MAX } from "../../protocol/flowNodes.ts";
import { localDay, parseLocalDay } from "../../protocol/localDay.ts";
import { grantCapability, revokeCapability, setUnattended } from "../grants.ts";
import { jobRunner } from "../jobRunner.ts";
import { PathAccessError } from "../rootedFiles.ts";
import {
  declaresCapability,
  performSandboxAddRow,
  performSandboxAddToNote,
  performSandboxGenerate,
  performSandboxGenerateOptions,
  performSandboxRead,
  performSandboxWrite,
  readSandboxDocument,
  type SandboxDocument,
  SandboxRequestError,
  startSandboxGenerateImage,
  startSandboxGenerateVideo,
} from "../sandbox.ts";
import { type Incoming, type RouteContext, sendDispatchError, sendTextError } from "./shared.ts";

// Every /api/sandbox/* body as it arrives: the union of every route's fields,
// each validated by its handler, since a body is whatever the client sent.
type IncomingSandboxBody = Incoming<
  SandboxWriteRequestBody &
    SandboxAddRowRequestBody &
    SandboxAddToNoteRequestBody &
    SandboxGrantRequestBody &
    SandboxGenerateOptionsRequestBody &
    SandboxUnattendedRequestBody
>;

export function mountSandboxRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  // The sandbox broker's server half: one route family, `kind` in the body
  // picking how the document's identity and declared capabilities are read
  // (sandbox.ts).
  //
  // Every handler re-checks declared-and-granted against the file as it is
  // on disk right now — the client's own check only decides whether to
  // prompt, and is never trusted on its own. A sandboxed frame can't reach
  // these at all (opaque origin, no allow-same-origin).
  function sandboxRoute(
    name: string,
    handle: (c: Context, body: IncomingSandboxBody, doc: SandboxDocument) => Promise<Response>,
    onError: (c: Context, error: unknown) => Response = sendTextError,
  ): void {
    app.all(`/api/sandbox/${name}`, async (c) => {
      if (c.req.method !== "POST") return c.body(null, 405);
      try {
        const body = (await c.req.json()) as IncomingSandboxBody;
        const doc = await readSandboxDocument(spaceRoot, body.kind, body.path);
        return await handle(c, body, doc);
      } catch (error) {
        if (error instanceof SandboxRequestError) return c.text(error.message, error.status);
        // A refusal from the path resolver already knows which status says
        // why — an unregistered library is a 404, a read-only one a 403 —
        // and flattening either to 500 would tell the client to retry
        // something that will never succeed.
        if (error instanceof PathAccessError) return c.text(error.message, error.status);
        return onError(c, error);
      }
    });
  }

  function requireString(value: unknown, name: string): string {
    if (typeof value !== "string") throw new SandboxRequestError(400, `Missing ${name}`);
    return value;
  }

  // A start's id goes back with its job to every window listing it, so only
  // a short token is kept. It never changes what the job makes, so any other
  // value is left out rather than refusing the start.
  function readStartId(value: unknown): string | undefined {
    return typeof value === "string" && /^[\w-]{1,64}$/.test(value) ? value : undefined;
  }

  // A Generate node's references, each with the pin it came in on; one sent
  // without a pin takes its place in the list as one.
  function readReferences(value: unknown): ReferenceImagePayload[] {
    return (Array.isArray(value) ? value : []).map((reference, index) => {
      const fields = (reference ?? {}) as { pin?: unknown; mediaType?: unknown; data?: unknown };
      const pin =
        typeof fields.pin === "number" && Number.isInteger(fields.pin) && fields.pin > 0 ? fields.pin : index + 1;
      return {
        pin,
        mediaType: requireString(fields.mediaType, "reference mediaType"),
        data: requireString(fields.data, "reference data"),
      };
    });
  }

  // A Generate Video's clips, each by its pin, its address and the digest
  // its read gave. Read field by field, as every field here is: one this
  // route doesn't name never reaches the server half.
  function readVideoReferences(value: unknown): VideoReferencePayload[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new SandboxRequestError(400, "videoReferences must be a list");
    return value.map((reference) => {
      const fields = (reference ?? {}) as { pin?: unknown; path?: unknown; digest?: unknown };
      const pin = fields.pin;
      if (typeof pin !== "number" || !Number.isInteger(pin) || pin < 1 || pin > VIDEO_REFERENCES_MAX) {
        throw new SandboxRequestError(
          400,
          `A video reference's pin must be a whole number from 1 to ${VIDEO_REFERENCES_MAX}`,
        );
      }
      const path = requireString(fields.path, "video reference path");
      if (!path) throw new SandboxRequestError(400, "Missing video reference path");
      const digest = requireString(fields.digest, "video reference digest");
      if (!/^[0-9a-f]{64}$/.test(digest))
        throw new SandboxRequestError(400, "A video reference's digest must be a SHA-256 in hex");
      return { pin, path, digest };
    });
  }

  // The last day an unattended leave holds. One already gone is refused: the
  // leave would be withdrawn the moment it was given.
  function lastDay(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !parseLocalDay(value)) {
      throw new SandboxRequestError(400, "until must be a day, as YYYY-MM-DD");
    }
    if (value < localDay(new Date())) throw new SandboxRequestError(400, `${value} has already passed`);
    return value;
  }

  sandboxRoute("read", async (c, body, doc) => {
    const targetPath = requireString(body.targetPath, "targetPath");
    return c.json<SandboxReadResult>(await performSandboxRead(spaceRoot, doc, targetPath));
  });

  sandboxRoute("write", async (c, body, doc) => {
    const targetPath = requireString(body.targetPath, "targetPath");
    const content = typeof body.content === "string" ? body.content : "";
    await performSandboxWrite(spaceRoot, doc, targetPath, content);
    return c.body(null, 204);
  });

  // A row's cells arrive whole or not at all: one that isn't text refuses the
  // row rather than writing the rest of it.
  sandboxRoute("add-row", async (c, body, doc) => {
    const targetPath = requireString(body.targetPath, "targetPath");
    const values: unknown = body.values;
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      throw new SandboxRequestError(400, "Missing values");
    }
    if (Object.values(values).some((value) => typeof value !== "string")) {
      throw new SandboxRequestError(400, "Every cell must be text");
    }
    const row = values as Record<string, string>;
    return c.json<AddRowResponse>(await performSandboxAddRow(spaceRoot, doc, targetPath, row));
  });

  sandboxRoute("add-to-note", async (c, body, doc) => {
    const targetPath = requireString(body.targetPath, "targetPath");
    const text = requireString(body.text, "text");
    const mode = body.affixMode;
    if (mode !== "prepend" && mode !== "append") {
      throw new SandboxRequestError(400, "affixMode must be prepend or append");
    }
    await performSandboxAddToNote(spaceRoot, doc, targetPath, text, mode);
    return c.body(null, 204);
  });

  // The consent pair. Grant only ever follows a human act naming the target —
  // the prompt's Allow click, or a drag of that exact file onto a Flow (docs/
  // protocol.md, Permission model); capabilities are user-granted, never
  // agent-granted.
  //
  // Both re-validate the key against the declarations, and against the paths
  // its wired pins could bring, so a tampered client can't record, or clear,
  // a capability the document never asked for.
  for (const [name, apply] of [
    ["grant", grantCapability],
    ["revoke", revokeCapability],
  ] as const) {
    sandboxRoute(name, async (c, body, doc) => {
      const key = requireString(body.capabilityKey, "capabilityKey");
      if (!declaresCapability(doc, key)) throw new SandboxRequestError(400, `${doc.label} doesn't declare "${key}"`);
      apply(spaceRoot, doc.subject, key);
      return c.body(null, 204);
    });
  }

  // A Flow's leave to run unattended — consent of the same kind, set only by
  // a human in that Flow's Permissions panel.
  sandboxRoute("unattended", async (c, body, doc) => {
    if (typeof body.allowed !== "boolean") throw new SandboxRequestError(400, "allowed must be a boolean");
    await setUnattended(spaceRoot, doc.subject, body.allowed, lastDay(body.until));
    return c.body(null, 204);
  });

  // The generation pair. The dispatch itself has nothing kind-specific in it
  // (actionHandler.ts); the grant check is shared with the headless runner
  // (sandbox.ts). A request's own abort stops the model call, so a run
  // stopped in the browser isn't billed to the end.
  sandboxRoute(
    "generate",
    async (c, body, doc) =>
      c.json<GenerateResponse>(
        await performSandboxGenerate(spaceRoot, doc, body as GenerateRequestBody, c.req.raw.signal),
      ),
    sendDispatchError,
  );

  // An image made within the request comes back in it, and a request's own
  // abort stops that call. An image a provider makes as a job is answered
  // once the job is recorded, as a clip is.
  sandboxRoute("generate-image", async (c, body, doc) => {
    const request = body as Incoming<SandboxGenerateImageRequestBody>;
    const started = await startSandboxGenerateImage(
      spaceRoot,
      doc,
      {
        folder: requireString(request.folder, "folder"),
        prompt: requireString(request.prompt, "prompt"),
        references: readReferences(request.references),
        model: typeof request.model === "string" ? request.model : undefined,
        aspectRatio: typeof request.aspectRatio === "string" ? request.aspectRatio : undefined,
        seed: typeof request.seed === "string" ? request.seed : undefined,
        prefix: typeof request.prefix === "string" ? request.prefix : undefined,
        prefixTyped: typeof request.prefixTyped === "string" ? request.prefixTyped : undefined,
        startId: readStartId(request.startId),
      },
      c.req.raw.signal,
    );
    if ("found" in started) return c.json<GenerateImageRouteResponse>(started.found);
    await jobRunner().watched([started.job.id]);
    return c.json<GenerateImageRouteResponse>({ job: started.job.id, resumed: started.resumed });
  });

  // Answers once the job is recorded, so no request holds a connection for a
  // clip's minutes: the run waits on the job through /api/jobs, and the host
  // saves the clip whether or not it still waits.
  sandboxRoute("generate-video", async (c, body, doc) => {
    const request = body as Incoming<SandboxGenerateVideoRequestBody>;
    const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
    const frame = (value: unknown, name: string) => {
      if (value == null) return undefined;
      const fields = value as { mediaType?: unknown; data?: unknown };
      return {
        mediaType: requireString(fields.mediaType, `${name} mediaType`),
        data: requireString(fields.data, `${name} data`),
      };
    };
    const started = await startSandboxGenerateVideo(spaceRoot, doc, {
      folder: requireString(request.folder, "folder"),
      prompt: requireString(request.prompt, "prompt"),
      startFrame: frame(request.startFrame, "startFrame"),
      endFrame: frame(request.endFrame, "endFrame"),
      references: readReferences(request.references),
      videoReferences: readVideoReferences(request.videoReferences),
      model: optional(request.model),
      aspectRatio: optional(request.aspectRatio),
      resolution: optional(request.resolution),
      duration: optional(request.duration),
      take: optional(request.take),
      prefix: optional(request.prefix),
      prefixTyped: optional(request.prefixTyped),
      startId: readStartId(request.startId),
    });
    if ("found" in started) return c.json<GenerateVideoRouteResponse>(started.found);
    await jobRunner().watched([started.job.id]);
    return c.json<GenerateVideoRouteResponse>({ job: started.job.id, resumed: started.resumed });
  });

  sandboxRoute(
    "generate-options",
    async (c, body, doc) =>
      c.json<GenerateOptionsResponse>(
        await performSandboxGenerateOptions(spaceRoot, doc, body as GenerateOptionsRequestBody, c.req.raw.signal),
      ),
    sendDispatchError,
  );
}
