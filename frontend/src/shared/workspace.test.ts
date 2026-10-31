import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, parseRoute, routeURL } from './workspace';
afterEach(() => vi.unstubAllGlobals());
describe('archive route compatibility', () => {
  it('keeps the daily topic distinct from the management tag and round trips it through stock navigation', () => {
    const route = parseRoute('?date=2026-10-29&daily_tag=机器人&boards=4&code=002708');
    expect(parseRoute(routeURL(route).slice(1))).toEqual(route);
    expect(route.dailyTag).toBe('机器人');
    expect(route.tag).toBe('');
    expect(parseRoute('?view=tags&tag=汽车&daily_tag=机器人').tag).toBe('汽车');
  });
  it('round trips existing view/date/compare/filter query parameters', () => {
    const route = parseRoute(
      '?view=intraday&date=2026-10-28&minute_code=000678&minute_compare=000980,600519&timeline_gem=1&exclude_st=1&layout=region&relation_exclude_latest=1',
    );
    expect(parseRoute(routeURL(route).slice(1))).toEqual(route);
    expect(route.minuteCompare).toEqual(['000980', '600519']);
  });
  it('rejects malformed codes without silently truncating valid comparison lists', () => {
    const route = parseRoute(
      '?code=%3Cscript%3E&minute_code=9999999&minute_compare=000001,000002,000003,000004,000005,000006,000001,bad&boards=100',
    );
    expect(route.view).toBe('date');
    expect(route.code).toBe('');
    expect(route.minuteCode).toBe('');
    expect(route.minuteCompare).toHaveLength(6);
    expect(route.boards).toBe('100');
  });
  it('restores date and filters through browser back without an extra history write', async () => {
    const callbacks = new Map<string, () => void>();
    const host = {
      addEventListener: (name: string, action: () => void) => callbacks.set(name, action),
      removeEventListener: vi.fn(),
    };
    const location = { pathname: '/', search: '?date=2026-10-28&boards=5' };
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    vi.stubGlobal('window', host);
    vi.stubGlobal('location', location);
    vi.stubGlobal('history', history);
    const workspace = createWorkspace();
    workspace.openStock('000678', '襄阳轴承');
    expect(workspace.route.value.view).toBe('stock');
    location.search = '?date=2026-10-27&boards=3&exclude_gem=1&daily_tag=机器人';
    callbacks.get('popstate')?.();
    expect(workspace.route.value).toMatchObject({
      view: 'date',
      date: '2026-10-27',
      boards: '3',
      excludeGEM: true,
      dailyTag: '机器人',
    });
    expect(history.pushState).toHaveBeenCalledTimes(1);
    workspace.dispose();
    expect(host.removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function));
  });
});

it('follows the latest trading session even when the archive is missing that session', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('location', { pathname: '/', search: '' });
  vi.stubGlobal('history', { pushState: vi.fn(), replaceState: vi.fn() });
  const calendar = {
    dates: ['2026-10-29', '2026-10-30'],
    start: '2026-01-01',
    end: '2026-12-31',
    latest_trade_date: '2026-10-30',
    calendar_date: '2026-10-31',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            dates: ['2026-10-29'],
            query_dates: ['2026-10-29'],
            latest_date: '2026-10-29',
            trading_calendar: calendar,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  );
  const workspace = createWorkspace();
  await workspace.refreshMeta();
  expect(workspace.date.value).toBe('2026-10-30');
  workspace.openDate('2026-10-29');
  await workspace.refreshMeta();
  expect(workspace.date.value).toBe('2026-10-29');
  workspace.openDate('2026-10-31');
  await workspace.refreshMeta();
  expect(workspace.date.value).toBe('2026-10-30');
  workspace.dispose();
});
