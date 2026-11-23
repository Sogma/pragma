// An anchored date-picker popover: a month grid under a month/year header,
// with Today and Clear. Created on open, it opens through flyout.ts, which
// places and dismisses it, so a call site needs only the one function.
//
// Values are plain `YYYY-MM-DD` strings, never Date objects: the day is
// resolved in the calendar the grid shows, so no time zone can shift it by
// one on the way in or out.

import { iconButton } from "./dom.ts";
import { openFlyout } from "./flyout.ts";

export interface DatePickerOptions {
  /** The element the popover points at — placed just below it, flipped
   * above when there isn't room. */
  anchor: HTMLElement;
  /** Current value. Only a leading `YYYY-MM-DD` is read, so a full timestamp
   * opens on its own day; anything else opens on today with nothing
   * selected. */
  value: string;
  /** Fired once, when the user picks — a `YYYY-MM-DD` string, or "" for
   * Clear. The popover closes itself immediately after. */
  onPick: (value: string) => void;
}

interface Day {
  year: number;
  month: number; // 0-based, like Date's
  day: number;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The leading `YYYY-MM-DD` of `value`, or undefined when it has none or
 * names a day that doesn't exist. */
export function parseDatePrefix(value: string): Day | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return undefined;
  const day = { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
  return sameDay(normalize(day), day) ? day : undefined;
}

export function formatDate({ year, month, day }: Day): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Rolls an out-of-range month or day over, the way Date's constructor does.
function normalize({ year, month, day }: Day): Day {
  const date = new Date(year, month, day);
  // Date maps years 0–99 onto 1900–1999; setFullYear doesn't.
  date.setFullYear(year, month, day);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

function sameDay(a: Day | undefined, b: Day | undefined): boolean {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}

function today(): Day {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

/** Opens the popover anchored to `anchor`, closing any other popover. */
export function openDatePicker({ anchor, value, onPick }: DatePickerOptions): void {
  const selected = parseDatePrefix(value);
  const now = today();
  // The day keyboard focus sits on; the grid always shows its month.
  let focus: Day = selected ?? now;

  const popover = document.createElement("div");
  popover.className = "popover date-picker";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Choose a date");

  const commit = (next: string): void => {
    onPick(next);
    flyout.close();
  };

  // --- Header: previous, month, year, next ---------------------------------
  const header = document.createElement("div");
  header.className = "date-picker-header";

  const previous = iconButton("date-picker-nav date-picker-prev", "Previous month");
  const next = iconButton("date-picker-nav date-picker-next", "Next month");

  const monthSelect = document.createElement("select");
  monthSelect.className = "form-input date-picker-month";
  monthSelect.setAttribute("aria-label", "Month");
  for (const [index, name] of MONTH_NAMES.entries()) monthSelect.add(new Option(name, String(index)));

  const yearInput = document.createElement("input");
  yearInput.type = "number";
  yearInput.className = "form-input date-picker-year";
  yearInput.setAttribute("aria-label", "Year");
  yearInput.min = "1";
  yearInput.max = "9999";

  header.append(previous, monthSelect, yearInput, next);
  popover.appendChild(header);

  // --- Grid ----------------------------------------------------------------
  const grid = document.createElement("div");
  grid.className = "date-picker-grid";
  grid.setAttribute("role", "grid");
  popover.appendChild(grid);

  // --- Footer --------------------------------------------------------------
  const footer = document.createElement("div");
  footer.className = "date-picker-footer";
  const todayButton = document.createElement("button");
  todayButton.type = "button";
  todayButton.className = "btn";
  todayButton.textContent = "Today";
  todayButton.addEventListener("click", () => commit(formatDate(today())));
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "btn";
  clearButton.textContent = "Clear";
  clearButton.addEventListener("click", () => commit(""));
  footer.append(todayButton, clearButton);
  popover.appendChild(footer);

  // Six full weeks starting on the Sunday on or before the 1st, so the grid
  // never changes height between months.
  function render(moveFocus: boolean): void {
    monthSelect.value = String(focus.month);
    yearInput.value = String(focus.year);

    const first = new Date(focus.year, focus.month, 1);
    first.setFullYear(focus.year, focus.month, 1);
    const start = normalize({ year: focus.year, month: focus.month, day: 1 - first.getDay() });

    const cells: HTMLElement[] = WEEKDAY_NAMES.map((name) => {
      const label = document.createElement("div");
      label.className = "caption date-picker-weekday";
      label.setAttribute("role", "columnheader");
      label.textContent = name;
      return label;
    });

    for (let offset = 0; offset < 42; offset++) {
      const day = normalize({ ...start, day: start.day + offset });
      const button = document.createElement("button");
      button.type = "button";
      button.className = "date-picker-day";
      button.textContent = String(day.day);
      button.setAttribute("aria-label", formatDate(day));
      if (day.month !== focus.month) button.classList.add("is-outside");
      if (sameDay(day, now)) button.classList.add("is-today");
      if (sameDay(day, selected)) button.setAttribute("aria-pressed", "true");
      // One tab stop into the grid; arrows move within it.
      button.tabIndex = sameDay(day, focus) ? 0 : -1;
      button.addEventListener("click", () => commit(formatDate(day)));
      cells.push(button);
    }

    grid.replaceChildren(...cells);
    if (moveFocus) grid.querySelector<HTMLButtonElement>('.date-picker-day[tabindex="0"]')?.focus();
  }

  // A month change keeps the day of the month where it can, clamped to the
  // new month's last day rather than spilling into the one after.
  function showMonth(year: number, month: number, moveFocus: boolean): void {
    const target = normalize({ year, month, day: 1 });
    const lastDay = normalize({ year: target.year, month: target.month + 1, day: 0 }).day;
    focus = { ...target, day: Math.min(focus.day, lastDay) };
    render(moveFocus);
  }

  previous.addEventListener("click", () => showMonth(focus.year, focus.month - 1, false));
  next.addEventListener("click", () => showMonth(focus.year, focus.month + 1, false));
  monthSelect.addEventListener("change", () => showMonth(focus.year, Number(monthSelect.value), false));
  yearInput.addEventListener("change", () => {
    const year = Number(yearInput.value);
    if (Number.isInteger(year) && year >= 1 && year <= 9999) showMonth(year, focus.month, false);
    else yearInput.value = String(focus.year);
  });

  grid.addEventListener("keydown", (event) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in step) {
      event.preventDefault();
      focus = normalize({ ...focus, day: focus.day + step[event.key] });
      render(true);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      showMonth(focus.year, focus.month + (event.key === "PageUp" ? -1 : 1), true);
    }
  });

  // --- Mount, focus --------------------------------------------------------
  // Rendered first: the flyout measures the popover to place it.
  render(false);
  const flyout = openFlyout(anchor, popover);
  grid.querySelector<HTMLButtonElement>('.date-picker-day[tabindex="0"]')?.focus();
}
