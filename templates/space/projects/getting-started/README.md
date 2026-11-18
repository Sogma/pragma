# Getting started

Make a short scene, then try rewriting a passage with a toolkit.

## Try it

In Settings → AI Models, add a provider and choose a **Default text model**. These examples use that model.

1. Open [[story-expander.flow.html|Story Expander]], allow it to read the Table when asked, and choose a story starter from the dropdown.
2. Set the Story Dials: tone, pace and point of view.
3. Click **Run**, allowing AI use when asked. A short scene appears under **Scene**.

Change a dial and run again to see its effect. To add your own starters, edit [[writing-prompts.table.html|Writing prompts]]; the dropdown follows the Table's rows.

## Try a toolkit

Open [[sample-scene]], select a sentence or two in the story, and click **Tighten** or **Expand** in the Tools tab. The proposed rewrite appears over your text for you to accept or reject.

**Save summary** summarizes the whole document, saves it to `summary.md` in this folder and opens it beside your document. Its first click asks before writing; later runs replace that summary.

## Files in this example

- [[writing-prompts.table.html]]: a Table of story starters you can edit.
- [[story-dials.applet.html]]: a sandboxed Applet with its own interface. On its own it displays a line of direction; inside a Flow it passes that line through its `direction` port.
- [[story-expander.flow.html]]: a Flow combining the Table, Applet and AI generation into a form.
- [[rewrite-selection.flow.html]]: a Flow toolkit whose Button nodes give a document its **Tighten**, **Expand** and **Save summary** buttons.
- [[rewrite.class.html]]: a Class holding every document tagged `#rewrite`. It links the toolkit, giving those documents its buttons. **Filter** and **Links** show how.
- [[sample-scene]]: a note tagged `#rewrite`. Give another document that tag in its properties to give it the same toolkit.

## Look inside

In Story Expander, **Graph Mode** in the `⋮` menu shows the wiring. The starter and the dials' direction fill the Scene prompt's placeholders through Template Variables, then go to Generate and Show Text. Edit the Scene prompt's text to change what the AI is told.

In the toolkit, a click starts at its Button and runs only the branch wired after it. Each Button's comment appears on hover; right-click its node title and pick **Comment…** to edit it.

In the form, drag a tile by its title to move it or by its corner to resize it. With a title focused, Alt+Arrow and Alt+Shift+Arrow do the same.

The links here are `[[wikilinks]]`: paths read from this note's folder, with `.md` optional. Type `[[` to pick a file or folder. Picks are relative within a scope and written from the space root across scopes. A folder whose `AGENTS.md` has `pragma:` in its frontmatter opens a scope, so links within it keep working when the folder moves or opens on its own.

Delete this folder once you don't need the example anymore; nothing else in the space requires it.
