// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createWorkspace, parseRoute, workspaceKey } from '@/shared/workspace';
import type { DailyData } from './models';
const transport = vi.hoisted(() => ({ request: vi.fn(), abort: vi.fn() }));
vi.mock('@/shared/api', () => ({
  ...transport,
  query: (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`,
}));
import DailyView from './DailyView.vue';
function fixture(): DailyData {
  return {
    date: '2026-10-29',
    rows: [{ code: '002708', name: '光洋股份', boards: 4, tags: ['汽车'], date: '2026-10-29' }],
    suspended_rows: [],
    coverage_note: '测试来源',
    data_status: 'ok',
    trading_max_boards: 4,
    available_total: 1,
    board_counts: [{ boards: 4, count: 1 }],
    tag_board_counts: { 汽车: { '4': 1 } },
    stats: { total: 1, consecutive: 1, max_boards: 4, first_boards: 0 },
  };
}
function setup() {
  const workspace = createWorkspace();
  workspace.route.value = parseRoute('?date=2026-10-29');
  workspace.meta.value = { dates: ['2026-10-28', '2026-10-29'], latest_date: '2026-10-29' };
  const wrapper = mount(DailyView, {
    global: {
      plugins: [ElementPlus],
      provide: { [workspaceKey as symbol]: workspace },
      stubs: { DailyCyclePreview: true, DailyMatrix: true },
    },
  });
  return {
    wrapper,
    workspace,
    dispose: () => {
      wrapper.unmount();
      workspace.dispose();
    },
  };
}
afterEach(() => vi.clearAllMocks());
it('keeps three common grouping modes visible and clears selection when the query day changes', async () => {
  transport.request.mockResolvedValue(fixture());
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  expect(wrapper.get('[aria-label="切换分组"]').text()).toContain('行业 / 标签地区拼音');
  await wrapper.get('[aria-label="预览光洋股份周期"]').trigger('click');
  expect(wrapper.findComponent({ name: 'DailyCyclePreview' }).props('stock')?.code).toBe('002708');
  workspace.openDate('2026-10-28');
  await nextTick();
  expect(wrapper.find('.ladder-stock.is-selected').exists()).toBe(false);
  const preview = wrapper.findComponent({ name: 'DailyCyclePreview' });
  expect(preview.exists() ? preview.props('stock') : null).toBeNull();
  dispose();
});
it('does not present request failure as an empty market or retain data under a different date', async () => {
  transport.request.mockResolvedValueOnce(fixture()).mockRejectedValue(new Error('日期读取失败'));
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  workspace.openDate('2026-10-28');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('日期读取失败');
  expect(wrapper.find('.daily-empty').exists()).toBe(false);
  expect(wrapper.find('[aria-label="预览光洋股份周期"]').exists()).toBe(false);
  dispose();
});

it('shows each stock once, filters ancestor topics and updates height counts without fetching a partial day', async () => {
  const data = fixture();
  data.rows = [
    {
      code: '002708',
      name: '光洋股份',
      boards: 4,
      tags: ['汽车', '减速器', 'PCB', '消费电子', '其他标签'],
      date: data.date,
    },
    { code: '001219', name: '青岛食品', boards: 4, tags: ['食品'], date: data.date },
    { code: '601956', name: '东贝集团', boards: 3, tags: ['机器人'], date: data.date },
  ];
  transport.request.mockResolvedValue(data);
  const { wrapper, workspace, dispose } = setup();
  workspace.meta.value!.tag_hierarchy = [{ name: '减速器', parent: '机器人' }];
  await flushPromises();
  expect(wrapper.findAll('[aria-label="预览光洋股份周期"]')).toHaveLength(1);
  expect(wrapper.get('[aria-label="4板梯队"]').findAll('.ladder-stock')).toHaveLength(2);
  expect(wrapper.find('[aria-label="查看光洋股份全部5个标签"]').exists()).toBe(true);
  await wrapper.get('[aria-label="查看光洋股份全部5个标签"]').trigger('click');
  await vi.waitFor(() => {
    expect(wrapper.get('[aria-label="查看光洋股份全部5个标签"]').attributes('aria-expanded')).toBe(
      'true',
    );
  });
  await wrapper.get('[aria-label="查看光洋股份全部5个标签"]').trigger('keydown', { key: 'Escape' });
  await nextTick();
  expect(wrapper.get('[aria-label="查看光洋股份全部5个标签"]').attributes('aria-expanded')).toBe(
    'false',
  );
  await wrapper.get('[aria-label="预览青岛食品周期"]').trigger('click');
  workspace.patchRoute({ dailyTag: '机器人' });
  await nextTick();
  expect(wrapper.findAll('.ladder-stock')).toHaveLength(2);
  expect(wrapper.find('[aria-label="预览青岛食品周期"]').exists()).toBe(false);
  expect(wrapper.find('.ladder-stock.is-selected').exists()).toBe(false);
  expect(wrapper.get('.daily-stats').text()).toContain('涨停2只');
  workspace.patchRoute({ boards: '4' });
  await nextTick();
  expect(wrapper.findAll('.ladder-stock')).toHaveLength(1);
  expect(wrapper.get('.daily-board-bar').text()).toContain('3板 1');
  expect(transport.request).toHaveBeenCalledTimes(1);
  workspace.patchRoute({ dailyTag: '食品' });
  await nextTick();
  expect(wrapper.find('[aria-label="预览青岛食品周期"]').exists()).toBe(true);
  workspace.patchRoute({ dailyTag: '不存在' });
  await nextTick();
  expect(wrapper.get('.daily-empty').text()).toContain('没有匹配记录');
  await wrapper.get('.daily-empty .el-button').trigger('click');
  expect(workspace.route.value.dailyTag).toBe('');
  expect(workspace.route.value.boards).toBe('');
  dispose();
});

it('keeps topic filters inactive in other grouping modes and disables them while the day loads', async () => {
  let resolve!: (data: DailyData) => void;
  transport.request.mockReturnValue(
    new Promise<DailyData>((done) => {
      resolve = done;
    }),
  );
  const { wrapper, workspace, dispose } = setup();
  expect(wrapper.find('.daily-loading').exists()).toBe(true);
  expect(wrapper.get('.daily-topic-pills button').attributes('disabled')).toBeDefined();
  resolve(fixture());
  await flushPromises();
  workspace.patchRoute({ dailyTag: '不存在', layout: 'region' });
  await nextTick();
  expect(wrapper.find('.daily-topic-filter').exists()).toBe(false);
  expect(wrapper.find('[aria-label="预览光洋股份周期"]').exists()).toBe(true);
  workspace.patchRoute({ layout: 'industry' });
  await nextTick();
  expect(wrapper.find('.daily-empty').exists()).toBe(true);
  dispose();
});
