# Templates

This space's templates, listed under Presets below the file tree because `_presets.json` names this folder for templates. New ▸ Template makes a file or folder from one in the folder you choose it on, and lists Pragma's own after these. Any folder can hold templates: add it with + beside Templates under Presets.

- A file is a file template. A folder with a `README.md` is a folder template, copied whole; a folder without one groups templates into a submenu.
- `{{$title}}` takes the name you type for the copy, and `{{$date}}` today's date. `{{$date:%A, %B %-d}}` writes the date your way, with strftime's `%` codes, as the Daily Note's heading does. A template with a date and no title starts its name at today, so Enter makes the day's note.
- Write a `<hint>` for whatever you'll fill in yourself.
