import { describe, expect, it } from "vitest";

import { addDaysISO, isISODate, isoDateTimeToLocalDate } from "./date";

describe("date helpers", () => {
  it.each(["2026-09-28", "2028-02-29", "2027-01-01", "9999-12-31"])("accepts a valid calendar day %s", (value) => {
    expect(isISODate(value)).toBe(true);
  });

  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-09-00", "2026-9-28", "2026-09-28T00:00:00Z", "0000-01-01", "", undefined, 20260928])("rejects invalid calendar day %s", (value) => {
    expect(isISODate(value)).toBe(false);
  });
  it("derives review dates from local time instead of UTC date prefixes", () => {
    expect(isoDateTimeToLocalDate("2026-07-02T16:30:00.000Z")).toBe("2026-07-03");
    expect("2026-07-02T16:30:00.000Z".slice(0, 10)).toBe("2026-07-02");
  });

  it("keeps review next dates on ISO calendar days", () => {
    expect(addDaysISO("2026-07-03", 1)).toBe("2026-07-04");
  });
});
