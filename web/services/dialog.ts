// The dialog service — the one owner of modal chrome (docs/architecture.md's
// Feedback and interaction section). A caller asks for a confirmation, prompt, pick, or its own
// content panel and gets a promise; the service owns the scrim, close button,
// click-outside, Escape, focus and its return, and stacking.
//
// A dialog scoped to a pane (an applet's consent prompt) passes it as `host`
// and is anchored inside it, centred over the thing it is about.
import { type SetupNeed, withSetupNeed } from "../../src/protocol/setupNeed.ts";
import type { EntryIcon } from "../core/paths.ts";
import { DisposableStore, listen } from "../lib/disposable.ts";
import { createEntryIcon } from "../lib/dom.ts";
import { createOutcomeLine, type OutcomeLine } from "../lib/outcomeLine.ts";
import { createSpaceIcon } from "../lib/spaceIcon.ts";
import type { CommandRegistry } from "./commands.ts";
import type { KeybindingRegistry } from "./keybindings.ts";

/** What a dialog is about, drawn before its title: an entry's icon as the
 * tree draws it, the Space icon, or Pragma's logo. */
export type DialogIcon = EntryIcon | "space" | "pragma";

export interface DialogOptions {
  // Rendered as a header with a close button, and names the dialog; omit for
  // a headerless panel. A node for a title with styled parts, such as a muted
  // qualifier.
  title?: string | Node;
  icon?: DialogIcon;
  content: HTMLElement;
  host?: HTMLElement;
  // Extra class on the panel, for a size or layout variant.
  className?: string;
  // Escape closes the dialog unless this returns true — a dialog with an
  // inner step (Settings' subpage) steps back first.
  onEscape?: () => boolean;
  // A click on the scrim closes the dialog; off for a dialog that must be
  // answered.
  closeOnBackdrop?: boolean;
  // Focused on open; otherwise the first focusable control, else the panel.
  initialFocus?: HTMLElement;
}

export interface DialogHandle {
  readonly panel: HTMLElement;
  close(): void;
  readonly closed: Promise<void>;
}

interface ActionOptions {
  host?: HTMLElement;
  // Hands over the handle as the dialog opens, for a caller that may need
  // to close it early (a permission prompt when its run is stopped).
  onOpen?: (handle: DialogHandle) => void;
  // Runs while the dialog stays open with its buttons disabled and the
  // primary button reading `busyLabel`; a thrown error shows inline and the
  // dialog stays open. Without it the dialog closes at once.
  busyLabel?: string;
  // Shown when the action throws something that isn't an Error.
  failureMessage?: string;
}

// A primary action's buttons, and the line its failure shows in.
interface ActionParts {
  primary: HTMLButtonElement;
  cancel: HTMLButtonElement;
  outcome: OutcomeLine;
}

export interface ConfirmOptions extends ActionOptions {
  title: string;
  icon?: DialogIcon;
  // A node for a message with drawn parts, such as a path label; a list for a
  // message of several paragraphs.
  message: string | Node | (string | Node)[];
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  action?: () => Promise<void>;
}

// A submit that keeps the dialog open: the message to show, and optionally
// a new label for the primary button (a failed create that can be retried).
export interface FormOutcome {
  message: string;
  submitLabel?: string;
  // The setting that fixes it, linked under the message.
  need?: SetupNeed;
}

export interface FormField {
  id: string;
  label?: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  /** A dropdown rather than a text field. The selected option's `value` comes
   * back under the field's id like any other control; `value` picks the one
   * to start on, the first otherwise. */
  choices?: readonly { value: string; label: string }[];
  /** Values a text field offers as it's typed into, without limiting it to
   * them. */
  suggestions?: readonly string[];
  // The most characters a person can type or paste into a text field.
  maxLength?: number;
  // A line of help under the control, for a field whose label can't carry
  // the whole story — a setting described by whoever defined it, say.
  description?: string;
}

export interface FormOptions extends ActionOptions {
  title: string;
  icon?: DialogIcon;
  // A line above the fields.
  message?: string;
  fields: readonly FormField[];
  submitLabel?: string;
  cancelLabel?: string;
  className?: string;
  // The field to focus on open; the first otherwise.
  focus?: string;
  // Returns a message to show instead of submitting.
  validate?: (values: Record<string, string>) => string | undefined;
  // Returns a message (or an outcome) to show and stay open; resolves to
  // nothing to close.
  submit?: (
    values: Record<string, string>,
  ) => Promise<FormOutcome | string | undefined> | FormOutcome | string | undefined;
}

