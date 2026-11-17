import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isHiddenName } from "../protocol/entryName.ts";
import { isPrivateDocument, readFrontmatter } from "../protocol/frontmatter.ts";
import {
  credentialRefusal,
  defaultTextModel,
  noTextModelError,
  openModel,
  resolveModel,
} from "../protocol/modelProvider.ts";
import { type FindContextCandidate, type FindContextResult, isMarkdownFile } from "../protocol/types.ts";
import { resolveWithinSpace } from "./spaceFiles.ts";

const MAX_CANDIDATES = 3;

interface ScannedFile {
  path: string; // space-relative, forward-slash
  frontmatterBlock: string;
}

async function scanMarkdownFiles(spaceRoot: string, absoluteDir: string): Promise<ScannedFile[]> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: ScannedFile[] = [];

  for (const entry of entries) {
    if (isHiddenName(entry.name) || !entry.isFile() || !isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = path.relative(spaceRoot, absolutePath).split(path.sep).join("/");
    const content = await readFile(absolutePath, "utf8");
    if (isPrivateDocument(content)) continue; // never enters the ranking prompt — see docs/architecture.md's Privacy section
    const { data } = readFrontmatter(content);
    const frontmatterBlock = Object.keys(data).length > 0 ? JSON.stringify(data) : "(no frontmatter)";

    files.push({ path: relativePath, frontmatterBlock });
  }

  return files;
}

function buildPrompt(query: string, files: ScannedFile[]): string {
  const fileBlocks = files.map((file) => `### ${file.path}\n${file.frontmatterBlock}`).join("\n\n");

  return (
    `The writer is looking for the most relevant existing note for this thought:\n${JSON.stringify(query)}\n\n` +
    `Candidate files (path and frontmatter, from a single directory):\n\n${fileBlocks}\n\n` +
    `Return the top ${MAX_CANDIDATES} most relevant candidates, ranked best first, as a JSON object of the form ` +
    `{ "candidates": [{ "path": string, "score": number (0-1), "reasoning": string[] }] }. ` +
    `"path" must be exactly one of the candidate paths listed above. Return nothing but that JSON object — ` +
    `no prose, no markdown, no code fences.`
  );
}

function parseCandidates(responseText: string, validPaths: Set<string>): FindContextCandidate[] {
  const start = responseText.indexOf("{");
  const end = responseText.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model response did not contain a JSON object");
  }

  const parsed: unknown = JSON.parse(responseText.slice(start, end + 1));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("candidates" in parsed) ||
    !Array.isArray((parsed as { candidates: unknown }).candidates)
  ) {
    throw new Error("Model response did not contain a candidates array");
  }

  const candidates = (parsed as { candidates: unknown[] }).candidates.filter(
    (item): item is FindContextCandidate =>
      !!item &&
      typeof item === "object" &&
      typeof (item as FindContextCandidate).path === "string" &&
      validPaths.has((item as FindContextCandidate).path) &&
      typeof (item as FindContextCandidate).score === "number" &&
      Array.isArray((item as FindContextCandidate).reasoning),
  );

  return candidates.slice(0, MAX_CANDIDATES);
}

export async function runFindContext(
  spaceRoot: string,
  directoryPath: string,
  query: string,
): Promise<FindContextResult> {
  const absoluteDir = resolveWithinSpace(spaceRoot, directoryPath);
  const files = await scanMarkdownFiles(spaceRoot, absoluteDir);

  if (files.length === 0) {
    return { candidates: [], prompt: "", model: "" };
  }

  const effectiveModel = defaultTextModel();
  if (!effectiveModel) throw noTextModelError("No model configured. Set a default text model in Settings.");

  const prompt = buildPrompt(query, files);

  // Same single-completion shape the applet and Flow paths use — goes through
  // the shared provider seam (modelProvider.ts) rather than constructing an
  // Anthropic client of its own. An empty reply throws EmptyModelReplyError,
  // which /api/find-context does not special-case.
  const { provider, providerId, wireModel } = await openModel(resolveModel(effectiveModel));
  const { text } = await provider
    .complete({
      model: wireModel,
      system:
        "You are a retrieval assistant embedded in a text editor. Do any reasoning silently. " +
        "Your entire reply must be nothing but a valid JSON object.",
      content: prompt,
      // A small JSON object, but the budget also has to cover a reasoning
      // model's thinking — see the matching note in dispatchAction.ts.
      maxTokens: 8192,
    })
    .catch((error: unknown) => {
      throw credentialRefusal(error, providerId, effectiveModel) ?? error;
    });

  const validPaths = new Set(files.map((file) => file.path));
  return {
    candidates: parseCandidates(text, validPaths),
    prompt,
    model: effectiveModel,
  };
}
