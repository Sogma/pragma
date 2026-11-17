# Documentation

The protocol defines Pragma's shared contract: what documents mean, how tools compose, and what authority an action requires. The code is the source of truth for the reference implementation. These docs describe the formats another implementation must match, the boundaries and rules that constrain this one, and the public contracts for configuring and operating it.

For installation and a first project, start with [Get started](../README.md#get-started).

## Formats and interoperability

- [Protocol](protocol.md) — document kinds and formats, capabilities and grants, the `pragma` client, resolution rules, and Flows.
- [Flow nodes](flow-nodes.md) — the built-in node types: each one's ports, configuration, capability, and execution rules.

## Configuration and operation

- [Configuration](../README.md#configuration) — provider settings, credentials, model defaults, MCP servers, and known spaces.
- [Agent API](agent-api.md) — connecting MCP clients to a space: enabling the endpoint, tokens, and available tools.
- [Publishing](publishing.md) — sites, the space-side files and frontmatter fields that support them, and the publishing process.
- [Deployment](deployment.md) — remote access through a persistent service and an HTTPS proxy.

## Implementation and maintenance

- [Architecture](architecture.md) — hosts and request isolation, module boundaries, space identity and state ownership, document writes, workspace and UI ownership, Flow execution, agent integrations, model providers, privacy, and the visual system.
- [Model support](model-support.md) — model reference limits and terminology, their sources, and how to keep them accurate.
- [Documentation rules](#documentation-rules) — what belongs in these docs and how to keep them small and consistent.

## Documentation rules

1. **Contracts and structure, not implementation.** A doc says what a format is, what the rules are, and which module owns what. It never narrates what a function does, which element a feature uses, or how a handler is wired. That is a code comment's job.
2. **The spec names no implementation files** outside `protocol.md`'s final "Reference implementation" section. The spec is `protocol.md` and its Flow node catalog, `flow-nodes.md`; every sentence in either should still be true if Pragma were reimplemented in another language.
3. **`architecture.md` changes only when a module boundary, an invariant, or a cross-cutting rule changes.** Shipping a feature does not, by itself, require a doc change.
4. **Rationale lives at the point of use.** A local "why" goes in a code comment beside the code. A change's "why" goes in the commit body. A decision that constrains future work goes into the relevant spec section as a rule, not as a story.
5. **Plans live outside the repo.** A design is worked out in a plan kept elsewhere while it is open. When the work ships, the decisions that still constrain the design move into the spec or architecture doc as current-state rules.
6. **No history in current-state docs.** State the rules that apply: no "previously", "used to", "superseded", dated entries, or post-mortems.
7. **Every reference must resolve.** `npm run check:docs` (also a CI step, `scripts/check-docs.mjs`) verifies that cited doc paths and sections exist, that every repo path a doc cites is tracked by git, that the spec stays implementation-free, that current-state docs carry no history narration, and that each doc stays under its size limit.
8. **Pragma in prose, `pragma` in code.** Capitalize the name wherever it is written for a reader: docs, templates, and the app's own messages. Lowercase `pragma` is code: the command, the package name, the `pragma` client object, and paths and keys such as `.pragma/` and `pragma:`. Class, the document kind, follows the same rule: Class in prose, `class` in code. Write "a CSS class" wherever a doc or comment could otherwise be read as naming the kind.
9. **The spec is read by models too.** Pragma ships both spec documents, and the copilot and agent API serve them a section at a time by heading anchor. Each section must make sense read alone and link to any other section it relies on. Each anchor names one heading across the two documents.
10. **`flow-nodes.md` is checked against the node registry.** A unit test compares each entry's category, label, ports, config keys, capability, and action with the code. Keep the shared form: a port as `` `id: type` ``, a numbered run as `` `image_1`–`image_30: image` ``, and further detail in parentheses after it. The rules an entry states in prose remain a reviewer's to check.
