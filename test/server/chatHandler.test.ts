import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { APICallError, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ResolvedMcpServer } from "../../src/config/loadConfig.ts";
import { parseFlowFile } from "../../src/protocol/flowFile.ts";
import { serializeFlowFile } from "../../src/protocol/flowHtml.ts";
import { setupNeedOf } from "../../src/protocol/setupNeed.ts";
import type { FlowGraph, MetadataEntry } from "../../src/protocol/types.ts";
import { type EditorContext, runChat, runChatOn, type SelectedFile } from "../../src/server/chatHandler.ts";
import { createContextSources } from "../../src/server/copilotContext.ts";
import type { McpConnector } from "../../src/server/mcpTools.ts";
import { revisionOf } from "../../src/server/spaceFiles.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";
import { giveSpaceLibraries } from "../support/libraries.ts";

// The copilot's loop against the AI SDK's mock model — no provider, no
// network. Pins the contract docs/architecture.md's Embedded copilot section
// states: the tool surface keys off the EditorContext, and every edit and
// create is recorded as a proposal rather than written.

// `before` runs as the step is generated: the world changing between the
// model's tool calls.
type Step = { text?: string; toolCall?: { name: string; input: object }; before?: () => Promise<void> };

// One doGenerate per step, in order; the loop re-prompts after a tool call.
function scripted(steps: Step[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[index++] ?? { text: "" };
      await step.before?.();
      return {
        content: step.toolCall
          ? [
              {
                type: "tool-call" as const,
                toolCallId: `call_${index}`,
                toolName: step.toolCall.name,
                input: JSON.stringify(step.toolCall.input),
              },
            ]
          : [{ type: "text" as const, text: step.text ?? "" }],
        finishReason: { unified: step.toolCall ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

// The text a tool's result handed the model, read from the next call's prompt.
function toolOutput(model: MockLanguageModelV4, call: number): string {
  const message = model.doGenerateCalls[call].prompt.at(-1);
  const part = message?.role === "tool" ? message.content[0] : undefined;
  return part?.type === "tool-result" && part.output.type === "text" ? part.output.value : "";
}

function offeredTools(model: MockLanguageModelV4, call = 0): string[] {
  return (model.doGenerateCalls[call].tools ?? []).map((tool) => tool.name);
}

// A 1×1 PNG, so a look reads real image bytes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("runChatOn", () => {
  let spaceRoot: string;
  let notePath: string;

  beforeEach(async () => {
    spaceRoot = tempDir("pragma-chat-test-");
    notePath = path.join(spaceRoot, "note.md");
    await writeFile(notePath, "# Draft\n", "utf8");
    await writeFile(path.join(spaceRoot, "secret.md"), "---\nvisibility: private\n---\nhidden\n", "utf8");
  });

  it("offers the document-scoped tools only when a document is open", async () => {
    const onDocument = scripted([{ text: "ok" }]);
    await runChatOn(onDocument, spaceRoot, { view: "document", filePath: notePath }, [], "hi");
    expect(offeredTools(onDocument)).toEqual([
      "read_current_document",
      "edit_current_document",
      "list_space_files",
      "search_space_files",
      "read_space_file",
      "list_space_file_links",
      "read_pragma_spec",
      "propose_create_document",
      "propose_edit_file",
    ]);

    const onFolder = scripted([{ text: "ok" }]);
    await runChatOn(onFolder, spaceRoot, { view: "folder", dirPath: spaceRoot }, [], "hi");
    expect(offeredTools(onFolder)).not.toContain("read_current_document");
    expect(offeredTools(onFolder)).not.toContain("edit_current_document");
  });

  it("lists a folder's entries in order with their descriptions, keeping private ones from the model", async () => {
    const board = path.join(spaceRoot, "board");
    await mkdir(path.join(board, "act-one"), { recursive: true });
    await mkdir(path.join(board, "act-two"));
    await writeFile(path.join(board, "act-one", "README.md"), "---\ndescription: The first act.\n---\n", "utf8");
    await writeFile(
      path.join(board, "act-two", "README.md"),
      "---\nvisibility: private\ndescription: A secret act.\n---\n",
      "utf8",
    );
    await writeFile(path.join(board, "scene.fountain"), "= A door opens.\n\nINT. ROOM - DAY\n", "utf8");
    await writeFile(
      path.join(board, "hidden.md"),
      "---\nvisibility: private\ndescription: Not for the model.\n---\n",
      "utf8",
    );
    const order = ["scene.fountain", "hidden.md", "act-two", "act-one"].map((name) => ({ name }));
    await writeFile(path.join(board, "_structure.json"), JSON.stringify({ order }), "utf8");
    const model = scripted([{ text: "ok" }]);

    await runChatOn(model, spaceRoot, { view: "folder", dirPath: board }, [], "hi");

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).toContain(
      "its entries, in order, are:\n1. `scene.fountain`: A door opens.\n2. `act-two`\n3. `act-one`: The first act.",
    );
    expect(system).not.toContain("hidden.md");
    expect(system).not.toContain("Not for the model");
    expect(system).not.toContain("A secret act");
  });

  // Written by the protocol's own rule and handed over to copy, so a change
  // to the rule reaches the links the model writes.
  it("hands the model each entry's link to copy, as a document at the space root writes it", async () => {
    await mkdir(path.join(spaceRoot, "story"));
    await writeFile(path.join(spaceRoot, "story", "AGENTS.md"), "---\npragma: {}\n---\n", "utf8");
    await writeFile(path.join(spaceRoot, "story", "act.fountain"), "INT. CELLAR - NIGHT\n", "utf8");
    await mkdir(path.join(spaceRoot, "drafts"));
    await writeFile(path.join(spaceRoot, "drafts", "cellar.md"), "The cellar.\n", "utf8");
    const model = scripted([
      { toolCall: { name: "list_space_files", input: {} } },
      { toolCall: { name: "search_space_files", input: { query: "cellar" } } },
      { text: "Found it." },
    ]);
    const beside: EditorContext = { view: "document", filePath: path.join(spaceRoot, "story", "act.fountain") };
    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "where?", { beside });

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).toContain("The currently open document is `note.md`. Its link is [[note]].");
    expect(system).toContain("shows the document `story/act.fountain`. Its link is [[/story/act.fountain|act]].");
    expect(system).toContain("copy it exactly as a tool result gives it after `link`");

    const listed = toolOutput(model, 1).split("\n");
    expect(listed).toEqual(
      expect.arrayContaining(["drafts/ (link [[drafts/]])", "drafts/cellar.md (link [[drafts/cellar]])"]),
    );
    expect(listed.indexOf("drafts/ (link [[drafts/]])")).toBeLessThan(
      listed.indexOf("drafts/cellar.md (link [[drafts/cellar]])"),
    );
    expect(toolOutput(model, 2).split("\n")).toEqual([
      "drafts/cellar.md:1 (link [[drafts/cellar]]): The cellar.",
      "story/act.fountain:1 (link [[/story/act.fountain|act]]): INT. CELLAR - NIGHT",
    ]);
  });

  it("adds each module's context section after the project README", async () => {
    const project = path.join(spaceRoot, "project");
    await mkdir(project);
    await writeFile(path.join(project, "README.md"), "The project.", "utf8");
    await writeFile(path.join(project, "scene.md"), "# Scene\n", "utf8");
    const contextSources = createContextSources();
    contextSources.register("probe", {
      section: async (request) => ({ title: "Probe (project)", body: `Started in ${request.folder}.` }),
    });
    const model = scripted([{ text: "ok" }]);

    await runChatOn(model, spaceRoot, { view: "document", filePath: path.join(project, "scene.md") }, [], "hi", {
      contextSources,
    });

    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain(
      "## Project context (project/README.md)\n\nThe project.\n\n## Probe (project)\n\nStarted in project.",
    );
  });

  it("asks for the turn's effort level, with room for its thinking, and for none without one", async () => {
    const reasoned = scripted([{ text: "ok" }]);
    await runChatOn(reasoned, spaceRoot, { view: "none" }, [], "hi", { effort: "high" });
    expect(reasoned.doGenerateCalls[0]).toMatchObject({ reasoning: "high", maxOutputTokens: 16384 });

    const plain = scripted([{ text: "ok" }]);
    await runChatOn(plain, spaceRoot, { view: "none" }, [], "hi");
    expect(plain.doGenerateCalls[0].reasoning).toBeUndefined();
  });

  it("names an open Flow without offering it as the current document", async () => {
    const flowPath = path.join(spaceRoot, "pipeline.flow.html");
    await writeFile(flowPath, "<html></html>\n", "utf8");
    const model = scripted([{ text: "ok" }]);

    await runChatOn(model, spaceRoot, { view: "flow", filePath: flowPath }, [], "what does this do?");

    expect(offeredTools(model)).not.toContain("read_current_document");
    expect(offeredTools(model)).not.toContain("edit_current_document");
    expect(offeredTools(model)).toContain("read_space_file");
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("the Flow `pipeline.flow.html`");
  });

  it("tells the model an open Table marked private is not for it, and its read refuses it", async () => {
    const tablePath = path.join(spaceRoot, "cast.table.html");
    await writeFile(
      tablePath,
      '<html data-format="table"><body><dl data-role="metadata"><dt>visibility</dt><dd>private</dd></dl>' +
        "<p>the private word is quince</p></body></html>\n",
      "utf8",
    );
    const model = scripted([
      { toolCall: { name: "read_space_file", input: { path: "cast.table.html" } } },
      { text: "I can't read it." },
    ]);

    await runChatOn(model, spaceRoot, { view: "table", filePath: tablePath }, [], "what's in this?");

    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("marked `visibility: private`");
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).not.toContain("quince");
  });

  // The pane would save its in-memory copy over an accepted rewrite.
  it("refuses to propose an edit to the file an open Table pane renders", async () => {
    const tablePath = path.join(spaceRoot, "cast.table.html");
    await writeFile(tablePath, "<table></table>\n", "utf8");
    const model = scripted([
      { toolCall: { name: "propose_edit_file", input: { path: "cast.table.html", newContent: "x" } } },
      { text: "Can't." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "table", filePath: tablePath }, [], "add a row");

    expect(result.proposedEdit).toBeUndefined();
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("can't be changed from chat");
  });

  it("names the document the other group shows for the model to read, quoting none of it", async () => {
    const besidePath = path.join(spaceRoot, "other.md");
    await writeFile(besidePath, "the beside word is medlar\n", "utf8");
    const model = scripted([{ text: "ok" }]);

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "compare them", {
      beside: { view: "document", filePath: besidePath },
    });

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).toContain("The currently open document is `note.md`.");
    expect(system).toContain("other editor group shows the document `other.md`");
    expect(system).toContain("Read it with read_space_file");
    expect(system).not.toContain("medlar");
  });

  it("names a private document beside as private, and its read refuses it", async () => {
    const model = scripted([
      { toolCall: { name: "read_space_file", input: { path: "secret.md" } } },
      { text: "I can't read it." },
    ]);

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "what's beside?", {
      beside: { view: "document", filePath: path.join(spaceRoot, "secret.md") },
    });

    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("marked `visibility: private`");
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).not.toContain("hidden");
  });

  // The other group's pane would save its copy over an accepted rewrite, as
  // the focused one's would.
  it("refuses to propose an edit to a Table the other group has open, and proposes one to a document there", async () => {
    const tablePath = path.join(spaceRoot, "cast.table.html");
    await writeFile(tablePath, "<table></table>\n", "utf8");
    const toTable = scripted([
      { toolCall: { name: "propose_edit_file", input: { path: "cast.table.html", newContent: "x" } } },
      { text: "Can't." },
    ]);
    const onTable = await runChatOn(toTable, spaceRoot, { view: "document", filePath: notePath }, [], "add a row", {
      beside: { view: "table", filePath: tablePath },
    });
    expect(onTable.proposedEdit).toBeUndefined();
    expect(String(toTable.doGenerateCalls[0].prompt[0].content)).toContain("can't be changed from chat while");

    const besidePath = path.join(spaceRoot, "other.md");
    await writeFile(besidePath, "old\n", "utf8");
    const toDocument = scripted([
      { toolCall: { name: "propose_edit_file", input: { path: "other.md", newContent: "new\n" } } },
      { text: "Proposed." },
    ]);
    const onDocument = await runChatOn(toDocument, spaceRoot, { view: "document", filePath: notePath }, [], "fix it", {
      beside: { view: "document", filePath: besidePath },
    });
    expect(onDocument.proposedEdit).toMatchObject({ path: "other.md", before: "old\n", newContent: "new\n" });
  });

  it("reads Pragma's spec a section at a time, and is told to before writing a format", async () => {
    const model = scripted([
      { toolCall: { name: "read_pragma_spec", input: { section: "templateVariables" } } },
      { toolCall: { name: "read_pragma_spec", input: { section: "nope" } } },
      { text: "ok" },
    ]);

    await runChatOn(model, spaceRoot, { view: "none" }, [], "build me a flow");

    expect(offeredTools(model)).toContain("read_pragma_spec");
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("each node type it uses");
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("### `templateVariables`");
    expect(JSON.stringify(model.doGenerateCalls[2].prompt)).toContain("in Pragma's spec. Sections: ");
  });

  // The model hears what's wrong and can fix it within the turn; the writer
  // sees only a file that opens as it says.
  it("returns a proposed Flow's problems to the model, then shows its fix filled in", async () => {
    const at = { x: 0, y: 0 };
    const broken = serializeFlowFile({
      version: "1.0",
      graph: { nodes: [{ id: "k", type: "kit", position: at, config: {} }], edges: [] },
    });
    const fixed = serializeFlowFile({
      version: "1.0",
      graph: {
        nodes: [
          { id: "p", type: "prompt", position: at, config: { text: "hi {{x}}" } },
          { id: "v", type: "templateVariables", position: at, config: { var2Name: "x" } },
        ],
        edges: [{ id: "e", source: "p", sourcePort: "text", target: "v", targetPort: "source" }],
      },
    });
    const propose = (content: string) => ({
      toolCall: {
        name: "propose_create_document",
        input: { parentPath: "", name: "new.flow.html", type: "file", content },
      },
    });
    const model = scripted([propose(broken), propose(fixed), { text: "Proposed." }]);

    const result = await runChatOn(model, spaceRoot, { view: "none" }, [], "make me a flow");

    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("Nothing was proposed");
    expect(JSON.stringify(model.doGenerateCalls[2].prompt)).toContain("Pragma filled in");
    const shown = parseFlowFile(result.proposedDocument?.content ?? "");
    expect(shown?.graph.nodes.find((node) => node.id === "v")?.config.varSlots).toEqual([2]);
  });

  it("records no edit to a Flow whose replacement has problems", async () => {
    await writeFile(
      path.join(spaceRoot, "old.flow.html"),
      serializeFlowFile({ version: "1.0", graph: { nodes: [], edges: [] } }),
      "utf8",
    );
    const model = scripted([
      { toolCall: { name: "propose_edit_file", input: { path: "old.flow.html", newContent: "<html>nope</html>" } } },
      { text: "Couldn't." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "none" }, [], "fix it");

    expect(result.proposedEdit).toBeUndefined();
    expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain("isn't a Flow Pragma can read");
  });

  // `.git/config` can hold a remote's credentials, and a refusal naming the
  // file would confirm it exists, so a hidden path reads as a missing one.
  it("reads a hidden file as one that isn't there, handing the model none of it", async () => {
    await mkdir(path.join(spaceRoot, ".git"));
    await writeFile(path.join(spaceRoot, ".git", "config"), "url = https://plum-token@example.com\n", "utf8");
    const model = scripted([
      { toolCall: { name: "read_space_file", input: { path: ".git/config" } } },
      { toolCall: { name: "read_space_file", input: { path: "./notes/../.git/config" } } },
      { toolCall: { name: "read_space_file", input: { path: "./note.md" } } },
      { text: "Nothing there." },
    ]);

    await runChatOn(model, spaceRoot, { view: "none" }, [], "what's in the git config?");

    const seen = JSON.stringify(model.doGenerateCalls[3].prompt);
    expect(seen).not.toContain("plum-token");
    expect(seen).toContain("There's no file at .git/config in the space.");
    expect(seen).toContain("There's no file at ./notes/../.git/config in the space.");
    expect(seen).toContain("# Draft");
  });

  describe("an image on screen", () => {
    let frame: EditorContext;

    beforeEach(async () => {
      const filePath = path.join(spaceRoot, "frame.png");
      await writeFile(filePath, PNG);
      frame = { view: "image", filePath, path: "frame.png" };
    });

    it("offers look_at_image only while a raster image is on screen, in either group", async () => {
      const focused = scripted([{ text: "ok" }]);
      await runChatOn(focused, spaceRoot, frame, [], "hi");
      expect(offeredTools(focused)).toContain("look_at_image");
      expect(String(focused.doGenerateCalls[0].prompt[0].content)).toContain(
        "the image `frame.png` open in a read-only preview",
      );

      const beside = scripted([{ text: "ok" }]);
      await runChatOn(beside, spaceRoot, { view: "document", filePath: notePath }, [], "hi", {
        beside: frame,
      });
      expect(offeredTools(beside)).toContain("look_at_image");
      expect(String(beside.doGenerateCalls[0].prompt[0].content)).toContain(
        "other editor group shows the image `frame.png`. Its link is [[frame.png]]. You know its name and folder, " +
          "not what it depicts: " +
          "call look_at_image only when",
      );

      const none = scripted([{ text: "ok" }]);
      await runChatOn(none, spaceRoot, { view: "document", filePath: notePath }, [], "hi");
      expect(offeredTools(none)).not.toContain("look_at_image");
    });

    it("points the model at a vector image's source instead", async () => {
      const logoPath = path.join(spaceRoot, "logo.svg");
      await writeFile(logoPath, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
      const model = scripted([{ text: "ok" }]);

      await runChatOn(model, spaceRoot, { view: "image", filePath: logoPath, path: "logo.svg" }, [], "hi");

      expect(offeredTools(model)).not.toContain("look_at_image");
      const system = String(model.doGenerateCalls[0].prompt[0].content);
      expect(system).toContain("It's a vector image: read_space_file reads its source.");
      expect(system).toContain("never a raster image, video, or PDF");
    });

    it("shows the image in the tool's result to a provider that takes one there", async () => {
      const model = scripted([
        { toolCall: { name: "look_at_image", input: { path: "frame.png" } } },
        { text: "A red dot." },
      ]);

      const result = await runChatOn(model, spaceRoot, frame, [], "what is it?", {
        imagesInToolResults: true,
      });

      expect(model.doGenerateCalls[1].prompt.at(-1)).toMatchObject({
        role: "tool",
        content: [
          {
            type: "tool-result",
            output: {
              type: "content",
              value: [
                { type: "text", text: "The image `frame.png`:" },
                { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
              ],
            },
          },
        ],
      });
      expect(result.lookedAt).toEqual(["frame.png"]);
    });

    // OpenAI-compatible tool results carry text only.
    it("shows the image in a message after the tool's text to any other provider, once", async () => {
      const model = scripted([
        { toolCall: { name: "look_at_image", input: { path: "frame.png" } } },
        { toolCall: { name: "read_space_file", input: { path: "note.md" } } },
        { text: "A red dot, beside a draft." },
      ]);

      const result = await runChatOn(model, spaceRoot, frame, [], "what is it?");

      const afterLook = model.doGenerateCalls[1].prompt;
      expect(afterLook.at(-2)).toMatchObject({
        role: "tool",
        content: [{ output: { type: "text", value: "The image `frame.png` follows, in the next message." } }],
      });
      expect(afterLook.at(-1)).toMatchObject({
        role: "user",
        content: [
          { type: "text", text: "The image `frame.png` you asked to look at:" },
          { type: "file", mediaType: "image/png" },
        ],
      });
      const imageMessages = model.doGenerateCalls[2].prompt.filter(
        (message) => message.role === "user" && JSON.stringify(message).includes("you asked to look at"),
      );
      expect(imageMessages).toHaveLength(1);
      expect(result.lookedAt).toEqual(["frame.png"]);
    });

    it("refuses an image the writer doesn't have on screen", async () => {
      await writeFile(path.join(spaceRoot, "other.png"), PNG);
      const model = scripted([
        { toolCall: { name: "look_at_image", input: { path: "other.png" } } },
        { text: "I can't see that one." },
      ]);

      const result = await runChatOn(model, spaceRoot, frame, [], "and other.png?");

      expect(JSON.stringify(model.doGenerateCalls[1].prompt.at(-1))).toContain(
        "`other.png` isn't an image the writer has on screen.",
      );
      expect(result.lookedAt).toBeUndefined();
    });

    it("reads a hidden image as one that isn't there", async () => {
      await mkdir(path.join(spaceRoot, ".cache"));
      const hiddenPath = path.join(spaceRoot, ".cache", "frame.png");
      await writeFile(hiddenPath, PNG);
      const model = scripted([
        { toolCall: { name: "look_at_image", input: { path: ".cache/frame.png" } } },
        { text: "Nothing there." },
      ]);
      const hidden: EditorContext = { view: "image", filePath: hiddenPath, path: ".cache/frame.png" };

      const result = await runChatOn(model, spaceRoot, hidden, [], "what is it?", { imagesInToolResults: true });

      expect(JSON.stringify(model.doGenerateCalls[1].prompt.at(-1))).toContain("ENOENT: no such file or directory");
      expect(result.lookedAt).toBeUndefined();
    });

    it("names the image when the model refuses the request it went in", async () => {
      const model = scripted([
        { toolCall: { name: "look_at_image", input: { path: "frame.png" } } },
        {
          before: async () => {
            throw new APICallError({
              message: "Model does not support images.",
              url: "http://localhost:1234/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 400,
            });
          },
        },
      ]);

      await expect(runChatOn(model, spaceRoot, frame, [], "what is it?")).rejects.toThrow(
        'This model couldn\'t take the image "frame.png": Model does not support images.',
      );
    });

    describe("from a library", () => {
      let configDir: string;
      let library: string;

      // A library's folder sits in the config, so this points
      // PRAGMA_CONFIG_DIR at a throwaway config naming one.
      beforeEach(async () => {
        configDir = isolateConfig();
        library = tempDir("pragma-chat-library-");
        giveSpaceLibraries(configDir, spaceRoot, [
          { id: "footage", label: "Footage", path: library, access: "read-only" },
        ]);
        await mkdir(path.join(library, "shots"));
        await writeFile(path.join(library, "shots", "still.png"), PNG);
      });

      it("looks at one by its library path, and nothing else of the library reaches the model", async () => {
        await writeFile(path.join(library, "shots", "README.md"), "# Shot notes\n");
        const still: EditorContext = {
          view: "image",
          filePath: path.join(library, "shots", "still.png"),
          path: "lib:footage/shots/still.png",
        };
        const model = scripted([
          { toolCall: { name: "look_at_image", input: { path: "lib:footage/shots/still.png" } } },
          { text: "A red dot." },
        ]);

        const result = await runChatOn(model, spaceRoot, still, [], "what is it?", { imagesInToolResults: true });

        const system = String(model.doGenerateCalls[0].prompt[0].content);
        expect(system).toContain("the image `lib:footage/shots/still.png` open in a read-only preview");
        expect(system).toContain("It's in a library, which your other tools can't reach.");
        expect(system).not.toContain("Shot notes");
        expect(model.doGenerateCalls[1].prompt.at(-1)).toMatchObject({
          role: "tool",
          content: [
            {
              output: {
                type: "content",
                value: [
                  { type: "text", text: "The image `lib:footage/shots/still.png`:" },
                  { type: "file", mediaType: "image/png", data: { type: "data", data: PNG } },
                ],
              },
            },
          ],
        });
        expect(result.lookedAt).toEqual(["lib:footage/shots/still.png"]);
      });

      it("reads a hidden one as one that isn't there", async () => {
        await mkdir(path.join(library, ".cache"));
        await writeFile(path.join(library, ".cache", "still.png"), PNG);
        const hidden: EditorContext = {
          view: "image",
          filePath: path.join(library, ".cache", "still.png"),
          path: "lib:footage/.cache/still.png",
        };
        const model = scripted([
          { toolCall: { name: "look_at_image", input: { path: "lib:footage/.cache/still.png" } } },
          { text: "Nothing there." },
        ]);

        const result = await runChatOn(model, spaceRoot, hidden, [], "what is it?", { imagesInToolResults: true });

        expect(JSON.stringify(model.doGenerateCalls[1].prompt.at(-1))).toContain("ENOENT: no such file or directory");
        expect(result.lookedAt).toBeUndefined();
      });

      it("looks at one the focused pane points at, with no file of its own open", async () => {
        const selected: SelectedFile = {
          filePath: path.join(library, "shots", "still.png"),
          path: "lib:footage/shots/still.png",
          previewing: true,
        };
        const model = scripted([
          { toolCall: { name: "look_at_image", input: { path: "lib:footage/shots/still.png" } } },
          { text: "A red dot." },
        ]);

        const result = await runChatOn(model, spaceRoot, { view: "none" }, [], "what is it?", {
          selected,
          imagesInToolResults: true,
        });

        const system = String(model.doGenerateCalls[0].prompt[0].content);
        expect(system).toContain("The writer is previewing the image `lib:footage/shots/still.png`.");
        expect(system).toContain("It's in a library, which your other tools can't reach.");
        expect(result.lookedAt).toEqual(["lib:footage/shots/still.png"]);
      });
    });
  });

  // A gallery's selected tile, or the file a preview shows over its pane.
  describe("a file the focused pane points at", () => {
    const at = (relative: string, previewing = false): SelectedFile => ({
      filePath: path.join(spaceRoot, ...relative.split("/")),
      path: relative,
      previewing,
    });
    const turnWith = async (selected: SelectedFile, context: EditorContext = { view: "none" }) => {
      const model = scripted([{ text: "ok" }]);
      await runChatOn(model, spaceRoot, context, [], "hi", { selected });
      return { system: String(model.doGenerateCalls[0].prompt[0].content), tools: offeredTools(model) };
    };

    it("names a selected image, previewed or not, and lets look_at_image see it", async () => {
      await mkdir(path.join(spaceRoot, "stills"));
      await writeFile(path.join(spaceRoot, "stills", "a.png"), PNG);
      const gallery: EditorContext = { view: "folder", dirPath: path.join(spaceRoot, "stills") };

      const selected = await turnWith(at("stills/a.png"), gallery);
      expect(selected.system).toContain("The writer has selected the image `stills/a.png`.");
      expect(selected.system).toContain(
        "You know its name and folder, not what it depicts: call look_at_image only when the answer depends on " +
          "what it depicts, and then without asking first. This may or may not be what they're asking about.",
      );
      expect(selected.tools).toContain("look_at_image");

      const model = scripted([
        { toolCall: { name: "look_at_image", input: { path: "stills/a.png" } } },
        { text: "A red dot." },
      ]);
      const result = await runChatOn(model, spaceRoot, gallery, [], "what is it?", {
        selected: at("stills/a.png", true),
        imagesInToolResults: true,
      });
      expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain(
        "The writer is previewing the image `stills/a.png`.",
      );
      expect(model.doGenerateCalls[1].prompt.at(-1)).toMatchObject({
        role: "tool",
        content: [{ output: { type: "content", value: [{ text: "The image `stills/a.png`:" }, { type: "file" }] } }],
      });
      expect(result.lookedAt).toEqual(["stills/a.png"]);
    });

    it("names any other file by what the copilot can do with it, and offers no look", async () => {
      await mkdir(path.join(spaceRoot, "stills"));
      await writeFile(path.join(spaceRoot, "draft.md"), "# Draft\n");
      await writeFile(path.join(spaceRoot, "secret.md"), "---\nvisibility: private\n---\nThe hidden plot.\n");
      await writeFile(path.join(spaceRoot, "take.mp4"), "");
      await writeFile(path.join(spaceRoot, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      const expected: Array<[string, string]> = [
        ["stills", "The writer has selected the folder `stills`."],
        ["draft.md", "the file `draft.md`. Its link is [[draft]]. Read it with read_space_file when answering"],
        ["secret.md", "the file `secret.md`. Its link is [[secret]]. It's marked `visibility: private`"],
        ["take.mp4", "The writer has selected the video `take.mp4`, which you can't read."],
        ["logo.svg", "the image `logo.svg`. Its link is [[logo.svg]]. It's a vector image: read_space_file reads"],
      ];
      for (const [relative, sentence] of expected) {
        const { system, tools } = await turnWith(at(relative));
        expect(system, relative).toContain(sentence);
        expect(system, relative).not.toContain("The hidden plot.");
        expect(tools, relative).not.toContain("look_at_image");
      }
    });

    it("names nothing for a file gone since the pane pointed at it", async () => {
      const { system, tools } = await turnWith(at("gone.png", true));
      expect(system).not.toContain("gone.png");
      expect(tools).not.toContain("look_at_image");
    });
  });

  it("answers with no file open", async () => {
    const model = scripted([{ text: "ok" }]);

    const result = await runChatOn(model, spaceRoot, { view: "none" }, [], "hi");

    expect(result.reply).toBe("ok");
    expect(offeredTools(model)).not.toContain("read_current_document");
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("no file open in the editor");
  });

  it("withholds the document tools when the open document is private", async () => {
    const model = scripted([{ text: "ok" }]);
    await runChatOn(model, spaceRoot, { view: "document", filePath: path.join(spaceRoot, "secret.md") }, [], "hi");
    expect(offeredTools(model)).not.toContain("read_current_document");
    expect(offeredTools(model)).not.toContain("edit_current_document");
  });

  it("runs the tool loop: an edit to the open document is proposed, not written", async () => {
    const model = scripted([
      { toolCall: { name: "read_current_document", input: {} } },
      { toolCall: { name: "edit_current_document", input: { newContent: "# Draft\n\nMore.\n" } } },
      { text: "Added a line." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "add a line");

    expect(result.reply).toBe("Added a line.");
    expect(result.currentDocumentEdit).toEqual({
      path: "note.md",
      before: "# Draft\n",
      newContent: "# Draft\n\nMore.\n",
      revision: revisionOf("# Draft\n"),
    });
    expect(await readFile(notePath, "utf8")).toBe("# Draft\n");
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("bases the proposal on the model's last full read, not on the file as it is by then", async () => {
    const model = scripted([
      { toolCall: { name: "read_current_document", input: {} } },
      {
        // The writer's autosave lands between the model's read and its edit.
        before: () => writeFile(notePath, "# Draft\n\nTyped meanwhile.\n", "utf8"),
        toolCall: { name: "edit_current_document", input: { newContent: "# Draft\n\nMore.\n" } },
      },
      { text: "Added a line." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "add a line");

    expect(result.currentDocumentEdit?.before).toBe("# Draft\n");
  });

  it("reads the file for the proposal's base when the model edits without a full read", async () => {
    const model = scripted([
      { toolCall: { name: "edit_current_document", input: { newContent: "# Draft\n\nMore.\n" } } },
      { text: "Added a line." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "add a line");

    expect(result.currentDocumentEdit?.before).toBe("# Draft\n");
  });

  it("records a create proposal without writing anything", async () => {
    const model = scripted([
      { toolCall: { name: "propose_create_document", input: { parentPath: "", name: "aria.md", type: "file" } } },
      { text: "Proposed aria.md." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "new note");

    expect(result.proposedDocument).toEqual({ parentPath: "", name: "aria.md", type: "file" });
    expect(result.currentDocumentEdit).toBeUndefined();
    await expect(readFile(path.join(spaceRoot, "aria.md"), "utf8")).rejects.toThrow();
  });

  it("quotes a short selection into the prompt, named by its range in whole-file numbering", async () => {
    await writeFile(notePath, "# Draft\n\nfirst\nsecond\nthird\n", "utf8");
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 3, startColumn: 1, endLine: 4, endColumn: 7 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "tighten this");

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).toContain("The writer has `note.md:3:1-4:7` selected:\n\n```\nfirst\nsecond\n```");
    expect(system).not.toContain("third");
    expect(system).not.toContain("It's part of line");
  });

  it("quotes just the highlighted words of a line, and the whole line for context", async () => {
    await writeFile(notePath, "# Draft\n\nthese install methods still work\n", "utf8");
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 3, startColumn: 7, endLine: 3, endColumn: 22 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "the right words?");

    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain(
      "The writer has `note.md:3:7-3:22` selected:\n\n```\ninstall methods\n```\n\n" +
        "It's part of line 3:\n\n```\nthese install methods still work\n```\n\n" +
        "This may or may not be what they're asking about.",
    );
  });

  it("leaves out the line around a selection when the two won't both fit", async () => {
    await writeFile(notePath, `# Draft\n${"a".repeat(2000)} word\n`, "utf8");
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 2, startColumn: 2002, endLine: 2, endColumn: 2006 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "define this");

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).toContain("`note.md:2:2002-2:2006` selected:\n\n```\nword\n```");
    expect(system).not.toContain("It's part of line");
  });

  it("counts a CRLF file's lines and columns as the editor does", async () => {
    await writeFile(notePath, "# Draft\r\n\r\nfirst line\r\nsecond line\r\n", "utf8");
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 3, startColumn: 7, endLine: 4, endColumn: 7 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "hi");

    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("```\nline\nsecond\n```");
  });

  it("names a long selection's range instead of quoting it", async () => {
    await writeFile(notePath, `# Draft\n${"a".repeat(3000)}\n`, "utf8");
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 3001 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "summarize this");

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).toContain("`note.md:2:1-2:3001` selected, too much to quote here");
    expect(system).toContain("read_current_document with startLine 2 and endLine 2");
    expect(system).not.toContain("a".repeat(3000));
  });

  it("withholds the selection when the open document is private", async () => {
    const model = scripted([{ text: "ok" }]);

    await runChatOn(
      model,
      spaceRoot,
      {
        view: "document",
        filePath: path.join(spaceRoot, "secret.md"),
        selection: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 7 },
      },
      [],
      "what is this",
    );

    const system = String(model.doGenerateCalls[0].prompt[0].content);
    expect(system).not.toContain("hidden");
    expect(system).not.toContain("selected");
  });

  it("drops a selection whose range is past the end of the file", async () => {
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 40, startColumn: 1, endLine: 50, endColumn: 1 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "hi");

    expect(String(model.doGenerateCalls[0].prompt[0].content)).not.toContain("selected");
  });

  it("drops a selection whose columns run past its line", async () => {
    const model = scripted([{ text: "ok" }]);
    const selection = { startLine: 1, startColumn: 3, endLine: 1, endColumn: 40 };

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath, selection }, [], "hi");

    expect(String(model.doGenerateCalls[0].prompt[0].content)).not.toContain("selected");
  });

  // The Flow's file as its pane last saved it, and the prompt one turn
  // gets with one of its nodes selected.
  async function promptWithNodeSelected(graph: FlowGraph, node: string, metadata?: MetadataEntry[]): Promise<string> {
    const flowPath = path.join(spaceRoot, "pipeline.flow.html");
    await writeFile(flowPath, serializeFlowFile({ version: "1.0", graph, metadata }), "utf8");
    const model = scripted([{ text: "ok" }]);
    await runChatOn(model, spaceRoot, { view: "flow", filePath: flowPath, node }, [], "what does this do?");
    return String(model.doGenerateCalls[0].prompt[0].content);
  }

  it("quotes the node selected on a Flow's canvas without its layout, with its wires and spec section", async () => {
    const system = await promptWithNodeSelected(
      {
        nodes: [
          {
            id: "prompt-1",
            type: "prompt",
            position: { x: 40, y: 80 },
            size: { width: 300, height: 200 },
            color: "#123456",
            collapsed: true,
            label: "Opening",
            config: { text: "Write a hook" },
          },
          { id: "showText-2", type: "showText", position: { x: 400, y: 0 }, config: {} },
        ],
        edges: [{ id: "e1", source: "prompt-1", sourcePort: "text", target: "showText-2", targetPort: "text" }],
      },
      "prompt-1",
    );

    expect(system).toContain(
      'The writer has selected the Prompt node `prompt-1` on the canvas, labelled "Opening":\n\n' +
        '```json\n{"id":"prompt-1","type":"prompt","config":{"text":"Write a hook"},"label":"Opening"}\n```\n\n' +
        "Nothing is wired in. Wired out: `text` → `showText-2.text`.\n\n" +
        "Its type's rules are in the spec section `prompt`.\n\n" +
        "This may or may not be what they're asking about.",
    );
    expect(system).not.toContain("#123456");
  });

  it("names a selected node too long to quote instead of quoting it", async () => {
    const at = { x: 0, y: 0 };
    const long = "a".repeat(3000);
    const system = await promptWithNodeSelected(
      { nodes: [{ id: "prompt-1", type: "prompt", position: at, config: { text: long } }], edges: [] },
      "prompt-1",
    );

    expect(system).toContain(
      "The writer has selected the Prompt node `prompt-1` on the canvas. It's too long to quote here: " +
        "read it in the Flow's file with read_space_file when the answer needs it.\n\nIt has no wires.",
    );
    expect(system).not.toContain(long);
  });

  it("withholds the selected node of a private Flow", async () => {
    const at = { x: 0, y: 0 };
    const system = await promptWithNodeSelected(
      {
        nodes: [{ id: "prompt-1", type: "prompt", position: at, config: { text: "the private word is quince" } }],
        edges: [],
      },
      "prompt-1",
      [{ key: "visibility", values: ["private"] }],
    );

    expect(system).toContain("marked `visibility: private`");
    expect(system).not.toContain("quince");
    expect(system).not.toContain("The writer has selected");
  });

  // Its save failed, or the Flow on disk was changed under the pane.
  it("drops a selected node the saved Flow doesn't have", async () => {
    const at = { x: 0, y: 0 };
    const system = await promptWithNodeSelected(
      { nodes: [{ id: "prompt-1", type: "prompt", position: at, config: {} }], edges: [] },
      "prompt-9",
    );

    expect(system).not.toContain("The writer has selected");
  });

  it("points an Applet node to its spec section, and names a type this version lacks", async () => {
    const at = { x: 0, y: 0 };
    const graph: FlowGraph = {
      nodes: [
        { id: "applet-1", type: "applet", position: at, config: { path: "tools/dials.applet.html" } },
        { id: "old-1", type: "retired", position: at, config: {} },
      ],
      edges: [{ id: "e1", source: "old-1", sourcePort: "out", target: "applet-1", targetPort: "in" }],
    };

    const applet = await promptWithNodeSelected(graph, "applet-1");
    expect(applet).toContain("The writer has selected the Applet node `applet-1` on the canvas:");
    expect(applet).toContain("Wired in: `old-1.out` → `in`. Nothing is wired out.");
    expect(applet).toContain("Its type's rules are in the spec section `applet-nodes`.");

    const retired = await promptWithNodeSelected(graph, "old-1");
    expect(retired).toContain(
      "The writer has selected the node `old-1` on the canvas, of type `retired`, which this version of " +
        "Pragma doesn't have:",
    );
    expect(retired).not.toContain("Its type's rules");
  });

  it("reads back just the requested line range", async () => {
    await writeFile(notePath, "# Draft\n\nfirst\nsecond\nthird\n", "utf8");
    const model = scripted([
      { toolCall: { name: "read_current_document", input: { startLine: 3, endLine: 4 } } },
      { text: "done" },
    ]);

    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "read lines 3-4");

    const toolResult = model.doGenerateCalls[1].prompt.at(-1);
    expect(JSON.stringify(toolResult)).toContain("first\\nsecond");
    expect(JSON.stringify(toolResult)).not.toContain("third");
  });

  it("carries the history ahead of the new turn", async () => {
    const model = scripted([{ text: "ok" }]);
    await runChatOn(
      model,
      spaceRoot,
      { view: "document", filePath: notePath },
      [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
      ],
      "now",
    );
    const roles = model.doGenerateCalls[0].prompt.map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });

  it("offers MCP tools under their namespaced names, describes them, and closes the connection", async () => {
    const close = vi.fn(async () => {});
    const connect: McpConnector = async () => ({
      tools: {
        search: tool({
          description: "Search issues",
          inputSchema: z.object({ q: z.string() }),
          execute: async ({ q }) => `issue for ${q}`,
        }),
      },
      close,
    });
    const model = scripted([{ toolCall: { name: "mcp_linear_search", input: { q: "aria" } } }, { text: "Found it." }]);
    const linear: ResolvedMcpServer = { id: "linear", label: "Linear", url: "http://x", copilot: true, flows: false };

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "look", {
      external: { servers: [linear], connect },
    });

    expect(result.reply).toBe("Found it.");
    expect(offeredTools(model)).toContain("mcp_linear_search");
    const system = model.doGenerateCalls[0].prompt[0];
    expect(system.role).toBe("system");
    expect(String(system.content)).toContain("External tools");
    expect(String(system.content)).toContain("`mcp_linear_search`: Search issues");
    // The tool result reached the second step.
    const secondPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(secondPrompt).toContain("issue for aria");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("notes an unreachable MCP server in the prompt and still answers", async () => {
    const connect: McpConnector = async () => {
      throw new Error("ECONNREFUSED");
    };
    const model = scripted([{ text: "ok" }]);
    const down: ResolvedMcpServer = { id: "down", label: "Down", url: "http://x", copilot: true, flows: false };

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "hi", {
      external: { servers: [down], connect },
    });

    expect(result.reply).toBe("ok");
    expect(offeredTools(model).some((name) => name.startsWith("mcp_"))).toBe(false);
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("`down` couldn't be reached");
  });

  it("closes MCP connections when the provider call throws", async () => {
    const close = vi.fn(async () => {});
    const connect: McpConnector = async () => ({ tools: {}, close });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const srv: ResolvedMcpServer = { id: "s", label: "S", url: "http://x", copilot: true, flows: false };
    await expect(
      runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "hi", {
        external: { servers: [srv], connect },
      }),
    ).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("in Viewing offers no tool that changes a file, and says why", async () => {
    const model = scripted([{ text: "ok" }]);
    await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "hi", { mode: "viewing" });

    const offered = offeredTools(model);
    expect(offered).toEqual(expect.arrayContaining(["read_current_document", "read_space_file"]));
    for (const name of ["edit_current_document", "propose_create_document", "propose_edit_file"]) {
      expect(offered).not.toContain(name);
    }
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("Viewing mode");
  });

  it("in Viewing keeps only the MCP tools that claim to change nothing", async () => {
    const connect: McpConnector = async () => ({
      tools: {
        search: tool({
          description: "Search the web",
          inputSchema: z.object({ q: z.string() }),
          metadata: { annotations: { readOnlyHint: true } },
          execute: async () => "results",
        }),
        post: tool({
          description: "Post a message",
          inputSchema: z.object({ text: z.string() }),
          execute: async () => "posted",
        }),
      },
      close: async () => {},
    });
    const web: ResolvedMcpServer = { id: "web", label: "Web", url: "http://x", copilot: true, flows: false };

    const viewing = scripted([{ text: "ok" }]);
    await runChatOn(viewing, spaceRoot, { view: "none" }, [], "hi", {
      mode: "viewing",
      external: { servers: [web], connect },
    });
    expect(offeredTools(viewing).filter((name) => name.startsWith("mcp_"))).toEqual(["mcp_web_search"]);
    expect(String(viewing.doGenerateCalls[0].prompt[0].content)).not.toContain("mcp_web_post");

    const suggesting = scripted([{ text: "ok" }]);
    await runChatOn(suggesting, spaceRoot, { view: "none" }, [], "hi", { external: { servers: [web], connect } });
    expect(
      offeredTools(suggesting)
        .filter((name) => name.startsWith("mcp_"))
        .sort(),
    ).toEqual(["mcp_web_post", "mcp_web_search"]);
  });

  it("in Editing records the same changes, telling the model they're already made", async () => {
    const model = scripted([
      { toolCall: { name: "read_current_document", input: {} } },
      { toolCall: { name: "edit_current_document", input: { newContent: "# Draft\n\nMore.\n" } } },
      { text: "Added a line." },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "add a line", {
      mode: "editing",
    });

    expect(result.currentDocumentEdit?.newContent).toBe("# Draft\n\nMore.\n");
    expect(await readFile(notePath, "utf8")).toBe("# Draft\n");
    expect(String(model.doGenerateCalls[0].prompt[0].content)).toContain("Editing mode");
    expect(JSON.stringify(model.doGenerateCalls[2].prompt.at(-1))).toContain("Changes applied to the document");
  });

  it("records the revision of the file a proposed edit was read from", async () => {
    await writeFile(path.join(spaceRoot, "other.md"), "old\n", "utf8");
    const model = scripted([
      { toolCall: { name: "propose_edit_file", input: { path: "other.md", newContent: "new\n" } } },
      { text: "done" },
    ]);

    const result = await runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "fix it");

    expect(result.proposedEdit).toEqual({
      path: "other.md",
      before: "old\n",
      newContent: "new\n",
      revision: revisionOf("old\n"),
    });
  });

  // runChat names the provider, which this loop is never told.
  it("lets a provider's 401 through unchanged", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "bad key", url: "https://x", requestBodyValues: {}, statusCode: 401 });
      },
    });
    await expect(
      runChatOn(model, spaceRoot, { view: "document", filePath: notePath }, [], "hi"),
    ).rejects.toBeInstanceOf(APICallError);
  });
});

describe("runChat", () => {
  let configDir: string;

  // Which wording the refusal takes depends on the providers config.json
  // lists, so this points PRAGMA_CONFIG_DIR at a throwaway one.
  beforeEach(() => {
    configDir = isolateConfig();
  });

  const refusal = () =>
    runChat("/nowhere", { view: "folder", dirPath: "/nowhere" }, [], "hi", undefined).catch((error: unknown) => error);

  it("refuses a turn with no model and no default, naming the default as the fix", async () => {
    const modelProviders = [{ id: "anthropic", kind: "anthropic", textModels: ["claude-sonnet-5"] }];
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ modelProviders }));
    const refused = await refusal();
    expect((refused as Error).message).toBe("No model selected. Pick one, or set a default text model in Settings.");
    expect(setupNeedOf(refused)).toEqual({ kind: "defaultModel", output: "text" });
  });

  it("says to add a provider while none offers a text model, as there is nothing to pick", async () => {
    const refused = await refusal();
    expect((refused as Error).message).toBe("No models yet. Add a provider in Settings.");
    expect(setupNeedOf(refused)).toEqual({ kind: "defaultModel", output: "text" });
  });
});
