import { type EffortLevel, effortFor } from "./api.ts";
import {
  type CompletionTools,
  credentialRefusal,
  defaultTextModel,
  noTextModelError,
  openModel,
  type PromptContent,
  type PromptContentBlock,
  resolveModel,
} from "./modelProvider.ts";
import type {
  ActionResult,
  ContextFile,
  GenerateEnvelope,
  GenerateImageInput,
  GenerateOptionsEnvelope,
  GenerateResult,
} from "./types.ts";

function parseOptions(responseText: string, expectedCount: number): string[] {
  const start = responseText.indexOf("[");
  const end = responseText.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model response did not contain a JSON array");
  }

  // Models occasionally leave a trailing comma before the closing bracket
  // (`["a", "b",]`) — invalid JSON, but common enough that failing on it
  // isn't worth a retry. Stripped here rather than reaching for a permissive
  // JSON5-style parser, since this is the one shape that actually shows up.
  const jsonText = responseText.slice(start, end + 1).replace(/,(\s*)\]$/, "$1]");

  const parsed: unknown = JSON.parse(jsonText);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Model response was not a JSON array of strings");
  }

  return parsed.slice(0, expectedCount);
}

// Everything both dispatch paths share before they diverge on the model's
// raw text (candidates vs. a single reply): provider resolution, the "no
// text block" failure, and the one fallback from a blank `model` (the
// button/field's own) to the default.
interface ModelCall {
  text: string;
  model: string;
  effort?: EffortLevel;
  looked?: true;
}

/** The level a generation asked for `pick` runs at: the model's own level
 * nearest it, or none for its default. */
export function generationEffort(model: string | undefined, pick: EffortLevel | undefined): EffortLevel | undefined {
  const effectiveModel = model || defaultTextModel();
  return pick && effectiveModel ? effortFor(pick, resolveModel(effectiveModel).effortLevels) : undefined;
}

async function callModel(
  system: string,
  model: string | undefined,
  content: PromptContent,
  signal?: AbortSignal,
  tools?: CompletionTools,
  pick?: EffortLevel,
): Promise<ModelCall> {
  const effectiveModel = model || defaultTextModel();
  if (!effectiveModel) throw noTextModelError();

  const { provider, providerId, wireModel, effortLevels } = await openModel(resolveModel(effectiveModel));
  const effort = effortFor(pick, effortLevels);
  try {
    // The output a button or node wants is short (a rewritten line, a list
    // of N options), but the budget also has to cover a reasoning model's
    // thinking — some local "thinking" fine-tunes are very verbose. Headroom
    // rather than a tight cap; a non-reasoning model just stops at its
    // natural length and never approaches this.
    const { text, looked } = await provider.complete({
      model: wireModel,
      system,
      content,
      maxTokens: 16384,
      signal,
      tools,
      effort,
    });
    return { text, model: effectiveModel, ...(effort ? { effort } : {}), ...(looked ? { looked } : {}) };
  } catch (error) {
    // A refused key names its provider; every other failure (an empty reply,
    // a rate limit, the network) propagates untouched.
    throw credentialRefusal(error, providerId, effectiveModel) ?? error;
  }
}

const OPTIONS_SYSTEM_PROMPT =
  "You are a collaborative writing assistant embedded in a text editor. Do any reasoning " +
  "silently. Your entire reply must be nothing but a valid JSON array of strings.";

// The candidate list a call's text holds, a multimodal call's included.
function optionsOf({ text, model: effectiveModel, effort }: ModelCall, numOptions: number): ActionResult {
  return { options: parseOptions(text, numOptions), model: effectiveModel, ...(effort ? { effort } : {}) };
}

const REPLY_SYSTEM_PROMPT =
  "You are a collaborative writing assistant embedded in a text editor. Do any reasoning " +
  "silently. Reply with nothing but the requested field's content — no prose, no markdown, " +
  "no code fences, no surrounding quotes, no explanation.";

// The single-reply path — no candidate list, no JSON parsing to fail on: a
// generation's result is used as-is (see GenerateResult in types.ts), so the
// model's raw text *is* the answer, trimmed of incidental whitespace only.
function replyOf({ text, model: effectiveModel, effort }: ModelCall): GenerateResult {
  return { reply: text.trim(), model: effectiveModel, ...(effort ? { effort } : {}) };
}

/** A look before a generation answers: the tools its model may call, and the
 * files they read, which the answer is then asked for with. */
export interface GenerationLook {
  tools: CompletionTools;
  found: () => ContextFile[];
}

// With a look, the first call answers when the model needs nothing more.
// Once it has looked, its text is set aside and the answer is asked for
// again, without tools and with what it read in the context: a plain call,
// whose reply a model keeps to the asked-for content better than one written
// after its looking.
async function answered(
  look: GenerationLook | undefined,
  context: ContextFile[] | undefined,
  call: (context: ContextFile[] | undefined, tools?: CompletionTools) => Promise<ModelCall>,
): Promise<ModelCall> {
  const first = await call(context, look?.tools);
  if (!first.looked || !look) return first;
  return call([...(context ?? []), ...look.found()]);
}

