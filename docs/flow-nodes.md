# Flow nodes

The built-in node types, the registry a Flow node's `type` names (see [Graph shape](protocol.md#graph-shape)), grouped by category, each under its type id. The `applet` type is the exception: its ports come from its Applet, so it is specified with Applets, under [Applet nodes](protocol.md#applet-nodes).

An entry opens with the type's label and its description, the line a host shows for the type, then lists its ports and config keys, which are wire identifiers, and the capability its config adds to the Flow's derived set (see [Capabilities and grants](protocol.md#capabilities-and-grants)). A widget input has an inline fallback, kept in the node's config under the port's id (see [Ports and types](protocol.md#ports-and-types)), and an input marked optional may go unconnected. A key the config lacks, a fallback included, reads as empty, or unchecked, unless its entry names a default. A checkbox's value is the text `"true"` or `"false"`, and a value given as a new node's is what an editor writes when it creates one. A select widget offers the values its entry lists, and a value off the list, wired or stored, is still used: an editor shows a stored one as it is, never swapping it for one. With no blank option, a blank reads as its new-node value. A path in config comes only from a drag (see [Node types](protocol.md#node-types)); a node's path input takes it from a wire instead, read and granted as [Wired paths](protocol.md#wired-paths) says. That input is always optional and named `path`, except on `addRow`, whose other inputs are its Table's column ids, where it is `table_path`. A pick stored from a live list, a folder's child or a Table's row, is never replaced when the list loses it: an editor shows it as missing, and the node fails when it runs. Only a node with nothing picked takes the list's first entry. Where each type lives in Pragma's own source is mapped in [Reference implementation](protocol.md#reference-implementation).

A path a node reads or adds to, stored or wired, with no file at it fails the node when it runs, a Table's as much as a note's: a gone file never reads as an empty one, though a blank one does. An editor that reads the path ahead of a run shows the same failure on the node, and keeps what the node recorded from the file, such as Add Row's columns, for when it is back. Every Load node hands on the file it read as `path`, from the root, `/…` or `lib:<id>/…`, so it names that file wherever it is wired, and `""` when it read none or read an image picked from the computer.

Copyright © 2026 SGM DevNet LLC and contributors. This catalog, like the [protocol](protocol.md), is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Data

### `loadRow`

**Load Row**: one row of a Table, picked on the node.

- **Outputs:** `selected: text`, `row: object`, `path: text`
- **Config:** `tablePath`, `selectedValue`
- **Capability:** readFile(`tablePath`)

`selected` is the row's first-column value, and `row` the whole row keyed by column **label**. A `media` or `path` value names its entry from the Table's folder, and is handed on from the root, `/…` or `lib:<id>/…`, so it names that entry wherever it is wired; one that names nothing is handed on as written.

### `loadRandomRow`

**Load Random Row**: a row of a Table, picked at random on every run.

- **Inputs:** `path: text` (optional)
- **Outputs:** `selected: text`, `row: object`, `path: text`
- **Config:** `tablePath`, `weightColumn`
- **Capability:** readFile(`tablePath`)

The pick is weighted by an `integer` column when `weightColumn` names one. A row whose weight is blank, non-numeric, or `<= 0` is excluded; if that excludes every row, the pick is uniform over all rows. `selected` and `row` are as for [`loadRow`](#loadrow): the row's first-column value, and the whole row keyed by column **label**.

### `loadTableRows`

**Load Table**: every row of a Table.

- **Inputs:** `path: text` (optional)
- **Outputs:** `rows: object` (a list of rows), `path: text`
- **Config:** `tablePath`
- **Capability:** readFile(`tablePath`)

Gives every row as one list, each row keyed by column **label** and its `media` and `path` values handed on from the root, as `loadRow`'s `row` is; no table configured gives `[]`.

### `getField`

**Get Field**: an object's top-level fields, as text.

- **Inputs:** `object: object`
- **Outputs:** `field_1`–`field_10: text`
- **Config:** `field{N}Key` (one per slot), `fieldSlots`

Outputs `object`'s top-level field named exactly `field{N}Key` on `field_{N}`, as text; a slot with no key outputs nothing. No key at all, a non-record input, or a missing, list or record field fails the node, never reading as `""`. `fieldSlots` lists the slots past the first that an editor shows, as numbers; a run reads every slot whatever it holds.

### `showObject`

**Show Object**: an object, shown and passed on.

- **Inputs:** `object: object`
- **Outputs:** `object: object` (passthrough)

Displays its input and passes it through unchanged, so it can sit mid-chain.

### `chart`

**Chart**: rows, drawn as a chart.

- **Inputs:** `rows: object`
- **Outputs:** `rows: object` (passthrough)
- **Config:** `chartType`, `x`, `y`

Draws its rows and passes them through: `chartType` is `bar` (the default) or `line`, and `x` and `y` name columns. Input that isn't a list of rows, a column not chosen, or one the rows lack fails the node, naming the columns the rows have.

### `addRow`

**Add Row**: one row, added to a Table.

- **Inputs:** `table_path`, then one per column of its Table, each optional
- **Outputs:** `path: text`
- **Config:** `tablePath`, `columns`, `values`
- **Capability:** writeDocument(`tablePath`)

Adds one row to the Table it names, or to the one a wire into `table_path` names, which takes the row by the same column ids. Its inputs are the Table's columns, each port's id the column's id — so renaming a column keeps its wires — kept in `columns` as a host last read the Table, so a run and an editor type edges without reading it. A host that reads the Table again records its columns as they are, and a column gone takes its wires with it. A `checkbox` column takes a `boolean`, an `integer` a `number`, and every other type `text`; a wired value is written as its cell's text, a `boolean` as `"true"` / `"false"`. With nothing wired, a column takes the text `values` holds for its id, set on the node and kept apart from its other config, since a column's id can be any string, with its [date placeholders](protocol.md#date-placeholders) filled; given neither, it gets a new row's starting value (see [Tables](protocol.md#tables)) from the Table as it is at the run. A `media` or `path` input is a path as the Flow names one, such as Generate Image's `path`, and is written as the Table names entries, from the Table's own folder by the writing rule (see [Links](protocol.md#links)), a folder keeping its `/`. The run refuses a value for a column the Table lacks, and a Table it cannot fully read, rather than write either; otherwise the write goes through the same site bookkeeping a granted `writeDocument` gets anywhere. Every run adds a row, so an unchanged run adds another. Its `path` output is the Table it added the row to, from the root, as [`writeNote`](#writenote)'s is the note.

### `int`

**Int**: a whole number, set on the node.

- **Outputs:** `int: number`
- **Config:** `value`, `control`

Gives `value`, a whole number written as text, `0` when blank; any other text, or a number beyond ±9007199254740991, fails the node. A run gives `value` as it finds it, and once a run an editor started has run the node, that editor moves `value` on by `control` and saves it: `increment` adds 1, `decrement` subtracts 1, `randomize` picks a whole number from 1 to 2147483646, and `fixed`, a blank `control` or any other leaves it. A run started anywhere else, by a toolkit button or a caller outside the host, moves nothing (see [Execution](protocol.md#execution)).

## Text

### `prompt`

**Prompt**: a fixed text, typed on the node.

- **Outputs:** `text: text`
- **Config:** `text`

Its `text` output passes on its own value, its [date placeholders](protocol.md#date-placeholders) filled, so exposing it makes a run input, not a result (see [Execution](protocol.md#execution)).

### `choice`

**Choice**: one pick from a fixed list.

- **Outputs:** `text: text`
- **Config:** `options` (one per line), `text` (the pick)

Gives its pick: one of `options`, a line each, trimmed, blank and repeated lines dropped. An empty pick is the first option, as a dropdown with nothing chosen shows. A pick that isn't one of the options fails the node: only a caller outside the host, or a hand edit, could have supplied it. The pick is checked as typed, then its [date placeholders](protocol.md#date-placeholders) filled. As a Prompt's does, its `text` output passes on its own value, so exposing it makes a run input, not a result.

### `loadNote`

**Load Note**: a Markdown note.

- **Inputs:** `path: text` (optional)
- **Outputs:** `title: text`, `properties: object`, `body: text`, `raw: text`, `path: text`
- **Config:** `notePath`
- **Capability:** readFile(`notePath`)

Scoped to `.md` files. `title` is the display title; `properties` the parsed frontmatter (`{}` when absent or invalid); `body` the rest, without frontmatter or title heading; `raw` the whole file.

### `loadFolderNote`

**Load Folder Note**: a note, picked from a folder.

- **Outputs:** `title: text`, `properties: object`, `body: text`, `raw: text`, `path: text`
- **Config:** `folderPath`, `notePath`
- **Capability:** readFile(`folderPath`)

Lists its folder non-recursively and reads the currently selected child, giving [`loadNote`](#loadnote)'s outputs. Its capability is the **folder**, so one grant covers every child, present or future, matched by address however either path is written. The child is stored as a drop of it would be.

### `templateVariables`

**Template Variables**: a text with its `{{name}}` placeholders filled in.

- **Inputs:** `source: text`, `var_1`–`var_10: text`
- **Outputs:** `text: text`
- **Config:** `var{N}Name` (one per slot), `varSlots`

Replaces each `{{name}}` in `source` with the value wired into the slot whose name is `name`, and the [date placeholders](protocol.md#date-placeholders) with the run's moment, in one pass: text a slot puts in is never read for placeholders. Names are `\w+`, and the first of two slots with one name wins. A placeholder with no matching, wired slot is left as-is. `varSlots` lists the slots past the first that an editor shows, as numbers; a run reads every slot whatever it holds.

### `joinText`

**Join Text**: three texts, joined by a separator.

- **Inputs:** `text_1: text` (text widget), `text_2: text` (text widget), `text_3: text` (text widget), `separator: text` (text widget, `", "` in a new node)
- **Outputs:** `text: text`

### `numberToText`

**Number to Text**: a number, written as text.

- **Inputs:** `number: number`
- **Outputs:** `text: text`
- **Config:** `digits`

Writes its number in decimal, a whole number padded with leading zeros to at least `digits` digits, the sign kept in front: `-7` at three digits is `-007`. `digits` is a whole number from 1 to 20, written as text; blank or anything else pads nothing, and a number with a fraction is never padded. With nothing wired it fails.

### `resolvePath`

**Resolve Path**: a path, read from one document's folder.

- **Inputs:** `base: text` (text widget), `path: text` (text widget), `as_link: boolean` (checkbox widget)
- **Outputs:** `path: text`

Reads `path` from the folder of the document `base` names, as a link written in it would be: `a.md` beside it, `../a.md` above it, `/a.md` from its root, with a `..` past the root naming nothing. A `base` ending in `/` is that folder itself, a blank one is the Flow, and `base` is read as any wired path is, from the Flow's folder. The output names the same entry from its root, `/a.md`, or `lib:<id>/a.md` in a library. With `as_link`, it is written as a link inside `base` would write it instead: relative when the two have the same closest parent scope, from the root otherwise, percent-encoded. A `path` ending in `/` keeps it. It reads nothing, so it declares no capability; a node the path is wired into asks for the file. A blank or unreadable `path` or `base` fails the node, and so does a link out of a library.

### `toggleText`

**Toggle**: one of two texts, picked by a boolean.

- **Inputs:** `true: boolean` (checkbox widget), `on_true: text` (text widget), `on_false: text` (text widget), `text: text`
- **Outputs:** `text: text`
- **Config:** `affixMode` (`prepend`, the default, or `append`)

Outputs `on_true` when `true` is truthy, else `on_false`; if `text` is connected, that input is prepended or appended to the pick, as `affixMode` says. Unconnected `text` means a pure toggle.

### `showText`

**Show Text**: a text, shown and passed on.

- **Inputs:** `text: text`
- **Outputs:** `text: text` (passthrough)

Displays its input and passes it through unchanged, so it can sit mid-chain.

### `writeNote`

**Write Note**: a text, written over a Markdown note.

- **Inputs:** `path: text` (optional), `text: text`
- **Outputs:** `path: text`
- **Config:** `notePath`
- **Capability:** writeDocument(`notePath`)

Writes its `text` over the whole of the Markdown note it names — frontmatter included — through the same write and site bookkeeping a granted `writeDocument` gets anywhere (see [Patch](protocol.md#patch)). Dragging the note on grants nothing: the first run asks to write it, as it asks for a note a wire names. Its `path` output is the note it wrote, from the root, so a node wired from it runs after the write: a [`button`](#button) whose click should save, or a node that reads the note back.

### `addToNote`

**Add to Note**: a text, added to a Markdown note.

- **Inputs:** `path: text` (optional), `text: text`
- **Outputs:** `path: text`
- **Config:** `notePath`, `affixMode` (`append`, the default, or `prepend`)
- **Capability:** writeDocument(`notePath`)

Adds its `text` to the Markdown note it names: at its end, or with `prepend` where [`loadNote`](#loadnote)'s `body` starts, below the frontmatter and title heading. The text starts a line of its own and ends with a line break, both written as the note writes its breaks, and goes in otherwise as it is. Every byte the note held is kept, and an empty text adds nothing. The note is read and written in one step, with the grant and site bookkeeping [`writeNote`](#writenote) gets, and its `path` output is the note, as `writeNote`'s is.

### `writeFolderNote`

**Write Folder Note**: a text, written as a note in a folder.

- **Inputs:** `path: text` (optional), `name: text` (text widget), `text: text`
- **Outputs:** `path: text`
- **Config:** `folderPath`
- **Capability:** writeDocument(`folderPath`)

[`writeNote`](#writenote)'s write, as the note `name` names in the folder `folderPath` or a wire names: over a note of that name, or a new one. `name` is one file name, never a path: what a file name can't hold is repaired rather than refused, a separator included, so a wired name stays in the folder, and `.md` is added unless it is there. A blank name fails the node, and so does a missing folder, which is never made. Its grant is the **folder**, asked at the first run as for a wired one, and covers every note written directly in it, present or future. `path` is the note written, from the root.

### `comment`

**Comment**: an annotation on the canvas.

- **Config:** `text`

Has no ports and does nothing at run time.

## AI

### `generateText`

**Generate Text (AI)**: a model's reply to a prompt.

- **Inputs:** `prompt: text`, `context: text` (optional), `image_1`–`image_30: image` (optional), `model: text` (text-model select widget)
- **Outputs:** `text: text`
- **Config:** `reuse`, `imageSlots`, `effort`
- **Capability:** generateText, and searchContext while `context` is wired

Makes the host's generation call: the prompt, each connected image with its pin's mention before it, such as `@image_2`, so the prompt can name it, and the chosen model. Unconnected `model` falls back to the host default. An editor shows the image pins one at a time; `imageSlots` lists those it shows, as numbers, and a run reads every pin whatever it holds. A prompt naming an empty pin fails the node.

A path wired into `context`, such as a [`button`](#button)'s, sends that path's [context](protocol.md#context-of-a-path) ahead of the prompt and lets the model look further in its scope before it replies, asked for once per scope. What went and what the model searched for are reported to whoever started the run, and while `context` is wired the node never reuses.

`effort` is how hard the model reasons: blank for its default, else `low`, `medium`, `high` or `xhigh`, sent as the nearest level the model takes, or not at all to one taking none; a host may let a look reach further at a higher level. One naming no level fails the node.

With `reuse` set, a host that remembers the node's last reply may hand it back without calling the model while everything the node receives repeats: its inputs, its config but `reuse`, and the default an unconnected `model` falls back to. A host that keeps no such memory calls the model on every run. Regenerating a held node asks the model again for it alone, on what its last run received, and the new reply is the one held from then on.

### `generateOptions`

**Generate Options (AI)**: a list of alternatives from a model.

- **Inputs:** `prompt: text`, `context: text` (optional), `image_1`–`image_30: image` (optional), `model: text` (text-model select widget)
- **Outputs:** `options: object` (a list of text)
- **Config:** `count`, `reuse`, `imageSlots`, `effort`
- **Capability:** generateText, and searchContext while `context` is wired

[`generateText`](#generatetext)'s list form: the host's options call, so `options` is parsed from the model's JSON array, never split out of free text. `count` is how many to ask for, 10 by default and at most 20; a value that isn't a whole number takes the default. `context`, the image pins, `effort`, `reuse` and Regenerating work as on [`generateText`](#generatetext), with the list in place of the reply.

### `generateImage`

**Generate Image (AI)**: an image from an image model, saved into a folder.

- **Inputs:** `prompt: text`, `image_1`–`image_30: image` (optional), `model: text` (image-model select widget), `aspect_ratio: text` (`"1:1"` in a new node, select widget: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`), `prefix: text` (text widget, `"{{$date:%y%m%d}}"` in a new node)
- **Outputs:** `image: image`, `path: text`, `file_name: text`
- **Config:** `outputFolderPath`, `seed`, `take`, `imageSlots`
- **Capability:** generateImage(`outputFolderPath`)

Makes the host's image call: `prompt`, the connected images as references in pin order, the chosen model (unconnected, the host's default image model), an aspect ratio `W:H`, either term whole or decimal, and `seed`: take N sends it plus N − 1, and a blank `seed` sends none. An editor shows the reference pins one at a time, as many as the chosen model takes; `imageSlots` lists those it shows, as numbers, and a run reads every pin whatever it holds. A model takes references as an unnamed list, so an `@image_N` in the prompt is sent as that image's place among the connected ones, in the model's own words for a reference where the host knows them and as `reference image 1` and on where it doesn't: an empty pin takes no place, and a mention of one fails the node. References past the number the model takes are left out and reported, and a mention of one of those fails the node. Its result goes into the folder `outputFolderPath` names, a space folder or a library one, and that folder comes only from a drag. A result's filename is its `prefix`, then `_` and a digest of the resolved model ref, the prompt as sent, the references' bytes, the aspect ratio and `seed`, then `_` and its take, a whole number of at least four digits, so a blank `prefix` leaves the `_` first. `take` is the take a run asks for, blank for take 1. A `prefix` is one file name, never a path, so one from a wire stays in the folder; characters a file name can't hold are repaired rather than refused, and a typed extension is dropped. A run whose inputs and take match a file already in the folder returns that file and makes no call, so nothing about a run is written into the Flow and an unchanged Run costs nothing. A match is found by what ends its name, whatever comes before: `_`, the digest in any case, `_` and the take by its number. A file carries the prefix when its name begins as the prefix typed, each placeholder standing for any value, so a run on another day finds it whatever date it has; a `prefix` it doesn't carry gets a copy of it, still with no call. Regenerating asks for a new take, one past the highest any result in the folder or job still running has for those inputs, and an editor writes it into `take`. `path` is the result's path from the root, `/…`, or `lib:<id>/…` in a library, and `file_name` its name without the extension. A setting the provider changed or ignored is reported on the node, not failed. So is what a generation cost, when the provider names a price, and the host keeps it in its record of the run; a reused result cost nothing. A provider's image job is recorded and saved as a clip's is.

### `generateVideo`

**Generate Video (AI)**: a clip from a video model, saved into a folder.

- **Inputs:** `prompt: text`, `start_frame: image` (optional), `end_frame: image` (optional), `image_1`–`image_30: image` (optional), `video_1`–`video_10: video` (optional), `model: text` (video-model select widget), `aspect_ratio: text` (`"1:1"` in a new node, select widget: `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9`), `resolution: text` (`"480p"` in a new node, select widget: `480p`, `720p`, `1080p`, `4K`), `duration: text` (`"3"` in a new node, select widget: `3`, `4`, `5`, `6`, `8`, `10`, `12`, `15`), `prefix: text` (text widget, `"{{$date:%y%m%d}}"` in a new node)
- **Outputs:** `path: text`, `file_name: text`
- **Config:** `outputFolderPath`, `take`, `imageSlots`, `videoSlots`, `removedFrames`, `modelSettings`
- **Capability:** generateVideo(`outputFolderPath`)

Makes the host's video call: `prompt`; either the frames, `start_frame` as the clip's first and `end_frame` as its last, or the references: images, shown, mentioned and sent as [`generateImage`](#generateimage)'s are, and clips, shown the same way under `videoSlots`, mentioned as `@video_N`, and sent by reference: the host reads each under the Flow's grants, fails the node when one doesn't match the digest its read gave, and sends at most 256 MiB of clips in all; the chosen model (unconnected, the host's default video model), an aspect ratio as [`generateImage`](#generateimage) takes one, `resolution`, the clip's short side as `720p`, `4K` or a frame size such as `1280x720`, and `duration`, whole seconds. An editor shows the frame pins the chosen model takes, less those `removedFrames` lists by frame, `start` or `end`, and always one with a wire. A node given both frames and references fails. A frame or reference the model has no place for, as the host's model support file says or, where it says nothing, the provider's catalog, is left out and reported, and stays out of the result's digest; a prompt naming a left-out reference fails the node before anything is sent. A setting the model changed or ignored is reported, not failed. The clip leaves by `path` and `file_name`, written as `generateImage`'s are. A result is found, named, copied and regenerated as `generateImage`'s is, its digest also taking the bytes of the frames sent, each clip's digest, the resolution, the duration and any model settings, and no seed: video models take none, so `take` never reaches the model. A clip is a job that can outlast the request waiting on it, so a host records each job as it starts: a run whose inputs and take match a recorded job waits on it instead of starting another, and the host saves a stopped run's clip, after a restart too. What the provider quoted before the job is reported on the node as a quote, since the charge can differ. `modelSettings` holds the model's own settings by its catalog's names, each only while off its default; one the model doesn't take is left out and reported. A task `mode` left unset follows the inputs, and one they can't take fails the node.

## Image

### `loadImage`

**Load Image**: one raster image.

- **Inputs:** `path: text` (optional)
- **Outputs:** `image: image`, `name: text`, `width: number`, `height: number`, `aspect_ratio: text`, `path: text`
- **Config:** `imagePath`, `optional`
- **Capability:** readFile(`imagePath`)

It reads a raster image: a PNG, JPEG, GIF or WebP. A vector image (SVG) is not one, and a stored or wired path naming it, or anything else, fails the node before anything is asked. Also accepts an OS file pick or drop, which needs no capability and persists nothing; only a tree drag stores `imagePath`. `name` is the filename without extension; `width`/`height` are decoded from the bytes. `aspect_ratio` names their ratio long side first, flipped for a portrait image: one of 1:1, 5:4, 4:3, 3:2, 16:10, 16:9, 1.85:1, 2:1, 21:9 or 2.39:1 when within 1% of it, otherwise the long side over one to two decimals (`1.46:1`, `1:1.46`). Its stored or wired path may name a library's file as well as the space's, read under the same capability; it is the one node whose wire may name a library. A wire into `path` wins over a pick from the computer as it does over a stored path. With `optional` set and nothing picked it gives no outputs at all, rather than failing, so whatever it feeds goes without, as an unwired input would.

### `loadFolderImage`

**Load Folder Image**: a raster image, picked from a folder.

- **Outputs:** `image: image`, `name: text`, `width: number`, `height: number`, `aspect_ratio: text`, `path: text`
- **Config:** `folderPath`, `imagePath`
- **Capability:** readFile(`folderPath`)

Lists its folder's raster images non-recursively and reads the currently selected one, giving [`loadImage`](#loadimage)'s outputs. Its capability is the **folder**, so one grant covers every child, present or future, matched by address however either path is written. The child is stored as a drop of it would be.

## Video

### `loadVideo`

**Load Video**: one video clip.

- **Inputs:** `path: text` (optional)
- **Outputs:** `video: video`, `name: text`, `width: number`, `height: number`, `aspect_ratio: text`, `duration: number`, `fps: number`, `path: text`
- **Config:** `videoPath`, `optional`
- **Capability:** readFile(`videoPath`)

It reads a clip, an MP4, M4V, MOV or WebM file, in the space or a library, stored or wired; a path naming anything else fails the node before anything is asked. It hands the clip on as a `video` value, by reference and never its bytes (see [Ports and types](protocol.md#ports-and-types)). `name` is the filename without extension; `width`, `height`, `duration`, in seconds, and `fps`, a variable rate's average, come from the clip's header, each left out when the header doesn't give it, and `aspect_ratio` is written as [`loadImage`](#loadimage)'s. Only a tree drag stores `videoPath`, and nothing is picked from the computer: a clip goes on as a file the host can read. `optional` works as on [`loadImage`](#loadimage).

## Editor

### `button`

**Button**: where a toolkit click starts, in the document it was clicked in.

- **Outputs:** `selection: text`, `raw: text`, `path: text`
- **Config:** `requireSelection`
- **Capability:** readCurrentDocument, only while `selection` or `raw` is wired
- **Action:** each instance is a toolkit button (see [Actions](protocol.md#actions))

A click starts here: the Button runs before any other node, then every node its wires reach and whatever those need (see [Actions](protocol.md#actions)). It hands on the document the click was made in, as [`currentDocument`](#currentdocument) reads it: `selection` (`""` when nothing is selected), `raw`, the whole file, and `path`, its path from the root. Only `selection` and `raw` read the document, so a Button that passes on just its `path` asks for nothing. With no document bound it fails, naming why, and with nothing wired from it, since a click would run nothing; with `requireSelection` it also fails when nothing was selected, before asking for any grant, and then nothing else runs. A chain that takes no value from the Button, directly or through the nodes before it, is not part of its click.

### `currentDocument`

**Current Document**: the document the run is bound to.

- **Outputs:** `title: text`, `properties: object`, `body: text`, `raw: text`, `path: text`, `selection: text`, `has_selection: boolean`
- **Config:** `requireSelection`
- **Capability:** readCurrentDocument

Reads the document the run is bound to (see [Actions](protocol.md#actions)), with [`loadNote`](#loadnote)'s four outputs over the whole file, plus its path from the root as `path`, `selection` (`""` when nothing is selected) and `has_selection`. A [`resolvePath`](#resolvepath) wired from `path` names files beside the document, wherever the Flow sits. With no document bound it fails, naming why; with `requireSelection` it also fails when nothing was selected, before asking for any grant. A click runs it when its work needs it, so it serves a branch several [`button`](#button)s share and the outputs a Button doesn't give.

### `replaceSelection`

**Replace Selection**: a text, proposed in place of the selection.

- **Inputs:** `text: text` (optional), `options: object` (optional)

Proposes its input in place of the bound selection, drawn over the document for the writer to accept or reject; nothing is written until they do. Given `options`, a list of text that wins over `text` when both are wired, it proposes them as alternatives: one shows at a time, the writer steps through them, and accepting keeps the one showing. It declares no capability: the accept is the consent, as a pick in a host-rendered picker is. With nothing wired it fails rather than proposing to delete the selection. It is the ending for changing the open document (see [Actions](protocol.md#actions)); an answer belongs in a [`showResult`](#showresult).

### `showResult`

**Show Result**: a text, shown where the run started.

- **Inputs:** `text: text` (optional), `options: object` (optional)
- **Outputs:** `text: text`

Shows its input where the run was started: under the button when a toolkit started it, a line per entry of `options` (which wins over `text`, as for [`replaceSelection`](#replaceselection)), and on its card on the canvas. It passes the lines on as `text`, joined by blank lines, so a run from outside the host gets them as an exposed output. It declares no capability, and with nothing wired it fails. It is the ending for an answer, such as a summary or alternatives to read, and for a receipt of work done elsewhere (see [Actions](protocol.md#actions)).

### `openToSide`

**Open to the Side**: a file, opened beside the document the run is bound to.

- **Inputs:** `path: text` (optional)
- **Config:** `documentPath`

Opens the file its path names in the editor beside the document the run is bound to, or beside the Flow when run from the canvas: never in that document's place, and without moving the focus, so the run goes on. The path is wired into `path` or comes from a file dragged onto the node (`documentPath`), read as [Wired paths](protocol.md#wired-paths) says and from the space only, and it asks for no grant: the file is only shown to the person who clicked, and nothing reaches the Flow. A file already open beside comes to the front there. With no one present, as in a run from outside the host, it opens nothing and fails nothing; with no path it fails. It is an ending (see [Actions](protocol.md#actions)), for a file the click made or one the writer needs beside the document.
