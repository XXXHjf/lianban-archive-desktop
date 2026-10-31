// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElCheckbox } from 'element-plus';
import { request, abort } from '@/shared/api';
import type { Shareholders, Subsidiaries } from './types';
import ShareholdersPanel from './ShareholdersPanel.vue';
import { blockedTypes } from './preferences';

vi.mock('@/shared/workspace', () => ({ useWorkspace: () => ({ editor: { value: null } }) }));
vi.mock('@/shared/api', () => ({
  abort: vi.fn(),
  query: (path: string) => path,
  request: vi.fn(async () => ({
    rows: [
      {
        code: '000002',
        holders: [{ name: '香港中央结算有限公司', type: '其他', exclusion_reason: '结算代持账户' }],
      },
      { code: '000003', holders: [{ name: '实际机构', type: '其他' }] },
    ],
    profiles: [{ report_date: '2026-09-30', fetched_at: '2026-10-30T15:00' }],
    today_status: 'unavailable',
    scope_note: '测试来源口径',
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  blockedTypes.value = {};
});

it('defaults to blocking accounts and retains the selection for another stock', async () => {
  blockedTypes.value = { 其他: false };
  const wrapper = mount(ShareholdersPanel, {
    props: { stock: { code: '000001' } },
    global: {
      directives: { loading: () => {} },
      components: { ElCheckbox },
      stubs: {
        ElButton: true,
        ElAlert: true,
        ElCollapse: true,
        ElTable: defineComponent({
          props: { data: { type: Array, default: () => [] } },
          setup: (props) => () => h('div', { 'data-peers': '' }, JSON.stringify(props.data)),
        }),
      },
    },
  });
  await flushPromises();
  expect(wrapper.get('[data-peers]').text()).not.toContain('000002');
  expect(wrapper.get('[data-peers]').text()).toContain('000003');
  const toggle = wrapper
    .findAllComponents(ElCheckbox)
    .find((checkbox) => checkbox.text() === '排除账户')!;
  expect((toggle.get('input').element as HTMLInputElement).checked).toBe(true);
  await toggle.get('input').setValue(false);
  expect(wrapper.get('[data-peers]').text()).toContain('000002');
  await wrapper.setProps({ stock: { code: '000004' } });
  await flushPromises();
  expect(wrapper.get('[data-peers]').text()).toContain('000002');
  wrapper.unmount();
});

const fixture: Shareholders = {
  name: '本股',
  rows: [],
  profiles: [{ scope: 'float', report_date: '2026-09-30', fetched_at: '2026-10-30T15:00' }],
  today: '2026-10-30',
  today_status: 'confirmed',
  today_stale: false,
  source: '东方财富',
  coverage: 1,
  requested: 1,
  status: 'current',
  scope_note: '名单全名匹配',
  own_holders: {
    float: [
      { name: '账户甲', type: '基金', report_date: '2026-09-30', holding_ratio: 1.23444 },
      { name: '账户乙', type: '其他', report_date: '2026-09-30', holding_ratio: 1.23444 },
      { name: '零值', type: '个人', report_date: '2026-09-30', holding_ratio: 0 },
      { name: '缺失', type: '个人', report_date: '2026-09-30', holding_ratio: null },
    ],
    total: [{ name: '总股本名单', type: '基金', report_date: '2026-06-30', holding_ratio: null }],
  },
  control_owners: [
    {
      kind: 'controller',
      name: '控股机构',
      type: '企业',
      source_url: 'javascript:alert(1)',
      fetched_at: '',
    },
    {
      kind: 'actual_controller',
      name: '控制人',
      type: '个人',
      source_url: 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index',
      fetched_at: '',
    },
  ],
  control_checked: true,
  control_status: 'current',
};
const subs: Subsidiaries = {
  code: '000001',
  name: '本股',
  source: '同花顺',
  status: 'current',
  disclosure_date: '2026-08-28',
  fetched_at: '2026-10-30T15:00',
  source_url: 'https://basic.10jqka.com.cn/000001/operate.html',
  rows: [{ name: '子公司甲', relation: '控股子公司', holding_ratio: '60%', business: '' }],
};
function fullMount() {
  return mount(ShareholdersPanel, {
    props: { stock: { code: '000001' } },
    global: { plugins: [ElementPlus], directives: { loading: () => {} } },
  });
}
async function tab(wrapper: ReturnType<typeof fullMount>, label: string) {
  await wrapper
    .findAll('[role="tab"]')
    .find((item) => item.text() === label)!
    .trigger('click');
  await flushPromises();
}
it('shows permanent control details, unfiltered own holders, raw float sum and distinct missing ratios', async () => {
  vi.mocked(request).mockResolvedValue(fixture);
  blockedTypes.value = { 基金: true, 其他: true, 个人: true };
  const wrapper = fullMount();
  await flushPromises();
  expect(wrapper.get('.control-owners').text()).toContain('控股机构');
  expect(wrapper.findAll('[role="tab"]').map((item) => item.text())).toEqual([
    '共同股东',
    '十大流通股东',
    '十大股东',
    '子公司',
  ]);
  expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('共同股东');
  await tab(wrapper, '十大流通股东');
  const panel = wrapper.get('[role="tabpanel"]:not([style*="display: none"])');
  expect(panel.text()).toContain('账户甲');
  expect(panel.text()).toContain('账户乙');
  expect(panel.text()).toContain('0.0000%');
  expect(panel.text()).toContain('未披露');
  expect(panel.text()).toContain('3 / 4 位披露占比');
  expect(panel.get('.holding-total').text()).toBe('2.4689%');
  expect(panel.text()).toContain('占总流通股本');
  await tab(wrapper, '十大股东');
  const total = wrapper.get('[role="tabpanel"]:not([style*="display: none"])');
  expect(total.text()).toContain('总股本名单');
  expect(total.text()).toContain('2026-06-30');
  expect(total.text()).toContain('占总股本');
  expect(total.find('.holding-total').exists()).toBe(false);
  expect(
    wrapper.findAll('a').every((anchor) => !anchor.attributes('href')?.startsWith('javascript:')),
  ).toBe(true);
  wrapper.unmount();
});
it('loads subsidiaries only when selected, preserves cached rows on refresh failure and validates source links', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(fixture)
    .mockResolvedValueOnce(subs)
    .mockRejectedValueOnce(new Error('网络失败'));
  const wrapper = fullMount();
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(1);
  await tab(wrapper, '子公司');
  expect(request).toHaveBeenCalledTimes(2);
  expect(wrapper.text()).toContain('子公司甲');
  expect(wrapper.text()).toContain('公告 2026-08-28');
  expect(wrapper.find('a[href="https://basic.10jqka.com.cn/000001/operate.html"]').exists()).toBe(
    true,
  );
  await wrapper
    .findAll('button')
    .find((button) => button.text() === '刷新子公司')!
    .trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('保留上次取得的资料');
  expect(wrapper.text()).toContain('子公司甲');
  wrapper.unmount();
});
it('aborts subsidiary loading on stock change and ignores stale responses', async () => {
  let resolve!: (value: Subsidiaries) => void;
  const pending = new Promise<Subsidiaries>((done) => {
    resolve = done;
  });
  vi.mocked(request)
    .mockResolvedValueOnce(fixture)
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(fixture);
  const wrapper = fullMount();
  await flushPromises();
  await tab(wrapper, '子公司');
  await wrapper.setProps({ stock: { code: '000002' } });
  await flushPromises();
  expect(abort).toHaveBeenCalledWith(expect.stringContaining('-subsidiaries'));
  resolve(subs);
  await flushPromises();
  expect(wrapper.text()).not.toContain('子公司甲');
  expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe('共同股东');
  wrapper.unmount();
});
it('does not expose unsafe source links and displays a clear empty subsidiary state', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(fixture)
    .mockResolvedValueOnce({
      ...subs,
      status: 'empty',
      rows: [],
      source_url: 'https://basic.10jqka.com.cn.evil.example/000001',
    });
  const wrapper = fullMount();
  await flushPromises();
  await tab(wrapper, '子公司');
  expect(wrapper.text()).toContain('来源暂无可用子公司资料');
  expect(
    wrapper.findAll('a').some((anchor) => anchor.attributes('href')?.includes('evil.example')),
  ).toBe(false);
  wrapper.unmount();
});
