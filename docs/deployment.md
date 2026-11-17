# Remote access

Running Pragma as a persistent service on an always-on machine (a Raspberry Pi or similar) that your other devices reach. Pragma itself listens only on `127.0.0.1`: an HTTPS proxy on the same machine serves it to other devices, and `pragma start --external-url` names the address that proxy serves. `architecture.md`'s Runtime and hosting section describes how this relates to the other hosts. Running Pragma on one machine, with `pragma start` or the desktop app, needs none of this.

## Prerequisites

As in the README's [From source](../README.md#from-source): Node.js 24+ and git, on the host machine itself (not bundled into the app), plus an HTTPS proxy (below).

## Install

```bash
git clone https://github.com/sogma/pragma.git /opt/pragma
cd /opt/pragma
npm install   # also builds the app into dist/web/
```

## Configure

As the account systemd will run the service as (see `User=` below, not necessarily your own login), add your space to Pragma's list:

```bash
npm run pragma -- space add /path/to/your-space   # a new one: init /path/to/your-space
```

That wrote a `spaces` entry to the account's `~/.config/pragma/config.json`; set `spacePath` there too, the one space the service serves:

```json
{ "spacePath": "/path/to/your-space" }
```

Then save the passphrase every device signs in with, 15 characters or more. It asks twice, shows neither, and keeps it in a [credential record](#credential-records) of its own, never in `config.json`:

```bash
npm run pragma -- passphrase
```

All three are required. `--external-url` refuses to start without the passphrase, whatever the proxy in front restricts, so auth can't end up silently unconfigured; and it refuses a space with no `spaces` entry, for the reason below.

A new passphrase applies once Pragma restarts, and signs every device out. After 5 wrong passphrases, each doubles the next wait, from 1 second to 15 minutes, until an hour passes without one. New devices share that count; one that has signed in before keeps its own.

### The space registry

Every space has an id, and it is the join key for that space's capability approvals (`grants.json`) and its API tokens. The `spaces` map is where ids live; the key is the id and it is opaque, so any string you like will do — `"main"` is as valid as a generated one. The label is separate and editable; the id must never change once approvals exist under it.

**This target never creates an entry.** The desktop app mints one when someone picks a folder in a native dialog, and `space add` or `init` when you type one; the service has no such moment. That is deliberate: identity would otherwise be inferred from the path, and the path is precisely what changes when a space moves — so a service restarted against a moved space would quietly adopt it as a *new* space, leaving every approval and token attached to an id nothing is serving any more. You'd meet it days later as everything asking for permission again.

**So when you move a space, locate its existing entry.** Don't add a second one or change the id (`space list` shows ids):

```bash
npm run pragma -- space locate <id> /mnt/data/your-space
```

It moves `spacePath` too if that named the old folder; then restart the service. The desktop app's **Locate** does the same with a folder picker; here it's typed because a route that accepted a filesystem path would be reachable by every device the proxy serves.

**Git stays off until the space is trusted.** A repository's own config can make git run any program, so the service runs no git command in a space whose entry doesn't say `"trusted": true`. The first device to open the space is asked; to settle it in advance, add the field yourself:

```json
"spaces": { "main": { "path": "/path/to/your-space", "trusted": true } }
```

## HTTPS proxy

The proxy terminates HTTPS — browsers withhold APIs Pragma uses from a plain-HTTP page — and forwards to `http://127.0.0.1:14319`, keeping the request's `Host`: Pragma answers only on loopback names and the external URL's host, and refuses proxied requests without `--external-url`.

**Tailscale Serve** is the shortest path when your devices are on a tailnet. Turn on [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) for the tailnet, then on the host:

```bash
tailscale serve --bg 14319   # prints https://<machine>.<tailnet>.ts.net
```

Only devices on your tailnet can reach that address. Don't use `tailscale funnel`: it publishes the space to the internet with only the passphrase in the way.

**Caddy** suits a domain of your own, and obtains and renews its certificate itself. For a name only your network reaches, give it your DNS provider's token so it can prove the domain over DNS ([DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge)):

```text
notes.example.com {
	reverse_proxy 127.0.0.1:14319
}
```

Any other proxy works if it terminates HTTPS and keeps `Host`.

## Secrets

Keys, tokens, sign-ins and the passphrase rest apart from `config.json`, one record each under the config folder's `credentials/plain/`:

- A key entered in Settings crosses the network **once**, inside the proxy's HTTPS, on the request that saves it. After that it stays server-side: the panel never displays a value back, and whatever needs it (a model call, a publish) uses it here on the host.
- On this target records rest **in plain text**, guarded by file permissions. The desktop app encrypts its own through the OS keychain, and neither reads the other's records.

### Credential records

Settings writes these for you. To write one by hand:

- Stop every Pragma process using this config folder first, and give each edit a `revision` the record has not had before (`openssl rand -hex 16` makes one).
- Keep `credentials/` and every folder in it at `700`, and each record at `600`. Pragma refuses anything other accounts can read, and names the `chmod` that fixes it.
- A key serves only the endpoint its record names, written as Pragma writes it: scheme, host, a port other than the default, and path, with no trailing slash. A record without one makes Pragma name the file and the endpoint it expects.

| Credential | File in `credentials/plain/` | `endpoint` |
|---|---|---|
| Model provider key | `provider-keys/id-<id>.json` | its `baseURL`, or the vendor's: `https://api.anthropic.com/v1`, `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta` |
| Publisher key | `publisher-keys/id-<id>.json` | its `baseURL` |
| MCP server token | `mcp-tokens/id-<id>.json` | its `url` |

`<id>` is the entry's id, with each character other than lowercase letters, digits, `-` and `_` written as `%` and its byte in hex (`My Key` → `id-%4Dy%20%4Bey`). A key's record:

```json
{
  "version": "1.0",
  "kind": "provider-keys",
  "id": "anthropic",
  "revision": "9b0e1f2a3b4c5d6e",
  "state": "live",
  "endpoint": "https://api.anthropic.com/v1",
  "secrets": { "key": "sk-ant-..." }
}
```

A sign-in (ChatGPT, an MCP server's OAuth) is written only by signing in, which needs a browser on this machine: run `pragma dev` here, as the service's account, and sign in from its Settings.

### Model providers

AI features need at least one model provider configured — an Anthropic key, and/or other hosted or local (LM Studio / Ollama) models. On this target you can either:

- **Use Settings → AI Models in the app** (on every hosting target, not just the desktop app). It writes the entry into `modelProviders` and the key into its record.
- **Hand-edit `config.json`**: a `modelProviders` array, format in the README's [Configuration](../README.md#configuration) section, with each key in a record as above.

Or **leave a provider's key blank** and export `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` for the service account (systemd `Environment=`) instead; then no key is stored on disk or sent over the network at all. The provider itself must still be configured, only one with no base URL reads its vendor's variable, and a saved key that can't be used blocks the variable rather than giving way to it.

### MCP servers

The copilot's MCP servers (Settings → MCP Servers, `architecture.md`'s Copilot as an MCP client section) are HTTP endpoints, as on every target.

### Publishing

Optional — only needed to publish space content to an external service (Sogma CMS today; see `publishing.md`). Configured the same way, under Settings → Publishing, writing to a separate `publishers` array in the same `config.json`. Unlike model providers, there's no environment-variable fallback yet: a publisher's key is entered through the panel or written as its record.

## Run directly (before wiring up systemd)

```bash
npm run pragma -- start --external-url https://<machine>.<tailnet>.ts.net --port 14319
```

Confirm another device reaches it at that address before moving on to the systemd unit below.

## systemd unit

`deploy/pragma.service` is a template — copy it in and fill in the placeholders:

```bash
sudo cp deploy/pragma.service /etc/systemd/system/pragma.service
sudo systemctl edit --full pragma.service   # set User=, WorkingDirectory=, and ExecStart's node path and URL
sudo systemctl daemon-reload
sudo systemctl enable --now pragma
```

The node path matters: systemd doesn't run `ExecStart` through a login shell, so an nvm-installed node, the common case on a Pi, is almost never at `/usr/bin/node`. Run `which node` as the account in `User=` and use that full path.

`Restart=on-failure` means a crash restarts the service; it does not mean the space directory or config file need any special provisioning beyond existing at the paths above — Pragma reads them fresh on each start.

Check status/logs with `systemctl status pragma` / `journalctl -u pragma -f`.

## Updating

```bash
cd /opt/pragma
git pull
npm install   # rebuilds dist/web/
sudo systemctl restart pragma
```

`pragma start` refuses a `dist/web/` older than any file its build read, so a pull without `npm install` stops the service with a message to run `npm run build`, rather than serving a frontend out of step with the server.

## Known gaps

- One shared git identity for all edits — no per-user attribution.
- Chats stay in the window they were typed in: another device doesn't see them.
- One passphrase for the whole household, not per-person accounts.
- Agents can't reach the MCP endpoint through the proxy: it listens on loopback only (`agent-api.md`).
