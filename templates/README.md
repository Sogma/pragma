# Templates

Starter content Pragma copies: a whole space when it creates one, and one of its own templates when New ▸ Template makes something from it. Not source, and not fixtures — everything here is shipped to users as-is.

## `space/`

The space scaffold. `pragma init`, the first-run questions of `pragma start` and `pragma dev`, the Manage Spaces modal, and the desktop app's create-space flow all copy this directory into the new space (`src/protocol/scaffoldSpace.ts`), so **anything you change here is what the next person sees the first time they open Pragma** — including a stray file you did not mean to ship.

The desktop app's Example projects switch, and the same question on the command line, can leave the worked examples out: the folders in `space/projects/`, the README lines that link into them, and the tags in `_tags.json`, which only their Classes use. Everything else is copied as is. Keep each example's links to it on their own lines of the README, so leaving it out leaves no dead link.

One file a new space gets is *not* here: `.gitignore`. Every packager mangles that name — electron-builder drops it, npm rewrites it — so `scaffoldSpace.ts` writes it out instead. Edit it there.

`space/projects/getting-started/` is a worked example of how Pragma's document kinds fit together: a Table, an Applet, two Flows and a Class that reference each other, and a sample note to try the toolkit's buttons on. It doubles as the reference corpus the format spec points at (see `docs/protocol.md`). Two things follow:

- **It has to stay true.** When a format or a client API changes, update the example in the same change. An example that no longer works is worse than no example, and this one is what new users copy from.
- **It has to stay small.** It is a first impression, not a feature tour. New users delete this folder when they are done with it; anything that belongs in the docs belongs in the docs.

`space/projects/translation/` puts the same kinds to work on one professional's job, a translator's: a brochure to translate, the client's style guide that both of its toolkits read, a query sheet a Flow adds rows to, and a Class that gives the brochure its buttons. It is the example to show someone who asks what Pragma would do for their own work. It follows the same two rules, and stays one job rather than every tool a translator could want.

`space/_templates/` is the space's own templates, one of each kind: a Daily Note file template, dated by `{{$date}}`, and a Project folder template, titled by `{{$title}}`, with a `README.md` explaining both. It stays true and small for the same reasons, and twins none of `builtin/`'s, or New ▸ Template would list one twice.

## `builtin/`

Pragma's own templates, offered under New ▸ Template after a space's own and read by the same rule as a space's `_templates/`: a file is a file template, a folder with a README a folder template, and a folder without one a group. A file or folder added here is offered with no other change, and copied only into the folder New was chosen on, never into a new space.

- **Each stays a skeleton.** Pragma fills in `{{$title}}` and `{{$date}}`; anything a writer fills in is a `<hint>`. Sample content, which every copy makes its writer rename or delete, earns its place only by showing how the template works, as the Screenplay's placeholder character does: its opening scene's cue links it.
- **An empty folder holds a `.gitkeep`**, since git keeps no empty folder. A copy leaves the dotfile out and keeps the folder.
- **`Scene.fountain` is the scene `Screenplay/scenes/` starts with.** Change one, and change the other to match.

## Adding a template

A new directory here is not picked up automatically — `scaffoldSpace.ts` names `space/`, and `src/server/templateCopy.ts` names `builtin/`. It also needs an entry in `electron-builder.yml` if it lives outside the paths already listed there, or it will be missing from packaged desktop builds while working fine in development.
