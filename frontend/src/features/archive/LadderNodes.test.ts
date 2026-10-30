// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it } from 'vitest';
import ElementPlus from 'element-plus';
import { createWorkspace, parseRoute, workspaceKey } from '@/shared/workspace';
import DailyStockRow from './DailyStockRow.vue';

it('opens the specific node and carries the row date and code to intraday', async () => {
  const ws = createWorkspace();
  ws.route.value = parseRoute('?date=2026-10-30');
  const wrapper = mount(DailyStockRow, {
    props: {
      stock: {
        code: '000001',
        name: '合成股票',
        date: '2026-10-29',
        boards: 2,
        nodes: [{ id: 'node-a', name: '合成断板', date: '2026-10-28', kind: 'manual' }],
      },
      active: false,
      highlight: false,
    },
    global: { plugins: [ElementPlus], provide: { [workspaceKey as symbol]: ws } },
  });
  await wrapper.get('.ladder-node').trigger('click');
  expect(wrapper.emitted('node')).toEqual([['node-a']]);
  await wrapper.get('[aria-label="查看合成股票当日分时"]').trigger('click');
  await flushPromises();
  expect(ws.route.value).toMatchObject({
    view: 'intraday',
    date: '2026-10-29',
    minuteCode: '000001',
    minuteCompare: [],
  });
  wrapper.unmount();
  ws.dispose();
});

it('does not offer mainboard intraday for unsupported boards', () => {
  const ws = createWorkspace();
  const wrapper = mount(DailyStockRow, {
    props: {
      stock: { code: '300001', name: '合成创业板', date: '2026-10-29' },
      active: false,
      highlight: false,
    },
    global: { plugins: [ElementPlus], provide: { [workspaceKey as symbol]: ws } },
  });
  expect(wrapper.find('[aria-label="查看合成创业板当日分时"]').exists()).toBe(false);
  wrapper.unmount();
  ws.dispose();
});
