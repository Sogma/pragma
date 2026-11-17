# Security policy

Pragma is in beta. If you think you have found a vulnerability, please report it privately rather than in a public issue.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability**. The report opens as a private advisory that only you and the maintainer can see.

There is no bounty program. Reporters are credited in the release notes if they want to be.

Only the latest release is considered; please reproduce against it before reporting.

## Threat model

Pragma is a single-user, local-first tool. The trust boundary is the operating-system user account that runs it: anyone who can act as that user can read the space, the grant store and any stored secrets, and that is by design.

The boundaries Pragma does enforce, and which reports should be about:

- **Space content vs. the host.** Applets and Flows arrive in a space, written by anyone, a model included. An Applet runs sandboxed and reaches neither the host nor the space, and the network only the two ways [docs/protocol.md](docs/protocol.md#network) names: a WebRTC peer connection, and its frame navigating to the video embed's site. A file from outside reaches it only when the user hands one over, as by picking it in the browser's own file picker. A Flow reaches the space and model providers only through capabilities the user approved, pinned to what the Flow does, the code of any Applet it uses included.
- **The agent endpoint vs. the network.** The MCP/REST listener is loopback only, refuses browser origins, requires a bearer token, and a read-only token cannot write. See [docs/agent-api.md](docs/agent-api.md).
- **Remote access vs. other devices.** Pragma listens on loopback only. Under `--external-url`, the passphrase gate is the only thing between whoever reaches the HTTPS proxy and the space; every other target refuses requests a proxy forwarded. See [docs/deployment.md](docs/deployment.md).

## In scope

- Sandbox escape: an Applet reaching the network, the host or the space in any way not named above, or a Flow reaching the space without a granted capability, or beyond the path it was granted.
- Bypassing the approval pin: a Flow running under approvals given before what it does, or the code of an Applet it uses, changed.
- The agent endpoint: token or origin checks bypassed, a read-only token writing, or the endpoint reached from a web page (DNS rebinding).
- Forging or extending a remote-access session, or reaching a space through a proxy in front of a target started without `--external-url`.
- Any route that discloses stored secrets, or reads or writes outside the space (path traversal).
- The desktop updater accepting an artifact that is not a genuine release.

## Out of scope

- Anything that requires already having the user's OS account or a local shell.
- A Flow doing what the user explicitly approved it to do.
- A proxy that rewrites `Host` to a loopback name and sends no forwarding header, in front of a target without `--external-url`. Nothing marks such a request as proxied; serve through a proxy only with `--external-url`, as [docs/deployment.md](docs/deployment.md) describes.
- Gatekeeper or SmartScreen warnings on unsigned builds.
- Traffic to model providers or publishers made with the user's own keys.
- The app's own `/api/*` routes treated as a public API. They are the app's private wire contract, not a supported surface.
- Advisories in dependencies with no reachable path through Pragma. Report those upstream.
