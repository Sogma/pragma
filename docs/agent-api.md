# Agent API

Pragma serves its space to external callers over one loopback endpoint, in two encodings: **MCP** for agent harnesses — Claude Code, Claude Desktop, Cursor — and **plain REST** for everything else. Same listener, same tokens, same rules; Pragma implements the contract once and each caller brings its own UX.

## Posture

- **A separate listener.** Not a path on the server that serves the app. The app's `/api/*` is its own private wire contract, and a token honoured there would reach chat, sandbox execution, provider secrets, git and publishing — none of which "read-only" contains.
- **Loopback only, on every target**, including remote access, whose HTTPS proxy never reaches it. An agent must run on the same machine.
- **Off until switched on.** With the endpoint disabled Pragma opens no port an agent could reach.
- **Bearer tokens, never cookies.** The listener reads no session cookie, so the app's session cannot reach it and a token cannot reach the app.
- **Any browser `Origin` is refused**, and `Host` is checked against loopback when none is sent. A legitimate MCP client is not a web page; the check exists because DNS rebinding otherwise lets a malicious page reach a loopback server.
- **A request body over 4 MiB is refused** with a 413, on MCP and REST alike.
- **Never writes a Flow or Applet**, whatever the token's access. It reads and runs them, and never authors or alters executable code: a human approving what such a document may do sees what it asks for, not what changed, so an edit an agent made would ride that approval — and with unattended runs, an agent that could edit a flow could also start it.

It is not a boundary against someone with access to the machine: a token's hash and the space sit on the same disk, under the same user.

## Turning it on

Settings → API Access:

1. **Enable access.** The endpoint starts at once; no restart.
2. **Create a token.** It is shown once — only its hash is stored, so there is no second chance to read it. Name it for the client that will hold it, so revoking later is unambiguous.
3. **Leave Read-only on** when you create it, unless you have reason not to. A token's access is decided then and never widened afterwards: nothing elsewhere can change what an existing token may do, so what you granted is what it keeps until you revoke it.

A token is bound to one space, by its registry id. Relocating that space keeps its tokens working; a token minted for another space is refused even while Pragma is serving it.

## Connecting a client

The endpoint speaks MCP over Streamable HTTP at `/mcp`, on the port shown in the panel (4319 unless changed).

```bash
claude mcp add --transport http pragma http://127.0.0.1:4319/mcp \
  --header "Authorization: Bearer YOUR_TOKEN"
```

For a client configured by file — Claude Desktop, Cursor — the equivalent entry:

```json
{
  "mcpServers": {
    "pragma": {
      "type": "http",
      "url": "http://127.0.0.1:4319/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## REST

MCP is for agent harnesses. A caller that is not one — a script, a workflow tool, anything with a plain HTTP client — reaches the same space through ordinary JSON on the same port, with the same token and the same rules.

| | |
|---|---|
| `GET /space` | Name, how many files are visible, what this token may do |
| `GET /files` | Every visible file, as space-relative paths; `?folder=` for one folder's |
| `GET /files/<path>` | One file's text; `?section=` for one section of a note, by its heading |
| `GET /links/<path>` | What a note or screenplay links to, and the notes that link to it |
| `GET /search?q=…` | Lines matching a string |
| `GET /runnable` | The flows this token could run, with their inputs and outputs |
| `GET /spec` | The sections of Pragma's spec, and its node categories |
| `GET /spec/<section>` | One section of it, by heading anchor |
| `POST /files/<path>/run` | Run a runnable document, returning its results |

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4319/files/README.md
```

One namespace: a flow *is* a file, so it runs at its own path rather than through a parallel `/flows/`. **Running is not reading** — a flow can spend model budget and, with Write Note, Add to Note or Add Row nodes, change the space — so `/run` refuses a read-only token, while every `GET` serves one. A document that exists but cannot be run is refused with a 400 naming that, rather than a 404 pretending it is absent.

A flow also has to be **allowed to run unattended** — Allow in that flow's Permissions, in the editor — or `/run` refuses it with a 403. That leave is per flow, lasts the number of days picked when allowing it or until revoked, and is withdrawn by any change to what the flow does. After its last day `/run` refuses the flow the same way, naming that day. A run stops after five minutes, or as soon as its caller disconnects or cancels; nodes still running then fail naming why. A flow runs once at a time: a second run while one is going is a 409.

A run takes its flow's exposed inputs as an optional JSON body, applied to that run only and never saved. Names come from `/runnable`; an input the flow does not expose is a 400.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -d '{"inputs": {"join-1.text_1": "hello"}}' \
  http://127.0.0.1:4319/files/greet.flow.html/run
```

## Tools

The MCP encoding of the same surface. Every tool reads except `run_flow`, which is offered only to a token that may write.

| Tool | What it returns |
|---|---|
| `describe_space` | The space's name, how many files are visible, and whether this token may write |
| `list_space_files` | Every visible file, as space-relative paths, or one folder's |
| `search_space_files` | Lines matching a string, across visible documents |
| `read_space_file` | One file's text, by space-relative path, or one section of a note by its heading |
| `list_space_file_links` | What a note or screenplay links to, and the notes that link to it |
| `list_runnable_flows` | The flows allowed to run unattended, with their inputs and outputs |
| `read_pragma_spec` | One section of Pragma's spec, by heading anchor |
| `run_flow` | Runs one, with optional inputs, returning its outputs; image outputs come back as images |

**Visible** is narrower than "inside the space", and the same in every tool. A dot-prefixed folder never appears — so `.trash/` and `.git/` are not listed — and a document with `visibility: private` in its frontmatter, or frontmatter that doesn't parse, is excluded from listing, search, and reading alike. What a tool will not list it will not read: naming such a path directly answers the same "no such document" as naming one that does not exist.

Raster images, video and PDFs are listed but not readable as text, and a search returns a bounded number of matches. A note's section is named by its heading or that heading's anchor and comes with its subsections; a link is counted only between visible files.

**The spec** is `protocol.md` and its Flow node catalog, `flow-nodes.md`, as this install ships them — the formats and rules a space's documents follow — not space content, so it reads the same to every token. A section comes with its subsections, and any heading's anchor names one, a node type's being its type id, so a model can follow the spec's own links.

## Revoking

Settings → API Access → Revoke, on the token's row. It stops working at once, and no other token is affected — which is the reason tokens are separate records rather than one shared key.
