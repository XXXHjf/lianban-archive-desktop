import type { EChartsOption, SeriesOption } from 'echarts';
import type { MinuteDetail, MinutePoint, MinuteStock, TimelineData, TimelineEvent } from './types';

export const colors = [
  '#ce6251',
  '#487da9',
  '#58616c',
  '#379286',
  '#b87935',
  '#8b6e60',
  '#667f3c',
  '#244a76',
];
export function acceptsRefresh(existing: MinuteDetail | undefined | null, incoming: MinuteDetail) {
  return (
    incoming.points.length > 0 &&
    !(existing?.fetched_at && incoming.fetched_at && incoming.fetched_at < existing.fetched_at)
  );
}
export function regularTime(clock: string): boolean {
  if (!/^\d{2}:[0-5]\d(?::[0-5]\d)?$/.test(clock)) return false;
  const [h = 0, m = 0, s = 0] = clock.split(':').map(Number);
  const seconds = h * 3600 + m * 60 + s;
  return (seconds >= 34200 && seconds <= 41400) || (seconds >= 46800 && seconds <= 54000);
}
export function clockKey(clock: string) {
  return clock.length === 5 ? `${clock}:00` : clock;
}
export function daySlot(clock: string) {
  const [h = 0, m = 0, s = 0] = clock.split(':').map(Number);
  const minute = h * 60 + m + s / 60;
  return minute < 570
    ? 0
    : Math.max(0, Math.min(241, minute >= 780 ? minute - 780 + 121 : minute - 570 + 1));
}
export function slotClock(slot: number) {
  if (slot < 1) return '09:25';
  const minute = Math.floor(slot) + (slot < 121 ? 569 : 659);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
// Unlike the compressed timeline coordinate, a chart index retains both lunch-edge observations.
export function chartSlot(clock: string) {
  const [h = 0, m = 0, s = 0] = clock.split(':').map(Number);
  const minute = h * 60 + m + s / 60;
  return minute < 570 ? 0 : minute >= 780 ? minute - 780 + 122 : minute - 570 + 1;
}
export function chartClock(slot: number) {
  if (slot < 1) return '09:25';
  const minute = Math.floor(slot) + (slot < 122 ? 569 : 658);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
export function chartPointAt(detail: MinuteDetail | null, slot: number) {
  return slot === 0
    ? detail?.auction?.points?.find((point) => point.time === '09:25')
    : detail?.points.find((point) => chartSlot(point.time) === slot);
}
export function nearestChartSlot(detail: MinuteDetail, slot: number) {
  if (slot === 0 && detail.auction?.points?.length) return 0;
  return detail.points.reduce(
    (best, point) =>
      Math.abs(chartSlot(point.time) - slot) < Math.abs(best - slot) ? chartSlot(point.time) : best,
    detail.points[0] ? chartSlot(detail.points[0].time) : 0,
  );
}
export function displayPoint(detail: MinuteDetail, point: MinutePoint): MinutePoint {
  const match = detail.auction?.points?.find((value) => value.time === '09:25');
  return point.time === '09:30' &&
    match &&
    point.volume >= match.volume &&
    point.amount + 0.1 >= match.amount
    ? {
        ...point,
        volume: Math.max(0, point.volume - match.volume),
        amount: Math.max(0, point.amount - match.amount),
      }
    : point;
}
export function stockRows(
  rows: MinuteStock[],
  search: string,
  latestCodes: ReadonlySet<string> = new Set(),
  latestDate = '',
) {
  const term = search.trim().toUpperCase();
  return rows
    .filter(
      (row) =>
        !/^(?:\*?ST|SST|S\*ST)/i.test(row.name.trim()) &&
        (!term || `${row.code} ${row.name} ${row.initials || ''}`.toUpperCase().includes(term)),
    )
    .sort(
      (a, b) =>
        b.boards - a.boards ||
        Number(latestCodes.has(b.code) && b.date !== latestDate) -
          Number(latestCodes.has(a.code) && a.date !== latestDate) ||
        a.code.localeCompare(b.code),
    );
}
export function visibleTags(
  stock: MinuteStock,
  hierarchy: { name: string; parent: string }[] = [],
) {
  const tags = stock.tags || (stock.industry ? [stock.industry] : []),
    parents = new Map(
      hierarchy.map((row) => [row.name.toLocaleLowerCase(), row.parent.toLocaleLowerCase()]),
    );
  const ancestors = new Set<string>();
  for (const tag of tags) {
    const visited = new Set<string>();
    let name = parents.get(tag.toLocaleLowerCase());
    while (name && !visited.has(name)) {
      ancestors.add(name);
      visited.add(name);
      name = parents.get(name);
    }
  }
  return tags.filter((tag) => !ancestors.has(tag.toLocaleLowerCase()));
}
export interface TimelineFilters {
  group: string;
  kind: string;
  excluded: string[];
  sort: string;
}
export function timelineRows(data: TimelineData, filters: TimelineFilters) {
  const excluded = new Set(filters.excluded),
    seals = ['seal', 'relock', 'last_seal'];
  const rows = data.pool
    .filter(
      (stock) =>
        Number.isInteger(stock.boards) &&
        stock.boards >= 1 &&
        !excluded.has(stock.code) &&
        (filters.group === 'all' ||
          (filters.group === 'first' ? stock.boards === 1 : stock.boards >= 2)),
    )
    .map((stock) => {
      const raw = data.events.filter((event) => event.code === stock.code);
      const first =
        stock.first_time && (stock.first_time.startsWith('09:25') || regularTime(stock.first_time))
          ? stock.first_time
          : raw
              .filter((event) => event.kind === 'seal' && regularTime(event.time))
              .sort((a, b) => clockKey(a.time).localeCompare(clockKey(b.time)))[0]?.time;
      const source: TimelineEvent[] =
        first && first === stock.first_time
          ? [
              {
                id: `${stock.code}-seal-${first}`,
                code: stock.code,
                name: stock.name,
                boards: stock.boards,
                time: first,
                kind: 'seal',
                label: '首次封板',
                precision: 'source',
                detail: `${stock.clock_source || '当日涨停池'}提供的首次封板时间`,
              },
            ]
          : [];
      const seen = new Set<string>();
      const events = [...source, ...raw]
        .filter((event) => {
          const key = `${event.kind}-${clockKey(event.time)}`;
          const valid =
            regularTime(event.time) ||
            (event.kind === 'seal' &&
              event.precision === 'source' &&
              /^09:25(?::[0-5]\d)?$/.test(event.time));
          if (
            !valid ||
            seen.has(key) ||
            (filters.kind !== 'all' &&
              !(filters.kind === 'seal' ? seals.includes(event.kind) : filters.kind === event.kind))
          )
            return false;
          seen.add(key);
          return true;
        })
        .sort(
          (a, b) => clockKey(a.time).localeCompare(clockKey(b.time)) || a.id.localeCompare(b.id),
        );
      return { stock, events, first };
    })
    .filter((row) => filters.kind === 'all' || row.events.length);
  return rows.sort(
    (a, b) =>
      (filters.sort === 'first_time'
        ? Number(!a.first) - Number(!b.first) || (a.first || '').localeCompare(b.first || '')
        : 0) ||
      b.stock.boards - a.stock.boards ||
      a.stock.code.localeCompare(b.stock.code),
  );
}
export function priceOption(details: MinuteDetail[], average: boolean): EChartsOption {
  const primary = details[0],
    previous = primary?.previous_close || 0;
  const slots = Array.from({ length: 243 }, (_, index) => chartClock(index));
  const series: SeriesOption[] = [];
  const extent =
    Math.max(
      previous * 0.01,
      ...details.flatMap((detail) =>
        [...detail.points, ...(detail.auction?.points || [])].flatMap((point) =>
          detail.previous_close
            ? [
                Math.abs(point.price / detail.previous_close - 1) * previous,
                average && detail === primary && point.average
                  ? Math.abs(point.average - previous)
                  : 0,
              ]
            : [],
        ),
      ),
    ) * 1.08;
  const low = Math.max(0.001, previous - extent),
    high = Math.max(low + 0.001, previous + extent);
  details.forEach((detail, index) => {
    if (!(detail.previous_close && detail.previous_close > 0)) return;
    const close = detail.previous_close;
    const points = new Map(detail.points.map((point) => [chartSlot(point.time), point]));
    const auction = detail.auction?.points?.find((point) => point.time === '09:25');
    if (auction)
      series.push({
        type: 'scatter',
        name: `${detail.stock.name} 09:25撮合`,
        itemStyle: { color: colors[index % colors.length] },
        symbolSize: 8,
        data: [[0, (auction.price / close) * previous]],
      });
    series.push({
      type: 'line',
      name: `${detail.stock.name}${index ? '' : '（主图）'}`,
      showSymbol: false,
      connectNulls: false,
      itemStyle: { color: colors[index % colors.length] },
      lineStyle: {
        width: index ? 1.4 : 2,
        type:
          index < colors.length
            ? 'solid'
            : Math.floor(index / colors.length) % 2
              ? 'dashed'
              : 'dotted',
      },
      data: slots.map((_, slot) => {
        const point = points.get(slot);
        return point ? (point.price / close) * previous : null;
      }),
    });
    if (!index && average)
      series.push({
        type: 'line',
        name: '均价',
        showSymbol: false,
        connectNulls: false,
        itemStyle: { color: '#b58c2e' },
        data: slots.map((_, slot) => points.get(slot)?.average ?? null),
      });
  });
  return {
    animation: false,
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    legend: { type: 'scroll' },
    grid: { left: 62, right: 62, top: 42, bottom: 66 },
    xAxis: { type: 'category', data: slots, boundaryGap: false },
    yAxis: [
      { type: 'value', min: low, max: high, scale: true, name: '主图价格 / 元' },
      {
        type: 'value',
        min: low,
        max: high,
        name: '涨幅',
        scale: true,
        axisLabel: {
          formatter: (value: number) =>
            previous > 0 ? `${((value / previous - 1) * 100).toFixed(2)}%` : '—',
        },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      { type: 'slider', xAxisIndex: 0, bottom: 10 },
    ],
    series,
  };
}
export function volumeOption(details: MinuteDetail[], shared: boolean): EChartsOption {
  const maxima = details.map((detail) =>
    Math.max(
      1,
      ...detail.points.map((point) => displayPoint(detail, point).volume / 100),
      ...(detail.auction?.points || []).map((point) => point.volume / 100),
    ),
  );
  const common = Math.max(1, ...maxima),
    rowHeight = 110;
  const slots = Array.from({ length: 243 }, (_, index) => chartClock(index));
  return {
    animation: false,
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
    grid: details.map((_, index) => ({
      left: 62,
      right: 24,
      top: index * rowHeight + 22,
      height: 72,
    })),
    xAxis: details.map((_, index) => ({
      type: 'category' as const,
      gridIndex: index,
      data: slots,
      axisLabel: { show: index === details.length - 1 },
    })),
    yAxis: details.map((detail, index) => ({
      type: 'value' as const,
      gridIndex: index,
      name: `${detail.stock.name} / 手`,
      min: 0,
      max: shared ? common : maxima[index],
    })),
    dataZoom: [
      { type: 'inside', xAxisIndex: details.map((_, index) => index) },
      { type: 'slider', xAxisIndex: details.map((_, index) => index), bottom: 0 },
    ],
    series: details.map((detail, index) => {
      const points = new Map(
        detail.points.map((point) => [
          chartSlot(point.time),
          displayPoint(detail, point).volume / 100,
        ]),
      );
      const auction = detail.auction?.points?.find((point) => point.time === '09:25');
      if (auction) points.set(0, auction.volume / 100);
      return {
        type: 'bar' as const,
        name: detail.stock.name,
        xAxisIndex: index,
        yAxisIndex: index,
        itemStyle: { color: colors[index % colors.length] },
        data: slots.map((_, slot) => points.get(slot) ?? null),
      };
    }),
  };
}
