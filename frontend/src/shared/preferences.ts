export function readPreference<T>(
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    return validate(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Preferences are optional when browser storage is unavailable. */
  }
}
export interface RecentStock {
  code: string;
  name: string;
}
const recentKey = 'limit-up-archive.recent-stocks.v1';
export function recentStocks() {
  return readPreference<RecentStock[]>(
    recentKey,
    [],
    (value): value is RecentStock[] =>
      Array.isArray(value) &&
      value.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          /^\d{6}$/.test(item.code) &&
          typeof item.name === 'string',
      ),
  ).slice(0, 10);
}
export function rememberStock(stock: RecentStock) {
  if (!stock.name.trim()) return;
  writePreference(
    recentKey,
    [stock, ...recentStocks().filter((item) => item.code !== stock.code)].slice(0, 10),
  );
}
