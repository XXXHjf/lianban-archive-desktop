import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortAll, ApiError, post, query, request } from './api';
afterEach(() => {
  abortAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('v1 transport', () => {
  it('encodes queries without losing false or zero', () => {
    expect(
      query('/api/date', {
        date: '2026-10-28',
        q: '<机器人 &>',
        absent: undefined,
        blank: '',
        flag: false,
        n: 0,
      }),
    ).toBe('/api/date?date=2026-10-28&q=%3C%E6%9C%BA%E5%99%A8%E4%BA%BA+%26%3E&flag=false&n=0');
  });
  it('cancels a superseded request without replacing the newer result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path: string, options: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            if (_path.endsWith('old'))
              options.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            else resolve(new Response(JSON.stringify({ code: '000678' })));
          }),
      ),
    );
    const old = request('/api/old', 'stock');
    const latest = request('/api/new', 'stock');
    expect(await old).toBeNull();
    expect(await latest).toEqual({ code: '000678' });
  });
  it('retains structured revision conflict information and write payload', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: '备注已更新', revision: 9 }), { status: 409 }),
      );
    vi.stubGlobal('fetch', fetcher);
    const payload = { code: '000678', revision: 8, content: '保留草稿', entry_id: 1 };
    const call = post('/api/stock-note', payload, 'save');
    await expect(call).rejects.toMatchObject({
      status: 409,
      data: { revision: 9 },
      message: '备注已更新',
    });
    expect(fetcher.mock.calls[0][1].body).toBe(JSON.stringify(payload));
  });
  it('reports timeout as an error, not an empty successful response', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            options.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
      ),
    );
    const result = request('/api/stock', 'stock');
    const check = expect(result).rejects.toThrow('30 秒');
    await vi.advanceTimersByTimeAsync(30000);
    await check;
  });
  it('rejects invalid JSON envelopes and distinguishes server errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('null'))
        .mockResolvedValueOnce(new Response('{"error":"只读"}', { status: 403 })),
    );
    await expect(request('/api/meta', 'meta')).rejects.toThrow('有效的数据');
    await expect(request('/api/tags', 'tags')).rejects.toBeInstanceOf(ApiError);
  });
});
