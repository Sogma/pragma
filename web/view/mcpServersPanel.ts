import {
  fetchMcpServers,
  fetchMcpSignInStatus,
  fetchProviders,
  type McpServerRow,
  type McpSignInStatus,
  postConnectMcpServer,
  postDeleteMcpServer,
  postMcpSignIn,
  postSaveMcpServer,
  type SaveMcpServerRequestBody,
} from "../core/apiClient.ts";
import { PROVIDER_PRESET_IDS } from "../core/providerPresets.ts";
import { buildOpenRow, replaceRows } from "../lib/dom.ts";
import type { DialogService } from "../services/dialog.ts";

export interface McpServersPanelDeps {
  // Opens the Settings modal's one-level-deep drill-down subpage
  // (openSettingsSubpage in main.ts) — this panel only ever opens
  // "mcp-server".
  openSettingsSubpage: (id: string) => void;
  // Back from the form to the MCP Servers category, which re-runs its loader.
  closeSettingsSubpage: () => void;
  // After every saved change: a server on for Flows lists image models.
  onServersChanged(): void;
  // A getter, not the service: this panel is wired while Settings' markup is
  // built, which is before the dialog service exists, and nothing here needs
  // it until Remove is clicked.
  dialog(): DialogService;
}

// Labels that name the service's endpoint rather than the service, and
// second-level suffixes that sit in front of a country code.
const GENERIC_HOST_LABELS = new Set(["mcp", "api", "www"]);
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** A server's default name, from its host: `https://mcp.higgsfield.ai/mcp`
 * gives "Higgsfield", `https://api.example.co.uk/mcp` gives "Example". An IP
 * address or a single-label host is its own name. */
