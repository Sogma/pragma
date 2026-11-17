// How a date or a time is written wherever one shows, in the reader's own
// locale: one form per meaning. A surface picks the form for what it shows
// and never formats a date itself, so two surfaces showing one moment say it
// alike.

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

// A moment that doesn't parse reads Unknown: a formatter throws on it.
function written(when: Date | string | number, form: Intl.DateTimeFormat): string {
  const date = new Date(when);
  return Number.isNaN(date.getTime()) ? "Unknown" : form.format(date);
}

/** A moment in full: its date and its time. */
export function dateTimeLabel(when: Date | string | number): string {
  return written(when, DATE_TIME);
}

/** A day: its date alone. */
export function dateLabel(when: Date | string | number): string {
  return written(when, DATE);
}

/** A moment as a list row's end shows it: by the clock on its own day, by
 * its date after that. */
export function shortWhen(time: number, now = Date.now()): string {
  const date = new Date(time);
  return sameDay(date, new Date(now)) ? TIME.format(date) : DAY.format(date);
}

/** A version's moment: by the clock on its own day, named Yesterday the day
 * after, and by its date from then on. */
export function versionWhen(time: number, now = Date.now()): string {
  const date = new Date(time);
  if (sameDay(date, new Date(now))) return TIME.format(date);
  const day = sameDay(date, new Date(now - 24 * 60 * 60 * 1000)) ? "Yesterday" : DAY.format(date);
  return `${day} ${TIME.format(date)}`;
}
