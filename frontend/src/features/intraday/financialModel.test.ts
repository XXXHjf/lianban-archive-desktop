import { describe, expect, it } from 'vitest';
import { financialModel, minuteTime, percentPrice, priceRuns, timeClock } from './financialModel';
import type { MinuteDetail, MinutePoint } from './types';

const point = (time: string, price = 11, volume = 10000): MinutePoint => ({
  time,
  price,
  volume,
  amount: price * volume,
  slot: 0,
});
const detail: MinuteDetail = {
  date: '2026-10-30',
  stock: { code: '001219', name: '测试', boards: 5 },
  status: 'complete',
  previous_close: 10,
  points: [],
  note: '',
};

describe('financial market data adapter', () => {
  it('retains the full day, Shanghai timestamps, both lunch edges and missing observations', () => {
    const result = financialModel(
      [{ ...detail, points: [point('11:30'), point('13:00'), point('13:02')] }],
      false,
    );
    expect(result.grid).toHaveLength(243);
    expect(result.grid[121]?.time).toBe(minuteTime(detail.date, 121));
    expect(timeClock(result.grid[121]!.time)).toBe('11:30');
    expect(timeClock(result.grid[122]!.time)).toBe('13:00');
    expect(result.stocks[0]?.price).toHaveLength(3);
    expect(priceRuns(result.stocks[0]!.price).map((run) => run.length)).toEqual([2, 1]);
  });
  it('keeps the auction independent and subtracts it only from the inclusive opening bar', () => {
    const result = financialModel(
      [
        {
          ...detail,
          points: [point('09:30', 11, 15000), point('09:31', 10.9, 3000)],
          auction: { points: [point('09:25', 11, 10000)] },
        },
      ],
      false,
    );
    expect(result.stocks[0]?.volume.map((bar) => bar.value)).toEqual([100, 50, 30]);
    expect(result.stocks[0]?.volume[2]?.color).toBe('#24885b');
    expect(priceRuns(result.stocks[0]!.price).map((run) => run.length)).toEqual([1, 2]);
  });
  it('normalizes peer prices by previous close while preserving each real volume and price', () => {
    const primary = { ...detail, points: [point('09:30')] };
    const peer = {
      ...detail,
      stock: { ...detail.stock, code: '000002' },
      previous_close: 20,
      points: [point('09:30', 22, 20000)],
    };
    const result = financialModel([primary, peer], false);
    expect(result.stocks.map((stock) => stock.price[0]?.value)).toEqual([11, 11]);
    expect(result.stocks.map((stock) => stock.maximum)).toEqual([100, 200]);
    expect(result.volumeMaximum).toBe(200);
    expect(peer.points[0]?.price).toBe(22);
    expect(percentPrice(11, 10)).toBe('+10.00%');
  });
  it('includes enabled average in the shared price range, and keeps unavailable average empty', () => {
    const input = { ...detail, points: [{ ...point('10:00', 10.1), average: 8.8 }] };
    expect(financialModel([input], true).range.minValue).toBeCloseTo(8.8);
    expect(financialModel([input], false).range.minValue).toBeCloseTo(9);
    expect(financialModel([{ ...detail, points: [point('10:00')] }], true).stocks[0]?.mean).toEqual(
      [],
    );
  });
  it('uses rounded main-board limit prices and keeps the range centered on yesterday close', () => {
    const input = { ...detail, previous_close: 5.37, points: [point('09:30', 5.91)] };
    const range = financialModel([input], false).range;
    expect(range.maxValue).toBeCloseTo(5.91);
    expect(range.minValue).toBeCloseTo(4.83);
  });
});
