import type { GenerateOptionsRequestBody, GenerateRequestBody } from "../protocol/api.ts";
import { dispatchGenerate, dispatchGenerateOptions, type GenerationLook } from "../protocol/dispatchAction.ts";
import type {
  ActionResult,
  ContextFile,
  GenerateEnvelope,
  GenerateImageInput,
  GenerateOptionsEnvelope,
  GenerateResult,
} from "../protocol/types.ts";

/** The "run a generation" dispatch — the capability/grant check (does this
 * Flow declare, and currently hold, the "generateText" capability) happens in
 * sandbox.ts before this is ever called, the same "broker validates, this
 * just dispatches" split /api/sandbox/read follows for its own capability. */
export async function runGenerate(
  body: GenerateRequestBody,
  signal?: AbortSignal,
  context?: ContextFile[],
  look?: GenerationLook,
): Promise<GenerateResult> {
  const images: Record<string, GenerateImageInput> = {};
  for (const [key, image] of Object.entries(body.images ?? {})) {
    images[key] = { mediaType: image.mediaType as GenerateImageInput["mediaType"], data: image.data };
  }

  const envelope: GenerateEnvelope = { instruction: body.instruction, values: body.values ?? {}, images, context };
  return dispatchGenerate(envelope, body.model, signal, look, body.effort);
}

/** The generateOptions counterpart to the generation dispatch above — same
 * broker/dispatch split (the capability/grant check happens in sandbox.ts
 * before this runs). */
export async function runGenerateOptions(
  body: GenerateOptionsRequestBody,
  signal?: AbortSignal,
  context?: ContextFile[],
  look?: GenerationLook,
): Promise<ActionResult> {
  const images: Record<string, GenerateImageInput> = {};
  for (const [key, image] of Object.entries(body.images ?? {})) {
    images[key] = { mediaType: image.mediaType as GenerateImageInput["mediaType"], data: image.data };
  }

  const envelope: GenerateOptionsEnvelope = {
    instruction: body.instruction,
    values: body.values ?? {},
    images,
    context,
    numOptions: body.numOptions,
  };
  return dispatchGenerateOptions(envelope, body.model, signal, look, body.effort);
}
