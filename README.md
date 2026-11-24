<img src="web/public/images/logo.svg" alt="Pragma" width="240">

Pragma is an open protocol and local editor for AI-assisted work in a space you own. A space is a folder that keeps your writing, data, workflows, and sandboxed applications together as plain Markdown and HTML files.

Move between doing the work yourself, shaping the tools that help you, and delegating to agents. Keep the context close, the results inspectable, and the authority to act in your hands.

## Why Pragma

**Context is King. Patterns rule. First principles win.**

We want computers worthy of the human imagination. Every expansion of machine capability should bring a corresponding expansion of human agency. Write the sentence yourself. Shape the process that transforms a thousand sentences. Delegate the repetition. Step back into the work wherever judgment, curiosity, or taste demands it.

An interface should evolve with the task and the person, revealing useful controls while preserving the context that gives the work meaning. Creative work needs room for discovery: put drafts beside each other, rearrange the pieces, keep one possibility alive while exploring another. People must be able to inspect, correct, interrupt, and direct the system throughout.

**An interface may change its shape. Its promises must remain legible.**

Pragma begins with a folder, called a *space*. Its documents and tools are material you can inspect, edit, share, and carry into another environment. An open [protocol](docs/protocol.md) defines their formats, how they compose, and what authority their actions require. It gives independent implementations a common foundation. A system that cannot safely interpret a document should protect it from destructive rewriting. The ambition is work that can survive changes in its tools.

Context gives intelligence something worth working on. Patterns turn discoveries into practices. First principles let us reshape the instruments themselves. Together, they point toward a future in which people author their working environments as readily as they author their work.

Bring the unfinished novel, the impossible question, the project that refuses to fit the form. Build the instruments it deserves.

**The future should have your fingerprints all over it.**

## What a space holds

| Kind | Extension | What it is |
|---|---|---|
| Text | `.md`, `.fountain` | Markdown notes and Fountain screenplays |
| Table | `.table.html` | Rows with typed columns, edited as a grid |
| Class | `.class.html` | Notes, screenplays, and media from chosen folders, selected by a filter and shown as rows |
| Flow | `.flow.html` | A graph of typed nodes that can load documents or rows, call models, and transform text |
| Applet | `.applet.html` | A small sandboxed app with its own interface |

Classes connect documents to tools. A Class selects documents by folder, tag, or another value; its linked Flows become buttons in each document's Tools tab. Flows also run from their canvas, the command line, or an agent. The [protocol](docs/protocol.md) specifies every format.

## What you can do

- **Work across your space.** Write in two side-by-side editor groups, follow wikilinks, browse folders as galleries, and view images, video, and PDFs. Jump with Quick Open (`Mod+P`) or the command palette (`Mod+Shift+P`).
- **Work with a copilot.** Chat about what is on screen. By default, edits and new documents wait for your approval. Editing mode applies them immediately with Undo; Viewing mode changes nothing.
- **Choose your model.** Use Anthropic, OpenAI, Google Gemini, your ChatGPT plan through Continue with ChatGPT, or an OpenAI-compatible server such as LM Studio or Ollama.
- **Control what runs.** Flows ask before reading files, writing files, or calling models. Applets touch nothing on their own: what reaches one comes through a Flow. Approvals are revocable, and changing a Flow's behavior or the code of an Applet it uses withdraws them. Unattended runs require their own approval; permissions stay with the host that granted them.
- **Connect an agent.** Let Claude Code, Cursor, or another MCP client read and search the space and run approved Flows. The [agent endpoint](docs/agent-api.md) is loopback-only and token-gated, and stays off until you enable it in Settings → API Access.
- **Keep work in git.** Commit, pull, and push a space that is already a git repository.
- **Publish your writing.** Turn a folder of Markdown notes into a website through a service implementing the Sogma CMS API. See [publishing](docs/publishing.md).

## Get started

> [!NOTE]
> Pragma is in beta. APIs, the protocol, and CLI commands can change between releases.

### Desktop app

