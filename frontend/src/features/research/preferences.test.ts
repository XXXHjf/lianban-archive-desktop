import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockedTypes,
  filterShareholders,
  preferenceError,
  setBlocked,
  typeBlocked,
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
});
