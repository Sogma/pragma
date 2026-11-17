# Protocol

Pragma's protocol defines document formats, path and context resolution, the `pragma` client, execution, and authority across independent hosts. The [Flow node catalog](flow-nodes.md) is part of the same contract. Every statement in either should hold for a second implementation written from scratch.

Sections specify required behavior, defaults, choices, and refusals. Examples illustrate storage. [Reference implementation](#reference-implementation) maps Pragma's own source; [Architecture](architecture.md) describes its boundaries.

Copyright © 2026 SGM DevNet LLC and contributors. This document and the Flow node catalog are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and their examples are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

| Part | Contract |
|---|---|
| [Scope and foundations](#scope-and-foundations) | Document identity, portable tools, host state, and model independence |
| [Shared document rules](#shared-document-rules) | Safe writes, names, frontmatter, titles, descriptions, tags, and folder order |
| [Addressing and context](#addressing-and-context) | Spaces and libraries, links, scopes, project context, and templates |
| [Document formats](#document-formats) | HTML storage, Text, Tables, Classes, Applets, and Flows |
| [Execution and authority](#execution-and-authority) | Grants, capability digests, wired access, execution, toolkits, and document writes |
| [Reference implementation](#reference-implementation) | Configuration choices and the source map for Pragma's own host |

## Scope and foundations

The shared model consists of [document kinds](#document-kinds), [portable tools](#tools-live-in-the-space-consent-does-not), and [host-owned state](#space-content-and-host-state). [Text interpretation](#blind-to-document-structure), [model selection](#blind-to-the-provider), and [action surfaces](#kind-specific-action-surfaces) define the boundaries hosts share.

### Document kinds

A **space** is a directory tree containing the work and the tools that act on it. A **library** is another root declared by the space and located by the host; its addressing and boundaries are defined in [Addresses and libraries](#addresses-and-libraries).

**Files, documents and notes.** Anything in a space or library is a **file**: a **document** when of a kind below, **media** when an image, video or PDF. A Fountain text document is a **screenplay**, any other a **note**.

A file's **document kind** is decided by extension alone, in any case, never by frontmatter or any in-file marker. Compound suffixes are matched whole (`.table.html`, not the last extension segment).

| Kind | Extension | Storage | Editable surface |
|---|---|---|---|
| Text | `.md`, `.fountain`, … | plain text | text editor |
| Table | `.table.html` | HTML | host-rendered grid |
| Class | `.class.html` | HTML | host-rendered views of its rows |
| Applet | `.applet.html` | HTML + embedded manifest | the Applet's own sandboxed markup |
| Flow | `.flow.html` | HTML + embedded graph | host-rendered node-graph canvas |

### Document identity

A document is named by its path, and no kind gives it an id of its own. A host that keeps state about a document keys it by that path, as [grants](#grant-storage) do.

### Tools live in the space; consent does not

A tool, an Applet or Flow, is a space document in the same directory tree and format family as its data, read and saved through the same document path. There is no external tool directory or install step. Attachments resolve through space documents: [Classes](#classes), Flow paths, and Applet references, never host configuration. Every persistent tool effect is a file in the space; no tool has a sealed private store.

A tool can be written by anyone, including a model, so its file's presence grants no trust. A human approves one capability for one file, pinned to its behavior; the approval is host state scoped to one host and space (see [Grant storage](#grant-storage)). Tools and attachments travel with the space; approvals do not. These rules bind every document kind: a host that keeps tools outside the space, resolves attachments through its own settings, gives a tool a private store, or stores grants inside the space breaks the contract whatever its file formats.

### Space content and host state

Open tabs, folder folds, grants, and library locations are host state and stay outside the space. Sync carries only space files. Content conventions are:

- In each directory: `_structure.json` for manual order and `_properties.json` for [folder order](#folder-order).
- At the space root: `_tags.json` for [declared tags](#declared-tags), `_libraries.json` for [libraries](#addresses-and-libraries), and `_templates/` for [templates](#templates).
- In each site folder: `_site.json` and `_queue.json` (see [Publishing](publishing.md)).

A leading underscore marks a name Pragma gives meaning, visible where a dot would hide it. This is a convention, not a reserved namespace.

### Blind to document structure

The protocol does not render prose structure — Fountain scene headings, Markdown sections, and the like — and parses it only where hosts must agree: a screenplay's [world names](#world-names) and [description](#descriptions), and the [tags](#sources) a note writes in its text. Syntax and rendering are editor-level concerns. It does read a document's [frontmatter](#frontmatter), and a Table's, Class's or Flow's [metadata](#metadata), but only for named keys it acts on (`tags`, see [Tags](#tags); `description`, see [Descriptions](#descriptions); `visibility`, see `architecture.md`'s Privacy section; any key a [Class's](#classes) filter names); both are otherwise schema-less.

`documentType` is the one structural signal the protocol carries for text documents, and it is derived purely from file extension: `.fountain` resolves to `"screenplay"`, every other text file to `"note"`. A host uses it to select an editor language mode and to gate document-kind-specific UI. It is never passed into a generation call.

### Blind to the provider

A generation call names an opaque `model`, never an endpoint, credential, or wire protocol. In `<providerId>/<model>`, the first `/` separates a configured provider from its model id. A bare id resolves however the host chooses.

A provider is a host-configured connection contributing models. All Flow generation uses one host generation boundary. An image call's `model` always names its provider, which may be another connection type such as an MCP server.

`model` is optional on every generation field and call. Omission or `""` selects the host's default; without one, the call fails. A hard-coded model runs only where it resolves. Omission makes the Flow portable to the receiving host's default.

### Kind-specific action surfaces

Each document kind has its own action surface. An Applet acts on nothing: it shows its own UI, and as a Flow node hands back state and outputs. A Flow runs a graph of typed nodes and shows their outputs; run from a toolkit button, it reads the document the button was clicked in, proposes edits to it, opens files beside it, and writes what its grants allow. See [Patch](#patch).

## Shared document rules

These rules apply across document kinds. The sections cover [versions and safe writes](#format-versions-and-safe-writes), [entry names](#entry-names), [symbolic links](#symbolic-links), [frontmatter](#frontmatter), [display titles](#display-titles), [descriptions](#descriptions), [tags](#tags), and [folder order](#folder-order). Structured HTML documents also share the [metadata format](#metadata).

### Format versions and safe writes

Each format carries a version field — `data-format-version` on the root element where Pragma owns the markup (`.table.html`, `.class.html`, `.flow.html`), manifest `version` where the author does (`.applet.html`). A missing value defaults to `1.0`. An author's own version for a document, distinct from the format's, exists only as an Applet's manifest `meta.version`.

The version check protecting a write is distinct from migration. No automatic migration is defined; a Flow's `typeVersion` records its node type's version (see [Graph shape](#graph-shape)).

#### Reading and write protection

A reader never rejects an unrecognized version — the format degrades gracefully, and a file from a newer implementation stays readable. But Table, Class and Flow are re-serialized whole on every save, from a model built out of what the writer could parse, so writing one back silently discards the rest. A host therefore **must not save over a document it could not fully read** — present it read-only instead. That is one whose major exceeds the one the host writes, or a non-blank file it cannot parse at all: no `data-format` root naming its kind, or a Flow graph block that is not valid JSON. Compare **majors only** — a newer minor is additive, and a version that doesn't parse as a number is not newer. A blank file is a new document and opens editable. An Applet needs no guard, since its save persists the author's raw HTML rather than re-serializing a parsed model.

#### Empty and malformed files

Every file reader returns a safe empty value on a missing, empty, or malformed file rather than throwing. A brand-new file of any kind reads as "nothing declared yet."

A parser's empty value does not permit an unsafe save. Under the [node catalog](flow-nodes.md), a node reading or adding to a file that does not exist fails; a blank file reads as empty.

### Entry names

A name a host writes must be portable between filesystems. The same rules govern names in every directory of a space or library.

- **Legal characters.** Reject `<`, `>`, `:`, `"`, `|`, `?`, `*`, control characters, and a leading dot. A host must not create an entry its own tree would then hide.
- **Collisions.** Names that differ only by case or canonically equivalent Unicode are the same for collision checking on every platform. `é` as one code point and as `e` plus a combining accent therefore collide. An entry is not its own collision: a case-only or normalization-only rename is permitted.
- **Protocol names.** For names such as `README.md`, `index.md`, `_structure.json`, and `_templates/`, use the exactly spelled entry if present; otherwise use the entry whose name folds to it. Write back under the spelling found.
- **Invalid input.** Reject an invalid name typed by a person so they can correct it. A name arriving without someone to ask, such as an OS drag or clipboard paste, may be repaired instead.
- **Titles and names.** A host may keep a typed title verbatim as the display title and derive a legal filename; the two are independent afterward. [Template copying](#copying-a-template) defines when an unrepresentable title must be refused.

Name matching is distinct from permission identity: [grant paths](#grant-storage) and capability addresses are compared exactly, without case or Unicode folding.

### Symbolic links

A host follows no symbolic link below a root — the space or a library. Such a link is left out of every listing, reads as absent where a host looks for a file it names itself (`_structure.json`, `_tags.json`), and refuses any read or write that names it or a path through it, wherever it points: one leading out carries access past the root's edge, one leading back in gives a file a second path when grants, manual order and link rewriting all go by path. The root's own path, and anything above it, may be links. A folder kept elsewhere joins as a library, with its own access.

### Frontmatter

A Markdown document's frontmatter is a YAML block at the very top of the file.

| Operation | Rule |
|---|---|
| Read delimiters | The first line is exactly `---`; the block closes at the next line exactly `---`. A blank first line or `--- ` means there is no frontmatter, and those delimiters are Markdown. |
| Read or write a byte order mark | Skip a leading byte order mark when reading and omit it when writing. |
| Add a block | Put one blank line below it. |
| Edit a block | Keep the blank lines around it. Rewrite only changed keys: replace a changed value in place, remove a key with its own lines, append a new key after the last. Preserve all other lines, including comments. |
| Remove the last key | Remove the empty block. |
| Edit a block that cannot be safely spliced | Write the block afresh, as for a flow map. |

Frontmatter remains schema-less except where a rule names a key, such as [tags](#sources), [descriptions](#descriptions), or a [Class field](#class-fields).

### Display titles

A host that shows a document's title derives it by these rules, so independent implementations agree.

| Kind | Title | Fallback |
|---|---|---|
| Markdown | Plain text of an opening level-1 heading, ATX or Setext, after any frontmatter | Base filename without its extension |
| Table, Class, Flow | `<head><title>` | Base filename without its extension |
| Applet | Manifest `meta.name` | Base filename without its extension |
| Other text kinds | The kind's own title convention, such as a Fountain title page | The kind's convention applies |

HTML comments in a Markdown heading are omitted from its title. Comments on lines of their own may precede the opening heading.

A heading promoted to the title is not also rendered as body content. An editor may expose it as an editable title field. Until that field changes, write the heading back as read. After an edit, write an ordinary `# ` heading that reads back as typed, in the heading's position. When adding a heading, put it at the start of the file, directly below any frontmatter.

### Descriptions

A **description** is a one-line account a host may show beside a file's name:

- Markdown: a non-empty string in frontmatter `description`.
- Fountain: the first `=` synopsis line containing text outside a boneyard, note, or title page. Insert a new synopsis at the top, below any title page.
- Table, Class, Flow: [metadata](#metadata) `description`.
- Applet: manifest `meta.description`.
- Folder: its `README.md`'s description. Other files have none.

For Fountain, only an empty line is blank; spaces are content. A title page ends at the first empty line. A note runs from `[[` through the next `]]`, over multiple lines but never across an empty line, which leaves `[[` as text.

### Tags

A **tag** is a name attached to a document; a [Class](#classes) can hold every file that carries one. The tags a space declares, in `_tags.json` at its root, are the ones a host suggests, each with its color.

A tag's **name** is one or more characters that are neither whitespace nor punctuation, and not only the digits 0–9. Punctuation is ASCII's but `_`, `-` and `/`, and Unicode's General and Supplemental Punctuation blocks (U+2000–206F, U+2E00–2E7F). Every source is read by this rule, so any tag can be written in text as `#name`. A value is read trimmed, one leading `#` dropped, since `#` marks a tag and is never part of its name: `#draft` in frontmatter is `draft`. A value that then names no tag is none; a host keeps it in its file, and refuses one a person types, saying why.

Two tags that differ only by case or by canonically equivalent Unicode are one tag, compared as [entry names](#entry-names) are, wherever a host compares two: `#Draft`, `draft` and a `Draft` entry in `_tags.json` are one tag.

**`/` nests one tag under another**, and wherever a host asks whether something carries a tag, one nested under it counts: a note tagged `project/alpha` carries `project`.

#### Sources

- **Document tags** — the open document's frontmatter `tags:` field: a list's text items, or a lone text value. `tags` is the one key a host may treat as list-shaped regardless of its current value; that is a rendering hint only, and the frontmatter parser stays schema-less.
- **Inline tags** — the `#tags` a Markdown document writes in its text, which with its frontmatter's are one list, no record kept of which is which. A tag is `#` and a name, at the start of a line or after whitespace, the name running on while its characters are a name's. A tag is kept as written. A `#` in code, math, a link, a wikilink, a URL or HTML starts no tag, and frontmatter is not text. A Fountain screenplay has none, since its `#` opens a section.
- **Table, Class and Flow tags** — the `tags` in its [metadata](#metadata).

A declared tag is suggested, never required: any tag name can be written.

#### Declared tags

`_tags.json` at the space root lists the tags a space declares. A tag's meaning has to be consistent everywhere it is used, so a space has one such file, never one per folder.

```json
{ "tags": [
  { "name": "lyrics", "color": "#ecb72b" },
  { "name": "draft" }
] }
```

| Key | Meaning |
|---|---|
| `name` | The tag's name. |
| `color` | The tag's display color, `#rrggbb`. |

- **Declared, never collected.** An entry exists because someone declared its tag: applying a tag to a document or folder writes nothing here. An entry with no `color` still declares its tag, and one whose `name` names no tag declares nothing.
- **The first entry naming a tag, in any case, is the tag's.**
- **A writer changes one entry at a time**, against the file as it stands, and keeps what it doesn't read: other keys, in the file and in each entry, and the entries' order.
- **A file that doesn't parse, or whose `tags` isn't a list, declares nothing**, and is written again only once it is fixed, so a hand edit gone wrong is never replaced. A space with no `_tags.json` declares nothing either.

### Folder order

A directory's children are listed in exactly one order, chosen by the directory itself: by its `_properties.json`'s `"sort": { "by": …, "order": "asc" | "desc" }`, or its `_structure.json`. Only its own files are read, never an ancestor's.

| Order | When | Rule |
|---|---|---|
| **Manual** | no `sort`, and a `_structure.json` | that file's order; entries it doesn't list follow in name order |
| **Name** | `"by": "name"`, or no `sort` and no `_structure.json` | folders first, then by name in natural order, ignoring case |
| **Created**, **Modified** | `"by": "created"`, `"by": "modified"` | folders first, then by when each entry was made or last changed |
| **Size** | `"by": "size"` | folders first, then files by size in bytes; folders by name |
| **Property** | `"by": "property"`, with `"property": "<key>"` | by that frontmatter key's value |

`order` defaults to `asc`; `desc` reverses the comparison, never the folders-first rule. Ties keep name order. A `sort` matching no row is ignored, as if absent. Any `sort` leaves `_structure.json` in place, unfollowed, so removing the `sort` brings the manual order back. `_structure.json` is `{ "order": [{ "name": "<name>" }, …] }`; a reader ignores an entry's other keys.

Created and Modified come from the reader's own filesystem, and no copy carries them: a clone or a sync resets them, so two readers can order a folder differently. Where no creation time is kept, the last change stands in. A host may show a folder another way for one person, but writes that into the folder only when asked to make it the folder's own.

Property order:

- **Where the value comes from.** A `.md` document's own frontmatter; for a folder, the frontmatter of its `index.md`. Any other entry has none.
- **Which values sort.** A number is a number. A string of the form `YYYY-MM-DD`, optionally with `THH:MM[:SS[.fff]]` and a `Z` or `±HH:MM` zone, is an instant, and a time with no zone is UTC. Any other non-empty string, and `true`/`false`, is text. Absent, empty, list and map values are no value.
- **Comparison.** Numbers and instants compare numerically and come before text. Text compares in natural order ("post 2" before "post 10"), ignoring case. `desc` reverses this.
- **Ties and missing values.** Entries with equal values keep name order. Entries with no value follow all the others in name order, in either direction.
- Folders and files are ordered together, not folders first.

## Addressing and context

All document kinds share [addresses and libraries](#addresses-and-libraries) and [link resolution](#links). [Scopes](#scopes) govern link writing and settings; [project context](#project-context) and [context of a path](#context-of-a-path) determine surrounding material. [Templates](#templates) and [date placeholders](#date-placeholders) govern creation and text substitution.

### Addresses and libraries

A path stored in a document is either an **address**, naming its root explicitly, or a **reference**, resolved from that document. A library is declared in `_libraries.json` at the space root as a `libraries` list of `{ id, label }` entries. The host keeps each library's filesystem location outside the space (see [Space content and host state](#space-content-and-host-state)).

| Form | Resolution |
|---|---|
| `space:<path>` | From the space root, independent of the referring document's location |
| `lib:<id>/<path>` | From the declared library's root |
| `/path` | From the root containing the document: the space or its library |
| `a.md`, `./a.md`, `art/a.md`, `../a.md` | From the document's folder; a `..` beyond its root names nothing |

Addresses are recognized first. Other paths are references, read and percent-decoded by the [link rules](#links). A library document may name only entries in its own library; even `space:` cannot reach outside it. A library therefore has the same meaning in every space that browses it.

#### Address grammar

- A library id contains only lowercase letters, digits, and `-`; it contains neither `/` nor `:`. A path's scheme splits at its first colon.
- The only schemes are lowercase `space` and `lib`. Any other scheme is an error, never a fallback to a space-relative reference.
- `space:` carries no space id. A connection reaches one space, and its addresses cannot select a different one.
- An address contains no `.`, `..`, or empty segment. A trailing `/` is permitted only as a folder marker. Paths use `/` as the separator; a backslash is an error.
- A caller with no referring document, such as an external API client, must name the root explicitly. A bare path is refused.

#### Writing and permission identity

Write document paths as relative references or `/`-rooted references, as [Links](#links) specifies, and library paths as `lib:` addresses. A path dropped onto a node is written by the Markdown link rule. `space:` is the form for a path with no referring document, such as an API argument or grant key.

A [capability key](#capabilities-and-grants) holds the address resolved from the Flow's folder. In a Flow at the space root, `notes.md`, `/notes.md`, and `space:notes.md` name one key. Compare addresses exactly as spelled, with no case or Unicode folding, as for [grant paths](#grant-storage).

Address syntax does not itself grant access. [Capabilities and grants](#capabilities-and-grants), [Wired paths](#wired-paths), and each document kind define which roots and file types an operation may use.

### Scopes

A folder whose `AGENTS.md`, its name in any case, has a `pragma` key in its frontmatter opens a **scope** over its tree, the folder itself included, whatever the key holds: a bare `pragma:` opens one with no settings. Scopes nest at any depth. The space is the root scope, and a library is one scope, its root, where an `AGENTS.md` opens none. An entry's **closest parent scope** is the innermost scope it sits in.

Folders organize; pragmas mean: no folder's name or place means anything to the protocol, and a scope goes wherever its folder goes, since its `AGENTS.md` travels with it. A scope decides how a path is written inside it (see [Links](#links)), never what a written path names.

A scope's `pragma` value may be a map of **settings**: core's sit directly under it, and a document kind's under its document type, as `screenplay:` holds a screenplay's, so a host that doesn't read a kind leaves its block as written. A setting names a folder, written as a path in the `AGENTS.md` is and read from its folder, and only one inside its scope, the scope's own included: a folder outside names nothing. A scope that gives a setting no value takes the nearest enclosing scope's, and a setting no scope gives means nothing. The one setting is `screenplay.world`, a screenplay's [world](#world-names).

### Links

Alongside standard Markdown links (`[text](path)`), a text document can reference another entry with a wikilink: `[[target]]` or, for separate display text, `[[target|display text]]` — the long-standing wiki convention, piped form included. A Fountain screenplay is the exception: there `[[…]]` is a note, which every Fountain app leaves out of the printed script, so a screenplay links by [world names](#world-names) instead.

A wikilink's target is a path, never a name, read by the grammar every path a document holds shares — Markdown links and embeds, `media` and `path` values, a Flow's config, an Applet's imports, a Class's links:

- `lib:<id>/…` names an entry in that library and `space:…` one in the space (see [Addresses and libraries](#addresses-and-libraries)).
- `/…` names a path from the root the document sits in, the space or its library.
- Anything else names a path from the document's own folder.
- A `..` past the root names nothing, and no path names an entry whose name starts with a dot.
- A path names the file or folder at that path, whether a host's listing shows it or not; a trailing `/` says it must be a folder.
- Names compare folding case and Unicode, as [entry names](#entry-names) do; a path that matches two entries that way names neither.

A path is percent-decoded first, as a Markdown link's is, an address included, except a wikilink, which is read as written. A Markdown link to a URL with a scheme of its own (`https:`, `mailto:`), or to a bare `#anchor`, is no path. A wikilink may leave off `.md`, never a folder's `/`: beside `plan.md`, `plan.table.html` and `plan/`, `[[plan]]` names the note, `[[plan.table.html]]` the Table and `[[plan/]]` the folder. So no file elsewhere, and none added later, changes what a link names.

An unresolved target renders inert: visually distinct from a resolved link, not clickable, and never creates a file or prompts for disambiguation. Resolution needs only the files that exist, looked up in the root's listing. A host that keeps what each document links to, to list the documents linking to one, answers exactly as a fresh lookup would. An unpiped wikilink displays its target as written, except a relative one, which displays its file or folder name, a file's extension stripped whole (`.table.html`) unless the file is of no [document kind](#document-kinds) or media type.

#### Writing a link

A host writes a path relative from the document when the two have the same closest parent scope (see [Scopes](#scopes)), and from the root, `/…`, otherwise, so a scope's own links keep working wherever it is opened or moved. A space document names a library entry as `lib:<id>/…`; a library document names nothing outside its library. A wikilink is written without `.md` and a folder with its `/`, and it pipes the linked file's [display title](#display-titles) only when the unpiped link would show something else, so a path from the root is always piped. A Markdown link keeps the extension, is percent-encoded and takes the display title as its text; a new embed takes the file's name as its alt text, which an app that can't follow the path shows instead. The scope decides only which form is written, never what a written link means.

#### References when entries move

A reference survives the move of either entry it joins. A host that moves an entry rewrites, in the same operation, every path the move would break, written as a new link would be from the document's place: a Markdown document's links and embeds, a Table's `media` and `path` values and drop folders, a Class's links and drop folders, the folders its Folder rules name, written from its scope as Folder writes one, and the folders an `AGENTS.md`'s settings name; a path between two entries with the same closest parent scope is relative, so moving that scope rewrites none of them. A path in a Flow or an Applet is left as written. With no path read as a name, a move has no collision to report.

#### World names

A screenplay links the names it already spells, with nothing written into the file, so it prints unchanged in any Fountain app. Its **world** is every file under the folder its `screenplay.world` setting names (see [Scopes](#scopes)), except media — images, video and PDFs — so a picture kept beside the note it illustrates never shares that note's name; a screenplay no scope gives that setting has none. A name is compared, folding case and Unicode, with each world file's basename less its extension (a compound one like `.table.html` whole), and exactly one match links it; anything else stays plain text. Names are read from three kinds of line:

- a **character cue**: the whole cue, less a forced cue's `@`, a dual cue's `^` and any extension such as `(V.O.)`;
- a **scene heading**: the text between the `INT.`/`EXT.` prefix (or a forced heading's `.`) and any scene number (a `#`, letters, digits, `-` or `.`, and a `#`, ending the line but for its notes, as in `#110A#`), read outside any note as parts separated by ` - `. Two or more leading parts that resolve together link whole, the most parts first, so `INT. VOSTOK STATION - KITCHEN - DAY` links a room's `Vostok Station - Kitchen` file before the station's own. Otherwise the location is the first part alone; a later part never links on its own;
- an **action line**: each run of capitalised words, those whose first letter is a capital (`Lina` as well as `LINA`, never `lina`), separated only by whitespace and read outside any note.

In a location or a run, the longest span that resolves wins, scanning from the left: `THE THING EMERGES` links `THE THING`. A word ending in `'s` is tried with it, then without. No link is stored, so a renamed world file changes which names link and leaves every screenplay as it was.

### Project context

For anything that needs more context than a single document provides, the host resolves the **nearest ancestor `README.md`**:

1. The start directory is the one containing whatever is open (or, for a folder view, that directory itself). Walk upward from there.
2. The first directory at or above the start that contains a `README.md` is the result; its content is folded into the consumer's context.
3. The walk stops before the space root, so a document with no closer `README.md` resolves to nothing — the space root's own `README.md` describes the space, not a boundary a single document belongs to.

Any directory with a `README.md` at its root is a boundary; what a space chooses to put there is its own convention.

### Context of a path

A generation can send the files around a path with its call, through a [`generateText`](flow-nodes.md#generatetext) node's `context`: the path says where to look, the instruction what matters. That path's **context** starts with, in this order:

1. the `AGENTS.md` of the scope it sits in, the space's own at its root;
2. the `README.md` [Project context](#project-context) resolves for it, a folder starting the walk at itself;
3. each note or screenplay it names, in the order it first names them: a screenplay's [world names](#world-names), a note's [links](#links).

The model may then look further before it answers: list, search and read the files of the scope's folder, and follow their links both ways. A model that can't use tools answers from the files above.

Only files inside the scope's folder go, never the path's own file and none twice, read as saved; a library's file has no context. A private file stays out, never listed, found or read, and so does all a private note names, since what it names tells what it holds. A host may hold each file, the whole and the looking to limits, cutting or leaving out what is over them, and tells whoever started the run what went, what the model searched for, what was cut or left out, and why it stopped looking.

### Templates

A space keeps its templates in `_templates/` at its root: each is a file or a folder a host copies to start a new one, under the name its writer types. No other folder holds templates, wherever it sits, and a library's `_templates/` is an ordinary folder.

- **A file is a file template**, directly in `_templates/` or in a group: a file a host's tree would list, but never one of the space's own files, such as `_structure.json`.
- **A folder with a `README.md` is a folder template**, the whole folder. The first `README.md` on the way down ends the walk: every subfolder below it is part of it.
- **A folder without one is a group**, read by the same rule; a group holding no template is left out. The root's own `README.md` describes `_templates/` and is no template.
- **A host may offer templates of its own** beside the space's, read by the same rule; neither hides the other.

#### Copying a template

- **A copy's name** is the one typed for it, plus a file template's whole extension, not added twice when typed. A taken name is refused, and a folder template's entries keep their own names.
- **`{{$title}}` takes the typed title verbatim, and the [date placeholders](#date-placeholders) the moment the copy is made.** `{{$title}}` is matched as they are, in any case and with nothing else inside the braces, and all are filled in one pass: in a Markdown file's body, inside its frontmatter's values, each one it changes written back as YAML needs, and anywhere in a Fountain file. Any other kind, and any other `{{…}}`, is copied as written.
- **A title no file name can carry** follows the typed-title rule of [Entry names](#entry-names): where the template writes `{{$title}}`, the title goes there and the copy takes a name derived from it. With nowhere to keep it, the name is refused.
- **A folder copy leaves out** dot entries, symbolic links, `_site.json` and `_queue.json`, so it never binds a second folder to a site. A Markdown copy landing in a site drops `id` and `pushed`, as a duplicate does (`publishing.md`).
- **Nothing in a copy is rewritten.** A path inside a template arrives as written, and grants, kept by path, never carry over.

### Date placeholders

`{{$date}}` and `{{$date:FORMAT}}` write a moment into text wherever a rule fills them: a [template's copy](#copying-a-template), and text typed on a Flow node (see [Ports and types](#ports-and-types)). The `$` marks a value the host fills, as in `{{$title}}`, so none meets a name a person gives a placeholder: `{{date}}` is no date.

- **The moment is the writer's**: what their clock shows, at their offset from UTC, where the host can tell it, else the host's own. One reading serves all that is filled at once, a whole copy or a whole run, so a run that crosses midnight names one day.
- **`{{$date}}` is the day, `YYYY-MM-DD`, and `{{$date:FORMAT}}` is FORMAT with each directive replaced**, POSIX `strftime`'s in its POSIX locale, so names are English on every host: `%Y` the year and `%y` its last two digits, `%m` the month, `%d` the day, `%H` the hour from 00 to 23 and `%I` from 01 to 12, `%M` the minute, `%S` the second, `%p` `AM` or `PM`, `%j` the day of the year, `%a` and `%A` the weekday as `Mon` and `Monday`, `%b` and `%B` the month as `Nov` and `November`, `%u` the weekday from 1 for Monday to 7, `%V` the ISO week and `%G` its year, `%z` the offset as `+0100`, `%F` for `%Y-%m-%d`, `%T` for `%H:%M:%S`, and `%%` for `%`. A number is zero-padded, and a `-` after the `%` drops the padding: `%-d` gives `9`.
- **Any other directive is written as it stands, and a FORMAT holding none of these leaves its placeholder as written**, so `{{$date:YYYY-MM-DD}}`, a format for another tool, never gives a wrong date.
- **The name is matched in any case, with nothing else inside the braces**: `{{$Date}}` is filled, `{{ $date }}` is not. FORMAT runs to the closing braces and holds no brace or line break.
- **Filling is one pass**: text a placeholder put in is never read for placeholders again.

## Document formats

The shared envelope and each document kind define what is stored, how it is read and written, and which effects are permitted. [Execution and authority](#execution-and-authority) governs Flow runs and grants; the [node catalog](flow-nodes.md) defines individual built-in nodes.

### Pragma Open Document Format

[Tables](#tables), [Classes](#classes), and [Flows](#flows) use a shared HTML envelope with semantic markup, typed data, and metadata. Additional kinds needing structured, diffable storage should use this format before defining another. Its text remains inspectable and editable, and its semantic HTML remains legible in a browser or preview without a Pragma handler. HTML parsing tolerates imperfect markup; native elements such as `<table>` and `<dl>` retain their ordinary meaning.

Types and metadata use `data-*` attributes. Embedded JSON, including an Applet's manifest and a Flow's graph, lives in an inert `<script type="application/json">` block: it is parsed, never executed. A literal `</script>` inside the JSON is stored as `<\/script`.

The [format-version and safe-write rules](#format-versions-and-safe-writes) apply to the structured kinds. Each kind defines the elements it reads and the content it writes below.

#### Metadata

A Table, Class or Flow says what it is about in a `<dl data-role="metadata">` block in its `<body>`, as a Markdown document does in its frontmatter:

```html
<dl data-role="metadata">
  <dt>description</dt><dd>Image-generation models to pick from.</dd>
  <dt>tags</dt><dd>studio</dd><dd>reference</dd>
</dl>
```

- **A `<dt>` is a key, and the `<dd>`s after it are its values**, grouped as HTML groups a description list: a run of `<dt>`s shares the `<dd>`s that follow it. A value is its element's text, trimmed, and an empty one is no value. A key with one value is text and with several a list, `tags` is a list whatever it holds, and a key with no value is still kept. A key written twice keeps its first group.
- **Any key may appear.** A host acts only on the keys it names: `description` ([Descriptions](#descriptions)), `tags` ([Tags](#tags)), `visibility` (`architecture.md`'s Privacy section), and a Table's `created` and `modified`, the days it was first and last saved.
- **A writer keeps every entry**, in order, each with its values in order, and writes the block even when it is empty, so a file's shape never depends on its metadata.

### Text documents

A text document is plain prose with a selectable region, acted on in place. It carries no inline configuration; its actionable buttons come entirely from toolkits — Flows whose Button nodes are buttons (see [Actions](#actions)) — attached through the [Classes](#classes) holding it.

#### Text reads

A host's file read returns, for a text document:

```json
{ "kind": "text", "path": "...", "content": "...", "documentType": "note", "toolkits": [ ... ], "classLinks": [ ... ] }
```

Each entry in `toolkits` is a resolved toolkit: `{ classPath, path, name, actions }`, `classPath` being the Class that links it and `actions` its buttons, each `{ nodeId, label, comment }`, with no `comment` for a node that has none. Each entry in `classLinks` is `{ classPath, name, paths }`: a Class holding the document, its display name, and the existing [other files](#what-a-class-links) it links, from the root.

#### Text embeds

An image embed names its image by a path, read as every path a note holds is (see [Links](#links)); a note inside a library names only its own library's files. A library embed renders only where a host has located that library, and a move never rewrites one. An image embed whose destination is a YouTube video URL is a **video embed**: a reader shows that video's player, and a plain link to the same URL stays a link.

#### Text math

Math is TeX between `$` marks, or display math between `$$` marks. An inline `$` opens before a non-blank and closes at the next `$` that follows a non-blank and precedes no digit, so `$5 and $10` is text. A line opening with `$$` and holding no other `$` starts a block, which runs, blank lines included, to a line ending in a `$$` run at least as long with no `$` before it, or to the end of its quote, list item or document. An escaped `\$`, and a `$` right after `{{`, as in `{{$date}}`, opens and closes nothing. Nothing in math is read as Markdown, so it holds no link or tag; a reader may typeset it or show it as written, and a title reads it as written.

### Tables

A **Table** is a small, reusable, multi-column table of rows — e.g. a shared list a Flow offers as a dropdown rather than duplicating it. Rows are real persisted file content: every add, edit, and delete round-trips to disk.

#### Table storage

`.table.html`, one file per Table.

```html
<!DOCTYPE html>
<html data-format="table" data-format-version="1.0">
<head>
  <meta charset="utf-8">
  <title>Target models</title>
</head>
<body>

  <dl data-role="metadata">
    <dt>description</dt><dd>Image-generation models to pick from.</dd>
    <dt>created</dt><dd>2026-08-08</dd>
    <dt>modified</dt><dd>2026-08-09</dd>
  </dl>

  <table data-role="data">
    <thead>
      <tr>
        <th data-field="value"    data-type="text">Model</th>
        <th data-field="provider" data-type="text">Provider</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>Nano Banana Pro</td><td>Google</td></tr>
      <tr><td>Seedream 5.0 Pro</td><td>ByteDance</td></tr>
    </tbody>
  </table>

</body>
</html>
```

- **`<html data-format>`** must be `"table"`; otherwise the file reads as empty and, unless blank, read-only. `data-format-version` follows [Format versions and safe writes](#format-versions-and-safe-writes).
- **`<head><title>`** is the Table's display name, the only place it is stored.
- **`<dl data-role="metadata">`** holds its [metadata](#metadata).
- **`<table data-role="data">`** holds the columns in `<thead>` and the rows in `<tbody>`.

The `.html` suffix is required so the file can render in a plain browser or repository preview. A Table can live anywhere in a space; references to one are explicit paths, including a Flow node's configured path.

#### Table columns

Each `<th>` in `<thead>` defines one column. Its text is the label. Renaming a column changes only this label; its id remains unchanged.

| Attribute | Meaning and default |
|---|---|
| `data-field` | The column id. |
| `data-type` | `text`, `select`, `checkbox`, `color`, `integer`, `media`, `path`, or `timestamp`. Any other value reads as `text`. |
| `data-options` | A `select` column's options, comma-separated. |
| `data-media-folder` | For `media`, the destination for a desktop drop, written as its values are. Absent means the Table's folder. Values are not limited to that folder. |
| `data-show-name` | For `media`, shows the file's name beside its picture. When absent, only the picture is shown. |
| `data-default` | For `timestamp`, `"now"` gives a new row the instant it is added. Absent means blank. No other value is defined, and the attribute has no meaning on another type. |

#### Table rows

Each `<tbody><tr>` is a row. Cells correspond to columns by position, and each `<td>`'s text is its value. Rows have no independent id; a Table needing one can declare an ordinary column for it.

| Type | Value and reading rules |
|---|---|
| `text`, `select` | Plain cell text. |
| `checkbox` | The literal text `"true"` or `"false"`. |
| `color` | CSS hex `#rgb` or `#rrggbb`, in any case on read; canonical form is lowercase `#rrggbb`. An unmatched value, including a color name or an empty cell, displays no color and is preserved verbatim. |
| `integer` | Plain cell text edited through a numeric input. It is neither parsed nor canonicalized. |
| `timestamp` | An instant under the timestamp rules below. |
| `media` | A file reference read as an image embed in a note: relative to the Table's folder, or an explicit `lib:<id>/…` address. A Table inside a library names only files in that library. Empty means no file; a missing file displays as missing and its value is preserved. |
| `path` | A file or folder reference under the same rules as `media`, with a trailing `/` for a folder. It names an entry to open or pass to a Flow, and a host offers a picker. |

A timestamp is an ISO 8601 date and time with `Z` or a UTC offset. Seconds are optional, a space may replace `T`, and reading is case-insensitive. The canonical form is UTC to the second, such as `2026-10-07T12:32:05Z`; it gives each instant one spelling that sorts as text. A host displays the instant in the viewer's local time. A value without a zone, a date without a time, or an impossible date such as February 30 displays as ordinary text and remains verbatim.

#### Table views

`data-layout="cards"` on `<table data-role="data">` makes the default view one card per row. Absent means a grid. The layout a host is showing is host state and is never written back; the attribute supplies the default.

A card takes its picture from the first `media` column, its title from the first column other than the picture, and its badge from the first `select` column other than the title. Every other column is a line. No additional layout attributes are required.

#### Table writes

Reading is inert, through an HTML parser rather than a browser. Saving re-serializes the whole Table through the same document-write path as any other file. Serialization is deterministic: after a one-row edit, every other line remains byte-identical.

The [safe-write guard](#format-versions-and-safe-writes) applies before any whole-file save.

#### New table rows

A row added by a person or [Add Row](flow-nodes.md#addrow) fills every column without a supplied value as follows:

| Column | Starting value |
|---|---|
| `select` | Its first option. |
| `checkbox` | `"false"`. |
| `timestamp` with `data-default="now"` | The instant the row is added. |
| Any other column | Blank. |

Adding a column gives existing rows the same starting value, except that a `timestamp` remains blank: adding the column establishes no creation time for those rows. Changing a default never rewrites existing rows.

### Classes

A **Class** defines a group of files, the fields they share, and the views and tools available for them. Its rows are Markdown notes, screenplays and media, and a row's values are its own file's, a note's in its frontmatter, so nothing is copied out of a file and several Classes may show the same one. A Class holds a filter, which picks its rows from its root, its [fields](#class-fields), its [views](#class-views), and the files it [links](#what-a-class-links) them to.

#### Class storage

`.class.html`, one file per Class.

```html
<!DOCTYPE html>
<html data-format="class" data-format-version="1.0">
<head>
  <meta charset="utf-8">
  <title>Lyrics</title>
</head>
<body>

  <dl data-role="metadata">
  </dl>

  <ul data-role="filter">
    <li data-property="file.folder" data-test="is">*/lyrics</li>
  </ul>

  <ul data-role="links">
    <li>lyrics.flow.html</li>
  </ul>

  <table data-role="fields">
    <thead>
      <tr>
        <th data-field="status" data-type="select" data-options="draft,final">Status</th>
        <th data-field="cover" data-type="media" data-media-folder="covers">Cover</th>
        <th data-field="file.modified" data-type="timestamp">Modified</th>
      </tr>
    </thead>
  </table>

  <ol data-role="views">
    <li data-name="Board" data-layout="cards" data-group-by="status"></li>
    <li data-name="Drafts" data-sort="file.modified" data-order="desc" data-fields="status,file.modified">
      <ul data-role="filter">
        <li data-property="status" data-test="is">draft</li>
      </ul>
    </li>
  </ol>

</body>
</html>
```

- **`<html data-format>`** must be `"class"`; reading and writing follow [Format versions and safe writes](#format-versions-and-safe-writes). **`<head><title>`** is its [display title](#display-titles), and **`<dl data-role="metadata">`** is its [metadata](#metadata).
- **The filter, links and views are `<body>`'s own children**, read only there, since a view may carry a filter of its own.
- **`<ul data-role="filter">`** holds rules, one `<li>` each: `data-property` names a [value](#class-values), `data-test` a test, and its text the test's values, comma-separated.
- **`<ul data-role="links">`** lists files, one `<li>` each, in order, each a path read from the Class's folder. A writer leaves it out when it is empty.
- **`<table data-role="fields">`** holds the Class's [fields](#class-fields), and **`<ol data-role="views">`** its [views](#class-views). Neither changes which files a Class holds.

#### Membership

- **A Class's rows come from its root**, the space or its library, as a host's tree lists it: no dot entry, and nothing reached through a symbolic link. Its filter keeps the rows it holds, so a Class with no filter holds every one.
- **Its Folder rule says which folders they come from**: the first rule of its own filter on `file.folder` that tests `is` or `within`. A host may read only the folders it names, and below a pattern's first `*`, since every row it holds is among them.
- **A row is** a Markdown note other than a folder's own `index.md`, `README.md` or `AGENTS.md`; a Fountain screenplay; an image, video or PDF; or a folder holding an `index.md`, read through that file and held by the folder above it. A Table, Class, Flow or Applet is never a row, and a file reached twice is one row.
- **The space's [templates](#templates) are no rows** unless the Folder rule names a folder among them.
- **The Class's filter keeps a row when every rule holds**; a view's narrows only what that view shows. Each rule tests one of the row's values against its own: `has`, that one of the rule's values is the row's value or one of its items; `is`, that the row's value, not a list, is one of them; `within`, on `file.folder` alone, that the row's folder is one of them or below one; `contains`, that one of them is inside the value's text or an item's, ignoring case; `empty` and `not-empty`, where absent, blank and an empty list are empty. A test a reader doesn't know holds, so a newer one hides nothing.

#### Class values

- **A note's values are its frontmatter's keys**, none when its frontmatter doesn't parse. A screenplay's are its title page's, whose keys match in any case, and a media file has none. A folder's row reads its `index.md`.
- **A row's title** is its file's [display title](#display-titles), a screenplay's from its title page. A folder row's is the leading heading of its `index.md`, else the folder's name, and a media file's is its name without extension.
- **A key starting with `file.` names one of the file's own facts**, never a property, and no Class sets one:
  - `file.name`: its name without extension; a folder row's is the folder's.
  - `file.folder`: the folder it sits in, written from the Class's [scope](#scopes): `.` for the scope's folder, `album/lyrics` below it, and from the root, `/…`, outside it. A folder row's is the folder holding it.
  - `file.ext`: what follows the last dot of its name, in lower case, such as `fountain`; a folder row's is `md`.
  - `file.size`, in bytes, and `file.modified`, the instant it last changed.
  - `file.tags`: every tag it carries, those a `has` on `tags` counts, each once.
- **On `tags` and `file.tags`, a test reads the tags a value names**, and a tag matches in any case, as does one [nested](#tags) under it. A `has` on `tags` counts a note's [inline tags](#sources) with its frontmatter's.
- **An extension matches in any case** on `file.ext`, with or without its dot.
- **`is` and `within` on `file.folder` take a pattern**: a `*` step stands for any one folder name, and a leading `/` names a folder outside the scope. Names match in any case, and a value with no `*` is the folder it names, however it is written.
- **`this.file.folder` is the Class's own folder** wherever it sits, so a moved Class or a template's copy reads its own. A folder of that name is written `./this.file.folder`.

#### Class fields

**The `<thead>` of `<table data-role="fields">` defines a Class's fields as a Table's defines its columns** (see [Table columns](#table-columns)): `data-field`, `data-type`, `data-options`, `data-media-folder`, `data-show-name` and `data-default`, with the `<th>` text as the label, mean what they mean there, except:

- **`data-field` is a key**: one of a row's [values](#class-values), or one of a file's own facts. It holds no comma, since a view lists keys comma-separated.
- **A field on a file's own fact keeps that fact's type** whatever its `<th>` says. Only its label is the Class's.
- **A Class has no `path` type**: a move rewrites no note's frontmatter, so a path kept there would break on the first move. One written by hand reads from the note's folder, as a `media` value does.
- **`data-media-folder` is read from the Class's folder.** A file dropped on a value is copied there, else into the note's own folder.

A field's type decides how a note's frontmatter stores its value, as plain YAML any Markdown app reads:

| Type | Stored as |
|---|---|
| `text`, `select` | a string |
| `checkbox` | `true` or `false` |
| `integer` | a whole number |
| `color` | a string, a Table's canonical `#rrggbb` |
| `timestamp` | a string, a Table's canonical UTC form |
| `media` | a string, a path read and written as an image embed in that note is |

- **Reading is lenient.** A value that isn't its field's type, such as a list in a `text` field, `wip` in a `select` or `"yes"` in a `checkbox`, shows as the text it is and is never rewritten until that field is set. A list shows its items, and no list is set.
- **A missing key is blank.** Adding a field writes nothing, and changing a field's type or options rewrites no note.
- **Only a note's values are set**, a folder row's in its `index.md`: never a screenplay's title page, a media file, a file's own fact, or a note whose frontmatter doesn't parse.
- **Setting a value writes one key**, every other key kept as the [frontmatter](#frontmatter) edit rule keeps it. Blank text removes the key, a checkbox is always `true` or `false`, and text that isn't its type's, such as `3a` in an `integer`, is stored as typed.

#### Class views

`<ol data-role="views">` lists a Class's views, one `<li>` each, in order. A host opens the first, and which one it shows is its own state, never written. A Class with none shows every row in one list, with every field.

- **`data-name`** names the view.
- **`data-layout="cards"`** shows a card per row; absent means a list, a line per row.
- **`data-sort`** names a key the rows are ordered by, ascending unless **`data-order="desc"`**.
- **`data-group-by`** names a key the rows are grouped by.
- **`data-fields`** lists the keys of the fields the view shows, comma-separated, in order. Absent means every field, in the Class's order, and a key naming no field is skipped.
- **A `<ul data-role="filter">` inside it** holds the view's own rules, read as the Class's are (see [Membership](#membership)).

A writer leaves out the list layout and the ascending order. A view shows its rows by these rules:

- **A row leads with its title.** A card is composed as a [Table card](#table-views) is, with the row's title for its title: the first `media` field the view shows is its picture, the first `select` its badge, and every other field a line. A media row is its own picture.
- **A sort compares values as [Folder order](#folder-order)'s property order does**, rows with no value after the rest in either direction and ties in name order.
- **With no sort**, a Class reading one folder, the one its Folder rule names or its whole root, shows its rows in the order the host shows that folder, its subfolders' depth-first as a tree lists them. Rows from several folders are in name order: natural, ignoring case.
- **Groups keep the view's order inside each**, and come in natural order of their values, a `select` field's options first in their own order. The rows with no value come last, and a list value groups as all its items together.

#### New notes

A host that makes a note from a Class puts it in the first folder its Folder rule names, a pattern's before its first `*`, else in the Class's own folder, never one below it. It offers none where that folder's root takes no writes.

- **The typed title** is kept as the note's leading heading, and a legal name derived from it (see [Entry names](#entry-names)).
- **Each field's starting value** is written where it isn't blank, as a [new Table row](#new-table-rows) gets one.
- **What keeps it in the view it was added from** is set over that: each `has` rule's first value, from the Class's filter and the view's, added to its key's list; each `is` rule's value where it names exactly one; then the group it was added under, the group of rows with none removing that key. An `is` value and a group are typed as their field stores them. A file's own fact is never set, though a `has` on `file.tags` adds to `tags`. On `tags`, it adds the tag its value names, unless the note carries it or one nested under it.
- **A Class linking a Markdown file template** makes the note as a copy of it instead, titled as [Copying a template](#copying-a-template) says. The starting values then fill only keys the template's frontmatter leaves out, and what keeps the note in view is set over it. With several linked, the host asks which.

#### What a Class links

Only the space's own Classes link anything, never one in a library or in `_templates/`. What a link gives each of its rows follows from what it names, and a link naming nothing gives nothing:

- **A Flow in the space**: its buttons in the row's toolkit (see [Toolkit resolution](#toolkit-resolution)).
- **A Markdown file template** in `_templates/`: what a [new note](#new-notes) made from the Class starts from.
- **Any other file**, in the space or a library: a place among the row's links, under the Class.

### Applets

An **Applet** is a `.applet.html` document that runs its own logic in a sandboxed iframe rather than being pure data a host renders — real code and any UI, traded against needing an explicit trust boundary. **On its own an Applet touches nothing**: no space read or write, no model call, no host picker. Anything more comes from a Flow: the Applet declares ports, and as a node in a Flow it takes inputs and gives outputs while the Flow's built-in nodes read, write and call models (see [Applet nodes](#applet-nodes)).

#### Core model

1. **Logic** — the file's own raw HTML/JS/CSS, mounted into an iframe via `srcdoc` (never `src` pointing at a space URL), with `sandbox="allow-scripts"` and no `allow-same-origin`. The resulting opaque (`null`) origin is load-bearing: the frame cannot read the parent's DOM, session cookie, or same-origin-authenticated network. `postMessage` is its only channel out, and the host answers no request on it.
2. **Manifest** — a declarative block embedded in the file, read by the host outside the sandbox and never handed to the iframe: the Applet's identity, its look, the files it imports and, for a Flow node, its ports.
3. **State** — none of its own. There is no sealed per-applet store: no SQLite, no applet-private blob, no `localStorage` reachable inside the sandbox. As a Flow node, what it hands back is saved in the Flow, a space document like any other.

#### Manifest

Embedded as a `<script type="application/json" data-role="manifest">` block, parsed inertly:

```html
<script type="application/json" data-role="manifest">
{
  "version": "1.0",
  "meta": {
    "name": "3D Stage",
    "version": "0.3.0",
    "description": "Block a shot: a camera, a figure and a light on a set."
  },
  "style": "default",
  "imports": { "three": "space:tools/three/three.module.js" },
  "ports": {
    "inputs": [],
    "outputs": [
      { "id": "description", "type": "text" },
      { "id": "frame", "type": "image", "description": "The camera's view." }
    ]
  }
}
</script>
```

- **`version`** — the manifest format version (see [Format versions and safe writes](#format-versions-and-safe-writes)).
- **`meta`** — optional display identity: `name`, `description`, and a purely informational `version` (the author's own label).
- **`style`** — optional; see [Standard style](#standard-style).
- **`imports`** — optional; see [Imports](#imports).
- **`ports`** — optional; see [Applet nodes](#applet-nodes).

**`capabilities` is not part of the format.** A manifest that lists any is refused, with the reason shown, rather than run with calls that fail: an Applet's reads, model calls and writes belong to a Flow's built-in nodes. An empty list, or none, is an ordinary Applet.

#### Imports

`imports` maps module specifiers to the files the Applet imports. A path follows [Addresses and libraries](#addresses-and-libraries): an address from its root, anything else from the Applet's folder. An import is a `.js` or `.mjs` module, or a `.glb` model, in the space — never a document, never a file in a library. **An import is part of the Applet**: it travels with the Applet's space and is read with no grant, so naming one cannot read a document into the frame, and a library's file reaches an Applet only through a Flow, under a `readFile` grant. A `.glb` imports as a module whose default export is the file's bytes, as an `ArrayBuffer`. A model is always glTF's one-file form: a `.gltf` names its buffers and textures by relative URI, which the frame cannot resolve.

The host reads each import and hands it to the frame as a `data:` URL in an import map, placed after the frame's policy and before the Applet's own markup, so the frame fetches nothing. A `blob:` URL made by the host page would not do: it belongs to the page's origin, which the frame doesn't share. **An import reaches another only by bare specifier**, never by relative path, since a module loaded from a `data:` URL has no location to resolve one against; a package published as several files is bundled into one. An import that can't be read stops the Applet from opening, with the reason, rather than letting it run on part of its code.

#### Applet nodes

An Applet is a node in a Flow through the `ports` its manifest declares: `{ "inputs": [...], "outputs": [...] }`, each port `{ id, type, description }` over the Flow port types (see [Ports and types](#ports-and-types)), the optional `description` one line on what it carries. The id should follow the built-in style, lowercase snake_case, and is the pin's only name; a `label` is ignored. The node names its Applet by path rather than holding its code, so one Applet serves every Flow that uses it, a fix lands once, and a Flow holds only each use's state. A port without a usable id or type is dropped, as is a repeated id, and every input is optional. **A port id is a wire identifier for every Flow that uses the Applet**, as a built-in node's is.

**A run never executes an Applet.** The host runs it live in the node while the Flow is open and saves what it reports; a run reads those saved outputs, so a Flow holding one runs headless exactly as it runs on the canvas. A node whose Applet has reported nothing fails, naming why. An Applet node takes inputs or gives outputs, never both: outputs computed from inputs would lag the run by one execution. The host refuses an Applet declaring both as a node.

The node's config holds `appletPath`, dragged from the tree; the `appletHash` and `ports` its file had when last read, so a run and the canvas type edges without reading it; and the `state` and `outputs` it last reported, each capped at 2 MB of JSON. The client the host injects into a node's frame:

```js
pragma.state               // what the Applet last handed back, or undefined
pragma.setState(value)     // saved in the node's config, handed back on the next open
pragma.setOutputs(values)  // keyed by output port id; an image port takes a data: URL
pragma.onInputs(listener)  // called after a run with the values wired into its inputs
```

A report is checked against the declared ports, and one value of the wrong type, or for a port not declared, refuses all of it. An Applet running on its own gets inert versions of the same calls, so one file serves both ways.

`appletHash` covers the Applet file and every import it loads. The Applet's code shapes what reaches the Flow's Generate and write nodes, as a Prompt node's text does, so **a save where an Applet node already in the graph records a different hash does not carry the Flow's grants forward** (see [Capability digest](#capability-digest)), whether the code changed inside the host or outside it. A node first added is the person's own drag, and doesn't count.

#### Network

An Applet's script has no network access, and no other way out. A host refuses every request the frame can cause, not just script's own `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`: an image, script, stylesheet or font URL, and the frame navigating itself, each carry data out in the URL, and a remote script would also run code the node's recorded hash never covered. Only `data:` and `blob:` URLs, which never leave the frame, load. The exception no host can close is a WebRTC peer connection, which browsers give a page no way to deny a frame.

#### Standard style

`style` in the manifest is an optional string; `"default"` is the only value that does anything. An Applet that sets `"style": "default"` is styled by the host, which injects a stylesheet ahead of the Applet's own markup; any other value, or an absent field, leaves the Applet's CSS untouched. The stylesheet is inlined as text, never linked: a request from the opaque-origin frame carries no session cookie, so a passphrase-protected host would answer it with its login page.

**The CSS class vocabulary is the contract; its visual declarations belong to the host.** An Applet that opts in can rely on every name below being styled without supplying CSS of its own. It may also supply its own CSS. A host must style the complete vocabulary, using its own palette and appearance.

| Selector | Role |
|---|---|
| `body` | the Applet's page ground and base type |
| `.form` | the single-column body wrapper |
| `h1`, `.description` | the Applet's title and its subtitle line |
| `.field` | one labeled control: a `label` plus a `textarea` or `select` |
| `.checkbox-field` | a `.field` whose label and checkbox sit on one line |
| `button` | a bare button element, needing no class |
| `.error` | an inline failure message |

The vocabulary is deliberately small: enough for a form-shaped Applet, not a component library. Anything richer is the Applet's own CSS, which it may still declare — the host's stylesheet is placed first, so a same-specificity rule the Applet declares afterward wins by document order.

A host may only use signals available inside the sandbox to pick a light or dark rendering. A sandboxed iframe cannot see the host page's DOM, so an Applet is styled from the OS/browser preference, never from an in-app appearance setting the host exposes elsewhere.

#### Sharing

A `.applet.html` file is shared as a space document: copied, versioned in git, or dragged into another space. Its imports travel with it only when copied too. A Flow copied without its Applet shows the node as missing.

### Flows

A **Flow** is a `.flow.html` document holding a node graph: typed nodes connected by typed edges, run on demand by the host. Unlike an Applet, a Flow carries no script of its own — it is inert data. The node types are the host's, and the graph only names them.

The layering: the **Flow model** (this section) is the portable program; a graph editor is one view over it; the host's node implementations are its executable building blocks. A different editor or runtime could exist without changing the format.

A run follows [Execution and authority](#execution-and-authority); a toolkit button also follows [Actions](#actions).

#### Flow storage

```html
<!DOCTYPE html>
<html data-format="flow" data-format-version="1.0">
<head>
  <meta charset="utf-8">
  <title>Character sheet</title>
  <script type="application/json" data-role="graph">{"nodes":[...],"edges":[...],"viewport":{"x":0,"y":0,"zoom":1}}</script>
</head>
<body>

  <dl data-role="metadata">
    <dt>description</dt><dd>Builds a character sheet from a Table row.</dd>
  </dl>

</body>
</html>
```

- **`<html data-format>`** must be `"flow"`, or the file reads as an empty graph — read-only, as is one whose graph block isn't valid JSON (see [Format versions and safe writes](#format-versions-and-safe-writes)). A missing or blank file, or a blank graph block, reads as an empty graph and opens editable — a zero-byte `.flow.html` is a valid, buildable canvas. **`data-format-version`** is the format version.
- **`<head><title>`** is the Flow's display name — the only place it is stored.
- **`<dl data-role="metadata">`** is the Flow's [metadata](#metadata). No `created`/`modified` counterpart.
- **`data-role="graph"`** — the graph, in Pragma's own canonical shape, never a graph library's. Serialization is deterministic and byte-stable for unchanged content; node and edge order is array order.

A Flow has **no manifest and no `capabilities` field**: it carries no script of its own, so there is nothing for one to declare, and its [capabilities](#capabilities-and-grants) are derived from its graph.

#### Graph shape

```ts
FlowGraph {
  nodes: FlowNodeInstance[]
  edges: FlowEdgeInstance[]
  viewport?: { x, y, zoom }
  runAppModeOrder?: number      // where Run sits among App Mode's items
  runAppModeSize?: { columns, rows }  // Run's span in App Mode, in grid cells
  appModeActive?: boolean       // whether the flow opens in App Mode
}

FlowNodeInstance {
  id: string
  type: string                  // a node type; see Node types, below
  typeVersion?: string          // the type's version when this instance was created
  position: { x, y }
  config: Record<string, unknown>
  size?: { width, height }
  label?: string                // per-instance display name; absent = the type's label
  comment?: string              // one line of plain text for the node's users; absent = none
  color?: string                // "#rrggbb" node color; absent = default
  collapsed?: boolean
  mode?: "disabled"             // a run leaves the node out (see Execution); absent = it runs
  exposed?: string[]            // port ids / config keys shown in App Mode
  appModeOrder?: number
  appModeSize?: { columns, rows }  // the node's span in App Mode, in grid cells
}

FlowEdgeInstance { id, source, sourcePort, target, targetPort }
```

**`viewport` and `appModeActive` are the Flow's default view**: where its canvas opens, and whether in App Mode. A host writes them only when asked to make its view the default, never with a pan, zoom, switch of view or other save.

`config` is an unvalidated bag per node type. **Port ids and config keys are wire identifiers**: a saved edge references a port by id, so renaming a port id or config key orphans every saved graph that uses it. A built-in port's id is lowercase snake_case (`aspect_ratio`, `image_1`) and is also the name its pin shows; a form for a Flow's users may show it as words. Node labels, categories, and keywords may change freely; ids may not. `typeVersion` and `data-format-version` do not trigger migrations. The file's `data-format-version` still governs the [safe-write guard](#format-versions-and-safe-writes).

#### Ports and types

Port types are `text`, `image`, `boolean`, `object`, and `number`.

- **Types match exactly.** An edge connects ports of the same type, without coercion. Any conversion belongs to an explicit node in the graph.
- **An input accepts at most one edge.**
- **A mismatched edge is refused by the editor.** If stored in a graph, it fails its target node at run time, naming the edge.
- **An edge naming an absent port fails its target node**, naming the port. The editor draws that edge to a pin marked missing; the pin permits disconnection only, so the problem can be repaired before a run.

A **widget input** is an input port that also has an inline fallback control (a text box, a checkbox, or a select) used when nothing is connected; the fallback value lives in `config[portId]`. A plain input port with no widget is connect-only: unconnected means empty. A port may be marked `required: false` to say it is optional despite having no widget.

**Text typed on a node has its [date placeholders](#date-placeholders) filled when a run reads it**: a text box's fallback, a Prompt's or Choice's own `text`, and Add Row's values. A value that arrives on a wire is used as it arrives, and [`templateVariables`](flow-nodes.md#templatevariables) is the node that fills wired text.

#### Node types

The built-in node types are specified in [Flow nodes](flow-nodes.md), each under its type id: its ports, config, capability, and the rules it runs by. An Applet node's ports are its Applet's, not the registry's (see [Applet nodes](#applet-nodes)).

**Paths in config come only from a drag off a tree**, never typed, and are re-read fresh on every run. Every node but `loadImage`, `generateImage` and `generateVideo` takes space paths only and refuses a path naming another root. A node may also take its path from a wire (see [Wired paths](#wired-paths)).

#### App Mode

A Flow has two views over the same graph: the **graph canvas** and **App Mode**, a form of exactly the fields marked exposed, on the nodes a run doesn't leave out. Marking is per field, and only for fields that hold a value by themselves — widget inputs, outputs, config fields, and the folder/Table/image pickers — never for a connect-only socket. `exposed` on the node instance is the persisted list.

- **Inputs are editable; outputs are read-only and filled by a run.** A field output is the exception: a Prompt's or Choice's `text` passes on the node's own value, so exposing it gives a text box or dropdown for that value.
- **An exposed Applet node's `state` shows the Applet itself**, in a frame as tall as its item. The Applet fits itself to that frame.
- **Each node's exposed fields form one item**, ordered by `appModeOrder`. Run is another item, ordered by `runAppModeOrder`. Missing orders sort last in array order.
- **Editing a field edits the same `config` the canvas reads.** Run is the shared action in both views.
- **The selected view is host state.** The default view is the Flow's `appModeActive` (see [Graph shape](#graph-shape)).

**Item sizes are grid spans.** `appModeSize` gives an exposed node's item a span of `columns` by `rows`; `runAppModeSize` does the same for Run. Items fill the grid row by row in App Mode order.

- The grid has six columns, or two when narrower than 650 CSS pixels. Three columns span half the six-column row. A width at or beyond the grid's column count spans the whole row.
- Both dimensions are positive integers. Any other value reads as absent; an absent size uses the host's default for that item.
- The host determines cell heights, gaps, and defaults, and may cap `rows`. A host presenting App Mode as a list may ignore sizes.
- Sizes never reorder a run's inputs or results. The [capability digest](#capability-digest) excludes them, so resizing does not require renewed consent.

## Execution and authority

Flows combine host-provided node behavior with human-granted authority. The contract defines what a run may do, how its grants are stored and invalidated, how nodes execute, and how a toolkit action binds a run to a document. The graph format is specified under [Flows](#flows), and individual node behavior under [Flow nodes](flow-nodes.md).

### Grant storage

A grant records that a human approved one capability for one Flow, identified by its **space-relative path** at one `contentHash`, carrying a map of capability key to boolean and an optional `unattended` grant, held until revoked or through a last day (see [Execution](#execution)).

**Grants are host state, not space content, and a host must not store them inside the space.** Where it does keep them is its own business, but the record must be scoped to both the host and the space: a space that is copied, cloned, zipped or synced carries its files, and it must not carry the approvals made against them, or a capability a human allowed on one machine takes effect on another where nobody was asked.

A grant is lazy and first-use — a graph declares *possible* capabilities and the user is prompted the first time one is attempted — and user-granted, never agent-granted. Every entry is pinned to the `contentHash` it was approved at and re-checked on every use: a document changed since a human approved it matches no entry, so edited logic never inherits trust approved for different logic. The hash covers only the part of the graph that decides what a run can do (see [Capability digest](#capability-digest)).

**A path holds one entry**, which an approval at a new hash replaces. A path is compared exactly as spelled — `/`-separated, `.` and `..` resolved — and never folded by case or Unicode: two spellings of one file cost a re-prompt, but two files folded onto one path would share their approvals. A copied or moved document is a new path and is prompted fresh, an identical copy included, since its document-relative declarations name files beside it rather than beside the original. Revoking a capability removes its key and leaves the hash alone.

A host may carry an entry forward to a Flow's new hash across **a change a person makes through the host itself**, an edit or a drag: that change is their own consent, as a drag's is. Never across Applet code nobody approved (see [Applet nodes](#applet-nodes)), and never across a write no one made there: an edit from outside the host, a sync, or a rewrite the host makes on its own. Those leave the recorded hash behind, which is what makes the check worth making.

### Capabilities and grants

Paths and grant keys use [addresses and libraries](#addresses-and-libraries). Grants follow [Grant storage](#grant-storage) and are pinned to the [capability digest](#capability-digest).

A Flow's capability set is **derived, never declared**: walk the graph, ask each node a run doesn't leave out (see [Execution](#execution)) what its config requires. The declaration vocabulary is `readFile(path)`, `writeDocument(path)`, `generateText`, `readCurrentDocument`, `generateImage(folder)` and `generateVideo(folder)`, keyed as `readFile:<address>`, `writeDocument:<address>`, `generateText`, `readCurrentDocument`, `generateImage:<address>`, `generateVideo:<address>`, each the address of the path its node names. `readCurrentDocument` carries no path and means the document the run was started from. `generateImage` and `generateVideo` are each spending credits on that medium and writing the results into one folder, as one consent, and neither covers the other; like `generateText`, neither names a provider, because a node's model can arrive on a wire. Reconfiguring a node adds or drops a requirement with nothing to re-declare.

A `readFile` may name a declared library's file by its `lib:` address. **Only a raster image is read from a library**; any other library path is refused, and a host asking for such a read says that it reaches outside the space. A key holds its path's address, so granting a Flow one image from a library says nothing about any space file, and the same filename in both roots needs a grant for each.

A read against a granted `readFile`, or a write against a granted `writeDocument`, matches **by address: the target's own, or its folder's equaling a granted folder's** — flat containment, matching the folder nodes' non-recursive listing. The read returns a Table as `{ kind: "table", columns, rows }`, a raster image as `{ kind: "image", mediaType, data }` (base64), and anything else, SVG too, as `{ kind: "text", content }`. A private document of any of these kinds is refused, as every other space read refuses one.

Grants are lazy and first-use, prompted the moment a node needs one, user-granted only, and revocable per capability. A path supplied during a run follows [Wired paths](#wired-paths).

**A drag is consent.** Dragging a file out of a space or library tree onto a Flow — onto the canvas, which creates the Load node for that file's kind, or onto an existing node's drop target — records that node's declared read with no prompt. The gesture already names one specific file, in a tree the host itself renders, so a dialog asking to read the file just dragged would be asking a question the drag answered, the standing an OS file picker has. What is recorded is an ordinary grant — revocable, and covering re-reads on every later run — not an ungated read, because the path persists in the graph and outlives the gesture. It is scoped to that one file: a folder capability is never granted this way, since one drag cannot consent to an open-ended set of files, and neither can any capability other than the dropped node's own read — a note dragged onto a Write Note records nothing, and neither does a folder dragged onto a Generate Image; each node's first run asks.

### Capability digest

A grant's `contentHash` is its **capability digest** (see [Grant storage](#grant-storage)): a hash over only the part of the graph that decides what a run can do — which nodes exist, how they are wired, and every config value a node reads. A Flow cannot pin its raw file: dragging a node or resizing a card rewrites the file, and a grant has to survive that. Hashing behaviour instead of bytes means a match says the graph still does what a human approved, whoever wrote the file last.

What the digest ignores is therefore contract, not an implementation detail: node position and size, per-instance label, comment, color and collapsed state, App Mode ordering and sizes, and the viewport. A reader classifying a field it does not recognize includes it — over-prompting is a cost, and an unhashed capability-relevant field is a hole.

Which changes may carry an entry to a new digest is set in [Grant storage](#grant-storage) and [Applet nodes](#applet-nodes).

### Wired paths

A node whose [Flow nodes](flow-nodes.md) entry lists a path input, `path` or `addRow`'s `table_path`, takes its path from that input when a wire is connected, in place of its config's; a connected empty value is no path, never the config's. The value is read as a path the Flow declares, from the Flow's own folder, and asked for by its address (see [Addresses and libraries](#addresses-and-libraries)). A wire may not name an entry with a segment starting with `.`, and only `loadImage`'s may name a library's file; a path breaking either rule, or leading nowhere, fails the node before anything is asked. A path a node only shows to the person who clicked, as [`openToSide`](flow-nodes.md#opentoside)'s, is read the same way and asked for by no one: nothing reaches the Flow.

**A wired path is no declaration.** The [capability set](#capabilities-and-grants) derives from node configuration; grants follow [Grant storage](#grant-storage). The derived set can't name a path a run computes, so its grant is per file: `readFile:<address>`, a library image's included, or `writeDocument:<address>`, asked the first time a run names that file and never recorded by a drag; a folder a [`writeFolderNote`](flow-nodes.md#writefoldernote) writes into is asked for once, as `writeDocument:<address>` of the folder. A path wired into a generation's `context` asks instead for `searchContext:<address>`, the address of the folder of the scope the path sits in, so one grant covers every path that scope holds and its [context](#context-of-a-path) never reaches past that folder. A host accepts such a key only while the graph has a wire into a pin of that access, read, write or context, and only for an address in its one spelling, so a Flow that wires nothing can't be asked for a path nobody chose. A read is allowed by a granted declaration that covers it, as any read is, or by a granted key of its own address. With no person present nothing can be asked, so only a file already granted is read or written. A host lists the wired paths a Flow holds grants for beside its derived set, while a wire could use them, so each can be revoked.

### Execution

Running is always an explicit action; a graph never re-executes on an edit. Before a run the host saves the file, so [grant checks](#capability-digest) see current content.

Built-in nodes are host-trusted code. The host enforces [capabilities and grants](#capabilities-and-grants) for their reads, writes, and model calls. [Applet nodes](#applet-nodes) retain their sandbox boundary and saved-output execution model. Node code the host does not ship gets an Applet node's sandbox and recorded hash, never the built-in nodes' trusted path.

A run follows [order and failure rules](#run-order-and-failure), [disabled-node propagation](#disabled-node-propagation), [result reuse](#run-result-reuse), [node value updates](#node-value-updates), [unattended-run requirements](#unattended-runs), and [input and result rules](#run-inputs-and-results). A toolkit button also follows [Actions](#actions).

#### Run order and failure

Order is topological: a node runs once every upstream node has finished. These rules apply to the nodes included in a run (see [Execution](#execution) and [Disabled-node propagation](#disabled-node-propagation)):

- A node whose upstream node failed is marked failed with that reason and does not run.
- A node of an unknown type fails.
- A node with an incoming edge whose source and target types disagree fails, naming the edge, and every node downstream fails through the failed-upstream rule above. The value is never coerced.
- A node still unrunnable when no progress can be made is part of a cycle and fails with that reason.
- A node that needs a person fails when none is present, naming itself. It is never skipped: a skipped node's outputs would read as unsupplied, and the graph would compute something other than what the canvas computes for it. A node whose config already holds what the person would supply needs no one — `loadImage` with a stored `imagePath` runs unattended, as does an `optional` one with nothing picked.

#### Disabled-node propagation

**A disabled node never runs, and neither does any node it feeds.** A node whose `mode` is `disabled` gives nothing, and each node wired downstream of it, however far, is skipped: never run on a stand-in for the missing value, so a write downstream never empties or redirects. The graph marks what is left out, and an editor shows it, so a run still computes what the canvas shows. A skipped node has not failed, and its outputs are absent. A node left out asks for no capability, gives no toolkit button, and holds no run input or result, so App Mode shows no item for it.

#### Run result reuse

**A node may hand back a result it already has for exactly what it receives, instead of running.** Only a type whose entry says so does: [`generateImage`](flow-nodes.md#generateimage) and [`generateVideo`](flow-nodes.md#generatevideo) find their own results in their folders, and [`generateText`](flow-nodes.md#generatetext) or [`generateOptions`](flow-nodes.md#generateoptions) with `reuse` set may be answered from the host's memory of its last run. That memory is the host's and never written into the Flow; a host that keeps none calls a held node on every run. A node that reads a document or writes one never reuses: running it again is how an edit is noticed, and the write is its point.

#### Node value updates

**A node may move its own value on once a run has used it, and only an editor writes the change.** Only a type whose entry says so does, [`int`](flow-nodes.md#int), and only after a run that editor started, saved as an edit. A run started anywhere else, by a toolkit button or a caller outside the host, uses the value as stored and writes nothing into the Flow.

#### Unattended runs

**Running with nobody at the canvas is its own grant.** [Capability grants](#capabilities-and-grants) say what a run may touch, not whether one may start unwatched, so a host that runs a Flow for any caller other than the space's owner acting directly — an agent, a schedule — requires the Flow's `unattended` grant as well, and refuses the run before any node starts without it. It sits beside the capability map, never as a key inside it, is pinned to the same hash, and is created only by a human looking at that Flow — per Flow, never a global setting. It may be given through a last day, after which it allows no run.

**A run with no person present has a time limit.** When it passes, no further node starts and a model call in flight is aborted, not left to finish; each such node fails with the limit as its reason.

#### Run inputs and results

The fields exposed in [App Mode](#app-mode) define a run's public inputs and results. The [execution rules](#execution) and [grants](#capabilities-and-grants) apply to every invocation.

**A run's inputs are its exposed fields that hold a value of their own** — widget inputs, config fields, pickers, and a Prompt's or Choice's own `text`, never a socket or another output — in App Mode order, each named `<node id>.<field>`. A caller may supply values. A value applies to that run only and is never written to the file; a name the Flow does not expose is refused before any node runs; a boolean field takes a boolean, a whole-number field a whole number, and every other a string. A supplied path is checked against the grants like any other read, so an input reaches only what was approved.

**A run's results are its exposed output ports**, in App Mode order — the declaration App Mode shows, never a second notion of output that could disagree with it. A Prompt's or Choice's `text` is the exception: it passes on the node's own value, so exposing it makes an input, not a result. An exposed output whose node failed is absent, not empty. A Flow that exposes no output has no results, and a host never infers one from the graph's shape; showing every node's value is a diagnostic view, never the results.

### Toolkit resolution

Toolkit resolution runs on every read of a text document in the space; a library's documents have none. Each [Class](#classes) holding the document as a row contributes the Flows it links, in its links' order, the Classes taken in path order: natural, ignoring case. A Flow reached twice is one toolkit, at its first place, and a link that is not an existing `.flow.html` file in the space gives none. A Flow's buttons are its Button nodes (see [Actions](#actions)). No toolkit means no buttons; several are presented in that order.

### Actions

Toolkit actions follow the [execution rules](#execution), with the branch and document binding defined here.

A Flow a document's [toolkit resolution](#toolkit-resolution) reaches is a toolkit. Its buttons are its **Button nodes** — instances of [`button`](flow-nodes.md#button), the node type the registry marks as an action, that a run doesn't leave out — each labelled with the instance's `label`, or the type's label when it has none, and carrying the instance's `comment` when it has one. They are ordered top to bottom by position, then left to right; a repeated label takes ` (2)`, ` (3)` from its second use. A Flow with no Button contributes no buttons.

**A click starts at its Button**: the Button runs before any other node starts, then every node a wire reaches from it runs, with every node their inputs reach, each once. If the Button fails, as with nothing selected under its `requireSelection`, nothing else starts and nothing is asked. No other node starts, so a model call on another button's branch is never made. The graph is read fresh at the click and its grants apply as on the canvas, requested on first use.

**Where a click's work goes is an ending**: an ordinary node with no rule of its own, such as [`replaceSelection`](flow-nodes.md#replaceselection), which proposes text in place of the bound selection, [`showResult`](flow-nodes.md#showresult), which shows text under the button, and [`openToSide`](flow-nodes.md#opentoside), which opens a file beside the bound document. A click may end in several places; each ending acts when it runs, and a rejected proposal undoes no other. An ending that shows something does nothing when no one is present, and fails nothing. No ending moves the writer off the document the click was made in.

**A run is bound to the document the button was clicked in**, as it stood at the click: the whole file, unsaved edits included, and its selection. A later edit or selection change moves neither what `currentDocument` reads nor where `replaceSelection` proposes; a change the writer makes inside the text being replaced drops that proposal. A private document is refused. Switching documents stops the run. A run started anywhere else — the canvas, or a caller outside the host — has no document bound. Its results are its exposed outputs within the part that ran.

### Patch

File writes require [capability grants](#capabilities-and-grants); selection proposals use the document binding in [Actions](#actions). Each mechanism has its own semantics:

- **Flow `replaceSelection`** — propose text in place of the selected range, drawn over the live editor; nothing is written until the writer accepts it.
- **Flow `writeNote`** — write text over a whole note, behind a `writeDocument` grant for that note. A granted write is a change like any other, so it owes the note's site the pending entry and `updated` stamp an editor save does (see `publishing.md`).
- **Flow `addToNote`** — add text to a note on lines of its own, at its end or where its body starts, behind the same grant. The host reads and writes the note as one step, keeps every byte it held, and owes its site what `writeNote` does.

All are narrowly scoped one-shot writes: no inserts outside the target, no multi-file edits, no structured diff format.

### Edit paths

Two mechanisms touch a document, deliberately unrelated:

1. **Capability-gated actions** — Flows, governed by [Capabilities and grants](#capabilities-and-grants), [Execution](#execution), and [Patch](#patch). Constrained, guardrailed, one-shot, scoped to a declared or derived capability with a defined output shape.
2. **Agent copilot** — a chat-style collaborator the user talks to about the open document. It does not go through any capability taxonomy. See `architecture.md` for how it is built.

## Reference implementation

This section describes Pragma's own implementation. Source locations and configuration choices guide readers of that implementation; another host may organize its internals differently.

Pragma's text editor uses CodeMirror. Its provider connections use the kinds `anthropic`, `openai`, `google`, and `chatgpt`, with a base URL and an API key or sign-in. The `openai` kind also serves compatible endpoints, including LM Studio and Ollama; `google` is Gemini. Provider configuration is documented in the [configuration reference](../README.md#configuration), and bare-model-id resolution in [Model providers and configuration](architecture.md#model-providers-and-configuration).

The source map below is the only part of this document that names implementation files.

| Section | Source |
|---|---|
| Document kinds, extensions, shared types | `src/protocol/types.ts` |
| Frontmatter and its edits, `visibility`, `tags` list key | `src/protocol/frontmatter.ts` |
| Model resolution, provider seam | `src/protocol/modelProvider.ts`, `src/config/loadConfig.ts` |
| Generation chokepoint, prompt assembly, options parsing | `src/protocol/dispatchAction.ts` |
| Table read / write | `src/protocol/tableFile.ts`, `src/protocol/tableHtml.ts` |
| Class read / write, membership, values, fields, views, new notes, links | `src/protocol/classFile.ts`, `src/protocol/classHtml.ts`, `src/protocol/class.ts`, `src/server/classRows.ts`, `src/server/spaceClasses.ts` |
| Metadata, and the privacy it and frontmatter mark | `src/protocol/metadata.ts`, `src/protocol/privacy.ts` |
| Applet manifest read, content hash | `src/protocol/appletFile.ts` |
| Applet imports | `src/server/appletImports.ts` |
| Applet nodes: config, reports, the save rule | `src/protocol/appletNode.ts`, `web/flow/appletFrame.ts` |
| Add Row nodes: config, ports, cell text | `src/protocol/addRowNode.ts` |
| Flow read / write, node registry, capability derivation | `src/protocol/flowFile.ts`, `src/protocol/flowHtml.ts`, `src/protocol/flowNodes.ts` |
| Flow execution, node executors | `src/protocol/flowRuntime.ts`, `src/protocol/flowExecutors.ts` |
| Flow actions, and a toolkit button's run | `src/protocol/flowActions.ts`, `web/flow/toolkitAction.ts`, `web/view/toolkitRunner.ts` |
| Grant storage | `src/server/grants.ts` |
| Sandbox broker, server half (a kind's identity, declarations, reads and writes) | `src/server/sandbox.ts` |
| Declared tags, and how two tags compare | `src/protocol/tags.ts`, `src/server/spaceTags.ts` |
| Declared libraries | `src/protocol/libraries.ts`, `src/server/libraries.ts` |
| Tags written in a note, and the tags a host keeps | `src/protocol/inlineTags.ts`, `src/server/documentIndex.ts` |
| Toolkit resolution | `src/server/resolveToolkits.ts` |
| Project context, space reads, private-document refusal | `src/server/spaceFiles.ts`, `src/server/tree.ts` |
| Injected `pragma` clients, standard style, CSP | `web/services/sandboxHost.ts` |
| Sandbox broker, client half (first-use prompt, permissions, frame dispatch); the toolkit broker on it | `web/services/capabilityBroker.ts`, `web/view/toolkitRunner.ts` |
| Flow editor, App Mode | `web/flow/xyflowAdapter.ts`, `web/flow/appMode.ts`, `web/flow/appModeGrid.ts` |
| Math | `src/protocol/mathSyntax.ts` |
| Wikilink syntax, resolution and writing | `src/protocol/wikilink.ts`, `web/core/spaceTree.ts`, `web/wikilinkCompletion.ts` |
| What a note links to, and the backlinks a host keeps | `src/protocol/markdownLinks.ts`, `src/server/documentIndex.ts` |
| Scope settings | `src/protocol/scopeSettings.ts` |
| World names, and the Fountain elements they are read from | `src/protocol/worldNames.ts`, `src/protocol/fountainElements.ts`, `src/protocol/fountainSceneNumber.ts`, `web/formats/screenplay/language.ts` |
| Context of a path, and the look further | `src/server/pathContext.ts`, `src/server/contextLook.ts` |
| Descriptions, and the Fountain lines they read | `src/protocol/fountainSynopsis.ts`, `src/protocol/fountainLines.ts` |
| Date placeholders, and the clock reading they take | `src/protocol/datePlaceholders.ts` |
| HTTP routes for all of the above | `src/server/routes/file.ts` (`/api/file`, `/api/prompt/save`), `src/server/routes/sandbox.ts` (`/api/sandbox/*`), `src/server/routes/tags.ts` (`/api/space/tags`) |
| HTTP request and response shapes, shared by the routes and the web client | `src/protocol/api.ts` |
| Worked examples of each kind | `templates/space/` |
