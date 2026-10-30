import { afterEach, expect, it, vi } from 'vitest';
import { readPreference, recentStocks, rememberStock } from './preferences';
import { safeLink } from './format';
afterEach(() => vi.unstubAllGlobals());
it('degrades when local browser storage is disabled', () => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new DOMException('denied', 'SecurityError');
    },
    setItem() {
      throw new DOMException('denied', 'SecurityError');
    },
  });
  expect(recentStocks()).toEqual([]);
  expect(() => rememberStock({ code: '000678', name: '襄阳轴承' })).not.toThrow();
  expect(readPreference('x', 12, (v): v is number => typeof v === 'number')).toBe(12);
});
it('keeps the original recent-stock key and deduplicates in newest-first order', () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key),
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  rememberStock({ code: '000678', name: '襄阳轴承' });
  rememberStock({ code: '000980', name: '众泰汽车' });
  rememberStock({ code: '000678', name: '襄阳轴承' });
  expect(recentStocks().map((stock) => stock.code)).toEqual(['000678', '000980']);
  expect(stored.has('limit-up-archive.recent-stocks.v1')).toBe(true);
});
it('rejects configured links that can execute code or expose credentials', () => {
  for (const link of [
    'javascript:alert(1)',
    'https://user:pass@example.org/',
    'https://example.org/\nq',
    'file:///x',
  ])
    expect(safeLink(link)).toBe('');
  expect(safeLink('https://example.org/path?q=复盘')).toBe(
    'https://example.org/path?q=%E5%A4%8D%E7%9B%98',
  );
});
