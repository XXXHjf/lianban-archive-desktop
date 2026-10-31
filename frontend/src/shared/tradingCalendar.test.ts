import { describe, expect, it } from 'vitest';
import { latestTradeDate, localDate, tradingDateDisabled, tradingDates } from './tradingCalendar';
import type { Metadata } from './workspace';

const meta: Metadata = {
  dates: ['2026-09-30', '2026-10-29'],
  trading_calendar: {
    dates: ['2026-09-30', '2026-10-09', '2026-10-29', '2026-10-30', '2026-11-02'],
    start: '2026-01-01',
    end: '2026-12-31',
    latest_trade_date: '2026-10-30',
    calendar_date: '2026-10-31',
  },
};
const day = (value: string) => new Date(`${value}T12:00:00`);

describe('shared trading calendar', () => {
  it('disables holidays, weekends, future and unknown dates while allowing a session without archived data', () => {
    for (const value of ['2026-10-01', '2026-10-31', '2026-11-02', '2025-12-31'])
      expect(tradingDateDisabled(day(value), meta)).toBe(true);
    expect(tradingDateDisabled(day('2026-10-30'), meta)).toBe(false);
    expect(latestTradeDate(meta)).toBe('2026-10-30');
    expect(tradingDates(meta).at(-1)).toBe('2026-10-30');
  });
  it('keeps intraday and confirmed node availability as an intersection', () => {
    const available = ['2026-10-01', '2026-10-29'];
    expect(tradingDateDisabled(day('2026-10-01'), meta, available)).toBe(true);
    expect(tradingDateDisabled(day('2026-10-30'), meta, available)).toBe(true);
    expect(tradingDateDisabled(day('2026-10-29'), meta, available)).toBe(false);
  });
  it('does not invent sessions when the calendar is empty and falls back only for older metadata', () => {
    expect(tradingDateDisabled(day('2026-10-29'), null)).toBe(true);
    const empty = {
      ...meta,
      trading_calendar: { ...meta.trading_calendar!, dates: [], latest_trade_date: null },
    };
    expect(tradingDates(empty)).toEqual([]);
    expect(latestTradeDate(empty)).toBe('');
    expect(tradingDates({ dates: ['2026-10-29'], query_dates: ['2026-10-31'] })).toEqual([
      '2026-10-29',
    ]);
    expect(localDate(day('2026-10-29'))).toBe('2026-10-29');
  });
});
