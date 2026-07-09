import { describe, expect, it } from "vitest";
import {
  ISRAEL_CALENDAR,
  MON_FRI_CALENDAR,
  getDayKey,
  getNextDailyCutoff,
  getNextWeeklyReset,
  getQuestPeriodKeys,
  getWeekKey,
  hasPassedDailyCutoff,
  isWorkday,
  zonedTimeToUtc,
} from "./workCalendar";

describe("getDayKey", () => {
  it("uses the calendar's local date, not UTC", () => {
    // 23:30 UTC = 02:30 next day in Israel (summer, UTC+3)
    const d = new Date("2026-07-06T23:30:00.000Z");
    expect(getDayKey(d, ISRAEL_CALENDAR)).toBe("2026-07-07");
  });
});

describe("hasPassedDailyCutoff (15:30 local)", () => {
  it("false before the cutoff", () => {
    // 12:00 UTC = 15:00 Israel summer time
    expect(hasPassedDailyCutoff(new Date("2026-07-06T12:00:00.000Z"), ISRAEL_CALENDAR)).toBe(false);
  });
  it("true at/after the cutoff", () => {
    // 12:30 UTC = 15:30 Israel summer time
    expect(hasPassedDailyCutoff(new Date("2026-07-06T12:30:00.000Z"), ISRAEL_CALENDAR)).toBe(true);
  });
});

describe("getWeekKey (Sunday 06:00 Israel reset)", () => {
  it("Saturday belongs to the week started the previous Sunday", () => {
    // Sat 2026-07-11 12:00 Israel
    const d = new Date("2026-07-11T09:00:00.000Z");
    expect(getWeekKey(d, ISRAEL_CALENDAR)).toBe("2026-07-05");
  });

  it("Sunday before 06:00 still belongs to the previous week", () => {
    // Sun 2026-07-12 05:00 Israel (02:00 UTC)
    const d = new Date("2026-07-12T02:00:00.000Z");
    expect(getWeekKey(d, ISRAEL_CALENDAR)).toBe("2026-07-05");
  });

  it("Sunday after 06:00 starts the new week", () => {
    // Sun 2026-07-12 07:00 Israel (04:00 UTC)
    const d = new Date("2026-07-12T04:00:00.000Z");
    expect(getWeekKey(d, ISRAEL_CALENDAR)).toBe("2026-07-12");
  });

  it("supports Monday-start calendars", () => {
    // Sun 2026-07-12 12:00 UTC — Monday-start week began Mon 2026-07-06
    const d = new Date("2026-07-12T12:00:00.000Z");
    expect(getWeekKey(d, MON_FRI_CALENDAR)).toBe("2026-07-06");
  });
});

describe("zonedTimeToUtc", () => {
  it("converts Israel summer time (UTC+3) correctly", () => {
    const utc = zonedTimeToUtc(2026, 7, 6, 15, 30, "Asia/Jerusalem");
    expect(utc.toISOString()).toBe("2026-07-06T12:30:00.000Z");
  });

  it("converts Israel winter time (UTC+2) correctly — the old +3 approximation got this wrong", () => {
    const utc = zonedTimeToUtc(2026, 1, 15, 15, 30, "Asia/Jerusalem");
    expect(utc.toISOString()).toBe("2026-01-15T13:30:00.000Z");
  });
});

describe("getNextDailyCutoff", () => {
  it("returns today's cutoff when not yet passed", () => {
    const d = new Date("2026-07-06T08:00:00.000Z"); // 11:00 Israel
    expect(getNextDailyCutoff(d, ISRAEL_CALENDAR).toISOString()).toBe(
      "2026-07-06T12:30:00.000Z",
    );
  });

  it("returns tomorrow's cutoff when already passed", () => {
    const d = new Date("2026-07-06T13:00:00.000Z"); // 16:00 Israel
    expect(getNextDailyCutoff(d, ISRAEL_CALENDAR).toISOString()).toBe(
      "2026-07-07T12:30:00.000Z",
    );
  });
});

describe("getNextWeeklyReset", () => {
  it("returns the coming Sunday 06:00 Israel", () => {
    // Wed 2026-07-08 12:00 Israel
    const d = new Date("2026-07-08T09:00:00.000Z");
    // Sunday 2026-07-12 06:00 Israel = 03:00 UTC (summer)
    expect(getNextWeeklyReset(d, ISRAEL_CALENDAR).toISOString()).toBe(
      "2026-07-12T03:00:00.000Z",
    );
  });
});

describe("isWorkday", () => {
  it("Sunday is a workday in Israel but not Mon-Fri", () => {
    const sunday = new Date("2026-07-12T09:00:00.000Z");
    expect(isWorkday(sunday, ISRAEL_CALENDAR)).toBe(true);
    expect(isWorkday(sunday, MON_FRI_CALENDAR)).toBe(false);
  });

  it("Friday is not a workday in Israel", () => {
    const friday = new Date("2026-07-10T09:00:00.000Z");
    expect(isWorkday(friday, ISRAEL_CALENDAR)).toBe(false);
    expect(isWorkday(friday, MON_FRI_CALENDAR)).toBe(true);
  });
});

describe("getQuestPeriodKeys", () => {
  it("returns matching day and week keys", () => {
    const d = new Date("2026-07-08T09:00:00.000Z"); // Wed
    const keys = getQuestPeriodKeys(d, ISRAEL_CALENDAR);
    expect(keys.dayKey).toBe("2026-07-08");
    expect(keys.weekKey).toBe("2026-07-05");
  });
});
