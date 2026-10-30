// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import ElementPlus from 'element-plus';
import { createWorkspace, workspaceKey } from '@/shared/workspace';
import type { StockData } from './models';
const transport = vi.hoisted(() => ({ request: vi.fn(), abort: vi.fn() }));
vi.mock('@/shared/api', () => ({
  ...transport,
  query: (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`,
}));
import DailyCyclePreview from './DailyCyclePreview.vue';

function fixture(code: string): StockData {
  return {
    stock: { code, name: code },
    rows: [{ date: '2026-10-29', boards: 4 }],
    cycles: [{ start: '2026-10-26', end: '2026-10-29', boards: 4, ongoing: true }],
    range_start: '2020-01-02',
    range_end: '2026-10-29',
    as_of_date: '2026-10-29',
    coverage_note: '测试口径',
    stats: { limit_days: 1, max_boards: 4, cycles: 1 },
    relationships: {
      range_start: '2020-01-02',
      range_end: '2026-10-29',
      target_limit_days: 1,
      competition: { rounds: [], wins: [], losses: [] },
      cooccurrences: { rows: [] },
    },
  };
}
afterEach(() => vi.clearAllMocks());
it('rejects late results from the previously selected stock and names the archive cutoff', async () => {
  let resolveOld: (value: StockData) => void = () => {};
  transport.request.mockImplementation((path: string) =>
    path.includes('000001')
      ? new Promise<StockData>((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve(fixture('000002')),
  );
  const workspace = createWorkspace();
  const wrapper = mount(DailyCyclePreview, {
    props: { stock: { code: '000001', name: '旧股' }, day: '2026-10-27' },
    global: { plugins: [ElementPlus], provide: { [workspaceKey as symbol]: workspace } },
  });
  expect(wrapper.text()).toContain('正在读取周期');
  await wrapper.setProps({ stock: { code: '000002', name: '新股' } });
  await flushPromises();
  resolveOld(fixture('000001'));
  await flushPromises();
  expect(wrapper.text()).toContain('新股');
  expect(wrapper.text()).toContain('截至 2026-10-29');
  expect(wrapper.text()).toContain('所选交易日 2026-10-27');
  expect(wrapper.text()).toContain('研究当前周期');
  expect(wrapper.text()).not.toContain('旧股');
  await wrapper.get('.cycle-research').trigger('click');
  expect(workspace.route.value.code).toBe('000002');
  wrapper.unmount();
  workspace.dispose();
});
it('shows a retryable preview error without presenting a false empty cycle', async () => {
  transport.request.mockRejectedValue(new Error('测试连接失败'));
  const workspace = createWorkspace();
  const wrapper = mount(DailyCyclePreview, {
    props: { stock: { code: '000001', name: '甲' }, day: '2026-10-29' },
    global: { plugins: [ElementPlus], provide: { [workspaceKey as symbol]: workspace } },
  });
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('测试连接失败');
  expect(wrapper.text()).not.toContain('暂无已收录周期');
  wrapper.unmount();
  workspace.dispose();
});