// The `{{key}}` substitution GenerateEnvelope.instruction supports, against
// whatever `values` the request carries. An unmatched placeholder stays
// literal so a typo'd key stays visible rather than silently vanishing.
function substituteVariables(instruction: string, values: Record<string, string>): string {
  return instruction.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? values[key] : placeholder,
  );
}

// Shared by both prompt builders below — the same key/value pairs and image
// placeholders ahead of the instruction, whichever directive follows.
function buildValuesBlock(values: Record<string, string>, images: Record<string, GenerateImageInput>): string {
  const lines = [
    ...Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    ...Object.keys(images).map((key) => `@${key}: (see attached image)`),
  ];
  return lines.length > 0 ? `Values:\n${lines.join("\n")}\n\n` : "";
}

// The files a `context` pin sent, each in a tag naming its path from the
// root, ahead of all else the prompt carries, so the instruction comes last
// and reads them as reference. Nothing at all when none went.
function buildContextBlock(files: readonly ContextFile[] | undefined): string {
  if (!files?.length) return "";
  const attribute = (name: string, value: string) => ` ${name}="${value.replaceAll('"', "&quot;")}"`;
  const tagged = files.map(
    (file) =>
      `<file${attribute("path", file.path)}${file.section === undefined ? "" : attribute("section", file.section)}>\n` +
      `${file.content}\n</file>`,
  );
  return `Files from the writer's space, for reference:\n\n${tagged.join("\n\n")}\n\n`;
}

// Whatever key/value pairs and images the request carries, listed plainly
// ahead of the instruction.
function buildGeneratePrompt(envelope: GenerateEnvelope): string {
  return (
    buildContextBlock(envelope.context) +
    buildValuesBlock(envelope.values, envelope.images) +
    `${substituteVariables(envelope.instruction, envelope.values)}\n\n` +
    `Reply with only the requested content, nothing else — no prose, no markdown, ` +
    `no code fences, no surrounding quotes, no explanation.`
  );
}

// The generateOptions counterpart of the builder above — same values block
// and {{key}} substitution, but closes with a bare-JSON-array directive so it
// dispatches through the candidate-list path and OPTIONS_SYSTEM_PROMPT. That
// is what lets a Flow ask for "a few alternatives" without hand-rolling
// defensive JSON parsing on the client.
function buildGenerateOptionsPrompt(envelope: GenerateOptionsEnvelope): string {
  return (
    buildContextBlock(envelope.context) +
    buildValuesBlock(envelope.values, envelope.images) +
    `${substituteVariables(envelope.instruction, envelope.values)}\n\n` +
    `Return exactly ${envelope.numOptions} alternatives as a JSON array of strings, nothing else — ` +
    `no prose, no markdown, no code fences.`
  );
}

// `@key` (an @-mention, not `Key:`/`key:`) matches what an instruction types
// to refer back to this exact image (e.g. flow's generate node's
// `@image_1`..`@image_5`, see flowNodes.ts), per Anthropic's multi-image
// guidance: introduce each image with a short label the prompt can name.
//
// Interleaving isn't required, so every label+image pair comes ahead of the
// instruction text (each dispatcher's `content` below), not spliced into it.
function buildImageBlocks(images: Record<string, GenerateImageInput>): PromptContentBlock[] {
  return Object.entries(images).flatMap(([key, image]) => [
    { type: "text" as const, text: `@${key}` },
    { type: "image" as const, mediaType: image.mediaType, data: image.data },
  ]);
}

// The "run a generation" capability — a single-reply model call, behind
// /api/sandbox/generate.
export async function dispatchGenerate(
  envelope: GenerateEnvelope,
  model: string | undefined,
  signal?: AbortSignal,
  look?: GenerationLook,
  effort?: EffortLevel,
): Promise<GenerateResult> {
  const call = (context: ContextFile[] | undefined, tools?: CompletionTools) =>
    callModel(
      REPLY_SYSTEM_PROMPT,
      model,
      withImages(buildGeneratePrompt({ ...envelope, context }), envelope.images),
      signal,
      tools,
      effort,
    );
  return replyOf(await answered(look, envelope.context, call));
}

function withImages(prompt: string, images: Record<string, GenerateImageInput>): PromptContent {
  const imageBlocks = buildImageBlocks(images);
  return imageBlocks.length > 0 ? [...imageBlocks, { type: "text" as const, text: prompt }] : prompt;
}

// The generateOptions counterpart — behind /api/sandbox/generate-options for
// every sandboxed kind (see actionHandler.ts). Dispatches through the
// candidate-list path rather than the single-reply one, so callers get back
// ready-parsed candidates instead of raw text.
export async function dispatchGenerateOptions(
  envelope: GenerateOptionsEnvelope,
  model: string | undefined,
  signal?: AbortSignal,
  look?: GenerationLook,
  effort?: EffortLevel,
): Promise<ActionResult> {
  const call = (context: ContextFile[] | undefined, tools?: CompletionTools) =>
    callModel(
      OPTIONS_SYSTEM_PROMPT,
      model,
      withImages(buildGenerateOptionsPrompt({ ...envelope, context }), envelope.images),
      signal,
      tools,
      effort,
    );
  return optionsOf(await answered(look, envelope.context, call), envelope.numOptions);
}
