import type { Hierarchy } from './helpers';
import type { DailyData, Group, Stock } from './models';

export function topicPath(label: string, tags: Hierarchy) {
  return [...tags.ancestors(label)].reverse().concat(label).join(' / ');
}

export function matchesTopic(stock: Stock, topic: string, tags: Hierarchy) {
  return (
    !topic ||
    tags
      .all(stock)
      .some((label) =>
        [label, ...tags.ancestors(label)].some(
          (name) => name.toLowerCase() === topic.toLowerCase(),
        ),
      )
  );
}

export function dailyTopics(rows: Stock[], tags: Hierarchy) {
  const topics = new Map<string, { label: string; count: number; height: number; root: string }>();
  for (const stock of new Map(rows.map((row) => [row.code, row])).values()) {
    const labels = new Set(tags.all(stock).flatMap((label) => [label, ...tags.ancestors(label)]));
    for (const label of labels) {
      const entry = topics.get(label) || { label, count: 0, height: 0, root: tags.root(label) };
      entry.count++;
      entry.height = Math.max(entry.height, stock.boards || 0);
      topics.set(label, entry);
    }
  }
  return [...topics.values()].sort(
    (a, b) =>
      b.height - a.height ||
      b.count - a.count ||
      tags.compare(a.label, b.label) ||
      a.label.localeCompare(b.label, 'zh-CN'),
  );
}

// Fetch one day, then apply topic and exact-height filters to the same stock set.
export function dailyScope(
  source: DailyData,
  topic: string,
  boards: string,
  tags: Hierarchy,
): DailyData {
  const all = [...new Map(source.rows.map((stock) => [stock.code, stock])).values()].filter(
    (stock) => matchesTopic(stock, topic, tags),
  );
  const rows = all.filter((stock) => !boards || String(stock.boards) === boards);
  const suspended = source.suspended_rows.filter(
    (stock) => matchesTopic(stock, topic, tags) && (!boards || String(stock.boards) === boards),
  );
  const counts = new Map<number, number>();
  all.forEach((stock) => counts.set(stock.boards || 0, (counts.get(stock.boards || 0) || 0) + 1));
  return {
    ...source,
    rows,
    suspended_rows: suspended,
    available_total: all.length,
    board_counts: [...counts].map(([height, count]) => ({ boards: height, count })),
    trading_max_boards: Math.max(0, ...rows.map((stock) => stock.boards || 0)),
    stats: {
      total: rows.length,
      consecutive: rows.filter((stock) => (stock.boards || 0) >= 2).length,
      max_boards: Math.max(0, ...[...rows, ...suspended].map((stock) => stock.boards || 0)),
      first_boards: rows.filter((stock) => stock.boards === 1).length,
    },
  };
}

export function isArchiveDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Matching views retain their groups. The default topic view renders each stock once.
export function ladderBands(
  groups: Group[],
  mode: string,
  _tags: Hierarchy,
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
      groups: (mode === 'industry' ? [{ labels: [] as string[], stocks: all }] : groups).flatMap(
        (group) => {
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
                  sections: [{ labels: [] as string[], stocks }],
                },
              ];
        },
      ),
    }));
}

export function groupIdentity(labels: string[]) {
  return JSON.stringify(labels);
}
export function uniqueCount(stocks: Stock[]) {
  return new Set(stocks.map((stock) => stock.code)).size;
}
