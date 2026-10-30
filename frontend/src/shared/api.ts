export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
const channels = new Map<string, AbortController>();
export function abort(channel: string) {
  channels.get(channel)?.abort();
  channels.delete(channel);
}
export function abortAll() {
  for (const controller of channels.values()) controller.abort();
  channels.clear();
}
export function query(path: string, values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') params.set(key, String(value));
  return `${path}${params.size ? `?${params}` : ''}`;
}
export async function request<T>(
  path: string,
  channel: string,
  options: RequestInit = {},
): Promise<T | null> {
  abort(channel);
  const controller = new AbortController();
  channels.set(channel, controller);
  const timeout = setTimeout(() => controller.abort('timeout'), 30000);
  const externalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) externalAbort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...options.headers },
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const error =
        data && typeof data === 'object' && 'error' in data
          ? String(data.error)
          : `服务器返回 ${response.status}`;
      throw new ApiError(error, response.status, data);
    }
    if (data === null || typeof data !== 'object') throw new Error('服务器未返回有效的数据。');
    // v1 response contracts are declared by each feature; the transport validates the JSON envelope.
    return data as T;
  } catch (error) {
    if (controller.signal.reason === 'timeout')
      throw new Error('查询超过 30 秒，请稍后重试。', { cause: error });
    if (
      controller.signal.reason instanceof DOMException &&
      controller.signal.reason.name === 'TimeoutError'
    )
      throw new Error('连接超时，请稍后重试。', { cause: error });
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', externalAbort);
    if (channels.get(channel) === controller) channels.delete(channel);
  }
}
export function post<T>(path: string, payload: unknown, channel: string) {
  return request<T>(path, channel, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
