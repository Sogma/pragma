// Templates: Pragma's own, listed for New ▸ Template, the name a copy starts
// with, and a copy of one or of the space's own, made where New was chosen.
import type { Hono } from "hono";
import type {
  CreateEntryResponse,
  CreateFromTemplateRequestBody,
  PragmaTemplatesResponse,
  TemplateNameResponse,
} from "../../protocol/api.ts";
import { PathAccessError } from "../rootedFiles.ts";
import { copyTemplate, listPragmaTemplates, templateStartingName } from "../templateCopy.ts";
import type { Incoming, RouteContext } from "./shared.ts";

export function mountTemplateRoutes(app: Hono, { spaceRoot }: RouteContext): void {
  app.all("/api/templates", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      return c.json<PragmaTemplatesResponse>({ templates: await listPragmaTemplates() });
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  app.all("/api/space/template-name", async (c) => {
    if (c.req.method !== "GET") return c.body(null, 405);
    try {
      const { template, source, now } = c.req.query();
      const result = await templateStartingName(spaceRoot, { template, source, now });
      return "name" in result ? c.json<TemplateNameResponse>(result) : c.text(result.message, result.status);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });

  app.all("/api/space/create-from-template", async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    try {
      const result = await copyTemplate(spaceRoot, (await c.req.json()) as Incoming<CreateFromTemplateRequestBody>);
      return "created" in result ? c.json<CreateEntryResponse>(result.created) : c.text(result.message, result.status);
    } catch (error) {
      if (error instanceof PathAccessError) return c.text(error.message, error.status);
      return c.text(error instanceof Error ? error.message : "Internal error", 500);
    }
  });
}
