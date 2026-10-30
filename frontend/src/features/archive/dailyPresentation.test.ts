import { expect, it } from 'vitest';
import { hierarchy } from './helpers';
import { dailyScope, dailyTopics, isArchiveDate, ladderBands } from './dailyPresentation';
import type { DailyData, Stock } from './models';

it('renders a stock with several root and child memberships only once in the topic ladder', () => {
  const stock: Stock = {
    code: '002708',
    name: '光洋股份',
    boards: 4,
    tags: ['减速器', '汽车', 'PCB'],
  };
  const food: Stock = { code: '001219', name: '青岛食品', boards: 4, tags: ['食品'] };
  const tags = hierarchy([
    { name: '减速器', parent: '机器人' },
    { name: 'PCB', parent: '算力硬件' },
  ]);
  const groups = [
    { labels: ['机器人'], stocks: [stock] },
    { labels: ['汽车'], stocks: [stock] },
    { labels: ['算力硬件'], stocks: [stock] },
    { labels: ['消费'], stocks: [food] },
  ];
  const band = ladderBands(groups, 'industry', tags, false, new Set(), '')[0]!;
  expect(band.count).toBe(2);
  expect(band.groups).toHaveLength(1);
  expect(
    band.groups
      .flatMap((group) => group.sections.flatMap((section) => section.stocks))
      .map((row) => row.code),
  ).toEqual(['001219', '002708']);
  expect(stock.tags).toEqual(['减速器', '汽车', 'PCB']);
  expect(groups).toHaveLength(4);
});

it('filters nested topics and heights without duplicating counts or mixing suspended stocks into trading counts', () => {
  const tags = hierarchy([{ name: '减速器', parent: '机器人' }]);
  const stock: Stock = { code: '002708', name: '光洋股份', boards: 4, tags: ['减速器', '机器人'] };
  const source: DailyData = {
    date: '2026-10-29',
    rows: [
      stock,
      stock,
      { code: '000001', name: '乙', boards: 2, tags: ['机器人'] },
      { code: '001219', name: '青岛食品', boards: 4, tags: ['食品'] },
    ],
    suspended_rows: [{ code: '000002', name: '停牌股', boards: 5, tags: ['减速器'] }],
    coverage_note: '',
    data_status: 'ok',
    trading_max_boards: 4,
    available_total: 3,
    board_counts: [],
    tag_board_counts: {},
    stats: { total: 3, consecutive: 3, max_boards: 5, first_boards: 0 },
  };
  const filtered = dailyScope(source, '机器人', '4', tags);
  expect(filtered.rows.map((row) => row.code)).toEqual(['002708']);
  expect(filtered.available_total).toBe(2);
  expect(filtered.board_counts).toEqual([
    { boards: 4, count: 1 },
    { boards: 2, count: 1 },
  ]);
  expect(filtered.suspended_rows).toHaveLength(0);
  expect(filtered.stats).toEqual({ total: 1, consecutive: 1, max_boards: 4, first_boards: 0 });
  const allHeights = dailyScope(source, '机器人', '', tags);
  expect(allHeights.stats.max_boards).toBe(5);
  expect(allHeights.trading_max_boards).toBe(4);
  expect(allHeights.stats.total).toBe(2);
  expect(dailyTopics(source.rows, tags).find((topic) => topic.label === '机器人')?.count).toBe(2);
  expect(dailyTopics(source.rows, tags).some((topic) => topic.label === '减速器')).toBe(true);
  expect(dailyScope(source, '不存在', '', tags).rows).toEqual([]);
  expect(source.rows).toHaveLength(4);
});

it('preserves cross-group memberships but counts each height by unique stock', () => {
  const stock: Stock = { code: '002708', name: '光洋股份', boards: 4 };
  const bands = ladderBands(
    [
      { labels: ['汽车'], stocks: [stock] },
      { labels: ['机器人'], stocks: [stock] },
    ],
    'region',
    hierarchy(),
    false,
    new Set(),
    '',
  );
  expect(bands).toHaveLength(1);
  expect(bands[0]?.count).toBe(1);
  expect(bands[0]?.groups).toHaveLength(2);
});
it('omits empty height/group cells, retains all first boards and does not reorder source groups', () => {
  const stocks: Stock[] = [
    { code: '000001', name: '甲', boards: 1 },
    { code: '000002', name: '乙', boards: 4 },
  ];
  const groups = [
    { labels: ['A'], stocks: [...stocks] },
    { labels: ['B'], stocks: [stocks[0]!] },
  ];
  const bands = ladderBands(
    groups,
    'pinyin',
    hierarchy(),
    false,
    new Set(['000001']),
    '2026-10-29',
  );
  expect(bands.map((band) => band.height)).toEqual([4, 1]);
  expect(bands[0]?.groups.map((group) => group.labels)).toEqual([['A']]);
  expect(bands[1]?.count).toBe(1);
  expect(groups[0]?.stocks.map((stock) => stock.code)).toEqual(['000001', '000002']);
});
it('keeps latest-date highlighting priority only for confirmed nonmatching layouts', () => {
  const stocks: Stock[] = [
    { code: '000001', name: '甲', boards: 2, date: '2026-10-27' },
    { code: '000002', name: '乙', boards: 2, date: '2026-10-27' },
  ];
  const groups = [{ labels: ['A'], stocks }];
  const codes = (mode: string, provisional: boolean) =>
    ladderBands(
      groups,
      mode,
      hierarchy(),
      provisional,
      new Set(['000002']),
      '2026-10-29',
    )[0]?.groups[0]?.sections[0]?.stocks.map((stock) => stock.code);
  expect(codes('region', false)).toEqual(['000002', '000001']);
  expect(codes('pinyin', false)).toEqual(['000001', '000002']);
  expect(codes('region', true)).toEqual(['000001', '000002']);
});

it('rejects impossible calendar dates without allowing the picker to roll them forward', () => {
  expect(isArchiveDate('2026-02-31')).toBe(false);
  expect(isArchiveDate('2026-02-29')).toBe(false);
  expect(isArchiveDate('2024-02-29')).toBe(true);
  expect(isArchiveDate('2026-10-29')).toBe(true);
  expect(isArchiveDate('0000-01-01')).toBe(false);
});
