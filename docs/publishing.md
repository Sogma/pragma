# Publishing

Pragma is local-first: nothing leaves the machine unless a feature explicitly sends it somewhere. Publishing is that exception — a deliberate, user-triggered push of one markdown document at a time to an external service.

The publishing protocol is Sogma CMS's HTTP API: a service that implements it is a publish target, and Pragma knows nothing about a particular one beyond that contract. The wire contract itself (auth, resource shapes, idempotency, error codes) is that API's own spec, `public-api.md`, and is not restated here. This doc covers what Pragma commits to on the space side.

## Sites

A **site** is a space folder that contains a `_site.json` file. Site-ness is that file's presence, nothing else; a site can sit at any depth in the space.

```
my-blog/
  _site.json           { id, slug, name, domain?, primaryDomain, publisherId?, assetsFolder? }
  _queue.json          unsynced changes, present only when non-empty
  index.md             the site's home page
  about.md
  posts/
    index.md           the section's own page
    first.md
```

- **`_site.json`** holds the service-assigned `id` and `slug`, a copy of the site's `name` (the service holds it), the requested `domain`, the `primaryDomain` the service reports (`null` until one is live), and `publisherId` — which configured publisher the site lives on, and the one every later call about it goes to. `assetsFolder`, when set, is a site-relative folder that images pasted or dropped into a document under the site are copied into; unset, or naming a folder that is missing, they land beside the document. It never leaves the space.
- **The site folder is the published tree**, with no intermediate folder between the two: a document's path under the site root is its path on the site. A folder that should not publish belongs outside the site, not inside it under a different name.
- **Every folder's representative document is `index.md`**, uniformly at every depth including the site root. There is no separate home-page filename.
- **Only markdown publishes.** `_site.json`, `_queue.json`, and any other kind of file in the folder are Pragma's or the author's own; nothing sends them, so a folder of assets beside the pages is inert rather than disallowed.
- A site nested inside another site is not disallowed; site resolution picks the nearest ancestor.

## Publisher configuration

Publish targets live in the global config's `publishers` array, one entry per service:

```json
{ "publishers": [ { "id": "sogma", "kind": "sogma", "label": "Sogma CMS", "baseURL": "https://api.sogma.com/v1" } ] }
```

`kind` names the protocol the endpoint speaks, not the service running it: `"sogma"`, a closed union of one, covers Sogma's own API and anything else implementing it, told apart only by `baseURL`. `id` is what the rest of the space refers to a publisher by — it is a site's `publisherId` — and nothing reserves one, so a space can hold several entries of the same kind, whether separate services or separate deployments of one.

The key is held server-side only, in a record of its own bound to the publisher's `baseURL`: owner-only plain text on the CLI targets, encrypted through the OS keychain on the desktop app (`deployment.md`). Settings → Publishing adds, edits and removes entries; setting a key first probes `{baseURL}/sites` with it and refuses a key the service answers with 401 or 403. Publishers are a separate array from model providers, keys apart, never a variant of them.

Every call about a site — publishing a document under it, unpublishing one, reading or writing its settings — goes to the publisher its `_site.json` names. A `_site.json` with no `publisherId` resolves to the first configured publisher. One naming a publisher that is not configured is an error, never a fall back to another entry: publishers are separate services, so the wrong one would publish the document somewhere the author never chose.

## Creating a site

Right-clicking a folder in the space tree offers **New Site** when at least one publisher has a key stored; the form asks which publisher to use when more than one does. Submitting a name (and optional domain) runs, in order:

1. Create the site on the service with a fresh idempotency key.
2. Create the local folder, named by the **returned slug**, not the typed name.
3. Write `_site.json`.
4. Write `index.md` containing `# <name>`.

If any local step fails, Pragma deletes the just-created site remotely (it is always empty at that point). If that delete itself fails, the error names the orphaned site and a retry finishes only the local steps against it rather than creating a second one.

## Frontmatter fields

A document under a site carries these keys, all maintained by Pragma:

