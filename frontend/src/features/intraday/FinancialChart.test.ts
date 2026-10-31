// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { MouseEventParams, Time } from 'lightweight-charts';
import type { MinuteDetail } from './types';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  resize: vi.fn(),
  observe: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('lightweight-charts', () => ({
  BaselineSeries: 'Baseline',
  LineSeries: 'Line',
  HistogramSeries: 'Histogram',
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Dashed: 2, Solid: 0 },
  createChart: mocks.create,
  createSeriesMarkers: vi.fn(),
}));
import FinancialChart from './FinancialChart.vue';

const detail: MinuteDetail = {
  date: '2026-10-30',
  stock: { code: '001219', name: '青岛食品', boards: 5 },
  status: 'ok',
  note: '',
  previous_close: 10,
  points: [{ time: '09:30', slot: 0, price: 11, volume: 10000, amount: 110000 }],
};
function setup() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = mocks.observe;
      disconnect = mocks.disconnect;
    },
  );
  const charts: ReturnType<typeof fakeChart>[] = [];
  mocks.create.mockImplementation(() => {
    const chart = fakeChart();
    charts.push(chart);
    return chart;
  });
  const wrapper = mount(FinancialChart, {
    props: {
      details: [detail],
      average: false,
      sharedVolume: true,
      selectedSlot: 1,
      resetKey: '2026-10-30/001219',
    },
    global: { stubs: { ElButton: { template: '<button><slot /></button>' } } },
  });
  return { wrapper, charts };
}
function fakeChart() {
  const scale = {
    getVisibleLogicalRange: () => ({ from: 50, to: 100 }),
    setVisibleLogicalRange: vi.fn(),
  };
  const pane = {
    getHeight: () => 140,
    setStretchFactor: vi.fn(),
    priceScale: () => ({ applyOptions: vi.fn() }),
  };
  let click: ((event: MouseEventParams<Time>) => void) | undefined;
  return {
    remove: vi.fn(),
    resize: mocks.resize,
    panes: () => [pane, pane],
    timeScale: () => scale,
    setCrosshairPosition: vi.fn(),
    clearCrosshairPosition: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    subscribeClick: (callback: typeof click) => {
      click = callback;
    },
    click: (time: Time) => click?.({ time } as MouseEventParams<Time>),
    addSeries: () => {
      let points: { time: Time; value?: number }[] = [];
      return {
        setData: (data: typeof points) => {
          points = data;
        },
        data: () => points,
        createPriceLine: vi.fn(),
        priceScale: () => ({ applyOptions: vi.fn() }),
      };
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('keeps the zoom on display changes, resets on stock/date changes and releases the old chart', async () => {
  const { wrapper, charts } = setup();
  await wrapper.setProps({ average: true });
  expect(charts[0]?.remove).toHaveBeenCalledOnce();
  expect(charts[1]?.timeScale().setVisibleLogicalRange).toHaveBeenCalledWith({ from: 50, to: 100 });
  await wrapper.setProps({ resetKey: '2026-10-29/001219' });
  expect(charts[2]?.timeScale().setVisibleLogicalRange).toHaveBeenCalledWith({ from: -2, to: 244 });
  wrapper.unmount();
  expect(charts[2]?.remove).toHaveBeenCalledOnce();
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});

it('maps chart clicks into the same minute index used by the reading table and slider', async () => {
  const { wrapper, charts } = setup();
  charts[0]?.click((Date.parse('2026-10-30T13:00:00+08:00') / 1000) as Time);
  expect(wrapper.emitted('select')).toEqual([[122]]);
  await wrapper.setProps({ selectedSlot: 0 });
  expect(wrapper.text()).toContain('集合竞价');
  expect(wrapper.text()).toContain('—');
  wrapper.unmount();
});
