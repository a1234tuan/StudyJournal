import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";

import type { ISODate, ISODateTime } from "../types";

export const todayISO = (): ISODate => format(new Date(), "yyyy-MM-dd");

export const nowISO = (): ISODateTime => new Date().toISOString();

export const toISODate = (date: Date): ISODate => format(date, "yyyy-MM-dd");

export const isoDateTimeToLocalDate = (dateTime: ISODateTime): ISODate =>
  toISODate(new Date(dateTime));

export const addDaysISO = (date: ISODate, days: number): ISODate =>
  toISODate(addDays(parseISO(date), days));

export const daysUntil = (date: ISODate): number => {
  const parsed = parseISO(date);
  if (!isValid(parsed)) {
    return 0;
  }
  return differenceInCalendarDays(parsed, new Date());
};

export const formatChineseDate = (date: ISODate): string =>
  format(parseISO(date), "yyyy 年 M 月 d 日");

/** Month-and-day only, for grouping labels where the year is redundant. */
export const formatChineseMonthDay = (date: ISODate): string =>
  format(parseISO(date), "M 月 d 日");

export const monthCalendarDays = (month: Date): ISODate[] => {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  return eachDayOfInterval({ start, end }).map(toISODate);
};

export const weekRangeLabel = (): string => {
  const now = new Date();
  return `${format(startOfWeek(now, { weekStartsOn: 1 }), "M.d")} - ${format(
    endOfWeek(now, { weekStartsOn: 1 }),
    "M.d",
  )}`;
};
