// The spellchecker's switches: the root, for text fields, and for an editor,
// one that turns it on and a mark for text it should skip.
import { Decoration, EditorView } from "@codemirror/view";

/** An editor's text checked: CodeMirror turns the spellchecker off there. */
export const checkSpelling = EditorView.contentAttributes.of({ spellcheck: "true" });

/** Text the spellchecker skips inside text it checks: code, an address. */
export const unchecked = Decoration.mark({ attributes: { spellcheck: "false" } });

// A field takes spellcheck from the nearest ancestor that sets it, so the
// root decides for every field without its own. On removes the root's value
// rather than setting "true", which would force every input on: a search box
// or a model id would gain an underline it never had.
export function spellcheckFields(on: boolean): void {
  if (on) document.documentElement.removeAttribute("spellcheck");
  else document.documentElement.setAttribute("spellcheck", "false");
}
