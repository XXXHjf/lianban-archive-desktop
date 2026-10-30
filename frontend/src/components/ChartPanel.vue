<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { init, use, type EChartsType, type EChartsCoreOption } from 'echarts/core';
import { joinChartGroup, leaveChartGroup } from '@/shared/chartGroups';
import { LineChart, BarChart, ScatterChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
use([
  LineChart,
  BarChart,
  ScatterChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  VisualMapComponent,
  TitleComponent,
  CanvasRenderer,
]);
const props = withDefaults(
  defineProps<{
    option: EChartsCoreOption;
    height?: number;
    label?: string;
    resetKey?: string;
    group?: string;
  }>(),
  { height: 360, label: '数据图表，可使用图内滑块缩放范围', resetKey: '', group: '' },
);
const emit = defineEmits<{ click: [unknown] }>();
const container = ref<HTMLDivElement>();
let chart: EChartsType | undefined,
  observer: ResizeObserver | undefined,
  visibility: IntersectionObserver | undefined,
  groupName = '';
function setGroup(group: string) {
  if (!chart || group === groupName) return;
  leaveChartGroup(groupName);
  groupName = group;
  chart.group = group;
  joinChartGroup(group);
}
function create() {
  if (!container.value || chart) return;
  chart = init(container.value);
  chart.on('click', (event) => emit('click', event));
  chart.setOption(props.option);
  setGroup(props.group);
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(container.value);
  visibility?.disconnect();
}
onMounted(() => {
  if (!container.value) return;
  visibility = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) create();
    },
    { rootMargin: '200px' },
  );
  visibility.observe(container.value);
});
function configuredRange(option: EChartsCoreOption) {
  const configs: unknown = option.dataZoom;
  return JSON.stringify(
    (Array.isArray(configs) ? configs : [configs]).map((value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      return Object.fromEntries(
        ['id', 'start', 'end', 'startValue', 'endValue', 'xAxisIndex', 'yAxisIndex'].map((key) => [
          key,
          key in value ? Reflect.get(value, key) : undefined,
        ]),
      );
    }),
  );
}
watch(
  () => props.option,
  (option, oldOption) => {
    if (!chart) return;
    const previous: unknown = chart.getOption().dataZoom;
    const ranges = Array.isArray(previous)
      ? previous.flatMap((value: unknown, index) => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('start' in value) ||
            !('end' in value) ||
            typeof value.start !== 'number' ||
            typeof value.end !== 'number'
          )
            return [];
          return [{ dataZoomIndex: index, start: value.start, end: value.end }];
        })
      : [];
    chart.setOption(option, { notMerge: true });
    if (ranges.length && configuredRange(option) === configuredRange(oldOption))
      chart.dispatchAction({ type: 'dataZoom', batch: ranges });
  },
);
watch(() => props.group, setGroup);
watch(
  () => props.resetKey,
  () => {
    chart?.clear();
    chart?.setOption(props.option);
  },
);
watch(
  () => props.height,
  () => requestAnimationFrame(() => chart?.resize()),
);
function reset() {
  chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
}
onBeforeUnmount(() => {
  visibility?.disconnect();
  observer?.disconnect();
  chart?.dispose();
  leaveChartGroup(groupName);
});
</script>
<template>
  <div class="chart-container">
    <div
      ref="container"
      role="img"
      :aria-label="label"
      class="chart-panel"
      :style="{ height: `${height}px` }"
    ></div>
    <el-button v-if="option.dataZoom" link size="small" class="reset-range" @click="reset"
      >恢复全部范围</el-button
    >
  </div>
</template>
<style scoped>
.chart-container {
  width: 100%;
  min-width: 0;
  position: relative;
}
.chart-panel {
  width: 100%;
  min-width: 0;
}
.reset-range {
  position: absolute;
  right: 8px;
  top: 0;
  font-size: 10px;
}
</style>
