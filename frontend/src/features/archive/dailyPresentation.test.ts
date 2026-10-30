import { expect, it } from 'vitest';
import { hierarchy } from './helpers';
import { isArchiveDate, ladderBands } from './dailyPresentation';
import type { Stock } from './models';

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
