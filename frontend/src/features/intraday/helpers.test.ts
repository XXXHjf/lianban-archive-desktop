import { describe, expect, it } from 'vitest';
import { financialModel, minuteTime } from './financialModel';
import {
  acceptsRefresh,
  chartClock,
  chartPointAt,
  chartSlot,
  daySlot,
  displayPoint,
  nearestChartSlot,
  regularTime,
  slotClock,
  stockRows,
  timelineRows,
  visibleTags,
} from './helpers';
import type { MinuteDetail, MinuteStock, TimelineData, TimelineEvent } from './types';

const stock: MinuteStock = { code: '000001', name: '测试股票', boards: 2, first_time: '09:25:00' };
const detail: MinuteDetail = {
  date: '2026-10-23',
  stock,
  status: 'partial',
  note: 'fixture',
  previous_close: 10,
  points: [],
  auction: { points: [{ time: '09:25', slot: 0, price: 11, volume: 10000, amount: 110000 }] },
};
const event = (kind: TimelineEvent['kind'], time: string, precision = 'minute'): TimelineEvent => ({
  id: `${stock.code}-${kind}-${time}`,
  code: stock.code,
  name: stock.name,
  boards: stock.boards,
  kind,
  time,
  precision,
  label: kind,
  detail: 'fixture',
});
const data = (events: TimelineEvent[]): TimelineData => ({
  date: detail.date,
  pool: [stock],
  events,
  scope: { exclude_st: true, exclude_gem: true },
  coverage: { total: 1, analyzed: 1, partial: 1, missing: 0 },
  jobs: [],
});
describe('intraday exact API display semantics', () => {
  it('keeps auction discrete and maps the compressed lunch boundary without losing source seconds', () => {
    expect(daySlot('09:25:00')).toBe(0);
    expect(daySlot('09:30')).toBe(1);
    expect(daySlot('11:30')).toBe(121);
    expect(daySlot('13:00')).toBe(121);
    expect(daySlot('15:00')).toBe(241);
    expect(daySlot('09:30:30')).toBe(1.5);
    expect(slotClock(1)).toBe('09:30');
    expect(slotClock(241)).toBe('15:00');
    expect(regularTime('12:00')).toBe(false);
    expect(regularTime('09:25')).toBe(false);
  });
  it('subtracts the auction only from a cumulative 09:30 point, leaving inputs untouched', () => {
    const point = { time: '09:30', slot: 0, price: 11, volume: 15000, amount: 165000 };
    expect(displayPoint(detail, point)).toMatchObject({ volume: 5000, amount: 55000 });
    expect(point.volume).toBe(15000);
    expect(displayPoint(detail, { ...point, amount: 100 })).toMatchObject({
      volume: 15000,
      amount: 100,
    });
    expect(displayPoint(detail, { ...point, time: '09:31' })).toMatchObject({ volume: 15000 });
  });
  it('retains separate 11:30 and 13:00 chart observations and locates the nearest actual available minute', () => {
    expect(chartSlot('11:30')).toBe(121);
    expect(chartSlot('13:00')).toBe(122);
    expect(chartClock(121)).toBe('11:30');
    expect(chartClock(122)).toBe('13:00');
    expect(chartClock(242)).toBe('15:00');
    const points = [
      { time: '10:00', slot: 30, price: 11, volume: 1, amount: 11 },
      { time: '10:03', slot: 33, price: 11, volume: 1, amount: 11 },
    ];
    expect(nearestChartSlot({ ...detail, points }, chartSlot('10:01:50'))).toBe(chartSlot('10:03'));
    expect(nearestChartSlot({ ...detail, points }, 0)).toBe(0);
  });
  it('reads distinct lunch-edge prices through the same selector used by the minute slider', () => {
    const lunchDetail: MinuteDetail = {
      ...detail,
      auction: { points: [] },
      points: [
        { time: '11:30', slot: 120, price: 11, volume: 100, amount: 1100 },
        { time: '13:00', slot: 120, price: 12, volume: 200, amount: 2400 },
      ],
    };
    // The API/timeline compression shares a slot; the readable chart must retain actual clocks.
    expect(daySlot('11:30')).toBe(daySlot('13:00'));
    expect(chartPointAt(lunchDetail, chartSlot('11:30'))).toMatchObject({
      time: '11:30',
      price: 11,
      volume: 100,
    });
    expect(chartPointAt(lunchDetail, chartSlot('13:00'))).toMatchObject({
      time: '13:00',
      price: 12,
      volume: 200,
    });
    expect(chartClock(121)).toBe('11:30');
    expect(chartClock(122)).toBe('13:00');
    expect(chartPointAt(lunchDetail, chartSlot('13:01'))).toBeUndefined();
    expect(nearestChartSlot(lunchDetail, chartSlot('13:00:10'))).toBe(122);
    expect(financialModel([lunchDetail], false).stocks[0]?.price).toEqual([
      { time: minuteTime(lunchDetail.date, 121), value: 11 },
      { time: minuteTime(lunchDetail.date, 122), value: 12 },
    ]);
  });
  it('keeps source first and last seals, deduplicates minute-equivalent source nodes and rejects lunch observations', () => {
    const rows = timelineRows(
      data([
        event('seal', '09:25', 'source'),
        event('last_seal', '14:59:42', 'source'),
        event('volume', '12:00'),
        event('break', '10:00'),
      ]),
      { group: 'all', kind: 'all', excluded: [], sort: 'boards' },
    );
    expect(rows[0]?.events.map((event) => event.kind)).toEqual(['seal', 'break', 'last_seal']);
    expect(rows[0]?.events[0]?.precision).toBe('source');
    expect(rows[0]?.events[2]?.time).toBe('14:59:42');
    expect(
      timelineRows(data([event('break', '10:00')]), {
        group: 'all',
        kind: 'seal',
        excluded: [],
        sort: 'boards',
      })[0]?.events.map((event) => event.kind),
    ).toEqual(['seal']);
    expect(
      timelineRows(data([]), { group: 'all', kind: 'all', excluded: [stock.code], sort: 'boards' }),
    ).toEqual([]);
  });
  it('uses board height then latest-day membership for historical catalog prioritization', () => {
    const rows = [
      { ...stock, code: '000001', date: '2026-10-22' },
      { ...stock, code: '000002', date: '2026-10-22' },
      { ...stock, code: '000003', boards: 3 },
    ];
    expect(stockRows(rows, '', new Set(['000002']), '2026-10-23').map((row) => row.code)).toEqual([
      '000003',
      '000002',
      '000001',
    ]);
    expect(stockRows([...rows, { ...stock, name: '*ST测试', code: '000004' }], 'ST')).toEqual([]);
  });
  it('does not replace a visible cache with empty or older live responses', () => {
    const points = [{ time: '10:00', slot: 30, price: 11, volume: 1, amount: 11 }];
    const current = { ...detail, points, fetched_at: '2026-10-23T10:05:00+08:00' };
    expect(acceptsRefresh(current, { ...current, points: [] })).toBe(false);
    expect(acceptsRefresh(current, { ...current, fetched_at: '2026-10-23T10:04:00+08:00' })).toBe(
      false,
    );
    expect(acceptsRefresh(current, { ...current, fetched_at: '2026-10-23T10:06:00+08:00' })).toBe(
      true,
    );
  });
  it('shows leaf tags with an industry fallback and bounds malformed hierarchy cycles', () => {
    expect(visibleTags({ ...stock, industry: '汽车' })).toEqual(['汽车']);
    expect(
      visibleTags({ ...stock, tags: ['汽车', '整车'] }, [{ name: '整车', parent: '汽车' }]),
    ).toEqual(['整车']);
    expect(() =>
      visibleTags({ ...stock, tags: ['整车'] }, [
        { name: '整车', parent: '汽车' },
        { name: '汽车', parent: '整车' },
      ]),
    ).not.toThrow();
  });
});
