// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ElCheckbox } from 'element-plus';
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
