import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Higgsfield's MCP server as recorded: its tool definitions, output schemas
// and answers come from test/fixtures/higgsfield-mcp, so the client checks
// them as it would the real server's. Addresses in the answers point back
// here. Switches turn a call into a refusal, a job still running, or an
// answer its schema doesn't allow.

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/higgsfield-mcp");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), "utf8")) as Record<string, unknown>;

export const RESULT_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
// An MP4's first box, `ftyp`, and a little after it.
export const RESULT_MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 4, 5, 6]);

export interface HiggsfieldStandIn {
  url: string;
  uploads: Array<{ contentType: string; bytes: number }>;
  generateCalls: Array<Record<string, unknown>>;
  // Price asks (`get_cost`), which submit nothing, and the price they answer.
  costCalls: Array<Record<string, unknown>>;
  creditsExact: number;
  authorizations: string[];
  // A media id the server refuses, as for an upload made by another account.
  refusedMediaId?: string;
  jobRunning: boolean;
  // How long jobs_wait holds its answer, as the real long poll does, and how
  // long it tells the client to pause before the next.
  pollDelayMs: number;
  pollAfterSeconds: number;
  // Called as each jobs_wait arrives, for a test to act at that moment.
  onJobsWait?: () => void;
  offSchema: boolean;
  adjustments?: Record<string, unknown>;
  // The frame roles a video model's catalog entry declares; the recorded
  // model's own when unset.
  videoRoles?: string[];
  // Entries a test adds to the recorded video model list.
  extraVideoModels?: Array<Record<string, unknown>>;
  // The resolutions it lists, the same way; empty for a model with no
  // resolution setting.
  videoResolutions?: string[];
  // A job id the server refuses to name, as one from another account.
  refusedJobId?: string;
  // How many jobs_wait calls have answered.
  waits: number;
  close(): Promise<void>;
}

// The recorded video job's id, which its wait answers for.
export const VIDEO_JOB_ID = "3c9a1b2e-4f5d-4e6a-8b7c-9d0e1f2a3b4c";

export async function startHiggsfieldStandIn(): Promise<HiggsfieldStandIn> {
  const tools = JSON.parse(readFileSync(path.join(fixtures, "tools.json"), "utf8"));
  let base = "";

  const json = (res: ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const answers = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
    if (name === "media_upload") {
      const result = fixture("upload");
      const content = result.structuredContent as { uploads: Array<Record<string, unknown>> };
      content.uploads[0].upload_url = `${base}/upload/${standIn.uploads.length + 1}`;
      return result;
    }
    if (name === "media_confirm") return fixture("confirm");
    if (name === "models_explore") {
      if (args.action === "list") {
        const result = fixture("models-list-video");
        (result.structuredContent as { items: unknown[] }).items.push(...(standIn.extraVideoModels ?? []));
        return result;
      }
      const result = fixture("models-get");
      const entry = result.structuredContent as {
        medias: Array<{ roles: string[] }>;
        parameters: Array<{ name: string; options?: unknown[] }>;
      };
      if (standIn.videoRoles) entry.medias[0].roles = standIn.videoRoles;
      const listed = standIn.videoResolutions;
      if (listed) {
        entry.parameters = entry.parameters.flatMap((parameter) =>
          parameter.name !== "resolution" ? [parameter] : listed.length ? [{ ...parameter, options: listed }] : [],
        );
      }
      return result;
    }
    if (name === "generate_image" || name === "generate_video") {
      lastJob = name === "generate_video" ? "video" : "image";
      const params = args.params as Record<string, unknown>;
      (params.get_cost ? standIn.costCalls : standIn.generateCalls).push(params);
      const medias = (params.medias ?? []) as Array<{ value: string }>;
      if (standIn.refusedMediaId && medias.some((media) => media.value === standIn.refusedMediaId)) {
        return {
          content: [{ type: "text", text: "Media not found" }],
          structuredContent: { error: "Media not found" },
          isError: true,
        };
      }
      if (params.get_cost) {
        return {
          content: [{ type: "text", text: `${standIn.creditsExact} credits` }],
          structuredContent: { cost: { credits: 1, credits_exact: standIn.creditsExact } },
        };
      }
      const result = fixture(lastJob === "video" ? "generate-video" : "generate");
      if (standIn.adjustments) (result.structuredContent as Record<string, unknown>).adjustments = standIn.adjustments;
      return result;
    }
    if (name === "jobs_wait") {
      standIn.waits += 1;
      standIn.onJobsWait?.();
      if (standIn.offSchema) return { content: [], structuredContent: { jobs: "not a list" } };
      const jobs = args.jobs as Array<{ job_id: string }>;
      // Its output schema holds no error field, so a refusal is words alone.
      if (standIn.refusedJobId && jobs[0]?.job_id === standIn.refusedJobId) {
        return { content: [{ type: "text", text: "Job not found" }], isError: true };
      }
      const video = jobs[0]?.job_id === VIDEO_JOB_ID;
      const result = fixture(video ? "wait-video" : "wait-1");
      const content = result.structuredContent as { jobs: Array<Record<string, unknown>>; all_terminal: boolean };
      if (standIn.jobRunning) {
        content.jobs[0].status = "in_progress";
        delete content.jobs[0].result_url;
        content.all_terminal = false;
        Object.assign(content, { poll_after_seconds: standIn.pollAfterSeconds });
      } else {
        content.jobs[0].result_url = `${base}/${video ? "result.mp4" : "result.png"}`;
      }
      return result;
    }
    return { content: [{ type: "text", text: `No tool ${name}` }], isError: true };
  };

  const standIn: HiggsfieldStandIn = {
    url: "",
    uploads: [],
    generateCalls: [],
    costCalls: [],
    creditsExact: 0.12,
    authorizations: [],
    jobRunning: false,
    pollDelayMs: 0,
    pollAfterSeconds: 0.02,
    offSchema: false,
    waits: 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  let lastJob: "image" | "video" = "image";

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const pathname = new URL(req.url ?? "/", base).pathname;
      if (pathname.startsWith("/upload/") && req.method === "PUT") {
        standIn.uploads.push({ contentType: String(req.headers["content-type"]), bytes: Buffer.concat(chunks).length });
        res.writeHead(200);
        return res.end();
      }
      if (pathname === "/result.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(RESULT_PNG);
      }
      if (pathname === "/result.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" });
        return res.end(RESULT_MP4);
      }
      if (pathname !== "/mcp" || req.method !== "POST") {
        res.writeHead(405);
        return res.end();
      }
      standIn.authorizations.push(String(req.headers.authorization ?? ""));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
      };
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "Higgsfield AI", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools }
            : message.method === "tools/call"
              ? answers(message.params?.name ?? "", message.params?.arguments ?? {})
              : {};
      const delay = message.params?.name === "jobs_wait" ? standIn.pollDelayMs : 0;
      setTimeout(() => json(res, { jsonrpc: "2.0", id: message.id, result }), delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  standIn.url = `${base}/mcp`;
  return standIn;
}
