export function number(value: unknown, digits = 0) {
  const n = Number(value);
  return value == null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function dateLabel(value: unknown) {
  return typeof value === 'string' && value ? value.slice(0, 10) : '—';
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '操作未完成，请重试。');
}
export function money(value: unknown) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1e8
    ? `${number(n / 1e8, 2)} 亿`
    : Math.abs(n) >= 1e4
      ? `${number(n / 1e4, 2)} 万`
      : number(n, 2);
}
export function isST(name: string) {
  return /^(?:S\*ST|SST|\*ST|ST)/i.test(name.normalize('NFKC').replace(/\s+/g, ''));
}
export function isGEM(code: string) {
  return /^(300|301)/.test(code);
}
export function safeLink(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https?:\/\//i.test(value) ||
    [...value].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\',
    )
  )
    return '';
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}
