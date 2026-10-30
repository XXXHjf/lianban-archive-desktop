// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspace, parseRoute, workspaceKey } from '@/shared/workspace';
import type { StockData } from './models';
const transport = vi.hoisted(() => ({ request: vi.fn(), abort: vi.fn() }));
vi.mock('@/shared/api', () => ({
  ...transport,
  query: (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`,
}));
import StockView from './StockView.vue';

function fixture(code = '000678', name = '襄阳轴承'): StockData {
  return {
    stock: { code, name, tags: ['汽车'], note: '' },
    rows: [{ date: '2026-10-28', boards: 5 }],
    cycles: [],
    range_start: '2020-01-02',
    range_end: '2026-10-28',
    coverage_note: '公开测试档案',
    stats: { limit_days: 67, max_boards: 7, cycles: 43 },
    relationships: {
      range_start: '2020-01-02',
      range_end: '2026-10-28',
      target_limit_days: 67,
      competition: { rounds: [], wins: [], losses: [] },
      cooccurrences: {
        rows: [
          {
            code: '002164',
            name: '宁波东力',
            tags: ['风电'],
            dates: [{ date: '2026-10-28', target_boards: 5, peer_boards: 1 }],
          },
          {
            code: '000980',
            name: '众泰汽车',
            tags: ['汽车'],
            dates: [{ date: '2026-10-27', target_boards: 4, peer_boards: 1 }],
          },
        ],
      },
    },
  };
}
let pending: { resolve(value: StockData): void; reject(error: Error): void } | null = null;
let defer = false;
function setup() {
  transport.request.mockImplementation((path: string) => {
    if (path.startsWith('/api/comparison')) return Promise.resolve({ segments: [] });
    if (defer)
      return new Promise<StockData>((resolve, reject) => {
        pending = { resolve, reject };
      });
    return Promise.resolve(fixture());
  });
  const workspace = createWorkspace();
  workspace.route.value = parseRoute('?code=000678&date=2026-10-28');
  workspace.meta.value = { dates: ['2026-10-28'], latest_date: '2026-10-28' };
  const wrapper = mount(StockView, {
    global: {
      plugins: [ElementPlus],
      provide: { [workspaceKey as symbol]: workspace },
      stubs: {
        ChartPanel: true,
        StockActions: true,
        StockSearch: true,
        PairComparison: true,
        CompetitionRounds: true,
      },
    },
  });
  return {
    wrapper,
    workspace,
    dispose() {
      wrapper.unmount();
      workspace.dispose();
    },
  };
}
afterEach(() => {
  defer = false;
  pending = null;
  vi.clearAllMocks();
});
it('keeps the same-stock result, relation query and selected peer throughout refresh', async () => {
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  await wrapper.get('input[aria-label="筛选关联股票"]').setValue('000980');
  await flushPromises();
  expect(wrapper.get('.peer-heading').text()).toContain('众泰汽车');
  defer = true;
  workspace.revision.value++;
  await nextTick();
  expect(wrapper.findAll('h2').some((node) => node.text().includes('襄阳轴承'))).toBe(true);
  expect((wrapper.get('input[aria-label="筛选关联股票"]').element as HTMLInputElement).value).toBe(
    '000980',
  );
  pending?.resolve(fixture());
  await flushPromises();
  expect(wrapper.get('.peer-heading').text()).toContain('众泰汽车');
  expect(wrapper.findAll('.peer-button')).toHaveLength(1);
  dispose();
});
it('keeps the last valid result and query when a same-stock refresh fails', async () => {
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  await wrapper.get('input[aria-label="筛选关联股票"]').setValue('000980');
  await flushPromises();
  defer = true;
  workspace.revision.value++;
  await nextTick();
  pending?.reject(new Error('隔离刷新失败'));
  await flushPromises();
  expect(wrapper.text()).toContain('隔离刷新失败');
  expect(wrapper.get('.peer-heading').text()).toContain('众泰汽车');
  expect((wrapper.get('input[aria-label="筛选关联股票"]').element as HTMLInputElement).value).toBe(
    '000980',
  );
  dispose();
});
it('clears old results when the primary stock changes and accepts only the new stock response', async () => {
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  defer = true;
  workspace.openStock('000980', '众泰汽车');
  await nextTick();
  expect(wrapper.findAll('h2').map((node) => node.text())).toEqual(['个股档案']);
  pending?.resolve(fixture('000980', '众泰汽车'));
  await flushPromises();
  expect(wrapper.findAll('h2').some((node) => node.text().includes('众泰汽车'))).toBe(true);
  expect((wrapper.get('input[aria-label="筛选关联股票"]').element as HTMLInputElement).value).toBe(
    '',
  );
  dispose();
});
