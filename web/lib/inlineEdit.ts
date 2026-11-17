// The in-place name field: a rename, or a new entry's name, typed where the
// entry is drawn (a tree row, a gallery tile) rather than in a dialog.

// A file-type PendingCreate's specific document kind: it decides the
// extension and any seed content the create writes. Absent (or "note") is a
// plain file, extension-less until typed; the others are the New ▸
// submenu's other file leaves.
export type CreateKind = "note" | "table" | "class" | "flow";

export interface PendingCreate {
  parentPath: string;
  type: "file" | "directory";
  kind?: CreateKind;
  // Made as a copy of this template: its path, among the space's templates
  // or with `source` among Pragma's own, and the name the field's
  // placeholder calls it by.
  template?: { path: string; label: string; source?: "pragma" };
  // What the field starts with, selected so typing replaces it.
  initialName?: string;
}

/** Where a tree command's name is typed when another surface asks for it:
 * on a gallery's tile or in a tab's dialog, never on a row in a sidebar that
 * may be hidden. The surface draws the field and hands back what was typed;
 * the command keeps the write. Paths are rooted. */
export interface NamingSurface {
  /** `submit` gets the whole new name, extension included. */
  rename(path: string, submit: (name: string) => void): void;
  create(pending: PendingCreate, submit: (name: string) => void): void;
}

const CREATE_NOUNS: Record<CreateKind, string> = { note: "Note", table: "Table", class: "Class", flow: "Flow" };

// What a create makes, as its field's placeholder and its dialog's title
// both name it.
function createNoun(pending: PendingCreate): string {
  if (pending.template) return pending.template.label;
  return pending.type === "file" ? CREATE_NOUNS[pending.kind ?? "note"] : "Folder";
}

export function createPlaceholder(pending: PendingCreate): string {
  return `${createNoun(pending)} name`;
}

/** A dialog's title for a create, in the tree command's own words. */
export function createTitle(pending: PendingCreate): string {
  return `New ${createNoun(pending)}`;
}

// Enter commits, Escape cancels, and a click away commits too. `settled`
// guards against firing twice: committing or cancelling removes the input
// from the DOM, which itself fires a blur, so without the guard one Enter
// would submit twice.
export function attachEditInputHandlers(
  input: HTMLInputElement,
  onSubmit: (value: string) => void,
  onCancel: () => void,
): void {
  let settled = false;
  const submit = () => {
    if (settled) return;
    settled = true;
    onSubmit(input.value);
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    onCancel();
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", submit);
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("mousedown", (event) => event.stopPropagation());
}