export interface PromptOptions extends ActionOptions {
  title: string;
  icon?: DialogIcon;
  message?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  submitLabel?: string;
  cancelLabel?: string;
  className?: string;
  validate?: (value: string) => string | undefined;
  submit?: (value: string) => Promise<FormOutcome | string | undefined> | FormOutcome | string | undefined;
}

export interface PickOption {
  id: string;
  label: string;
  description?: string;
}

export interface PickOptions {
  title: string;
  message?: string;
  options: readonly PickOption[];
  host?: HTMLElement;
  onOpen?: (handle: DialogHandle) => void;
}

export interface DialogService {
  open(options: DialogOptions): DialogHandle;
  // True on confirm; false on cancel, close, Escape, or the scrim.
  confirm(options: ConfirmOptions): Promise<boolean>;
  // The entered value on submit; null on cancel. A one-field form.
  prompt(options: PromptOptions): Promise<string | null>;
  // Every field's value by id on submit; null on cancel. Enter submits a
  // single-line field, Ctrl/Cmd+Enter a multiline one.
  form(options: FormOptions): Promise<Record<string, string> | null>;
  // The chosen option's id; null on cancel.
  pick(options: PickOptions): Promise<string | null>;
  isOpen(): boolean;
  // Escape as the topmost dialog sees it: its own handler first, else it
  // closes. Bound to the key through the keybindings the service is given.
  escape(): void;
}

const FOCUSABLE =
  'input:not([type="hidden"]), textarea, select, button:not(.dialog-close), [href], [tabindex]:not([tabindex="-1"])';

// A panel is named by its title's id, and dialogs stack, so each title needs
// one of its own.
let titleCount = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = ""): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  return node;
}

// The Space icon is lit in a title (sidebar.css); the logo is the image
// Settings shows.
function iconElement(icon: DialogIcon): Element {
  if (icon === "space") return createSpaceIcon();
  if (icon === "pragma") {
    const logo = el("img", "");
    logo.src = "/images/mark.svg";
    logo.alt = "";
    return logo;
  }
  return createEntryIcon(icon);
}

export interface DialogServiceDeps {
  commands: CommandRegistry;
  keybindings: KeybindingRegistry;
}

