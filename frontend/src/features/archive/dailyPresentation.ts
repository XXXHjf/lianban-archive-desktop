import { subgroups, type Hierarchy } from './helpers';
import type { Group, Stock } from './models';

export function isArchiveDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Keep the original grouping/matching algorithms; only build a height-first reading model.
export function ladderBands(
  groups: Group[],
  mode: string,
  tags: Hierarchy,
  provisional: boolean,
  latestCodes: Set<string>,
  latestDate: string,
) {
  const all = [
    ...new Map(
      groups.flatMap((group) => group.stocks).map((stock) => [stock.code, stock]),
    ).values(),
  ];
  return [...new Set(all.map((stock) => stock.boards || 0))]
    .sort((a, b) => b - a)
    .map((height) => ({
      height,
      count: all.filter((stock) => stock.boards === height).length,
      groups: groups.flatMap((group) => {
        const stocks = group.stocks.filter((stock) => stock.boards === height);
        if (!['code', 'pinyin'].includes(mode) && !provisional)
          stocks.sort(
            (a, b) =>
              Number(latestCodes.has(b.code) && b.date !== latestDate) -
                Number(latestCodes.has(a.code) && a.date !== latestDate) ||
              a.code.localeCompare(b.code),
          );
        return !stocks.length
          ? []
          : [
              {
                labels: group.labels,
                sections:
                  mode === 'industry'
                    ? subgroups(stocks, group.labels[0] || '', tags)
                    : [{ labels: [] as string[], stocks }],
              },
            ];
      }),
    }));
}

export function groupIdentity(labels: string[]) {
  return JSON.stringify(labels);
}
export function uniqueCount(stocks: Stock[]) {
  return new Set(stocks.map((stock) => stock.code)).size;
}
