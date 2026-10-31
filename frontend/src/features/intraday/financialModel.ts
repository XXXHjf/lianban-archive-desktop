import type { HistogramData, LineData, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import { chartClock, chartSlot, displayPoint, regularTime } from './helpers';
import type { MinuteDetail } from './types';

export const marketUp = '#c84444';
export const marketDown = '#24885b';
export const compareColors = ['#2563eb', '#9b6b35', '#379286', '#7b647d', '#667f3c', '#244a76'];

export function minuteTime(date: string, slot: number): UTCTimestamp {
  return (Date.parse(`${date}T${chartClock(slot)}:00+08:00`) / 1000) as UTCTimestamp;
}
export function timeClock(time: number) {
  return new Date((time + 8 * 3600) * 1000).toISOString().slice(11, 16);
}
export function formatVolume(value: number) {
  return value >= 10000 ? `${(value / 10000).toFixed(2)}万` : value.toFixed(0);
}
export function percentPrice(value: number, previous: number) {
  const pct = previous > 0 ? (value / previous - 1) * 100 : 0;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

// The complete trading grid preserves missing observations and both lunch endpoints.
// Timestamps are real Shanghai times; the chart engine collapses the lunch break.
export function financialModel(details: MinuteDetail[], average: boolean) {
  const primary = details[0];
  const date = primary?.date || '2000-01-01';
  const previous = primary?.previous_close || 0;
  const grid: WhitespaceData<UTCTimestamp>[] = Array.from({ length: 243 }, (_, slot) => ({
    time: minuteTime(date, slot),
  }));
  let extent = previous * 0.01;
  const stocks = details.map((detail, index) => {
    const close = detail.previous_close || 0;
    const bySlot = new Map(
      detail.points
        .filter((point) => regularTime(point.time))
        .map((point) => [chartSlot(point.time), point]),
    );
    const auction = detail.auction?.points?.find((point) => point.time === '09:25');
    if (auction) bySlot.set(0, auction);
    const price: LineData<UTCTimestamp>[] = [];
    const mean: LineData<UTCTimestamp>[] = [];
    const volume: HistogramData<UTCTimestamp>[] = [];
    let lastPrice = close;
    for (let slot = 0; slot < grid.length; slot++) {
      const raw = bySlot.get(slot);
      if (!raw || !Number.isFinite(raw.price) || raw.price <= 0) continue;
      const time = minuteTime(date, slot);
      if (close > 0 && previous > 0) {
        const value = (raw.price / close) * previous;
        price.push({ time, value });
        extent = Math.max(extent, Math.abs(value - previous));
      }
      if (!index && average && raw.average && Number.isFinite(raw.average)) {
        mean.push({ time, value: raw.average });
        extent = Math.max(extent, Math.abs(raw.average - previous));
      }
      const point = slot === 0 ? raw : displayPoint(detail, raw);
      if (Number.isFinite(point.volume) && point.volume >= 0)
        volume.push({
          time,
          value: point.volume / 100,
          color: raw.price >= lastPrice ? marketUp : marketDown,
        });
      lastPrice = raw.price;
    }
    return {
      detail,
      price,
      mean,
      volume,
      maximum: Math.max(1, ...volume.map((point) => point.value)),
    };
  });
  const padding = extent * 1.06;
  return {
    date,
    previous,
    grid,
    stocks,
    range: {
      minValue: Math.max(0.001, previous - padding),
      maxValue: Math.max(0.002, previous + padding),
    },
    volumeMaximum: Math.max(1, ...stocks.map((stock) => stock.maximum)),
  };
}

// Separate runs prevent a line being drawn across missing market observations.
// 09:25 is an isolated auction print, never joined to the continuous session.
export function priceRuns(points: LineData<UTCTimestamp>[]) {
  const runs: LineData<UTCTimestamp>[][] = [];
  for (const point of points) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    const slot = chartSlot(timeClock(point.time));
    if (!run || !previous || slot === 1 || slot !== chartSlot(timeClock(previous.time)) + 1)
      runs.push([point]);
    else run.push(point);
  }
  return runs;
}