// Without `deps` (a test, a host that dispatches keys itself) Escape is
// only reachable through escape().
export function createDialogService(root: HTMLElement = document.body, deps?: DialogServiceDeps): DialogService {
  interface Entry {
    options: DialogOptions;
    close(): void;
  }
  const stack: Entry[] = [];

  function escapeTopmost(): void {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (top.options.onEscape?.()) return;
    top.close();
  }

  // A dialog outranks every other Escape claimant — a menu, a popover, a
  // pane's selection — since it is modal.
  if (deps) {
    deps.commands.register({
      id: "dialog.escape",
      label: "Close dialog",
      when: () => stack.length > 0,
      run: escapeTopmost,
    });
    deps.keybindings.register({ key: "Escape", command: "dialog.escape", weight: 200 });
  }

  function open(options: DialogOptions): DialogHandle {
    const store = new DisposableStore();
    const backdrop = el("div", options.host ? "dialog-backdrop dialog-scoped" : "dialog-backdrop");
    const panel = el("div", options.className ? `dialog-panel ${options.className}` : "dialog-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;

    if (options.title !== undefined) {
      const header = el("div", "dialog-header");
      const title = el("h2", "dialog-title");
      title.id = `dialog-title-${++titleCount}`;
      if (options.icon) {
        const icon = iconElement(options.icon);
        icon.classList.add("dialog-title-icon");
        icon.setAttribute("aria-hidden", "true");
        title.append(icon);
      }
      title.append(options.title);
      panel.setAttribute("aria-labelledby", title.id);
      const close = button("", "icon-button dialog-close");
      close.setAttribute("aria-label", "Close");
      store.add(listen(close, "click", () => handle.close()));
      header.append(title, close);
      panel.append(header);
    }
    panel.append(options.content);
    backdrop.append(panel);

    if (options.closeOnBackdrop !== false) {
      // A click's target is the nearest common ancestor of press and
      // release, so a text selection dragged past the panel's edge arrives
      // here as a backdrop click. Dismiss unless the press began inside the
      // panel, so a synthesized click with no press still dismisses.
      // `mousedown`, not `pointerdown`: touch and pen raise it too.
      let pressedInsidePanel = false;
      store.add(
        listen(backdrop, "mousedown", (event) => {
          pressedInsidePanel = event.target !== backdrop;
        }),
      );
      store.add(
        listen(backdrop, "click", (event) => {
          if (event.target === backdrop && !pressedInsidePanel) handle.close();
        }),
      );
    }

    const previouslyFocused = document.activeElement;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let isOpen = true;

    const entry: Entry = {
      options,
      close() {
        if (!isOpen) return;
        isOpen = false;
        const index = stack.indexOf(entry);
        if (index >= 0) stack.splice(index, 1);
        store.dispose();
        backdrop.remove();
        // Focus goes back where it came from, unless something else has
        // taken it meanwhile.
        const active = document.activeElement;
        if (
          previouslyFocused instanceof HTMLElement &&
          previouslyFocused.isConnected &&
          (active === null || active === document.body || panel.contains(active))
        ) {
          previouslyFocused.focus();
        }
        resolveClosed();
      },
    };
    const handle: DialogHandle = { panel, close: entry.close, closed };

    (options.host ?? root).append(backdrop);
    stack.push(entry);
    (options.initialFocus ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
    return handle;
  }

  // The shared tail of a confirmation and a prompt: a primary action that
  // may run asynchronously with the dialog held open, an inline error, and
  // buttons disabled meanwhile.
  function buildActions(
    options: ActionOptions & { cancelLabel?: string },
    primaryLabel: string,
    danger: boolean,
    onCancel: () => void,
  ): ActionParts & { actions: HTMLElement; error: HTMLElement } {
    const error = el("div", "dialog-error");
    const outcome = createOutcomeLine(error, { fallback: options.failureMessage ?? "Something went wrong." });
    const actions = el("div", "dialog-actions");
    const cancel = button(options.cancelLabel ?? "Cancel", "btn btn-large");
    const primary = button(
      primaryLabel,
      danger ? "btn btn-large dialog-primary danger" : "btn btn-large primary-fill dialog-primary",
    );
    cancel.addEventListener("click", onCancel);
    actions.append(cancel, primary);
    return { actions, primary, cancel, error, outcome };
  }

  async function runAction(
    parts: ActionParts,
    options: ActionOptions,
    labels: { primary: string },
    action: () => Promise<FormOutcome | string | undefined>,
  ): Promise<boolean> {
    parts.cancel.disabled = true;
    parts.primary.disabled = true;
    if (options.busyLabel) parts.primary.textContent = options.busyLabel;
    // A message the action returns fails it as a thrown one does.
    const done = await parts.outcome.run(async () => {
      const outcome = await action();
      if (outcome === undefined) return true;
      if (typeof outcome === "object" && outcome.submitLabel) labels.primary = outcome.submitLabel;
      throw typeof outcome === "string" ? new Error(outcome) : withSetupNeed(new Error(outcome.message), outcome.need);
    });
    parts.cancel.disabled = false;
    parts.primary.disabled = false;
    parts.primary.textContent = labels.primary;
    return done === true;
  }

  return {
    open,
    isOpen: () => stack.length > 0,
    escape: escapeTopmost,

    confirm(options) {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const content = el("div", "dialog-body");
        for (const paragraph of [options.message].flat()) {
          const message = el("p", "dialog-message");
          message.append(paragraph);
          content.append(message);
        }
        if (options.warning) content.append(el("div", "inline-warning", options.warning));
        const parts = buildActions(options, options.confirmLabel ?? "OK", options.danger ?? false, () =>
          handle.close(),
        );
        content.append(parts.error, parts.actions);
        const handle = open({
          title: options.title,
          icon: options.icon,
          content,
          host: options.host,
          initialFocus: parts.primary,
        });
        options.onOpen?.(handle);
        void handle.closed.then(() => settle(false));
        parts.primary.addEventListener("click", () => {
          void (async () => {
            const action = options.action;
            const ok = action
              ? await runAction(parts, options, { primary: options.confirmLabel ?? "OK" }, () =>
                  action().then(() => undefined),
                )
              : true;
            if (!ok) return;
            settle(true);
            handle.close();
          })();
        });
      });
    },

    async prompt(options) {
      const { label, value, placeholder, multiline, rows, validate, submit, ...rest } = options;
      const values = await this.form({
        ...rest,
        fields: [{ id: "value", label, value, placeholder, multiline, rows }],
        validate: validate ? (all) => validate(all.value) : undefined,
        submit: submit ? (all) => submit(all.value) : undefined,
      });
      return values ? values.value : null;
    },

    form(options) {
      return new Promise<Record<string, string> | null>((resolve) => {
        let settled = false;
        const settle = (value: Record<string, string> | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const content = el("div", "dialog-body");
        if (options.message) content.append(el("p", "dialog-message", options.message));
        const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
        for (const field of options.fields) {
          const wrapper = el("div", "dialog-field");
          if (field.label) {
            const label = el("label", "dialog-field-label", field.label);
            label.htmlFor = `dialog-field-${field.id}`;
            wrapper.append(label);
          }
          let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          if (field.choices) {
            control = el("select", "form-input dialog-input");
            for (const choice of field.choices) {
              const option = el("option", "", choice.label);
              option.value = choice.value;
              control.append(option);
            }
          } else if (field.multiline) {
            control = el("textarea", "form-input dialog-textarea");
            if (field.rows) control.rows = field.rows;
          } else {
            control = el("input", "form-input dialog-input");
            control.type = "text";
            control.autocomplete = "off";
          }
          control.id = `dialog-field-${field.id}`;
          if (field.suggestions?.length && control instanceof HTMLInputElement && control.type === "text") {
            const list = el("datalist", "");
            list.id = `dialog-field-${field.id}-suggestions`;
            for (const suggestion of field.suggestions) {
              const option = el("option", "");
              option.value = suggestion;
              list.append(option);
            }
            control.setAttribute("list", list.id);
            wrapper.append(list);
          }
          // A select with no matching option would otherwise land on no
          // selection at all, so an unset (or unknown) value starts on the
          // first choice — what the control already shows.
          if (field.choices) control.value = field.value ?? field.choices[0]?.value ?? "";
          else control.value = field.value ?? "";
          if (field.placeholder && !(control instanceof HTMLSelectElement)) control.placeholder = field.placeholder;
          if (field.maxLength !== undefined && !(control instanceof HTMLSelectElement))
            control.maxLength = field.maxLength;
          controls.set(field.id, control);
          wrapper.append(control);
          if (field.description) {
            const description = el("p", "caption dialog-field-description", field.description);
            description.id = `dialog-field-${field.id}-description`;
            control.setAttribute("aria-describedby", description.id);
            wrapper.append(description);
          }
          content.append(wrapper);
        }
        const labels = { primary: options.submitLabel ?? "OK" };
        const parts = buildActions(options, labels.primary, false, () => handle.close());
        content.append(parts.error, parts.actions);
        const first = controls.get(options.focus ?? options.fields[0]?.id ?? "");
        const handle = open({
          title: options.title,
          icon: options.icon,
          content,
          host: options.host,
          className: options.className,
          initialFocus: first,
        });
        if (first instanceof HTMLInputElement) first.select();
        options.onOpen?.(handle);
        void handle.closed.then(() => settle(null));

        const submitForm = () => {
          void (async () => {
            const values: Record<string, string> = {};
            for (const [id, control] of controls) {
              values[id] = control.value;
            }
            const invalid = options.validate?.(values);
            const submitter = options.submit;
            // A refused field fails the submit as a refused submit does.
            const ok = await runAction(parts, options, labels, async () => invalid ?? submitter?.(values));
            if (!ok) return;
            settle(values);
            handle.close();
          })();
        };
        parts.primary.addEventListener("click", submitForm);
        for (const control of controls.values()) {
          control.addEventListener("keydown", (event) => {
            const key = event as KeyboardEvent;
            if (key.key !== "Enter" || parts.primary.disabled) return;
            const multiline = control instanceof HTMLTextAreaElement;
            if (multiline && !(key.ctrlKey || key.metaKey)) return;
            key.preventDefault();
            submitForm();
          });
        }
      });
    },

    pick(options) {
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const settle = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const content = el("div", "dialog-body");
        if (options.message) content.append(el("p", "dialog-message", options.message));
        const list = el("div", "dialog-options");
        for (const option of options.options) {
          const item = button("", "dialog-option");
          item.append(el("span", "dialog-option-label", option.label));
          if (option.description) item.append(el("span", "dialog-option-description", option.description));
          item.addEventListener("click", () => {
            settle(option.id);
            handle.close();
          });
          list.append(item);
        }
        content.append(list);
        const actions = el("div", "dialog-actions");
        const cancel = button("Cancel", "btn btn-large");
        cancel.addEventListener("click", () => handle.close());
        actions.append(cancel);
        content.append(actions);
        const handle = open({ title: options.title, content, host: options.host });
        options.onOpen?.(handle);
        void handle.closed.then(() => settle(null));
      });
    },
  };
}
