# Architecture

Pragma is a TypeScript application built around a filesystem space. Its hosts share protocol rules and services. Git provides history and sync; the host owns identity, permissions, credentials and preferences.

This document defines implementation boundaries. Formats and capability contracts belong in the [protocol](protocol.md) and [Flow node catalog](flow-nodes.md).

- [Runtime and hosting](#runtime-and-hosting)
- [Module boundaries](#module-boundaries)
- [Space identity and state ownership](#space-identity-and-state-ownership)
- [Document writes and reference integrity](#document-writes-and-reference-integrity)
- [Workspace and UI ownership](#workspace-and-ui-ownership)
- [Flow execution](#flow-execution)
- [Agent integrations](#agent-integrations)
- [Model providers and configuration](#model-providers-and-configuration)
- [Privacy](#privacy)
- [Publishing](#publishing)
- [Visual system](#visual-system)
- [Compatibility](#compatibility)

## Runtime and hosting

The npm package requires Node.js 24+ and git.

### One route layer, four hosts

HTTP hosts serve `src/server/routes.ts`, a Hono app against one space root. Routes construct responses, with one module per resource family. A route catches only the errors that have a status of its own; the app's one error handler answers everything else.

| Host | Runtime contract |
| --- | --- |
| Local (`pragma start`) | Built app over loopback HTTP, without login. Rejects a build older than its inputs. |
| Development (`pragma dev`) | Vite with HMR, loaded only for development and builds. Uses the local server's fixed port; an occupied port fails. |
| Desktop (Electron) | Production server over loopback, gated by a per-launch secret cookie. Space logic goes over HTTP, never direct IPC, except actions that need a native folder picker. A stable port preserves browser settings, with a free-port fallback. |
| Remote access | `pragma start --external-url` behind an HTTPS proxy, with passphrase authentication. One space, one shared git identity, no per-user accounts. See [deployment](deployment.md). |

Routes and the agent endpoint share one `ServedSpace`. Switching replaces routes without restarting the listener or changing the URL.

`pragma run <flow>` executes in process through the sandbox routes' capability enforcement. It consults existing grants and refuses missing ones; only a human at the canvas can create approvals.

### Request and content isolation

Authentication and same-origin checks precede Hono for every `/api/*` request. The `AuthCheck` interface is independent of routing.

- Hosts bind loopback and check `Host`, including for static assets. Only loopback names and the external URL's host are accepted; Origin/Host equality cannot prevent DNS rebinding.
- Only an external-URL host accepts API requests with proxy headers, preventing proxy exposure of unauthenticated local servers.
- Space bytes never execute on the app's origin. Raw-file responses use a sandbox CSP: no scripts, an opaque origin and no external loads.
- Scripted parsers run in opaque-origin frames without network access; the host supplies bytes and data files. No frame's own CSP stops it navigating, so the page's `frame-src` admits only the video embed's player; a new kind of embedded frame is added there.
- Media uses streaming raw-file routes with byte ranges, never text routes. SVG renders through image elements; pixel operations accept only raster images. PDF link messages may open only web or mail URLs in new windows.

### Desktop boundary

The preload bridge is the renderer's only connection to Electron's main process. Its windows display only the app's origin; external navigation and new windows use the system browser.

Opening a space file externally requires trust and a main-process check at handoff; executable types, platform executable extensions and executable files are refused. File-manager reveals remain unrestricted.

macOS menus come from the page's command registry; the main process draws them and returns command selections.

## Module boundaries

**Specialized features are modules.** Registries expose sidebar views, panes, inspector tabs, menus, formats and copilot context. The app works with optional features unregistered. Core may know their keys, but cannot branch on them, carry their wording or depend on their implementation.

Core owns shared file-kind rules; modules own feature behavior, styles and preferences; `src/protocol/` owns interoperable contracts.

**Environment-specific concerns go behind interfaces.** Where the engine touches the filesystem, git, provider auth or secret storage, prefer an interface with a default local implementation over a hardcoded integration, as `AuthCheck`, `ModelProvider` and `CredentialStore` are, and as every host-state store is.

### Frontend layers

Data flows core → services → views; events notify views. Services own separate state slices accessed through their modules. **A view never imports another view.**

| Layer under `web/` | Dependencies | Responsibility |
| --- | --- | --- |
| `lib/` | None | Events, lifecycles, DOM helpers and shared controls. |
| `core/` | Library, protocol types | DOM-free API access, workspace state, tree queries and path resolution. |
| `services/` | Core | Registries, commands, settings, document models and dialogs. |
| `view/` | Services, core | DOM factories with injected dependencies. |
| `chart/` | Protocol | Chart rendering behind one library boundary. |
| `graph/` | Services, core, protocol | Inspector graph behind a three.js boundary, with layout in a worker. |
| `flow/` | Core, charts, protocol | Canvas, App Mode, browser execution environment and toolkit actions. |
| `formats/` | Services, core, top level | Registered formats: language, rendering, styles and preferences. |
| Top level | All layers | Bootstrap and composition across layers. |

**Imperative DOM, no framework.** DOM factories own listeners, subscriptions and children through a `DisposableStore`. CodeMirror and the Flow canvas are wrapped, never re-rendered. Repeatable subtrees use classes, not ids. Document-dependent code takes a group or pane, never a global current document. Derived state, such as the open document's path or model, is read from its source, never stored beside it.

Surfaces reuse shared controls and value renderers, choosing semantic variants and adding layout only. Entry links carry `data-space-path` for previews and navigation. Hover hints use `data-tooltip`; `title` is reserved for a frame's accessible name.

Trees own rooted paths for rows, collapse state, drags and opens; callers never root them again. Only rows near the viewport are on the page, so whether an entry has a row is the tree's to answer, never the DOM's. Drags write and read entries through one shared path module, so a dragged entry is linked, never imported as a duplicate. String-addressed assets live in `web/public/`.

### Protocol, server and packaging

| Module | Responsibility |
| --- | --- |
| `src/protocol/` | Formats, types, path/scope rules, Flow execution, provider interfaces, publishing client and wire contracts. Client-facing parts are isomorphic. |
| `src/server/` | Routes, host adapters and services, with feature modules under `modules/`. |
| `src/config/` | Global configuration and credential storage. |
| `src/cli/` | Space initialization, serving and headless execution. |
| `templates/` | Space scaffold and built-in templates. |

**Each protocol rule has one implementation.** Browser and server share path, scope, matching and resolution rules.

Shipped content stays outside `src/`; packages include templates and both specs. Files shipped beside code resolve from the package root, never module-relative paths.

Ratchets enforce view-import, store-path and protocol-rule boundaries, icon rules, and ceilings on module size, bootstrap mutable state and literal styling. Ceilings only decrease.

## Space identity and state ownership

### Identity belongs to the host

A space's opaque, immutable id lives in global config and keys approvals and API tokens. Labels and paths may change. No identity marker travels with the space for clones or archives to inherit.

The permanent `spaces` registry maps ids to paths, labels and trust. The capped `recentSpaceIds` list controls only the switcher; management enumerates the full registry.

Only a person's folder choice through Electron or local CLI commands can register a space. Remote access requires an existing entry. Moved folders remain unknown until deliberately repointed: a host that adopted unknown paths would turn a moved space into a new one, detaching its approvals and tokens.

For a missing folder, Electron and local servers may choose the most recent surviving registered space or first-run setup. Remote access and headless runs resolve only their configured space. Recovery never registers entries.

**Git runs only in a trusted space:** repository config can execute programs during status or fetch. The host registry records both trust and refusal; no git command runs without trust.

### State follows its owner

| State | Owner and persistence contract |
| --- | --- |
| Portable content | Documents, templates and declarations in the space. `.pragma/` holds only app state every machine opening the space should share, such as bookmarks: never an approval, one machine's view or a cache. |
| Registry/configuration | Host config directory, overridable with `PRAGMA_CONFIG_DIR`. |
| Approvals | Separate host `grants.json`, keyed by space id. |
| Library locations/access | Host registry; space `_libraries.json` names no folder or access. |
| Credentials/sign-ins | Dedicated host records, never config: OS-keychain-encrypted on desktop, owner-only plain files on CLI. Neither reads the other's. |
| Space layout | Host state keyed by space id: tabs, groups, modes, focus, folds and entry layouts. Unreadable layouts reset; absent groups open root `README.md`. |
| Browser preferences | Settings service or format module. Panel dimensions belong to the browser. |
| Document versions | Host history keyed by space id, unavailable to agent/copilot tools. |

Every host-state/cache store has an interface and default file implementation. Only its implementation names config/cache paths; human-edited `config.json` is the exception.

Unparseable registry or grants files are errors, never empty stores, since the next read-modify-write would make that emptiness permanent; only missing files mean first run. Writes replace atomically. Capability checks may deny all on unreadable grants, but recording a grant still refuses the file.

Credentials open only for their consumer and configured endpoint. Updates target the record read; unreadable records are preserved and reported, never treated as absent.

Library ids in `lib:<id>/…` are readable and immutable through renames or remounts. Access permission, not library status, determines editability.

### Derived data and unfinished work

Derived data is rebuildable host cache outside every root. The browser decodes thumbnails; the server keys them by path and version, rejecting changed-source results.

Each root's index trusts content only while modification time, size and inode match. Queries check one file, or refresh and check the whole root for root-wide queries. Links resolve against that listing. A host with other storage installs its own index before anything asks.

Paid jobs are recorded at submission and resume at startup without resubmission. Unless canceled, results save into the approved folder even after the initiating run ends.

## Document writes and reference integrity

### One write doorway

Every create, upload, move, delete and save resolves a rooted path through one server doorway. Unknown roots or access other than `read-write` are refused. Space bookkeeping (folder order, sorts, publishing and link rewrites) rejects libraries regardless of permission.

No `/api/*` route accepts a filesystem path, since remote access serves these routes to other devices. Creation uses the configured base directory; switching requires registration. Arbitrary folder selection/relocation requires Electron's native picker or a library folder already located by that host. Path-free metadata changes use ordinary routes.

Trash stays in the entry's root. Other dot-prefixed writes are confined to server-selected space `.pragma/` paths. Delete requests carry the confirmed choice; changing a setting cannot convert trash into permanent deletion.

### Revisions and shared working copies

Reads return opaque byte-derived revisions; editor saves echo them. Mismatches return 409 without writing or merging; the writer chooses a version. Writes on a human's grant or request remain unconditional. Editor-requested server writes return the next save's revision.

Open copies check revisions alongside tree versions. With no pending edit, changed files reload and deleted files clear their tabs; pending edits face save conflicts. Text reloads map selections, folds and history through the change; other panes remount.

Every server write to a space document preserves replaced text and the write source through `src/server/history.ts`. Class values edit row notes through shared models. Tag and bookmark changes apply one entry to the file as it stands; unparseable files are reported, never overwritten.

### Moves and references

A move repaths tabs and scans documents after renaming to rewrite references: reading the documents themselves, never the document index, resolving paths, excluding code and isolating unreadable-file failures. Responses identify changed paths to prevent stale-buffer overwrites; affected publications enter the publish queue. A bookmark follows its entry through a move or delete.

Rewrites are host-only, unavailable to Applets and Flows. Grant-bound Flow configuration and Applet manifests stay unchanged. Frontmatter rewrites cover only folder references in `AGENTS.md` `pragma:` blocks.

Preset files are not space content: they stay in path resolution, rewrites and agent listings; discovery surfaces omit them unless working among them.

Manual folder order is portable; gallery sorting is host layout until set as the folder default. Order switches retain the manual arrangement.

## Workspace and UI ownership

The header spans rail, sidebar, editor and assistant. Dialogs overlay the frame; login is separate. Registries supply views, panes and inspector tabs. The shell owns placement; contributions own content.

A list that belongs with the space's files, such as its trash, tags or presets, is a section in the Space tree's section stack; a sidebar view is a separate way across the space or the install.

One or two editor groups each own their tabs, pane instances, chrome and viewing modes. Focus determines command targets, inspector content, toolkits and copilot context. A command reaches the palette only by contribution and runs there with no argument, acting on the focused group's active tab. An inspector tab hears each change of the focused tab and is told when it shows and hides, so one that draws continuously stops while hidden.

### Files and views

- Opens replace the focused group's current tab in place, with no preview tab and no modifier-click; only an open of a surface a person returns to, such as "+", a new file, a version from History or Open in new tab, makes a new tab.
- A group has at most one tab per file; historical versions have separate identities. Renames repath tabs; the last group always retains a tab.
- An open may ask for a view, such as an Applet's Edit code; a new view joins an open's options, never a new way to open.
- Document content, metadata and Undo are shared by path; selection, folds and scroll belong to each view.
- Table, Class, Flow and Applet-source panes keep whole-file copies and may occupy only one group. Running Applets save nothing and may appear in both.
- Editing and reading views of the same file synchronize by source line, never relative height. Views in the same mode scroll independently.
- Panes access chrome through their group; a pane's toolbar overflow menu never repeats a control the toolbar shows. Registered formats supply document language, rendering and formatting. Visual formatting preserves stored text; Source mode shows the file as written.
- A format marks each rendered block with the file line it starts on, which synced scrolling reads. Hidden syntax shows where the selection touches it, at Find matches and in proposals, in every format; formatting actions edit the text as written; a type with no format opens as plain text.
- Reading view locks editing. Tables separate value/row editing from schema design.
- Toolkits bind to their originating document and editor. Leaving the document stops the run; moving focus does not. Run-initiated opens use the other group without taking focus.

### Feedback and interaction

Unsupported content stays in the file and becomes a notice, never silently discarded. Notices replace their source's prior notices and feed the Console and every status bar for that file.

API failures carry server messages to the invoking surface. Controls clear outcomes on retry and reveal results. Errors repairable in Settings name and link the requirement. An action that reveals an item in an unexpected place flashes it, with the one shared mark. The Console records consequential work not otherwise shown; it is neither an error fallback nor app-readable state.

Every modal opens through the dialog service, which owns focus, scrims and stacking. Every popover opens through the shared flyout, which owns placement, dismissal and focus return and keeps one open at a time. Escape follows the shared control chain. Pane shortcuts and Undo require pane focus outside text fields. Menus restore focus on closing. Pane-scoped permission dialogs stay within their pane, one per broker. A default shortcut the browser keeps from the page, such as Mod+N, Mod+T or Mod+W, is bound in the desktop app alone.

## Flow execution

The scheduler and node executors belong to `src/protocol/`. Executors import neither DOM nor transport. Environmental operations arrive through the run context, including a `SandboxPort` for capabilities and an image decoder. New environmental needs extend that context.

The port is transport, **not a permission boundary**. The server enforces grants; the canvas prompts people. Headless callers use existing grants only.

Run memory belongs to the host, never the Flow file. The canvas may provide per-Flow recall keyed by node inputs; headless execution provides none.

Run saves first. Every graph edit uses the pane's shared save path; dropping a node without Remove or Undo is refused and reported. Graph Undo tracks human actions in memory per Flow, excluding run outputs and Applet writes.

A standalone Applet runs HTML in an opaque-origin script sandbox with the `pragma` client. Its pane handles sizing, not capability requests, and refuses capability-declaring manifests before mounting. The copilot cannot replace running HTML; its source tab remains editable.

## Agent integrations

### Pragma as an MCP server

External harnesses use Pragma's MCP server to read the space and run permitted Flows. Pragma owns the [tool contract](agent-api.md); harnesses own interaction, models and billing.

### The embedded copilot

The copilot runs a bounded server-side tool loop through the provider interface. Context follows the visible pane. Non-document contexts omit document-scoped tools; the other group's file is named, never quoted automatically. Selections are hints in file coordinates. Only `look_at_image` sends image bytes, for that turn alone; history remains text.

Session chats belong to scopes and stay while their scope is visible. Replies and proposals remain with their originating chat. Project context is the nearest ancestor `README.md`. Module context uses the privacy doorway and size limits; failed contributions are omitted. Every path the copilot is handed comes with the link the protocol's writer makes for it from the space root, so the model copies links rather than writing them; a new tool or context that names a file does the same.

The server's tool list enforces modes: Viewing excludes native proposals and permits only external tools claiming to be read-only; Suggesting offers proposals; Editing applies them on reply.

**Proposals are not document text.** Autosave, publishing and readers see only accepted changes. Acceptance or Editing-mode application uses ordinary write paths and retains Undo. Unreviewed writes carry the model-read revision. Proposals move with human edits; overlaps drop the affected proposal rather than overwrite the writer's words. Each outcome is appended to the last assistant turn, so the model never proposes again against stale text.

The copilot cannot edit beneath an open Flow or Table's working copy in either group. Proposed Flows, Tables, Classes and Applets are validated before display; added problems return to the model. The host fills structural metadata by the panes' rules. Naming a path never grants access.

### The copilot as an MCP client

External MCP servers are separate from Pragma's own server. Off by default, they contribute namespaced tools and connect per turn. Unreachable servers are omitted with a prompt note. **External tools run outside native proposal acceptance**, subject to the turn's mode.

OAuth uses the person's browser and a temporary loopback listener, on desktop and development hosts only. Sign-in takes precedence over a key; saving a key signs out. Refreshes are serialized per server. Server URLs are immutable, and credentials serve only their bound URL.

## Model providers and configuration

Flow generation, Find in context and the copilot share `ModelProvider`. Flow generation has one chokepoint; the others share its resolver, with the copilot owning its loop. Adapters translate provider-neutral text and image blocks.

Providers use AI SDK text/image interfaces; video separates submission from status. Models must be resolved provider instances. SDK bare strings could select its hosted gateway, which Pragma must never contact.

Reference limits and vocabulary come from [model support data](model-support.md). Unsupported effort is rejected; a node's choice moves to the nearest supported level. Failures, including empty replies, preserve SDK error types.

Host configuration applies to browser and headless callers alike. The [README](../README.md#configuration) lists its fields.

- Providers declare ids, kinds, endpoints and separate text/image model lists. Kinds include Anthropic, OpenAI, Google and ChatGPT sign-in. OpenAI-compatible endpoints use a base URL. None is built in.
- `<providerId>/<model>` is explicit; a bare text-model id must match one provider. Image/video references always name a provider or Flow-enabled MCP server, sharing one id namespace.
- Saved keys precede vendor environment variables, which apply only without a custom base URL. Missing required keys fail before requests; local OpenAI-compatible endpoints may be keyless.
- Default models resolve server-side. Calls naming no model fail without a default.
- MCP configuration independently enables copilot tools and Flow adapters. Secrets remain server-side; Settings returns no keys or tokens. A rejected key changes no configuration.

A setting the host acts on is host configuration, such as whether Delete trashes and which files the space lists; any other preference is browser-local under `pragma:`, owned by the settings service or a format module.

## Privacy

`visibility` has three protocol values: `private`, `unlisted` and `public`. Only `private` is enforced, for Markdown, Tables, Classes and Flows: a private file never leaves this machine for a remote model provider, whichever provider that is. Malformed Markdown frontmatter counts as private. The other values create no anonymous access or per-user permissions.

Private content is excluded from model-facing reads, search, ranking, selections, toolkit reads, brokered Flow reads and publishing, even when open. Private document tools are omitted from the copilot. UI search includes private files.

Server model reads pass through one privacy doorway; tools share a reader presenting private or hidden paths as missing. Toolkit reads use an equivalent doorway over live editor state. Search and ranking skip private files rather than abort.

A person may run a private Flow from the canvas or a toolkit, sending its prompts as part of that run. The copilot and agent API cannot list, read or run it.

Libraries carry no `visibility`. Space-wide search, ranking, copilot, agent, publishing and git surfaces must not consume them wholesale. Files leave only when explicitly named by a granted Flow read, `look_at_image` or a published embed. Broader integration requires a privacy boundary.

The exclusion is about the network boundary, not AI as such. A local-only inference path may see private content only where a feature scopes it explicitly, never by loosening the definition. An MCP server the copilot calls is a network destination too: with a remote server configured, a local model does not keep data local.

## Publishing

[Publishing](publishing.md) defines sites, portable configuration and metadata. Every content-changing write performs queue and date bookkeeping through the shared save boundary. Only publish-result write-back is exempt. Deleting published content queues and attempts unpublishing.

Publishers have separate configuration and credentials. Publishing is a native host action with server-held tokens, never a document capability.

## Visual system

Colors, text sizes, radii and stacking order use shared tokens. Dark mode redefines tokens in one block; the theme resolves before first paint. New surfaces introduce no color literals. Semantic levels and value types retain their colors across surfaces; type colors are not user data.

Three blues by role: `--color-accent`, per theme, marks selection and on-states, except a tree's open file and selected rows, which wear the grey `--bg-selected`; `--color-primary` fills a primary action and the menu row under the pointer or keys, and `--color-badge` a count, both one value in both themes. A message takes its level's color: an error `--color-danger`, a warning `--color-warning`, a confirmation `--color-success`, a notice `--color-accent`.

Emphasis steps back in two named levels, *muted* then *faint*, and an accent's quieter form is its `-muted` token; a pale wash behind content is a *tint*, never a muted color. Pragma's logo palette, `--pragma-*`, clears 3:1 on the background tokens in each theme and is read only by stylesheets, through aliases such as a sidebar view's `--view-<id>`; a document never sees it.

Styles use four cascade layers: `base`, `primitives`, `components`, `utilities`. Controls adopt primitive CSS classes; components express only differences. CodeMirror and screenplay editor styles stay unlayered to override CodeMirror's runtime styles.

UI and document text sizes are independent. Prose shares a text-column width across editing and reading views, excluding insets. Screenplays use page zoom and character/line geometry. UI text does not select; content opts in, and single-token values select whole.

App icons are centralized monochrome SVG line art at stroke 1.5 in a 24-unit box, except vendor and designated Pragma marks. Entry icons share a primitive; surfaces control layout, not paint. These rules govern chrome, not document or Applet content.

## Compatibility

From 0.6.0 a release keeps saved data working, in the space and in host records: a change is additive, or it reads or migrates the old shape and the release notes say so. Only derived data and layouts may reset.

- **Fail loudly.** Unknown shapes produce an explicit error, never guessed values, dropped content or silent defaults.
- **Delete completely.** Removing a compatibility path also removes its fields, tests and documentation in the same change.
