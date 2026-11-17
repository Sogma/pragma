# Contributing

Pragma is in beta and has one maintainer. Changes land through issues: you describe the problem, the maintainer writes the code. There is no pull request queue, and that is deliberate.

## Why not pull requests

Pragma's code has a trust boundary at its centre: a space can hold documents written by anyone, including a model, and the code decides what they may touch. Every change is read with that in mind, checked against the rules in `AGENTS.md` and `docs/`, and kept in step with the spec and the template space. Doing that to a patch written elsewhere costs more than writing the change from a clear description, so the description is what Pragma asks for. Put a proposed fix in the issue, as a snippet or a diff, and it will be read as part of the report.

Keep each issue to one thing.

## A bug report

Say what you did, in order, and what you expected to happen instead. Add:

- the version of Pragma, and how you run it: the desktop app, `pragma start`, `pragma dev`, a remote-access server or another command;
- your operating system and how you installed Pragma;
- any error message, copied as text;
- the smallest document that still shows the problem, when a file is involved.

## A feature request

Describe the situation you are in and what Pragma does not let you do there. The design starts from that; a proposed solution is welcome after it.

## Security

Found a way across a boundary Pragma enforces? Report it privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

## Working with the source

Node.js 24 or later, and git.

```bash
npm install
npm run pragma -- dev path/to/a-space   # the editor from source, reloading as you edit
npm run typecheck
npm run lint
npm run check:docs
npm run test:unit
npm run test:e2e
```

The README's "From source" section covers creating a space and the desktop app. The docs in `docs/` describe formats and boundaries, never implementation; `docs/README.md` has the rules, and `npm run check:docs` enforces them.

## Licence

Anything you send, in an issue or otherwise, comes under Pragma's own licence, the [GNU General Public License v3.0 or later](LICENSE). A change to the protocol documents or the templates comes under their licences instead, which [COPYRIGHT](COPYRIGHT) lists. Nothing further is asked of you: there is no contributor agreement to sign.
