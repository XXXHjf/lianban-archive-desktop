<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { chartClock, chartPointAt, chartSlot, displayPoint } from './helpers';
import {
  compareColors,
  financialModel,
  formatVolume,
  marketDown,
  marketUp,
  minuteTime,
  percentPrice,
  priceRuns,
  timeClock,
} from './financialModel';
import type { MinuteDetail } from './types';

const props = defineProps<{
  details: MinuteDetail[];
  average: boolean;
  sharedVolume: boolean;
  selectedSlot: number;
  resetKey: string;
}>();
const emit = defineEmits<{ select: [number] }>();
const host = ref<HTMLDivElement>();
const hoverSlot = ref<number | null>(null);
const hoverPosition = ref<{ x: number; y: number } | null>(null);
const paneLabels = ref<{ name: string; top: number }[]>([]);
const activeSlot = computed(() => hoverSlot.value ?? props.selectedSlot);
const bounds = computed(() => financialModel(props.details, props.average));
const height = computed(() => 330 + props.details.length * 140 + 30);
const readings = computed(() =>
  props.details.map((detail, index) => {
    const raw = chartPointAt(detail, activeSlot.value);
    const point = raw ? displayPoint(detail, raw) : null;
    return {
      detail,
      point,
      color: index ? compareColors[(index - 1) % compareColors.length] : marketUp,
    };
  }),
);
let chart: IChartApi | undefined;
let observer: ResizeObserver | undefined;
let prices: ISeriesApi<'Baseline'>[] = [];
let range: LogicalRange | null = null;
let savedKey = '';
let suppressHover = false;
let frame = 0;
function labels() {
  if (!chart) return;
  let top = 0;
  paneLabels.value = chart.panes().flatMap((pane, index) => {
    const offset = top;
    top += pane.getHeight() + (index ? 1 : 0);
    return index
      ? [{ name: `${props.details[index - 1]?.stock.name || ''} · 成交量 / 手`, top: offset + 8 }]
      : [];
  });
}
function setCursor() {
  if (!chart) return;
  const time = minuteTime(props.details[0]?.date || '2000-01-01', props.selectedSlot);
  const series = prices.find((item) => item.data().some((point) => point.time === time));
  const data = series?.data().find((point) => point.time === time);
  suppressHover = true;
  if (series && data && 'value' in data) chart.setCrosshairPosition(data.value, time, series);
  else chart.clearCrosshairPosition();
  suppressHover = false;
}
function onHover(event: MouseEventParams<Time>) {
  if (suppressHover || !event.sourceEvent) return;
  hoverSlot.value =
    typeof event.time === 'number' && event.point ? chartSlot(timeClock(event.time)) : null;
  hoverPosition.value =
    hoverSlot.value !== null && event.point
      ? {
          x: Math.max(70, Math.min((host.value?.clientWidth || 250) - 180, event.point.x + 78)),
          y: Math.max(8, event.point.y + 12),
        }
      : null;
}
function fit() {
  chart?.timeScale().setVisibleLogicalRange({ from: -2, to: 244 });
}
function draw() {
  if (!host.value || !props.details.length) return;
  range = savedKey === props.resetKey ? chart?.timeScale().getVisibleLogicalRange() || range : null;
  savedKey = props.resetKey;
  chart?.remove();
  prices = [];
  const model = financialModel(props.details, props.average);
  chart = createChart(host.value, {
    width: host.value.clientWidth,
    height: height.value,
    layout: {
      background: { type: ColorType.Solid, color: '#ffffff' },
      textColor: '#64748b',
      fontFamily: 'Noto Sans SC, Microsoft YaHei, sans-serif',
      fontSize: 11,
      attributionLogo: false,
      panes: { separatorColor: '#e2e8f0', separatorHoverColor: '#cbd5e1', enableResize: false },
    },
    grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#edf0f4' } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#94a3b8', style: LineStyle.Dashed },
      horzLine: { color: '#94a3b8', style: LineStyle.Dashed },
    },
    leftPriceScale: {
      visible: true,
      minimumWidth: 66,
      borderVisible: false,
      textColor: 'transparent',
      scaleMargins: { top: 0.03, bottom: 0.03 },
    },
    rightPriceScale: {
      visible: true,
      minimumWidth: 68,
      borderVisible: false,
      scaleMargins: { top: 0.03, bottom: 0.03 },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: '#e2e8f0',
      rightOffset: 2,
      minBarSpacing: 1,
      fixLeftEdge: true,
      fixRightEdge: true,
      tickMarkFormatter: (time: Time) => (typeof time === 'number' ? timeClock(time) : ''),
    },
    localization: {
      locale: 'zh-CN',
      timeFormatter: (time: Time) => (typeof time === 'number' ? timeClock(time) : ''),
    },
    handleScale: { axisPressedMouseMove: false, mouseWheel: true, pinch: true },
  });
  // The whitespace grid fixes the full session without inventing price/volume data.
  const scaffold = chart.addSeries(LineSeries, {
    priceScaleId: 'right',
    lineVisible: false,
    lastValueVisible: false,
    priceLineVisible: false,
    crosshairMarkerVisible: false,
  });
  scaffold.setData(model.grid);
  const autoPrice = () => ({ priceRange: model.range });
  model.stocks.forEach((stock, index) => {
    const runs = priceRuns(stock.price);
    for (const [runIndex, run] of runs.entries()) {
      const series = chart!.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: model.previous },
        topLineColor: index ? compareColors[(index - 1) % compareColors.length]! : marketUp,
        bottomLineColor: index ? compareColors[(index - 1) % compareColors.length]! : marketDown,
        topFillColor1: 'transparent',
        topFillColor2: 'transparent',
        bottomFillColor1: 'transparent',
        bottomFillColor2: 'transparent',
        lineWidth: index ? 1 : 2,
        lineStyle: index > compareColors.length ? LineStyle.Dashed : LineStyle.Solid,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false,
        lastValueVisible: !index && runIndex === runs.length - 1,
        pointMarkersVisible: run.length === 1,
        pointMarkersRadius: 3,
        autoscaleInfoProvider: autoPrice,
      });
      series.setData(run);
      if (!index) prices.push(series);
      if (!index && runIndex === runs.length - 1)
        series.createPriceLine({
          price: model.previous,
          color: '#94a3b8',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '昨收',
        });
      if (run.length === 1 && chartSlot(timeClock(run[0]!.time)) === 0)
        createSeriesMarkers(series, [
          {
            time: run[0]!.time,
            position: 'inBar',
            shape: 'circle',
            color: index ? compareColors[(index - 1) % compareColors.length]! : marketUp,
            size: 0.7,
          },
        ]);
    }
    if (!index) {
      const percent = chart!.addSeries(LineSeries, {
        priceScaleId: 'left',
        color: 'transparent',
        lineVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: autoPrice,
        priceFormat: {
          type: 'custom',
          minMove: 0.01,
          formatter: (value: number) => percentPrice(value, model.previous),
        },
      });
      percent.setData(stock.price);
      percent.createPriceLine({
        price: model.previous,
        color: '#94a3b8',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
      if (props.average)
        for (const run of priceRuns(stock.mean)) {
          const mean = chart!.addSeries(LineSeries, {
            color: '#b58c2e',
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            autoscaleInfoProvider: autoPrice,
          });
          mean.setData(run);
        }
    }
    const volume = chart!.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'custom', minMove: 1, formatter: formatVolume },
        priceLineVisible: false,
        lastValueVisible: false,
        autoscaleInfoProvider: () => ({
          priceRange: {
            minValue: 0,
            maxValue: (props.sharedVolume ? model.volumeMaximum : stock.maximum) * 1.12,
          },
        }),
      },
      index + 1,
    );
    volume.setData(stock.volume);
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.18, bottom: 0 },
      minimumWidth: 68,
      borderVisible: false,
    });
    chart!.panes()[index + 1]!.setStretchFactor(140);
    chart!
      .panes()
      [index + 1]!.priceScale('left')
      .applyOptions({ visible: true, minimumWidth: 66, borderVisible: false });
  });
  chart.panes()[0]!.setStretchFactor(330);
  chart.subscribeCrosshairMove(onHover);
  chart.subscribeClick((event) => {
    if (typeof event.time === 'number') emit('select', chartSlot(timeClock(event.time)));
  });
  if (range) chart.timeScale().setVisibleLogicalRange(range);
  else fit();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    labels();
    setCursor();
  });
}
onMounted(() => {
  draw();
  observer = new ResizeObserver(() => {
    if (!host.value || !chart) return;
    chart.resize(host.value.clientWidth, height.value);
    labels();
  });
  if (host.value) observer.observe(host.value);
});
watch(() => [props.details, props.average, props.sharedVolume, props.resetKey], draw);
watch(
  () => props.selectedSlot,
  () => {
    hoverSlot.value = null;
    setCursor();
  },
);
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
  chart?.remove();
});
</script>