Download the Mac disk image, Windows installer, or Linux AppImage from the [latest release](https://github.com/sogma/pragma/releases/latest).

The Windows installer isn't signed during the beta, so Windows may stop it with "Windows protected your PC". Choose **More info**, then **Run anyway**.

Windows and Linux check for updates at launch; you can also use Settings → General → Check for updates. On a Mac, Check for updates reports new releases, which you download and install yourself.

### From npm

Requires [Node.js 24+](https://nodejs.org).

```bash
npm install -g @sogma/pragma

# Create a space with the getting-started example.
pragma init path/to/your-space

# Start the editor, then open the address it prints.
pragma start path/to/your-space
```

`npm install -g @sogma/pragma@latest` updates it. For access from other devices through an HTTPS proxy and behind a passphrase, see [deployment](docs/deployment.md).

### From source

Requires [Node.js 24+](https://nodejs.org) and git.

```bash
git clone https://github.com/sogma/pragma.git
cd pragma
npm install

# Create a space with the getting-started example.
npm run pragma -- init path/to/your-space

# Start the editor, then open the address it prints.
npm run pragma -- start path/to/your-space
```

`npm run electron` builds and starts the desktop app from the same checkout.

### First steps

1. **Open the example.** A new space includes `projects/getting-started/`: a Table, an Applet, two Flows, and a sample scene. In the desktop app, create a space from **Manage Spaces…** in the space switcher.
2. **Add a model.** Open Settings → AI Models, add a provider, and supply its key or sign in with Continue with ChatGPT. Then choose a model in the chat panel.
3. **Try a tool.** Open `sample-scene.md`, select a sentence, and click **Tighten** or **Expand** in the Tools tab. Accept or reject the proposed rewrite over your text.

The [getting-started guide](templates/space/projects/getting-started/README.md), also included in your new space, walks through the rest.

> [!IMPORTANT]
> History keeps what each save replaced on this computer only. Keep a separate backup, or use a git repository and push it to a remote through the Source Control view.

## Configuration

Use Settings → AI Models to manage providers and Settings → Publishing to manage publishers. These settings and the list of known spaces live in a global `config.json`:

- Linux: `~/.config/pragma/config.json`, or under `$XDG_CONFIG_HOME` when set
- macOS: `~/Library/Application Support/pragma/config.json`
- Windows: `%APPDATA%\pragma\config.json`

`PRAGMA_CONFIG_DIR` changes the configuration directory. A minimal file:

```json
{
  "spacePath": "path/to/your-space",
  "modelProviders": [{ "id": "anthropic", "kind": "anthropic", "textModels": ["claude-sonnet-5-5"] }]
}
```

Setting `spacePath` lets you run `start` without a path argument.

API keys stay outside this file. Settings stores them separately, encrypted with the OS keychain in the desktop app; desktop and command-line credentials are kept apart. Providers without a custom `baseURL` can also read their vendor's `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `AI_GATEWAY_API_KEY` from the environment when you leave the key blank.

Settings manages the other fields on every host, and a key the provider rejects changes nothing:

- `modelProviders`: `{ id, kind, label?, baseURL?, textModels?, imageModels?, videoModels?, maxTokens? }`. `kind` is `anthropic`, `openai`, `google`, `vercel` (Vercel's AI Gateway) or `chatgpt`, which signs in instead of taking a key. A `baseURL` points an `openai` entry at any OpenAI-compatible endpoint, such as LM Studio, Ollama, OpenRouter or vLLM, and a local one may be keyless; only an entry without a `baseURL` reads its vendor's variable. `imageModels` and `videoModels` are the ones Generate Image and Generate Video offer, kept apart so no text picker lists one, so a vendor serving several is one entry with one key. `maxTokens` sets a floor on each call's token budget, for verbose local reasoning models. None is built in, so an empty file offers no models.
- `defaultTextModel`, `defaultImageModel`, `defaultVideoModel`: the model a call that names none runs on, a run with no browser included. `<providerId>/<model>` names a provider; a bare text-model id works when exactly one provider lists it, and an image or video model always names its provider. With none set, such a call fails.
- `mcpServers`: `{ id, label?, url, copilot?, flows? }`, each a Streamable HTTP endpoint reached with a bearer token, an OAuth sign-in or neither. `copilot` gives the copilot its tools; `flows` lets Pragma's own nodes use it, offered only for a server Pragma has an adapter for.
- `sharing`: `{ kind: "s3", endpoint, bucket, region?, accessKeyId }`, an S3-compatible bucket (Settings → Files → Sharing) that frames and references go through for a provider that takes them only as links. Each file is reached by a link that expires after a day and deleted when its job ends. Its secret access key rests with the API keys.
- `moveToTrash`: whether Delete moves files to the trash (Settings → Files). On when absent.
- `showAllFileTypes`: whether the space lists every file, to the copilot and agents too (Settings → Files). Off when absent.
- `spaces` and `recentSpaceIds`: the registry of known spaces, `id → { path, label, trusted }`, which also records where each library a space declares sits on this machine, and the switcher's short list of ids.

Publish targets go in `publishers`, described in [publisher configuration](docs/publishing.md#publisher-configuration).

## Command line

Run each command as `pragma <command>`, or from a clone as `npm run pragma -- <command>`.

| Command | What it does |
|---|---|
| `dev [spacePath]` | Start the editor from a clone, with hot reload, for work on Pragma itself |
| `init [directory]` | Create a space with the getting-started example and add it to your spaces; defaults to the current directory |
| `space add <folder>` | Add an existing folder to your spaces without changing it |
| `space locate <id> <folder>` | Point a space at the folder it moved to, keeping its approvals and API tokens |
| `space list` | List known spaces with their ids and folders |
| `start [spacePath]` | Start the editor; `--external-url` enables access through an HTTPS proxy, behind a passphrase |
| `passphrase` | Save the passphrase for `start --external-url` |
| `run <flow>` | Run a `.flow.html` graph without the editor and print its results; `--json` prints the whole run |

## Documentation

Start with the [documentation index](docs/README.md) for formats, configuration, integrations, deployment, and architecture.

- [Protocol](docs/protocol.md) — document formats, capabilities, the `pragma` client, and Flow behavior.
- [Agent API](docs/agent-api.md) — connecting MCP clients and controlling their access.

## Privacy

Pragma has no telemetry or analytics. It contacts other services in these cases:

- **Services you add.** Model providers, MCP servers, publishers and the git remote you sync with each need your own account or key, so you accept that service's terms before Pragma sends it anything, and those terms govern what it keeps.
- **Content you view.** Videos and images that a document embeds from the web load from the sites that host them.
- **Updates.** The desktop app checks for updates at launch, unless you turn off Automatic updates.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 SGM DevNet LLC and contributors. Pragma is licensed under the [GNU General Public License v3.0 or later](LICENSE); [COPYRIGHT](COPYRIGHT) has the full notice and the files under other licences.
