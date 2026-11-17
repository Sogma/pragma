// A calendar day as `YYYY-MM-DD` in the machine's own time zone: the day a
// person sees. UTC's day differs from it for hours of every day, so a day
// stamped or compared in UTC lands on the wrong side of midnight.

export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day `days` after `date`'s. Counted in calendar days, so a clock
 * change in between moves no boundary. */
export function localDayAfter(date: Date, days: number): string {
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

/** The local midnight that starts `day`, or undefined when it names no real
 * day: `2026-02-30` is refused rather than rolled into March. */
export function parseLocalDay(day: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const parsed = new Date(year, month, date);
  return parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === date ? parsed : undefined;
}