<template>
  <section class="financial-chart" aria-label="分时价格与成交量，共用时间轴和十字光标">
    <div class="quote-strip">
      <span class="quote-time"
        >{{ chartClock(activeSlot) }}<small v-if="activeSlot === 0">集合竞价</small></span
      >
      <span
        v-for="(reading, index) in readings"
        :key="reading.detail.stock.code"
        class="quote-stock"
      >
        <i :style="{ background: reading.color }"></i>{{ reading.detail.stock.name }}
        <b
          :style="{
            color:
              reading.point &&
              reading.detail.previous_close &&
              reading.point.price < reading.detail.previous_close
                ? marketDown
                : reading.color,
          }"
          >{{ reading.point?.price.toFixed(2) ?? '—' }}</b
        >
        <span v-if="reading.point && reading.detail.previous_close">{{
          percentPrice(reading.point.price, reading.detail.previous_close)
        }}</span>
        <span v-if="!index && average" class="mean-quote"
          >均价 {{ reading.point?.average?.toFixed(2) ?? '—' }}</span
        >
        <span v-if="!index"
          >量 {{ reading.point ? formatVolume(reading.point.volume / 100) : '—' }} 手</span
        >
      </span>
      <el-button link size="small" class="fit-session" @click="fit">全日</el-button>
    </div>
    <div class="chart-stage">
      <div ref="host" class="financial-canvas" :style="{ height: `${height}px` }"></div>
      <div class="price-captions"><span>涨幅</span><span>价格 / 元</span></div>
      <template v-if="bounds.previous && paneLabels.length">
        <span
          v-for="fraction in [1, -1]"
          v-show="
            !hoverPosition ||
            Math.abs(hoverPosition.y - 12 - (paneLabels[0]!.top - 8) * (0.5 - fraction * 0.47)) > 16
          "
          :key="fraction"
          class="bound-caption"
          :style="{ top: `${(paneLabels[0]!.top - 8) * (0.5 - fraction * 0.47)}px` }"
          >{{
            percentPrice(
              bounds.previous + (bounds.range.maxValue - bounds.previous) * fraction,
              bounds.previous,
            )
          }}</span
        >
      </template>
      <div
        v-if="hoverPosition && hoverSlot !== null"
        class="chart-tooltip"
        :style="{ left: `${hoverPosition.x}px`, top: `${hoverPosition.y}px` }"
      >
        <strong>{{ chartClock(hoverSlot) }}</strong>
        <div v-for="reading in readings" :key="reading.detail.stock.code">
          {{ reading.detail.stock.name }}：{{ reading.point?.price.toFixed(2) ?? '—' }}
          <span v-if="reading.point && reading.detail.previous_close">{{
            percentPrice(reading.point.price, reading.detail.previous_close)
          }}</span>
        </div>
        <div>
          成交量：{{ readings[0]?.point ? formatVolume(readings[0].point.volume / 100) : '—' }} 手
        </div>
      </div>
      <span
        v-for="label in paneLabels"
        :key="label.name"
        class="volume-caption"
        :style="{ top: `${label.top}px` }"
        >{{ label.name }}</span
      >
    </div>
  </section>
