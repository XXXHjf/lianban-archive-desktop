// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { EChartsCoreOption } from 'echarts/core';
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  use: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('echarts/core', () => mocks);
vi.mock('echarts/charts', () => ({
  LineChart: {},
  BarChart: {},
  ScatterChart: {},
  HeatmapChart: {},
}));
vi.mock('echarts/components', () => ({
  GridComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  DataZoomComponent: {},
  MarkLineComponent: {},
  MarkPointComponent: {},
  VisualMapComponent: {},
  TitleComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));
import ChartPanel from './ChartPanel.vue';
const observers: { trigger(): void; disconnect: ReturnType<typeof vi.fn> }[] = [];
function setup() {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn();
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push(this);
      }
      observe() {}
      trigger() {
        this.callback([{ isIntersecting: true }]);
      }
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect = vi.fn();
    },
  );
  const chart = {
    on: vi.fn(),
    setOption: vi.fn(),
    getOption: vi.fn(() => ({ dataZoom: [{ start: 30, end: 60 }] })),
    dispatchAction: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    group: '',
  };
  mocks.init.mockReturnValue(chart);
  const option: EChartsCoreOption = {
    dataZoom: [{ type: 'inside' }, { type: 'slider' }],
    series: [{ type: 'line', data: [1, 2] }],
  };
  const wrapper = mount(ChartPanel, {
    props: { option },
    global: { stubs: { ElButton: { template: '<button><slot /></button>' } } },
  });
  return { wrapper, chart, option };
}
afterEach(() => {
  observers.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('initializes charts only when visible and disposes observers and canvas on unmount', () => {
  const { wrapper, chart } = setup();
  expect(mocks.init).not.toHaveBeenCalled();
  observers[0]?.trigger();
  expect(mocks.init).toHaveBeenCalledOnce();
  expect(chart.setOption).toHaveBeenCalledOnce();
  wrapper.unmount();
  expect(chart.dispose).toHaveBeenCalledOnce();
  expect(observers[0]?.disconnect).toHaveBeenCalled();
});
it('keeps user zoom through data refresh and respects an explicit locate/zoom command', async () => {
  const { wrapper, chart, option } = setup();
  observers[0]?.trigger();
  await wrapper.setProps({ option: { ...option, series: [{ type: 'line', data: [2, 3] }] } });
  expect(chart.dispatchAction).toHaveBeenCalledWith({
    type: 'dataZoom',
    batch: [{ dataZoomIndex: 0, start: 30, end: 60 }],
  });
  chart.dispatchAction.mockClear();
  await wrapper.setProps({
    option: {
      ...option,
      dataZoom: [
        { type: 'inside', start: 40, end: 80 },
        { type: 'slider', start: 40, end: 80 },
      ],
    },
  });
  expect(chart.dispatchAction).not.toHaveBeenCalled();
  await wrapper.get('button').trigger('click');
  expect(chart.dispatchAction).toHaveBeenCalledWith({ type: 'dataZoom', start: 0, end: 100 });
  wrapper.unmount();
});
it('changes chart link group and resets when switching date or primary stock', async () => {
  const { wrapper, chart } = setup();
  await wrapper.setProps({ group: '2026-10-28-000678' });
  observers[0]?.trigger();
  expect(mocks.connect).toHaveBeenCalledWith('2026-10-28-000678');
  await wrapper.setProps({ group: '2026-10-27-000980', resetKey: '2026-10-27-000980' });
  expect(mocks.disconnect).toHaveBeenCalledWith('2026-10-28-000678');
  expect(chart.group).toBe('2026-10-27-000980');
  expect(chart.clear).toHaveBeenCalledOnce();
  wrapper.unmount();
  expect(mocks.disconnect).toHaveBeenCalledWith('2026-10-27-000980');
});
