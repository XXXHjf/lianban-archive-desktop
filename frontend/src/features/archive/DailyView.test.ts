// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createWorkspace, parseRoute, workspaceKey } from '@/shared/workspace';
import type { DailyData } from './models';
import { blockedTypes, excludedAccountsKey } from '@/features/research/preferences';
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
it('keeps node controls on the board filter row without repeating the date or scope', async () => {
  transport.request.mockResolvedValue(fixture());
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  const boardBar = wrapper.get('.daily-board-bar');
  expect(boardBar.get('.daily-board-node-actions').text()).toContain('添加节点');
  expect(boardBar.get('.daily-board-node-actions').text()).toContain('节点记录');
  workspace.patchRoute({ boards: '4' });
  await nextTick();
  expect(wrapper.text()).not.toContain('统计范围：');
  expect(wrapper.find('.daily-status-line strong').exists()).toBe(false);
  expect(wrapper.find('[aria-label="查询交易日期"]').exists()).toBe(true);
  dispose();
});
it('shows a red dot only for a non-excluded, unblocked holder with another stock up today', async () => {
  transport.request.mockResolvedValue(fixture());
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  workspace.meta.value!.shareholder_alerts = {
    rows: [{ code: '002708', types: [], excluded_types: ['其他'] }],
  };
  blockedTypes.value = { 其他: false, [excludedAccountsKey]: false };
  await nextTick();
  expect(wrapper.find('.shareholder-alert-dot').exists()).toBe(false);
  workspace.meta.value!.shareholder_alerts.rows![0]!.types = ['个人'];
  await nextTick();
  expect(wrapper.find('.shareholder-alert-dot').exists()).toBe(true);
  expect(wrapper.get('.daily-shareholder-button').attributes('aria-label')).toContain('股票同涨停');
  blockedTypes.value = { 个人: true };
  await nextTick();
  expect(wrapper.find('.shareholder-alert-dot').exists()).toBe(false);
  blockedTypes.value = {};
  dispose();
});
it('puts shareholder, intraday and preview actions on the stock row in order', async () => {
  transport.request.mockResolvedValue(fixture());
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  const row = wrapper.get('.ladder-stock');
  expect(row.get('.daily-stock-actions').text()).toBe('股东分时预览');
  await row.get('[aria-label="查看光洋股份共同股东"]').trigger('click');
  expect(workspace.editor.value?.kind).toBe('shareholders');
  expect(workspace.editor.value?.stock.code).toBe('002708');
  const openIntraday = vi.spyOn(workspace, 'openIntraday');
  await row.get('[aria-label="查看光洋股份当日分时"]').trigger('click');
  expect(openIntraday).toHaveBeenCalledWith('002708', '2026-10-29');
  dispose();
});
it('keeps three common grouping modes visible and clears selection when the query day changes', async () => {
  transport.request.mockResolvedValue(fixture());
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  expect(wrapper.get('[aria-label="切换分组"]').text()).toContain('连板梯队地区拼音代码匹配');
  expect(wrapper.find('.daily-results-caption').exists()).toBe(false);
  await wrapper.get('[aria-label="预览光洋股份周期"]').trigger('click');
  expect(wrapper.findComponent({ name: 'DailyCyclePreview' }).props('stock')?.code).toBe('002708');
  workspace.openDate('2026-10-28');
  await nextTick();
  expect(wrapper.find('.ladder-stock.is-selected').exists()).toBe(false);
  const preview = wrapper.findComponent({ name: 'DailyCyclePreview' });
  expect(preview.exists() ? preview.props('stock') : null).toBeNull();
  dispose();
});
it('offers code matching as a direct grouping button', async () => {
  transport.request.mockResolvedValue(fixture());
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  const button = wrapper
    .findAll('[aria-label="切换分组"] button')
    .find((item) => item.text() === '代码匹配');
  expect(button).toBeDefined();
  await button!.trigger('click');
  expect(workspace.route.value.layout).toBe('code');
  expect(button!.attributes('aria-pressed')).toBe('true');
  expect(wrapper.find('.daily-results-caption').exists()).toBe(false);
  expect(wrapper.get('[aria-label="切换分组"]').text()).toContain('更多');
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

it('shows each stock once and applies board filters while topic controls are hidden', async () => {
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
  expect(wrapper.findAll('.ladder-stock')).toHaveLength(3);
  expect(wrapper.find('[aria-label="预览青岛食品周期"]').exists()).toBe(true);
  expect(wrapper.find('.daily-stats').exists()).toBe(false);
  expect(wrapper.get('.daily-topic-filter').isVisible()).toBe(false);
  expect(wrapper.find('[aria-label="筛选标签：汽车"]').exists()).toBe(false);
  workspace.patchRoute({ boards: '4' });
  await nextTick();
  expect(wrapper.findAll('.ladder-stock')).toHaveLength(2);
  expect(wrapper.get('.daily-board-bar').text()).toContain('3板 1');
  expect(transport.request).toHaveBeenCalledTimes(1);
  workspace.patchRoute({ boards: '3' });
  await nextTick();
  expect(wrapper.find('.ladder-stock.is-selected').exists()).toBe(false);
  workspace.patchRoute({ boards: '5' });
  await nextTick();
  expect(wrapper.get('.daily-empty').text()).toContain('没有匹配记录');
  await wrapper.get('.daily-empty .el-button').trigger('click');
  expect(workspace.route.value.dailyTag).toBe('');
  expect(workspace.route.value.boards).toBe('');
  dispose();
});

it('keeps saved topic filters inactive while the controls are hidden', async () => {
  let resolve!: (data: DailyData) => void;
  transport.request.mockReturnValue(
    new Promise<DailyData>((done) => {
      resolve = done;
    }),
  );
  const { wrapper, workspace, dispose } = setup();
  expect(wrapper.find('.daily-loading').exists()).toBe(true);
  expect(wrapper.get('.daily-topic-filter').isVisible()).toBe(false);
  resolve(fixture());
  await flushPromises();
  workspace.patchRoute({ dailyTag: '不存在', layout: 'region' });
  await nextTick();
  expect(wrapper.get('.daily-topic-filter').isVisible()).toBe(false);
  expect(wrapper.find('[aria-label="预览光洋股份周期"]').exists()).toBe(true);
  workspace.patchRoute({ layout: 'industry' });
  await nextTick();
  expect(wrapper.find('.daily-empty').exists()).toBe(false);
  expect(wrapper.find('[aria-label="预览光洋股份周期"]').exists()).toBe(true);
  dispose();
});

it('renders matching groups across board heights and hides groups reduced to one stock', async () => {
  const data = fixture();
  data.rows = [
    { code: '002086', name: '东方海洋', boards: 2, initials: 'DFHY' },
    { code: '002275', name: '桂林三金', boards: 5, initials: 'GLSJ' },
    { code: '600261', name: '阳光照明', boards: 3, initials: 'YGZM' },
    { code: '003032', name: '传智教育', boards: 1, initials: 'DFJY' },
  ];
  transport.request.mockResolvedValue(data);
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  workspace.patchRoute({ layout: 'code' });
  await nextTick();
  const group = wrapper.get('[aria-label="匹配分组 002"]');
  expect(group.findAll('.ladder-stock').map((row) => row.text())).toEqual([
    expect.stringContaining('桂林三金'),
    expect.stringContaining('阳光照明'),
    expect.stringContaining('东方海洋'),
  ]);
  expect(group.findAll('.matching-stock-boards').map((board) => board.text())).toEqual([
    '5板',
    '3板',
    '2板',
  ]);
  expect(wrapper.find('[aria-label="匹配分组 00"]').exists()).toBe(false);
  await group.get('[aria-label="预览桂林三金周期"]').trigger('click');
  expect(wrapper.findComponent({ name: 'DailyCyclePreview' }).props('stock')?.code).toBe('002275');
  workspace.patchRoute({ boards: '5' });
  await nextTick();
  expect(wrapper.get('.daily-empty').text()).toContain('没有符合要求的匹配分组');
  expect(wrapper.find('.daily-results-caption').exists()).toBe(false);
  const preview = wrapper.findComponent({ name: 'DailyCyclePreview' });
  expect(preview.exists() ? preview.props('stock') : null).toBeNull();
  workspace.patchRoute({ boards: '', layout: 'pinyin' });
  await nextTick();
  expect(wrapper.get('[aria-label="匹配分组 DF"]').findAll('.ladder-stock')).toHaveLength(2);
  expect(wrapper.find('.ladder-band').exists()).toBe(false);
  dispose();
});

it('groups regions first and orders each region by board height, including single-stock regions', async () => {
  const data = fixture();
  data.rows = [
    { code: '600002', name: '山东乙', boards: 2, registered_province: '山东省' },
    { code: '600001', name: '山东甲', boards: 5, registered_province: '山东省' },
    { code: '600003', name: '山东丙', boards: 3, registered_province: '山东省' },
    { code: '000001', name: '广东甲', boards: 1, registered_province: '广东省' },
    { code: '000002', name: '地区未知', boards: 1 },
  ];
  transport.request.mockResolvedValue(data);
  const { wrapper, workspace, dispose } = setup();
  await flushPromises();
  workspace.patchRoute({ layout: 'region' });
  await nextTick();
  const shandong = wrapper.get('[aria-label="地区分组 山东"]');
  expect(shandong.findAll('.ladder-stock').map((row) => row.text())).toEqual([
    expect.stringContaining('山东甲'),
    expect.stringContaining('山东丙'),
    expect.stringContaining('山东乙'),
  ]);
  expect(shandong.findAll('.matching-stock-boards').map((row) => row.text())).toEqual([
    '5板',
    '3板',
    '2板',
  ]);
  expect(wrapper.get('[aria-label="地区分组 广东"]').findAll('.ladder-stock')).toHaveLength(1);
  expect(wrapper.get('[aria-label="地区分组 地区待补充"]').findAll('.ladder-stock')).toHaveLength(
    1,
  );
  expect(wrapper.find('.ladder-band').exists()).toBe(false);
  await shandong.get('[aria-label="预览山东甲周期"]').trigger('click');
  expect(wrapper.findComponent({ name: 'DailyCyclePreview' }).props('stock')?.code).toBe('600001');
  workspace.patchRoute({ boards: '2' });
  await nextTick();
  expect(wrapper.get('[aria-label="地区分组 山东"]').findAll('.ladder-stock')).toHaveLength(1);
  expect(wrapper.find('[aria-label="地区分组 广东"]').exists()).toBe(false);
  dispose();
});