</template>

<style scoped>
.financial-chart {
  min-width: 0;
  margin-top: 16px;
}
.quote-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 18px;
  min-height: 40px;
  padding: 8px 0;
  border-top: 1px solid #e2e8f0;
  border-bottom: 1px solid #e2e8f0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.quote-time {
  color: #334155;
  font-weight: 600;
}
.quote-time small {
  margin-left: 8px;
  color: #64748b;
  font-weight: 400;
}
.quote-stock {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: #64748b;
}
.quote-stock i {
  width: 12px;
  height: 2px;
}
.quote-stock b {
  font-size: 14px;
  font-weight: 600;
}
.mean-quote {
  color: #b58c2e;
}
.fit-session {
  margin-left: auto;
}
.chart-stage {
  position: relative;
  margin-top: 28px;
}
.financial-canvas {
  position: relative;
  z-index: 0;
  width: 100%;
  min-width: 0;
}
.price-captions {
  z-index: 1;
  position: absolute;
  top: -18px;
  left: 8px;
  right: 8px;
  display: flex;
  justify-content: space-between;
  pointer-events: none;
  font-size: 11px;
  color: #64748b;
}
.volume-caption {
  z-index: 1;
  position: absolute;
  left: 76px;
  pointer-events: none;
  font-size: 11px;
  color: #64748b;
  background: #ffffffdf;
}
.bound-caption {
  position: absolute;
  z-index: 2;
  left: 0;
  width: 66px;
  padding-right: 5px;
  text-align: right;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  pointer-events: none;
  transform: translateY(-50%);
}
.chart-tooltip {
  position: absolute;
  z-index: 3;
  pointer-events: none;
  padding: 8px 10px;
  border: 1px solid #dbe2ea;
  border-radius: 4px;
  background: #fff;
  color: #334155;
  font-size: 12px;
  line-height: 1.7;
  box-shadow: 0 3px 12px #0f172a1a;
}
@media (max-width: 760px) {
  .quote-strip {
    gap: 8px 12px;
  }
  .quote-stock {
    gap: 6px;
  }
}
</style>
