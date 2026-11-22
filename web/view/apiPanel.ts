// Settings → API Access: the agent endpoint's switches and its tokens.
//
// Server-side, like the provider, publisher and MCP server lists: these
// are not this browser's preferences, they are what an external client is
// allowed to reach. The panel never receives a token value — one is shown
// exactly once, at creation, and only its hash is stored.
import {
  type ApiSettingsResponse,
  type ApiTokenRow,
  fetchApiSettings,
  postApiSettings,
  postCreateApiToken,
  postDeleteApiToken,
} from "../core/apiClient.ts";
import { dateLabel } from "../lib/dateText.ts";
import { buildRevokeButton, el } from "../lib/dom.ts";
import type { DialogService } from "../services/dialog.ts";

export interface ApiPanelDeps {
  dialog: DialogService;
  // The Settings modal's one-level-deep drill-down subpage — this panel only
  // ever opens "api-token". Closing it re-runs this panel's loader.
  openSettingsSubpage: (id: string) => void;
  closeSettingsSubpage: () => void;
}

export function wireApiPanel(root: HTMLElement, deps: ApiPanelDeps): () => void {
  // Shown once and never again: only the hash is stored, so a dialog implying
  // otherwise would be lying — and the one chance to copy it has to be easy to
  // take. Built with `open` rather than `confirm`: a confirmation always draws
  // a cancel button, and there is nothing here to cancel.
  function revealSecret(label: string, secret: string): Promise<void> {
    const body = el("div", "dialog-body");
    // The panel is sized to fit a token on one line; break-all is the fallback
    // for a narrow window, since wrapping beats putting the end of it behind a
    // horizontal scrollbar.
    const value = el("code", "api-token-value", secret);
    const warning = el("div", "inline-warning", "Copy it now. This is the one time it can be shown.");

    const actions = el("div", "dialog-actions");
    const copy = el("button", "btn btn-large", "Copy");
    copy.type = "button";
    const done = el("button", "btn btn-large primary-fill dialog-primary", "Done");
    done.type = "button";
    actions.append(copy, done);
    body.append(value, warning, actions);

    const handle = deps.dialog.open({
      title: `Token for ${label}`,
      content: body,
      className: "dialog-token-reveal",
      // Done is the only way out: Escape or a stray click on the scrim would
      // discard the one chance to copy it.
      onEscape: () => true,
      closeOnBackdrop: false,
    });

    let resetTimer = 0;
    copy.addEventListener("click", () => {
      navigator.clipboard
        .writeText(secret)
        .then(() => {
          copy.textContent = "Copied";
          window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(() => {
            copy.textContent = "Copy";
          }, 1200);
        })
        // A refused clipboard must not look like a successful copy: select the
        // token so it can be copied by hand instead.
        .catch(() => {
          copy.textContent = "Press Ctrl+C";
          getSelection()?.selectAllChildren(value);
        });
    });
    done.addEventListener("click", () => handle.close());
    return handle.closed;
  }

  const confirmRevoke = (label: string): Promise<boolean> =>
    deps.dialog.confirm({
      title: "Revoke token",
      message: `“${label}” stops working immediately. Any client using it will need a new one.`,
      confirmLabel: "Revoke",
      danger: true,
    });

  const q = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector) as T;
  const enabled = q<HTMLButtonElement>("#api-enabled");
  const port = q<HTMLInputElement>("#api-port");
  const restartNote = q<HTMLElement>("#api-restart-note");
  const list = q<HTMLElement>("#api-token-list");
  const addButton = q<HTMLButtonElement>("#api-add-token");
  const errorLine = q<HTMLElement>("#api-error");
  const formSection = q<HTMLElement>('[data-settings-subpage="api-token"]');
  const form = q<HTMLFormElement>("#api-token-form");
  const nameInput = q<HTMLInputElement>("#api-token-name");
  const readOnlySwitch = q<HTMLButtonElement>("#api-token-read-only");
  const createButton = q<HTMLButtonElement>("#api-token-create");
  const formError = q<HTMLElement>("#api-token-error");

  let current: ApiSettingsResponse | undefined;

  function showError(thrown: unknown): void {
    errorLine.textContent = thrown instanceof Error ? thrown.message : String(thrown);
    errorLine.hidden = false;
  }

  // The endpoint applies changes as they are made, so this note is for the
  // cases where it could not: a port already in use leaves the endpoint
  // stopped rather than silently moving, and the error line says why.
  function renderRestartNote(settings: ApiSettingsResponse): void {
    const running = settings.runningPort;
    if (settings.enabled && running === undefined) {
      restartNote.textContent = "The endpoint is not running. Check the port, or restart Pragma.";
    } else if (running !== undefined && running !== settings.port) {
      restartNote.textContent = `Still listening on port ${running}.`;
    } else {
      restartNote.hidden = true;
      return;
    }
    restartNote.hidden = false;
  }

  function renderTokens(tokens: ApiTokenRow[]): void {
    list.replaceChildren();
    for (const token of tokens) {
      const row = el("div", "settings-list-row");
      const meta = el("div", "settings-list-row-meta");
      meta.append(
        el("div", "settings-row-name", token.label),
        el(
          "div",
          "settings-row-sub",
          `Space: ${token.spaceLabel} · ${token.access === "read-write" ? "Read-write" : "Read-only"} · created ${dateLabel(token.createdAt)}`,
        ),
      );
      const revoke = buildRevokeButton(token.label, async () => {
        if (!(await confirmRevoke(token.label))) return;
        try {
          await postDeleteApiToken(token.id);
          await load();
        } catch (thrown) {
          showError(thrown);
        }
      });
      row.append(meta, revoke);
      list.append(row);
    }
  }

  async function load(): Promise<void> {
    errorLine.hidden = true;
    try {
      current = await fetchApiSettings();
      enabled.setAttribute("aria-checked", String(current.enabled));
      port.value = String(current.port);
      renderRestartNote(current);
      renderTokens(current.tokens);
    } catch (thrown) {
      showError(thrown);
    }
  }

  async function save(body: Parameters<typeof postApiSettings>[0]): Promise<void> {
    try {
      await postApiSettings(body);
    } catch (thrown) {
      // Read back first, so the switch and the port show what the endpoint
      // kept: the read clears the line, and the failure shows after it.
      await load();
      showError(thrown);
      return;
    }
    await load();
  }

  // The codebase's toggle is a role="switch" button, not a checkbox — its
  // state lives on aria-checked and a click flips it.
  const isOn = (button: HTMLButtonElement): boolean => button.getAttribute("aria-checked") === "true";
  enabled.addEventListener("click", () => void save({ enabled: !isOn(enabled) }));
  port.addEventListener("change", () => void save({ port: Number(port.value) }));

  // A token's access is decided here and never widened afterwards, so the
  // choice belongs beside the name rather than in a mode elsewhere — and
  // every visit starts from Read-only.
  function openForm(): void {
    nameInput.value = "";
    readOnlySwitch.setAttribute("aria-checked", "true");
    formError.hidden = true;
    deps.openSettingsSubpage("api-token");
    // The page is still sliding in, so a scrolling focus would chase it.
    nameInput.focus({ preventScroll: true });
  }

  // The secret goes in a dialog over Settings, not on this subpage: here
  // Escape steps back and the scrim closes Settings, either of which would
  // throw away the one chance to copy it. Back to the list first, so Done
  // lands on the new token's row.
  async function onCreate(): Promise<void> {
    formError.hidden = true;
    const label = nameInput.value.trim();
    if (!label) throw new Error("Give the token a name.");
    createButton.disabled = true;
    let created: Awaited<ReturnType<typeof postCreateApiToken>>;
    try {
      created = await postCreateApiToken(label, isOn(readOnlySwitch) ? "read-only" : "read-write");
    } finally {
      createButton.disabled = false;
    }
    if (!formSection.hidden) deps.closeSettingsSubpage();
    await revealSecret(created.token.label, created.secret);
  }

  addButton.addEventListener("click", openForm);
  readOnlySwitch.addEventListener("click", () => {
    readOnlySwitch.setAttribute("aria-checked", String(!isOn(readOnlySwitch)));
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onCreate().catch((thrown: unknown) => {
      formError.textContent = thrown instanceof Error ? thrown.message : "Couldn't create the token";
      formError.hidden = false;
    });
  });

  return () => void load();
}
