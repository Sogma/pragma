// `{{$date}}` and `{{$date:FORMAT}}`: a moment written into text, filled from
// one clock reading by the rules in protocol.md's Date placeholders section.
// Templates, a Flow's typed text and Template Variables all fill them here.

/** A wall-clock moment as its writer saw it: what the clock showed, and the
 * offset from UTC in minutes, east positive. Fields rather than a Date, so a
 * host in another time zone still formats the writer's moment. */
export interface ClockReading {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offset: number;
}

/** The machine's own clock at `date`. */
export function readClock(date: Date): ClockReading {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    offset: -date.getTimezoneOffset(),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function offsetText(offset: number, separator: string): string {
  const minutes = Math.abs(offset);
  return `${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}${separator}${pad(minutes % 60)}`;
}

/** The reading's day, `YYYY-MM-DD`. */
export function clockDay(reading: ClockReading): string {
  return `${pad(reading.year, 4)}-${pad(reading.month)}-${pad(reading.day)}`;
}

/** The reading as RFC 3339 local time with its offset,
 * `2026-11-09T14:30:05+01:00`: how a request carries its writer's moment. */
export function formatClock(reading: ClockReading): string {
  const time = `${pad(reading.hour)}:${pad(reading.minute)}:${pad(reading.second)}`;
  return `${clockDay(reading)}T${time}${offsetText(reading.offset, ":")}`;
}

const CLOCK_TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** The moment `text` names in that form, or undefined when it names no real
 * one: `2026-02-30T…` is refused rather than rolled into March. */
export function parseClock(text: string): ClockReading | undefined {
  const match = CLOCK_TEXT.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHours = Number(match[8] ? match[8] : 0);
  const offsetMinutes = Number(match[9] ? match[9] : 0);
  const calendar = utcDate(dayNumber(year, month, day));
  const real =
    calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  if (!real || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return undefined;
  const offset = (match[7] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  return { year, month, day, hour, minute, second, offset };
}

const DAY_MS = 86_400_000;

// Calendar arithmetic in UTC, so no time zone or clock change moves a day.
// Set through setUTCFullYear: Date.UTC reads a year below 100 as 19xx.
function dayNumber(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / DAY_MS);
}

function utcDate(days: number): Date {
  return new Date(days * DAY_MS);
}

/** 1 for Monday to 7 for Sunday. Day 0, 1970-01-01, was a Thursday. */
function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

// An ISO week belongs to the year its Thursday falls in, so the first days
// of January can sit in the last week of the year before.
function isoWeek(days: number): { year: number; week: number } {
  const thursday = days + 4 - isoWeekday(days);
  const year = utcDate(thursday).getUTCFullYear();
  return { year, week: Math.floor((thursday - dayNumber(year, 1, 1)) / 7) + 1 };
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = [
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

// POSIX strftime's directives that read alike on every host: names in the
// POSIX locale's English, no zone name, none a C library spells its own way.
// `-` drops a number's padding, as GNU's does, on every platform.
function directive(letter: string, unpadded: boolean, reading: ClockReading): string | undefined {
  const number = (value: number, width = 2) => (unpadded ? String(value) : pad(value, width));
  const days = dayNumber(reading.year, reading.month, reading.day);
  switch (letter) {
    case "Y":
      return String(reading.year);
    case "y":
      return number(reading.year % 100);
    case "m":
      return number(reading.month);
    case "d":
      return number(reading.day);
    case "H":
      return number(reading.hour);
    case "I":
      return number(reading.hour % 12 || 12);
    case "M":
      return number(reading.minute);
    case "S":
      return number(reading.second);
    case "p":
      return reading.hour < 12 ? "AM" : "PM";
    case "j":
      return number(days - dayNumber(reading.year, 1, 1) + 1, 3);
    case "a":
      return WEEKDAYS[isoWeekday(days) - 1].slice(0, 3);
    case "A":
      return WEEKDAYS[isoWeekday(days) - 1];
    case "b":
      return MONTHS[reading.month - 1].slice(0, 3);
    case "B":
      return MONTHS[reading.month - 1];
    case "u":
      return String(isoWeekday(days));
    case "V":
      return number(isoWeek(days).week);
    case "G":
      return String(isoWeek(days).year);
    case "z":
      return offsetText(reading.offset, "");
    case "F":
      return clockDay(reading);
    case "T":
      return `${pad(reading.hour)}:${pad(reading.minute)}:${pad(reading.second)}`;
    default:
      return undefined;
  }
}

const DIRECTIVE = /%(-?)([\s\S])/g;

/** `format` with each directive replaced from `reading`, or undefined when it
 * holds none: a format written for another tool, `YYYY-MM-DD`, is left for
 * its placeholder to stay as written. An unknown directive stays as it is. */
export function formatDate(reading: ClockReading, format: string): string | undefined {
  let dated = false;
  const text = format.replace(DIRECTIVE, (whole, flag: string, letter: string) => {
    if (letter === "%" && !flag) return "%";
    const value = directive(letter, flag === "-", reading);
    if (value === undefined) return whole;
    dated = true;
    return value;
  });
  return dated ? text : undefined;
}

/** A placeholder's name and, after its colon, its format, as a fill gets
 * them; undefined leaves the placeholder as written. */
export type PlaceholderFill = (name: string, format: string | undefined) => string | undefined;

// A name of word characters, a value the host fills marked with a `$` so it
// never meets a name a person gives, and nothing else inside the braces:
// `{{ $date }}` stays as written. A format runs to the closing braces and
// holds no brace or line break.
/** The placeholder pattern's source, for a pattern built around it: its
 * groups are the name, `$` included, and the format. */
export const PLACEHOLDER_SOURCE = String.raw`\{\{(\$?\w+)(?::([^{}\n]+))?\}\}`;
const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, "g");

/** A fresh copy of the placeholder pattern, global, for a scan of its own. */
export function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, "g");
}

/** `text` with each placeholder `fill` gives a value for replaced, in one
 * pass: a value put in is never read for placeholders again, so a wired text
 * or a title that mentions `{{$date}}` keeps it. */
export function fillPlaceholders(text: string, fill: PlaceholderFill): string {
  return text.replace(PLACEHOLDER, (whole, name: string, format: string | undefined) => fill(name, format) ?? whole);
}

/** The fill for `{{$date}}` and `{{$date:FORMAT}}`, the name in any case;
 * every other name is left as written. */
export function dateFill(reading: ClockReading): PlaceholderFill {
  return (name, format) => (name.toLowerCase() === "$date" ? formatDate(reading, format ?? "%F") : undefined);
}

/** `text` with its date placeholders filled from `reading`. */
export function fillDates(text: string, reading: ClockReading): string {
  return fillPlaceholders(text, dateFill(reading));
}

/** The date placeholders an editor offers once one is begun, each filled by
 * the rule above; any other format still works typed. */
export const DATE_OFFERS: readonly string[] = [
  "{{$date}}",
  "{{$date:%B %-d, %Y}}",
  "{{$date:%F %H:%M}}",
  "{{$date:%H:%M}}",
  "{{$date:%A}}",
  "{{$date:%Y}}",
];
