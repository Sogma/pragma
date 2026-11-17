// A value edited in place. At rest it is one line, cut with "…" where it
// doesn't fit, with a pencil after it and its whole text as a tooltip; while
// it is edited it wraps to show all of it. It edits one line: Enter ends the
// edit, and what it saves has every run of whitespace, a pasted line break
// too, as one space, trimmed. Escape takes the edit back.
//
// The field's text again lies over the field in its box. At rest it is the
// line shown, since a textarea can't draw "…"; while the field is edited it
// is invisible and wraps as the field does. Clicks pass through it to the
// field. It catches up only when an edit ends, since the field grows by
// itself.
//
// The copy's text is an attribute the stylesheet shows, not text in the
// element, so a selection or a find never meets the value twice.

export interface WrappingFieldOptions {
  value: string;
  // The field's accessible name, in place of a visible label.
  label: string;
  placeholder?: string;
  // "typing" saves each change as it is typed, "end" once, when the edit
  // ends. Either way only a change is saved, and Escape in "typing" saves
  // the text the edit started from, as it was.
  saves: "typing" | "end";
  save(text: string): void;
}

export function createWrappingField(options: WrappingFieldOptions): HTMLElement {
  const field = document.createElement("textarea");
  field.className = "form-input form-input-quiet wrapping-field-input";
  field.rows = 1;
  if (options.placeholder) field.placeholder = options.placeholder;
  field.setAttribute("aria-label", options.label);
  field.dataset.tooltipOverflow = "";
  field.value = options.value;

  const copy = document.createElement("span");
  copy.className = "wrapping-field-copy";
  copy.setAttribute("aria-hidden", "true");
  const pencil = document.createElement("span");
  pencil.className = "wrapping-field-pencil";
  copy.append(pencil);
  const syncCopy = () => {
    copy.dataset.text = field.value || field.placeholder;
  };
  syncCopy();

  // What the field showed when this edit began, and the last text saved.
  let atStart = field.value;
  let saved = field.value;
  const saveIfChanged = (text: string) => {
    if (text === saved) return;
    saved = text;
    options.save(text);
  };

  field.addEventListener("focus", () => {
    atStart = field.value;
  });
  field.addEventListener("input", () => {
    if (options.saves === "typing") saveIfChanged(oneLine(field.value));
  });
  field.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      field.blur();
    } else if (event.key === "Escape") {
      field.value = atStart;
      if (options.saves === "typing") saveIfChanged(atStart);
      field.blur();
    }
  });
  // An edit that changed nothing leaves the text as it was, line breaks and
  // all, and saves nothing: opening a value is not editing it.
  field.addEventListener("blur", () => {
    if (field.value !== atStart) {
      field.value = oneLine(field.value);
      saveIfChanged(field.value);
    }
    syncCopy();
  });

  const element = document.createElement("span");
  element.className = "wrapping-field";
  element.append(field, copy);
  return element;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
