// Work-calendar / quest-period time keys.
// Generalizes ERP_QA_HUB src/utils/petQuestTime.ts (hardcoded Asia/Jerusalem,
// Sunday-06:00 week reset, 15:30 daily cutoff) into a per-org configurable
// calendar (plan §9), using real IANA-timezone math instead of the old
// hardcoded UTC+3 approximation (which ignored DST).

export interface WorkCalendar {
  /** IANA timezone, e.g. "Asia/Jerusalem", "Europe/Berlin". */
  timeZone: string;
  /** 0=Sunday … 6=Saturday — the local weekday the quest week resets on. */
  weekStartDay: number;
  /** Local hour on weekStartDay when the week rolls over. */
  weekResetHour: number;
  /** Local time after which the daily quest cutoff has passed. */
  dailyCutoffHour: number;
  dailyCutoffMinute: number;
  /** Which local weekdays count as workdays (0=Sun … 6=Sat). */
  workdays: readonly number[];
}

/** Matches the original ERP hub behavior exactly (Sun–Thu Israeli work week). */
export const ISRAEL_CALENDAR: WorkCalendar = {
  timeZone: "Asia/Jerusalem",
  weekStartDay: 0,
  weekResetHour: 6,
  dailyCutoffHour: 15,
  dailyCutoffMinute: 30,
  workdays: [0, 1, 2, 3, 4],
};

/** Sensible default for individuals outside Israel (plan §9). */
export const MON_FRI_CALENDAR: WorkCalendar = {
  timeZone: "UTC",
  weekStartDay: 1,
  weekResetHour: 6,
  dailyCutoffHour: 15,
  dailyCutoffMinute: 30,
  workdays: [1, 2, 3, 4, 5],
};

export const DEFAULT_CALENDAR = ISRAEL_CALENDAR;

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=Sunday … 6=Saturday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const partFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getPartFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    partFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function getLocalParts(date: Date, timeZone: string): LocalDateTimeParts {
  const record = Object.fromEntries(
    getPartFormatter(timeZone)
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(record.year),
    month: Number(record.month),
    day: Number(record.day),
    // Intl can emit "24" for midnight in some engines — normalize to 0.
    hour: Number(record.hour) % 24,
    minute: Number(record.minute),
    second: Number(record.second),
    weekday: WEEKDAY_INDEX[record.weekday ?? ""] ?? 0,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** YYYY-MM-DD in the calendar's local timezone. */
export function getDayKey(date: Date, calendar: WorkCalendar = DEFAULT_CALENDAR): string {
  const p = getLocalParts(date, calendar.timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function hasPassedDailyCutoff(
  date: Date,
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): boolean {
  const p = getLocalParts(date, calendar.timeZone);
  return (
    p.hour > calendar.dailyCutoffHour ||
    (p.hour === calendar.dailyCutoffHour && p.minute >= calendar.dailyCutoffMinute)
  );
}

/**
 * Week key = the dayKey of the week's reset day (e.g. the most recent
 * Sunday-06:00 boundary in the original Israel calendar).
 */
export function getWeekKey(date: Date, calendar: WorkCalendar = DEFAULT_CALENDAR): string {
  const p = getLocalParts(date, calendar.timeZone);
  const daysSinceStart = (p.weekday - calendar.weekStartDay + 7) % 7;
  const beforeReset = daysSinceStart === 0 && p.hour < calendar.weekResetHour;
  const daysBack = beforeReset ? 7 : daysSinceStart;
  const resetDate = new Date(date.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return getDayKey(resetDate, calendar);
}

export function getQuestPeriodKeys(
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): { dayKey: string; weekKey: string } {
  return {
    dayKey: getDayKey(date, calendar),
    weekKey: getWeekKey(date, calendar),
  };
}

/**
 * Converts a local wall-clock time in an IANA timezone to the UTC instant.
 * Converging-offset technique — correct across DST transitions (ambiguous
 * local times resolve to one of the two valid instants, which is fine here).
 */
export function zonedTimeToUtc(
  year: number,
  month: number, // 1-based
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = desired;
  for (let i = 0; i < 3; i++) {
    const p = getLocalParts(new Date(utc), timeZone);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = desired - actual;
    if (diff === 0) break;
    utc += diff;
  }
  return new Date(utc);
}

/** The next instant the daily cutoff passes (today's if not yet passed, else tomorrow's). */
export function getNextDailyCutoff(
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): Date {
  const p = getLocalParts(date, calendar.timeZone);
  const today = zonedTimeToUtc(
    p.year,
    p.month,
    p.day,
    calendar.dailyCutoffHour,
    calendar.dailyCutoffMinute,
    calendar.timeZone,
  );
  if (!hasPassedDailyCutoff(date, calendar)) return today;
  // Advance one local day (using UTC date arithmetic on the local parts).
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    calendar.dailyCutoffHour,
    calendar.dailyCutoffMinute,
    calendar.timeZone,
  );
}

/** The next weekly reset instant (weekStartDay @ weekResetHour local). */
export function getNextWeeklyReset(
  date: Date = new Date(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): Date {
  const p = getLocalParts(date, calendar.timeZone);
  const daysSinceStart = (p.weekday - calendar.weekStartDay + 7) % 7;
  const passedThisReset = daysSinceStart > 0 || p.hour >= calendar.weekResetHour;
  const daysUntil = passedThisReset ? 7 - daysSinceStart : 0;
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + daysUntil));
  return zonedTimeToUtc(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    calendar.weekResetHour,
    0,
    calendar.timeZone,
  );
}

/** True when the given instant falls on a configured workday in the calendar's zone. */
export function isWorkday(date: Date, calendar: WorkCalendar = DEFAULT_CALENDAR): boolean {
  return calendar.workdays.includes(getLocalParts(date, calendar.timeZone).weekday);
}
