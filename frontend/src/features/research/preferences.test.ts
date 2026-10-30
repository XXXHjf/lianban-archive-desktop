import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockedTypes,
  accountsBlocked,
  excludedAccountsKey,
  filterShareholders,
  preferenceError,
  setBlocked,
  typeBlocked,
  shareholderAlertVisible,
} from './preferences';
import type { Peer } from './types';
function peer(code: string, types: string[], together = false): Peer {
  return {
    code,
    name: code,
    shared_count: types.length,
    today_together: together,
    holders: types.map((type) => ({ name: `${type}股东`, type, reports: [] })),
  };
}
beforeEach(() => {
  blockedTypes.value = {};
  preferenceError.value = '';
  vi.unstubAllGlobals();
});
describe('shareholder classification and alert consistency', () => {
  it('uses the legacy blocked defaults unless explicitly overridden', () => {
    expect(['基金', '其他', 'QFII'].every(typeBlocked)).toBe(true);
    expect(typeBlocked('自然人')).toBe(false);
    blockedTypes.value = { 基金: false, 自然人: true };
    expect(typeBlocked('基金')).toBe(false);
    expect(typeBlocked('自然人')).toBe(true);
  });
  it('applies the account block and category blocks consistently to alerts', () => {
    blockedTypes.value = { 其他: false };
    const row = { types: [], excluded_types: ['其他'] };
    expect(accountsBlocked()).toBe(true);
    expect(shareholderAlertVisible(row)).toBe(false);
    blockedTypes.value[excludedAccountsKey] = false;
    expect(shareholderAlertVisible(row)).toBe(true);
    blockedTypes.value.其他 = true;
    expect(shareholderAlertVisible(row)).toBe(false);
    expect(shareholderAlertVisible({ types: ['个人'], excluded_types: ['其他'] })).toBe(true);
  });
  it('drops empty peers, counts only unblocked holders and sorts today together first without changing API data', () => {
    const original = [
      peer('000003', ['基金']),
      peer('000002', ['自然人', '企业']),
      peer('000001', ['基金', '企业'], true),
    ];
    const result = filterShareholders(original);
    expect(result.map((row) => [row.code, row.shared_count])).toEqual([
      ['000001', 1],
      ['000002', 2],
    ]);
    expect(original[2]!.holders).toHaveLength(2);
  });
  it('retains active session filters and exposes fallback when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      setItem() {
        throw new Error('blocked');
      },
    });
    setBlocked('企业', true);
    expect(typeBlocked('企业')).toBe(true);
    expect(preferenceError.value).toContain('本次会话仍然生效');
  });
  it('excludes low-specificity relationships even when other categories are allowed, with explicit opt-in', () => {
    blockedTypes.value = { 其他: false };
    const excluded = peer('000001', ['其他'], true);
    excluded.holders[0]!.exclusion_reason = '结算代持账户';
    const mixed = peer('000002', ['其他', '其他']);
    mixed.holders[0]!.exclusion_reason = '客户汇总账户';
    expect(
      filterShareholders([excluded, mixed]).map((row) => [row.code, row.shared_count]),
    ).toEqual([['000002', 1]]);
    expect(filterShareholders([excluded, mixed], true).map((row) => row.shared_count)).toEqual([
      1, 2,
    ]);
    expect(excluded.holders).toHaveLength(1);
    blockedTypes.value = { 其他: true };
    expect(filterShareholders([excluded, mixed], true)).toEqual([]);
  });
});
