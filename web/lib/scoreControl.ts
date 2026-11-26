// A score as marks, wherever a Table column, a Class field or a Flow's Add
// Row holds one: a mark per step up to the field's max, lit up to its value,
// with a reject mark first where the field allows one. It takes text and
// hands text back, so it never knows where a value is saved; CSS draws the
// marks as stars.
import { type FieldDefinition, scoreMax, scoreOf } from "../../src/protocol/types.ts";

export interface ScoreControlOptions {
  field: FieldDefinition;
  value: string;
  // Names the control for assistive tech: its field's label.
  label?: string;
  // Absent, the marks are the value as content, with nothing to press.
  onChange?: (value: string) => void;
}

const REJECTED = -1;

/** The marks for `value`. A value that is no score shows unlit marks with
 * the value as written after them, kept until a mark is picked. */
export function createScoreControl(options: ScoreControlOptions): HTMLElement {
  const { field, onChange } = options;
  const max = scoreMax(field);
  const group = document.createElement("span");
  group.className = "score";
  const steps = [...(field.reject ? [REJECTED] : []), ...Array.from({ length: max }, (_, at) => at + 1)];
  const marks = steps.map((step) => {
    const mark = document.createElement(onChange ? "button" : "span");
    mark.className = step === REJECTED ? "score-reject" : "score-mark";
    if (mark instanceof HTMLButtonElement) {
      mark.type = "button";
      mark.setAttribute("role", "radio");
      mark.setAttribute("aria-label", step === REJECTED ? "Rejected" : `${step} of ${max}`);
      mark.addEventListener("click", () => pick(step));
    }
    group.appendChild(mark);
    return mark;
  });
  const held = document.createElement("span");
  held.className = "score-held";
  group.appendChild(held);

  let current = options.value;
  function paint(): void {
    const score = scoreOf(current, field);
    group.toggleAttribute("data-rejected", score === REJECTED);
    held.textContent = score === undefined ? current.trim() : "";
    held.hidden = score !== undefined;
    marks.forEach((mark, at) => {
      const step = steps[at];
      mark.toggleAttribute("data-lit", step !== REJECTED && score !== undefined && step <= score);
      if (mark instanceof HTMLButtonElement) mark.setAttribute("aria-checked", String(step === score));
    });
    // One mark takes Tab: the picked one, else the first star.
    const picked = steps.indexOf(score ?? 0);
    marks.forEach((mark, at) => {
      if (mark instanceof HTMLButtonElement)
        mark.tabIndex = at === (picked === -1 ? steps.indexOf(1) : picked) ? 0 : -1;
    });
    if (!onChange) {
      group.setAttribute("role", "img");
      group.setAttribute("aria-label", describe(score));
    }
  }

  function describe(score: number | undefined): string {
    if (score === undefined) return current.trim();
    if (score === REJECTED) return "Rejected";
    return score === 0 ? "No score" : `${score} of ${max}`;
  }

  // Picking the value held clears it, as a second press on a lit star does.
  function pick(step: number): void {
    const next = scoreOf(current, field) === step ? "" : String(step);
    set(next);
    marks[steps.indexOf(step)]?.focus();
  }

  function set(next: string): void {
    if (next === current) return;
    current = next;
    paint();
    onChange?.(next);
  }

  if (onChange) {
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", options.label ?? "Score");
    group.addEventListener("keydown", (event) => {
      const score = scoreOf(current, field);
      const at = steps.indexOf(score ?? 0);
      let target: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") target = at === -1 ? steps.indexOf(1) : at + 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = at - 1;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = steps.length - 1;
      else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        set("");
        return;
      } else return;
      event.preventDefault();
      const step = steps[target];
      if (step === undefined) return;
      set(String(step));
      marks[target]?.focus();
    });
  }
  paint();
  return group;
}
