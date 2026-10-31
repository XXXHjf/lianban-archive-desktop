import type { Metadata } from './workspace';

export interface TradingCalendar {
  dates: string[];
  start: string;
  end: string;
  latest_trade_date: string | null;
  calendar_date: string;
}

export function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

// Only confirmed open sessions are selectable; unknown dates stay disabled.
export function tradingDates(meta: Metadata | null): string[] {
  const calendar = meta?.trading_calendar;
  const dates = calendar
    ? calendar.dates.filter(
        (day) => day >= calendar.start && day <= calendar.end && day <= calendar.calendar_date,
      )
    : meta?.dates || [];
  return [...new Set(dates)].sort();
}

export function latestTradeDate(meta: Metadata | null): string {
  if (meta?.trading_calendar) return meta.trading_calendar.latest_trade_date || '';
  return tradingDates(meta).at(-1) || '';
}

export function tradingDateDisabled(
  value: Date,
  meta: Metadata | null,
  available?: readonly string[],
): boolean {
  const day = localDate(value);
  return !tradingDates(meta).includes(day) || (available !== undefined && !available.includes(day));
}
