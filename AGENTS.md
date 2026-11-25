## Always confirm before implementing

Reacting to a design question — including answering a clarifying question, or stating an opinion ("I think we need X") — is not authorization to start writing code, even if it sounds decisive. If the message still ends in a question ("what do you think?") or isn't a clear imperative ("implement it", "do it", "go ahead", "build it"), treat the design as still open: state the recommendation/trade-off and ask directly whether to implement.

This applies especially when the user answers an AskUserQuestion by choosing "Other" (free text) instead of one of the listed options — that only answers *which approach*, not whether to build it now. Always ask to confirm before implementing in that case.

## Discuss compatibility before building or breaking it

Code that keeps old data or old names working is a design decision, not part of the feature it comes with: reading a superseded file, setting or cache shape, upgrading stored data in place, a fallback for a renamed key or format. Before writing it, label it as compatibility, say what breaks without it, and give the clean-slate version beside it (old data read as unknown, a cache rebuilt, a setting reset) with its cost. Build it only on an explicit yes to that path: a yes to the feature is not one.

Before making a breaking change, raise it through the same process. Explain what would break and who would be affected. Present the clean break alongside an option that preserves compatibility, and spell out what preserving compatibility would cost.

## Keep docs at contract altitude

`docs/` describes contracts and structure, never implementation — the rules are in `docs/README.md`. In practice: do not add a feature walkthrough, element ids, or function names to `docs/architecture.md`; change it only when a module boundary, an invariant, or a cross-cutting rule changes. `docs/protocol.md` names no implementation files outside its "Reference implementation" section. Design plans are kept outside this repo; when a plan's work ships, its surviving decisions move into the spec as rules. `npm run check:docs` must pass.

A sentence earns its place in `docs/architecture.md` when someone building something new (a pane, a sidebar view, a route, anything that writes) must follow it, or when breaking it in one module would break another module or a security or data guarantee. What one surface shows, or does when clicked, belongs in that surface's code and tests. The doc's size cap in `scripts/check-docs.mjs` rises only for a new boundary, invariant or cross-cutting rule, never to make room for a feature.

Ask the user before adding a sentence to `docs/architecture.md` or raising its cap: quote the sentence, say which of the two tests above it meets, and add it only on a yes.

## Keep code comments to the decision and the trap

A code comment states the decision and the trap it guards — the thing a later editor would "fix" without it — in about five lines. A comment that guards several independent traps (`#editor .cm-gutters`) may use one short paragraph per trap; that is the ceiling, not the norm. The change's "why" — what was tried, what it replaced — goes in the commit body (`docs/README.md`, rule 4), not beside the code.

A comment never carries:

- the story of what the code looked like before, or a "currently", "today", "for now" or "yet" qualifier on what the code does;
- an explanation of how the language itself works;
- a restatement of what the selector or identifier already says;
- a function name. A file name only as a pointer to where the trap is enforced;
- a citation of a plan doc. Plans are kept outside this repo and deleted when their work ships, so a comment carries its own "why" or cites a permanent doc (`architecture.md`, `protocol.md`).

Doc comments on exported types and protocol definitions follow the same rule; a contract that needs more than five lines belongs in `docs/protocol.md`.

`npm run check:docs` ratchets two counts — comment blocks with a paragraph over five lines or more than three paragraphs, and comment lines narrating history — and both only go down. Split independent traps into paragraphs rather than cramming them into one. `node scripts/check-docs.mjs --comments` lists every hit.

## Keep the template space in sync

`templates/space/` (scaffolded by `pragma init`, `pragma start`'s first-run setup, the Manage Spaces modal, and Electron's create-space flow — see `scaffoldSpace.ts`) ships worked examples of Pragma's document kinds, including `projects/getting-started/`'s Table + Flow pair. When changing logic that Flows, Applets or Tables depend on — node types, the Applet manifest, the `.table.html` format, the `pragma` client surface — check whether the template space's example files still reflect that behavior, and update them in the same change rather than letting them drift out of sync with what they're meant to demonstrate.

## Keep scratch files out of the tree

Throwaway files (screenshots, comps, previews, one-off scripts) go in the system temp directory, or, when one must live under the repo, in your agent's own folder that `.gitignore` already lists: Node only finds `node_modules` for a script inside the repo. Never leave one anywhere else in the working tree.