export function labelFromUrl(raw: string): string {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return "";
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) return host;
  const named = labels.slice(0, -1).filter((label) => !GENERIC_HOST_LABELS.has(label));
  if (named.length > 1 && SECOND_LEVEL_SUFFIXES.has(named[named.length - 1])) named.pop();
  const name = named.pop() ?? labels[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Settings → MCP Servers, over /api/mcp-servers. Like the provider list
// (providersPanel.ts), a token rests server-side in the credential store and
// never comes back, only `keySource` (docs/architecture.md's Copilot as an
// MCP client section).
//
// `root` is the whole `#settings-body`: queries span both the list
// `<section>` and the sibling form subpage.
export function wireMcpServersPanel(root: HTMLElement, deps: McpServersPanelDeps): () => void {
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const note = q<HTMLParagraphElement>("#mcp-storage-note");
  const listNote = q<HTMLParagraphElement>("#mcp-list-note");
  const list = q<HTMLDivElement>("#mcp-server-list");
  const addButton = q<HTMLButtonElement>("#mcp-add-server");
  const form = q<HTMLFormElement>("#mcp-server-form");
  const formTitle = q<HTMLHeadingElement>("#mcp-form-title");
  const trustNote = q<HTMLParagraphElement>("#mcp-form-trust");
  const urlInput = q<HTMLInputElement>("#mcp-form-url");
  const urlText = q<HTMLSpanElement>("#mcp-form-url-text");
  const nameRow = q<HTMLDivElement>("#mcp-form-name-row");
  const nameInput = q<HTMLInputElement>("#mcp-form-name");
  const nameHint = q<HTMLParagraphElement>("#mcp-form-name-hint");
  const keyRow = q<HTMLDivElement>("#mcp-form-key-row");
  const keyInput = q<HTMLInputElement>("#mcp-form-key");
  const flowsRow = q<HTMLDivElement>("#mcp-form-flows-row");
  const flowsSwitch = q<HTMLButtonElement>("#mcp-form-flows");
  const copilotSwitch = q<HTMLButtonElement>("#mcp-form-copilot");
  const signInButton = q<HTMLButtonElement>("#mcp-form-sign-in");
  const setButton = q<HTMLButtonElement>("#mcp-form-set");
  const testButton = q<HTMLButtonElement>("#mcp-form-test");
  const statusLine = q<HTMLParagraphElement>("#mcp-form-status");
  const errorLine = q<HTMLParagraphElement>("#mcp-form-error");
  const removeButton = q<HTMLButtonElement>("#mcp-form-remove");
  const formSection = q<HTMLElement>('[data-settings-subpage="mcp-server"]');

  let formServerId = "";
  let savedUrl = "";
  let editing = false;
  let knownIds: string[] = [];
  let providerIds: string[] = [];
  let copilot = false;
  let flows = false;
  let flowsAvailable = false;
  let tokenSet = false;
  let tokenUnreadable = false;
  let needsToken = false;
  let signInAllowed = false;
  let signIn: McpSignInStatus = { state: "signed-out" };
  let authorizationUrl: string | undefined;
  let pollTimer: number | undefined;
  let status: Node[] = [];
  let statusFailed = false;
  // Whether this visit to the form created the server, and the word for the
  // list's note once a pending sign-in finishes.
  let addedHere = false;
  let finishVerb = "Saved";

  const slugify = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // A fresh server's id is the slug of its name, suffixed -2, -3, … past a
  // collision. The id names its saved token and sign-in, and is the
  // `mcp_<id>_` tool-name prefix the model sees, so it never moves once created.
  //
  // Model providers share the id namespace, since an image model ref may name
  // either, so their ids and the presets' are taken too.
  function uniqueId(name: string): string {
    const base = slugify(name) || "server";
    const taken = new Set([...knownIds, ...providerIds, ...PROVIDER_PRESET_IDS]);
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  }

  const text = (value: string): Node => document.createTextNode(value);

  function signInLink(): Node[] {
    if (!authorizationUrl) return [];
    const link = document.createElement("a");
    link.href = authorizationUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open the sign-in page again";
    return [text(" "), link];
  }

  function render(): void {
    formTitle.textContent = editing ? nameInput.value.trim() || formServerId : "Add MCP server";
    trustNote.hidden = editing;
    removeButton.hidden = !editing;
    nameRow.hidden = !editing;
    urlInput.hidden = editing;
    urlText.hidden = !editing;
    urlText.textContent = savedUrl;
    // Only when the server needs a token: it said so on connecting, or it
    // takes the one already stored and has no sign-in ahead of it.
    keyRow.hidden = !needsToken && !(tokenSet && signIn.state !== "signed-in");
    setButton.textContent = editing ? "Save" : "Add";
    testButton.hidden = !editing;

    const label = labelFromUrl(urlInput.value.trim());
    if (editing || label) {
      const code = document.createElement("code");
      code.textContent = `mcp_${editing ? formServerId : uniqueId(label)}_…`;
      const lead = editing ? "Tools appear as " : `Adds as “${label}”. Tools appear as `;
      nameHint.replaceChildren(text(lead), code);
    }
    nameHint.hidden = !editing && !label;

    flowsRow.hidden = !editing || !flowsAvailable;
    flowsSwitch.setAttribute("aria-checked", String(flows));
    copilotSwitch.setAttribute("aria-checked", String(copilot));

    // A server that asked for a token has just shown it offers no sign-in.
    signInButton.hidden = !editing || signIn.state === "signed-in" || needsToken;
    signInButton.disabled = !signInAllowed || signIn.state === "pending";
    signInButton.dataset.tooltip = signInAllowed ? "" : "Signing in needs pragma dev on the machine this host runs on";
    keyInput.placeholder = tokenSet
      ? "a token is set (enter a new one to replace it)"
      : tokenUnreadable
        ? "the saved token can't be used here: enter it again"
        : "";

    statusLine.replaceChildren(...status);
    statusLine.classList.toggle("inline-error", statusFailed);
    statusLine.hidden = status.length === 0;
  }

  function setStatus(nodes: Node[], failed = false): void {
    status = nodes;
    statusFailed = failed;
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  const serverName = (): string => nameInput.value.trim() || formServerId;

  // Back to the list with a note. The form closes only if it is still what's
  // showing, so a sign-in that finishes late never closes a page opened since.
  function finish(message: string): void {
    if (!formSection.hidden) deps.closeSettingsSubpage();
    listNote.textContent = message;
    listNote.hidden = false;
    // Settings restores where the list was; an added row may sit below it.
    addButton.scrollIntoView({ block: "nearest" });
    listNote.scrollIntoView({ block: "nearest" });
  }

  function toolCount(tools: string[]): string {
    if (tools.length === 0) return "connected, no tools";
    return `connected, ${tools.length} tool${tools.length === 1 ? "" : "s"}`;
  }

  function toolSummary(tools: string[]): string {
    if (tools.length === 0) return "Connected. The server offers no tools.";
    const shown = tools.slice(0, 8).join(", ");
    const more = tools.length > 8 ? `, and ${tools.length - 8} more` : "";
    return `Connected. ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${shown}${more}.`;
  }

  // The browser finishes the sign-in out of the page's sight, so the form asks
  // until it ends, for as long as the server keeps a sign-in pending.
  function pollSignIn(id: string): void {
    stopPolling();
    const deadline = Date.now() + 10 * 60_000;
    const tick = async (): Promise<void> => {
      try {
        const latest = await fetchMcpSignInStatus(id);
        if (id !== formServerId) return;
        signIn = latest;
      } catch {
        // A failed check retries on the next tick.
      }
      if (signIn.state === "pending" && Date.now() < deadline) {
        pollTimer = window.setTimeout(() => void tick(), 1500);
        return;
      }
      pollTimer = undefined;
      if (signIn.state === "signed-in") {
        deps.onServersChanged();
        await connect({ afterSignIn: true, verb: finishVerb });
      } else {
        setStatus([text(signIn.message ?? "The sign-in didn't finish.")], true);
        render();
      }
      void load();
    };
    pollTimer = window.setTimeout(() => void tick(), 1500);
  }

  function beginSignIn(url: string, verb: string): void {
    authorizationUrl = url;
    finishVerb = verb;
    // The desktop app hands the page to the system browser (electron/main.ts).
    window.open(url, "_blank", "noopener");
    signIn = { state: "pending" };
    setStatus([text("Finish signing in in your browser."), ...signInLink()]);
    render();
    pollSignIn(formServerId);
  }

  // Connects to the saved server and says what it found: its tools, or what
  // it wants first. A sign-in it asks for starts here, and connecting again
  // once it finishes shows the tools. With a `verb`, a connection that works
  // ends the visit: the form goes back to the list.
  async function connect({ afterSignIn = false, verb }: { afterSignIn?: boolean; verb?: string } = {}): Promise<void> {
    setStatus([text("Connecting…")]);
    render();
    try {
      const result = await postConnectMcpServer(formServerId);
      needsToken = result.state === "needs-token";
      if (result.state === "connected" && verb) {
        finish(`${verb} ${serverName()}: ${toolCount(result.tools)}.`);
        return;
      }
      if (result.state === "connected") {
        setStatus([text(toolSummary(result.tools))]);
      } else if (result.state === "needs-token") {
        setStatus([text(result.message)]);
        render();
        keyInput.focus();
        return;
      } else if (afterSignIn) {
        setStatus([text("Signed in, but the server still refused the connection.")], true);
      } else {
        beginSignIn(result.authorizationUrl, verb ?? "Signed in to");
        return;
      }
    } catch (error) {
      setStatus([text(error instanceof Error ? error.message : "Couldn't connect")], true);
    }
    render();
  }

  function openForm(row?: McpServerRow): void {
    stopPolling();
    listNote.hidden = true;
    addedHere = false;
    finishVerb = "Saved";
    errorLine.hidden = true;
    keyInput.value = "";
    editing = Boolean(row);
    formServerId = row?.id ?? "";
    savedUrl = row?.url ?? "";
    urlInput.value = savedUrl;
    nameInput.value = row?.label ?? "";
    copilot = row?.copilot ?? false;
    flows = row?.flows ?? false;
    flowsAvailable = row?.flowsAvailable ?? false;
    tokenSet = row?.keySource === "stored";
    tokenUnreadable = row?.keySource === "unreadable";
    // Why the saved token can't be used, in the line a failed Save reports in.
    if (row?.keyProblem) {
      errorLine.textContent = row.keyProblem;
      errorLine.hidden = false;
    }
    needsToken = false;
    signIn = row?.signIn ?? { state: "signed-out" };
    authorizationUrl = undefined;
    if (signIn.state === "pending") setStatus([text("Finish signing in in your browser.")]);
    else if (signIn.state === "signed-in") setStatus([text("Signed in. Remove the server to sign out.")]);
    else setStatus(signIn.message ? [text(signIn.message)] : [], true);
    render();
    if (row && signIn.state === "pending") pollSignIn(row.id);
    deps.openSettingsSubpage("mcp-server");
  }

  async function onSubmit(): Promise<void> {
    errorLine.hidden = true;
    const adding = !editing;
    // A saved server's URL is fixed (the save route refuses a change), so only
    // Add reads the field.
    const url = adding ? urlInput.value.trim() : savedUrl;
    if (!url) throw new Error("Enter the server's URL");
    if (!/^https?:\/\//i.test(url) || !labelFromUrl(url)) throw new Error("Enter the server's full URL");
    const key = keyInput.value.trim();

    const label = adding ? labelFromUrl(url) : nameInput.value.trim() || formServerId;
    const id = adding ? uniqueId(label) : formServerId;
    const payload: SaveMcpServerRequestBody = adding ? { id, label, url, copilot } : { id, label };
    if (key) payload.apiKey = key;

    setButton.disabled = true;
    try {
      await postSaveMcpServer(payload);
    } finally {
      setButton.disabled = false;
    }
    deps.onServersChanged();
    if (adding) addedHere = true;
    keyInput.value = "";
    if (key) {
      tokenSet = true;
      tokenUnreadable = false;
      signIn = { state: "signed-out" };
    }
    editing = true;
    formServerId = id;
    savedUrl = url;
    nameInput.value = label;
    render();
    void load();
    // Adding or a new token need a connection before the form can close; a
    // rename does not, and connecting can open a sign-in page.
    const verb = addedHere ? "Added" : "Saved";
    if (adding || key) await connect({ verb });
    else finish(`${verb} ${label}.`);
  }

  async function onSignIn(): Promise<void> {
    signInButton.disabled = true;
    try {
      beginSignIn(await postMcpSignIn(formServerId), "Signed in to");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't start signing in";
      signIn = { state: "signed-out", message };
      setStatus([text(message)], true);
      render();
    }
  }

  // On a saved server a switch applies at once, as Settings' other switches
  // do; while adding, Copilot is saved with the server.
  async function onCopilotToggle(): Promise<void> {
    copilot = !copilot;
    render();
    if (!editing) return;
    await saveSwitch({ copilot }, () => {
      copilot = !copilot;
    });
  }

  async function onFlowsToggle(): Promise<void> {
    flows = !flows;
    render();
    await saveSwitch({ flows }, () => {
      flows = !flows;
    });
  }

  async function saveSwitch(change: { copilot?: boolean; flows?: boolean }, undo: () => void): Promise<void> {
    try {
      await postSaveMcpServer({ id: formServerId, ...change });
      deps.onServersChanged();
      void load();
    } catch (error) {
      undo();
      errorLine.textContent = error instanceof Error ? error.message : "Couldn't save the server";
      errorLine.hidden = false;
      render();
    }
  }

  async function load(): Promise<void> {
    try {
      const [data, providers] = await Promise.all([fetchMcpServers(), fetchProviders().catch(() => undefined)]);
      knownIds = data.servers.map((s) => s.id);
      providerIds = providers?.providers.map((p) => p.id) ?? [];
      signInAllowed = data.signInAllowed;
      render();
      note.classList.remove("inline-error");
      note.hidden = data.store.kind !== "safe-storage" || data.store.available;
      note.textContent = "Secure storage isn't available on this system, so tokens can't be saved here.";
      replaceRows(
        list,
        data.servers.map((row) => {
          const meta = document.createElement("span");
          meta.className = "settings-list-row-meta";
          const name = document.createElement("span");
          name.className = "settings-row-name";
          name.textContent = row.label;
          const uses = [row.flowsAvailable && row.flows ? "Flows" : "", row.copilot ? "Copilot" : ""].filter(Boolean);
          if (uses.length > 0) {
            const tag = document.createElement("span");
            tag.className = "settings-row-uses";
            tag.textContent = ` (${uses.join(", ")})`;
            name.append(tag);
          }
          meta.append(name);
          return buildOpenRow(row.id, [meta], () => openForm(row));
        }),
      );
    } catch (error) {
      // The server's reason, such as a config.json it can't read, so the
      // fix can be made by hand.
      note.classList.add("inline-error");
      note.hidden = false;
      note.textContent = error instanceof Error ? error.message : "Couldn't load MCP servers.";
    }
  }

  async function onRemove(): Promise<void> {
    const id = formServerId;
    const removed = await deps.dialog().confirm({
      title: "Remove MCP server",
      message: `“${serverName()}” is removed, with its stored token, and its sign-in is revoked.`,
      confirmLabel: "Remove",
      busyLabel: "Removing…",
      danger: true,
      action: async () => {
        await postDeleteMcpServer(id);
      },
    });
    if (!removed) return;
    stopPolling();
    deps.onServersChanged();
    deps.closeSettingsSubpage();
  }

  urlInput.addEventListener("input", render);
  nameInput.addEventListener("input", render);
  removeButton.addEventListener("click", () => void onRemove());
  copilotSwitch.addEventListener("click", () => void onCopilotToggle());
  flowsSwitch.addEventListener("click", () => void onFlowsToggle());
  addButton.addEventListener("click", () => openForm());
  testButton.addEventListener("click", () => void connect());
  signInButton.addEventListener("click", () => void onSignIn());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSubmit().catch((error: unknown) => {
      errorLine.textContent = error instanceof Error ? error.message : "Couldn't save the server";
      errorLine.hidden = false;
    });
  });

  return () => {
    listNote.hidden = true;
    void load();
  };
}