| Key | Set when | Meaning |
|---|---|---|
| `id` | first publish | The service's opaque document id. Never parsed or validated; round-tripped verbatim on every later publish. Doubles as the `parent_id` a child document sends. |
| `pushed` | every publish | The service's own `updated_at` for that publish. |
| `created` | first save | Set once, then left alone. |
| `updated` | every save | Refreshed on each save. |
| `date` | first publish, or by the author | The publication date: the date the page is listed and dated under on the site. |
| `visibility` | by the author | `unlisted` publishes as unlisted; anything else as `public`. `private` excludes the document from publishing entirely (see `architecture.md`'s Privacy section). |

Three dates, never interchangeable. The **publication date** (`date`) is editorial, may lie in the past or the future, and is the only one sent. **Pushed** is when Pragma last sent the document, written only from the service's response. `created`/`updated` are local bookkeeping. The body sent is the markdown after frontmatter is split off, with a leading `# Heading` lifted out as `title` so it is not shown twice. It travels as `content` with `content_format` set to `markdown`; Pragma sends no other format.

A duplicate, or a copy made from a template, drops `id` and `pushed`, so its first publish creates a new page.

**Params.** A key the publisher's `DocumentParams` schema lists goes out in the page's `params` under the same name, its value as written: `anchor: v0.6.1` is sent as `"params": { "anchor": "v0.6.1" }`. Pragma keeps no list of its own, so a key the service adds needs no Pragma release, and a key it doesn't list stays in the space. Empty text sets nothing, as an empty `date` does. Any other value, a bare `anchor:` included, goes out as written, and a value the service refuses fails the publish, naming the property. Every publish sends the whole set, so a key taken out of the frontmatter leaves the page. A publisher whose API description lists no `DocumentParams`, or that serves none, gets no `params`. A publish that can't read the description, and has none cached from earlier, is refused rather than sent without them.

## Publishing a document

A document is **eligible** when it is markdown, not `private`, and anywhere inside a site's folder. Location is not a way to hold a markdown document back: everything under the site offers the control, and keeping one out means moving it above the site root or marking it `private`. An eligible open document shows a **Publish** control in the context panel of the assistant's Tools tab, labeled **Update** once the document carries an `id`. Nothing publishes on save; a push is always this explicit action.

**Every publish** resolves, in this order:

- **Site** — walk up from the document's folder to the nearest `_site.json`.
- **Parent** — the `id` in the containing folder's own `index.md` frontmatter. A folder's own `index.md` looks one level further up. A document directly under the site root, or a top-level section's own `index.md`, has no parent. When the parent `index.md` has no `id`, it is published first, by these same rules, so a missing ancestor at any depth is published outermost first. A parent `index.md` that does not exist is created as a bare `# <folder name>` heading before it is published. A `private` parent refuses the publish.
- **Slug** — `index` for the site's own root `index.md`; the folder's name for any other `index.md`; the filename for everything else. Slugified as lowercase with runs of non-alphanumerics collapsed to a single hyphen, `untitled` as the last-resort fallback.
- **Title** — the leading `# Heading`, else the filename.

A document with no `id` is then created with a fresh idempotency key; one with an `id` is updated. Either way `id` and `pushed` are written back into the frontmatter as it stands when the service answers, so a save made meanwhile survives and leaves the document pending. The returned URL is shown, never stored: a domain change or an ancestor's move would stale it.

**Publication date** travels as `published_at`, as written: a `YYYY-MM-DD` date or a timestamp with an offset, validated by the service. It is the page's dateline and schedules nothing. A first publish with no `date` key writes and sends the local day as `YYYY-MM-DD`, except on an `index.md` (a section or the home page), which stays undated. An empty `date` counts as set, so a cleared date stays cleared. Otherwise an absent or empty `date` is no date: a create omits `published_at`, and an update sends `null`, clearing the service's copy. A non-text `date` refuses the publish. The properties editor edits `date` with a date picker that replaces only the leading date, keeping a timestamp's time and offset.

**Update** sends `parent_id`, `slug`, `title`, `content`, `content_format`, `visibility`, `published_at` and, when the publisher takes them, `params` against the existing `id`. `parent_id` is always sent, `null` for a top-level document, and a parent different from the one the service holds moves the document there: the space folder decides where a page lives, so a document moved in the space moves on the site at its next publish, taking its URL and every URL beneath it along, with no redirect left behind. The site is fixed at creation and never resent. Last write wins; there is no optimistic concurrency.

## Site settings

Settings live on the service, not in the space, except the site's `assetsFolder`, which lives in `_site.json`. Nothing about the service's settings is mirrored locally, and their field set is not hardcoded: Pragma reads the service's own settings schema and renders whatever it describes, so a setting the service adds appears without a Pragma release.

A **Settings** item on each site's row in the Websites panel opens the dialog, offered only when a publisher key is stored. Its title names the site and the publisher it is bound to. It has the same category-list layout as Pragma's own Settings: **General** holds the site's name and assets folder, and each group the schema names is a category of its own.

- **One Save, on every page, writes only what changed, all or nothing.** The name and the changed settings go to the publisher in one request, the settings as a merge patch, so anything untouched stays as the service holds it, including settings this Pragma never drew. Emptying a field clears that setting. Only once the publisher accepts are the name it stored, trimmed, and the assets folder written to `_site.json`, the folder created then; an assets folder alone never reaches the publisher. Closing discards unsaved edits.
- **The name is the publisher's.** The dialog opens on it and puts `_site.json`'s copy right when the two differ.
- **Field descriptors** come from the schema: label, placeholder, and grouping. Only a toggle shows its help text. Categories follow the schema's own order, so a service puts Identity above Analytics by declaring it first.
- **A toggle** is a boolean, drawn as a switch and sent as `true` or `false`; unset reads as off.
- **An image setting** is a string marked `x-sogma-ref: "file"`: the `public_id` of an image file the site holds. It is drawn as a picker offering the images in the site folder; the one chosen is uploaded as publishing uploads an embed, and Save sends its `public_id`. The current image's preview comes from the site's file list, matched on `public_id`.
- **Nothing the service holds is validated locally.** The service validates, and a rejected write names the offending field, which the dialog reports against that field's label. Restating the service's rules here would only let them drift.
- **The schema is cached** for the life of the process against the ETag it was served with, and revalidated on every open.

## Images

An image embedded in a document is uploaded to the site, and the body that goes over the wire carries a reference the service resolves when it renders the page. **The file in the space is never rewritten**: it keeps the relative embed the author wrote, so it still renders in Pragma and in any other Markdown tool, and it still survives either file moving.

- **Only an embed is rewritten.** A link whose target happens to be an image is prose about a file, not a picture on the page, and is left exactly as written.
- **An embed resolves the way the note reads it** — relative to the document, or a `lib:<id>/…` path into a library located here. Publishing reads only the library files a published document embeds, never listing one; a library not located here is reported like a missing file, and any other scheme is left as written. A site setting's image, which no embed names, comes from the space only.
- **Only the raster and vector images Pragma recognizes are carried.**
- **Identical bytes upload once.** Within a document, one image embedded several times and two paths holding the same bytes both send once. Across publishes, the digest of each image is offered to the service, which answers with the file it already holds rather than taking the bytes again.
- **Images go up before the document does**, though not because the format demands it: a reference resolves whether or not its bytes have arrived. The order is so that an upload failing after the page went live cannot leave an image that never appears and nothing to say so.
- **Nothing waits for verification.** The service checks an upload after accepting it, and a file that fails renders as its alt text rather than as a broken image, which is worth more than holding every publish open.
- **Nothing local records what was uploaded.** The service is the only register of what a site holds, and a republish re-derives it from the bytes on disk.

An image over the publisher's size ceiling refuses the publish, naming the file, rather than quietly dropping it from the page. Pragma's own ceiling is only a pre-flight, spared upload; a refusal from the service reports the cap the service names, since its limits move and Pragma's copy of them can be stale. An embed that cannot be uploaded for any other reason — a missing file, an unsupported kind, a path outside the space — is left as written and reported, so one stale reference does not stop the rest of a page going out. Publishing also reports any image it sent from outside the site folder, since the site folder is otherwise the whole of what a site publishes.

## The pending queue

`<site>/_queue.json` is a list of what the site has locally that the service does not:

```json
[ { "op": "publish", "id": "doc_…" }, { "op": "publish", "path": "my-blog/new.md" }, { "op": "delete", "id": "doc_…" } ]
```

An entry is keyed by `id` whenever the document has one, and by `path` only for a document that has never been published; a move or rename carries a `path` entry to the queue of the site the document lands in, if any, and a delete drops it. An empty queue means no file.

What adds an entry:

- Saving an eligible document adds a `publish` entry — every save, no diffing. Any write to the document counts as a save, not only one a human typed: an assistant's edit and a granted `writeDocument` from a Flow queue it and refresh `updated` the same way. A link rewrite after a move is the one exception, below.
- Deleting a published document adds a `delete` entry, captured before the local delete runs (the last moment the `id` exists). A deleted folder does this for every published markdown file under it. Pragma then attempts the remote delete immediately; whatever fails stays queued, and the delete's result reports how many remain. The local delete always proceeds.
- Moving or renaming a published document adds a `publish` entry for it, since its slug or its parent changed. A moved or renamed folder does this for its own `index.md`; the pages under it follow their parent on the service. The links other documents hold to what moved are rewritten too, and each rewritten document in a site gets a `publish` entry, since its text changed. Unlike a save, a rewrite leaves the document's dates alone: its writer didn't edit it.

What removes an entry: a successful publish or update clears every entry matching the document's `id` or `path`.

Nothing lists the queue back to the user, and there is no retry loop; the queue only grows and shrinks through the triggers above.

## Not yet implemented

- **A distinct reaction to a 404 on update** (the remote document was deleted). It surfaces as a plain error rather than an offer to re-publish under a new id.
- **Standalone Unpublish** for a document that stays in the space. Unpublish only happens as a side effect of deleting the file.
- **Relative links to other pages** inside the markdown body. A link to another document is sent as written and does not become that document's published URL. Images are carried (see Images above); links are not.
- **Site management beyond creation and renaming** — re-parent or delete a site from the UI.
- **A queue UI** and automatic retry.
- **Publishing non-markdown kinds.** The control is gated to markdown documents.
