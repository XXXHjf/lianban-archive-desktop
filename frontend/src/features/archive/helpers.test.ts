import { describe, expect, it } from 'vitest';
import {
  cycleStatus,
  dailyGroups,
  hierarchy,
  matchingGroups,
  mergePeers,
  subgroups,
} from './helpers';
import type { Relationships, Stock } from './models';
const stock = (code: string, boards: number, tags: string[], initials = ''): Stock => ({
  code,
  name: code,
  boards,
  tags,
  initials,
});
describe('daily grouping preserves evidence cohorts', () => {
  it('matches every substring position and deduplicates repeated tokens per stock', () => {
    const a = stock('600001', 1, [], 'ABAB'),
      b = stock('600002', 1, [], 'XAB');
    const result = matchingGroups(
      new Map([
        ['ABAB', [a]],
        ['XAB', [b]],
      ]),
      (row) => row.initials || '',
      4,
    );
    expect(result.find((group) => group.labels[0] === 'AB')?.stocks.map((row) => row.code)).toEqual(
      ['600001', '600002'],
    );
    expect(result.some((group) => group.labels[0] === 'ABAB')).toBe(false);
    expect(result.find((group) => group.labels[0] === 'A')?.stocks).toHaveLength(2);
  });
  it('retains parent columns, child leaves and identical child cohort merging', () => {
    const tags = hierarchy([
      { name: '设备', parent: '工业' },
      { name: '机械', parent: '工业' },
    ]);
    const a = stock('600001', 2, ['工业', '设备', '机械']);
    const result = dailyGroups(
      [a],
      'industry',
      { 工业: { '2': 1 }, 设备: { '2': 1 }, 机械: { '2': 1 } },
      tags,
    );
    expect(result.map((group) => group.labels)).toEqual([['工业']]);
    expect(subgroups([a], '工业', tags).map((group) => group.labels)).toEqual([['设备', '机械']]);
    expect(tags.leaves(a)).toEqual(['设备', '机械']);
  });
  it('never merges groups made identical only by an exact board filter', () => {
    const a = stock('600001', 1, ['甲', '乙']);
    const result = dailyGroups(
      [a],
      'industry',
      { 甲: { '1': 1, '3': 1 }, 乙: { '1': 1, '2': 1 } },
      hierarchy(),
    );
    expect(result).toHaveLength(2);
    expect(
      dailyGroups([a], 'industry', { 甲: { '1': 1, '2': 1 }, 乙: { '1': 1, '2': 1 } }, hierarchy()),
    ).toHaveLength(2);
  });
  it('moves standalone unparented tags into a solitary column', () => {
    expect(
      dailyGroups([stock('600001', 1, ['独立'])], 'industry', { 独立: { '1': 1 } }, hierarchy())[0]
        ?.labels,
    ).toEqual(['独苗']);
  });
  it('merges only identical complete first-board cohorts and protects parent columns', () => {
    const rows = [stock('600001', 1, ['甲', '乙']), stock('600002', 1, ['甲', '乙'])];
    expect(
      dailyGroups(rows, 'industry', { 甲: { '1': 2 }, 乙: { '1': 2 } }, hierarchy()).map(
        (group) => group.labels,
      ),
    ).toEqual([['甲', '乙']]);
    const protectedGroups = dailyGroups(
      rows,
      'industry',
      { 甲: { '1': 2 }, 乙: { '1': 2 } },
      hierarchy([{ name: '子', parent: '甲' }]),
    );
    expect(protectedGroups).toHaveLength(2);
  });
  it('uses full-day tag heights to keep leaders ahead when showing only first boards', () => {
    const rows = [
      stock('600001', 1, ['首板多']),
      stock('600002', 1, ['高标']),
      stock('600003', 1, ['首板多']),
    ];
    const result = dailyGroups(
      rows,
      'industry',
      { 首板多: { '1': 20 }, 高标: { '1': 1, '8': 1 } },
      hierarchy(),
    );
    expect(result[0]?.labels).toEqual(['高标']);
  });
  it('keeps the original tag order when there is no user ordering metadata', () => {
    const tags = hierarchy(),
      row = stock('600001', 3, ['乙', '甲']);
    expect(tags.all(row)).toEqual(['乙', '甲']);
    expect(
      dailyGroups([row], 'industry', { 甲: { '3': 2 }, 乙: { '3': 2 } }, tags)[0]?.labels,
    ).toEqual(['乙']);
  });
});
describe('cycle status remains point-in-time', () => {
  const base = { start: '2026-10-19', end: '2026-10-20', boards: 3 };
  it('does not turn an unseen first board or clipped range into a confirmed cycle', () => {
    expect(cycleStatus({ ...base, start_known: false, ongoing: true }, '2026-10-20')).toBe(
      '周期边界待确认',
    );
    expect(cycleStatus({ ...base, clipped: true, end_known: true }, '2026-10-20')).toBe(
      '周期边界待确认',
    );
  });
  it('distinguishes ongoing, confirmed end, and missing later coverage', () => {
    expect(cycleStatus({ ...base, start_known: true, ongoing: true }, '2026-10-20')).toBe(
      '截至 2026-10-20 仍在连板',
    );
    expect(cycleStatus({ ...base, start_known: true, end_known: true }, '2026-10-22')).toBe(
      '已结束',
    );
    expect(cycleStatus({ ...base, start_known: true, end_known: false }, '2026-10-22')).toBe(
      '后续状态待确认',
    );
  });
});
describe('peer evidence', () => {
  it('deduplicates the same day and promotion round without collapsing different heights', () => {
    const round = { date: '2026-10-20', next_date: '2026-10-21', boards: 2 };
    const data: Relationships = {
      range_start: '2026-10-01',
      range_end: '2026-10-29',
      target_limit_days: 3,
      competition: {
        rounds: [],
        wins: [{ code: '600002', name: '乙', rounds: [round, round, { ...round, boards: 3 }] }],
        losses: [],
      },
      cooccurrences: {
        rows: [
          { code: '600002', name: '乙', dates: [{ date: '2026-10-20' }, { date: '2026-10-20' }] },
          { code: '600001', name: '本票', dates: [] },
        ],
      },
    };
    const result = mergePeers(data, '600001');
    expect(result).toHaveLength(1);
    expect(result[0]?.winCount).toBe(2);
    expect(result[0]?.commonCount).toBe(1);
    expect(result[0]?.lastDate).toBe('2026-10-21');
  });
});
