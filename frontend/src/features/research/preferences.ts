import { ref } from 'vue';
import type { Peer } from './types';
const key = 'limit-up-archive.shareholder-blocked-types.v1';
function read(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(value)) return {};
    const entries: [string, boolean][] = [];
    for (const item of value)
      if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'boolean')
        entries.push([item[0], item[1]]);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}
export const blockedTypes = ref(read());
export const preferenceError = ref('');
export function typeBlocked(type: string): boolean {
  const value = blockedTypes.value[type];
  return typeof value === 'boolean' ? value : ['基金', '其他', 'QFII'].includes(type);
}
export function filterShareholders(rows: readonly Peer[]): Peer[] {
  return rows
    .map((peer) => {
      const holders = peer.holders.filter((holder) => !typeBlocked(holder.type));
      return { ...peer, holders, shared_count: holders.length };
    })
    .filter((peer) => peer.shared_count > 0)
    .sort(
      (a, b) =>
        Number(b.today_together) - Number(a.today_together) ||
        b.shared_count - a.shared_count ||
        a.code.localeCompare(b.code),
    );
}
export function setBlocked(type: string, value: boolean) {
  blockedTypes.value = { ...blockedTypes.value, [type]: value };
  try {
    localStorage.setItem(key, JSON.stringify(Object.entries(blockedTypes.value)));
    preferenceError.value = '';
  } catch {
    preferenceError.value = '浏览器无法保存分类偏好，本次会话仍然生效。';
  }
}
