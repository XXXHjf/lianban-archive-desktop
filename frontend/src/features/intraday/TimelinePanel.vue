<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { EChartsOption } from 'echarts';
import ChartPanel from '@/components/ChartPanel.vue';
import StockLink from '@/components/StockLink.vue';
import { useWorkspace } from '@/shared/workspace';
import { daySlot, slotClock, timelineRows, visibleTags } from './helpers';
import type { TimelineData, TimelineEvent } from './types';

const props = defineProps<{
  data: TimelineData;
  busy: boolean;
  editable: boolean;
  progress: string;
}>();
const emit = defineEmits<{
  open: [event: TimelineEvent];
  refresh: [];
  collect: [];
  stop: [];
  scope: [exclude: boolean];
  sensitivity: [value: number];
}>();
const workspace = useWorkspace();
const group = ref('all'),
  kind = ref('all'),
  excluded = ref<string[]>([]),
  sort = ref('boards'),
  locate = ref(''),
  multiple = ref(3);
const selected = ref<TimelineEvent | null>(null),
  jumpTime = ref('09:25:00'),
  zoomStart = ref(0),
  zoomEnd = ref(100);
const rowStart = ref(0);
const showTags = ref(false);
try {
  showTags.value = localStorage.getItem('minute-timeline-tags') === '1';
} catch {
  /* Storage is optional. */
}
watch(showTags, (value) => {
  try {
    localStorage.setItem('minute-timeline-tags', value ? '1' : '0');
  } catch {
    /* Keep the in-memory preference. */
  }
});
const rows = computed(() =>
  timelineRows(props.data, {
    group: group.value,
    kind: kind.value,
    excluded: excluded.value,
    sort: sort.value,
  }),
);
const events = computed(() =>
  rows.value
    .flatMap((row) => row.events)
    .sort((a, b) => a.time.localeCompare(b.time) || a.code.localeCompare(b.code)),
);
watch(
  () => props.data.date,
  () => {
    selected.value = null;
    locate.value = '';
    zoomStart.value = 0;
    zoomEnd.value = 100;
  },
);
watch(events, (value) => {
  if (selected.value)
    selected.value = value.find((event) => event.id === selected.value?.id) || null;
});
function select(event: TimelineEvent) {
  selected.value = event;
}
function chartClick(value: unknown) {
  if (typeof value !== 'object' || value === null || !('data' in value)) return;
  const data = value.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('eventId' in data) ||
    typeof data.eventId !== 'string'
  )
    return;
  const event = events.value.find((event) => event.id === data.eventId);
  if (event) select(event);
}
function locateStock() {
  const row = rows.value.find((row) => row.stock.code === locate.value);
  const event = row?.events.find((event) => event.kind === 'seal') || row?.events[0];
  if (event) {
    select(event);
    jumpTime.value = event.time;
    jump();
  }
  const index = rows.value.findIndex((row) => row.stock.code === locate.value);
  if (index >= 0) rowStart.value = Math.max(0, Math.min(rows.value.length - 1, index - 4));
}
function jump() {
  const position = (daySlot(jumpTime.value) / 241) * 100,
    width = Math.min(100, zoomEnd.value - zoomStart.value || 10);
  zoomStart.value = Math.max(0, Math.min(100 - width, position - width / 2));
  zoomEnd.value = zoomStart.value + width;
}
function zoom(width: number) {
  const center = (zoomStart.value + zoomEnd.value) / 2;
  zoomStart.value = Math.max(0, Math.min(100 - width, center - width / 2));
  zoomEnd.value = zoomStart.value + width;
}
const option = computed<EChartsOption>(() => ({
  animation: false,
  tooltip: { trigger: 'item', renderMode: 'richText', confine: true, formatter: '{b}' },
  grid: { left: 144, right: 56, top: 20, bottom: 66 },
  xAxis: {
    type: 'value',
    min: 0,
    max: 241,
    minInterval: 1 / 60,
    axisLabel: {
      formatter: (value: number) => {
        const clock = slotClock(value),
          second = Math.round((value - Math.floor(value)) * 60);
        return zoomEnd.value - zoomStart.value <= 2 && value >= 1
          ? `${clock}:${String(second).padStart(2, '0')}`
          : value === 121
            ? '11:30 / 13:00'
            : clock;
      },
    },
  },
  yAxis: {
    type: 'category',
    inverse: true,
    data: rows.value.map((row) => `${row.stock.name} ${row.stock.boards}板`),
    axisLabel: { width: 130, overflow: 'truncate' },
  },
  dataZoom: [
    {
      type: 'inside',
      xAxisIndex: 0,
      filterMode: 'none',
      start: zoomStart.value,
      end: zoomEnd.value,
    },
    {
      type: 'slider',
      xAxisIndex: 0,
      filterMode: 'none',
      start: zoomStart.value,
      end: zoomEnd.value,
      bottom: 6,
    },
    {
      type: 'slider',
      yAxisIndex: 0,
      orient: 'vertical',
      filterMode: 'none',
      right: 0,
      width: 16,
      startValue: Math.min(rowStart.value, Math.max(0, rows.value.length - 1)),
      endValue: Math.min(rowStart.value + 21, Math.max(0, rows.value.length - 1)),
    },
  ],
  series: ['seal', 'break', 'volume'].map((kind) => ({
    type: 'scatter' as const,
    name: kind === 'seal' ? '封板 / 回封' : kind === 'break' ? '开板' : '放量',
    symbol: kind === 'volume' ? 'diamond' : 'circle',
    symbolSize: 11,
    itemStyle: { color: kind === 'seal' ? '#c45145' : kind === 'break' ? '#2b8a67' : '#bd9136' },
    data: rows.value.flatMap((row, index) =>
      row.events
        .filter((event) =>
          kind === 'seal'
            ? ['seal', 'relock', 'last_seal'].includes(event.kind)
            : event.kind === kind,
        )
        .map((event) => ({
          name: `${event.time} ${event.name} ${event.label} · ${event.precision === 'source' ? '来源时间' : '分钟观察'}`,
          value: [daySlot(event.time), index],
          eventId: event.id,
        })),
    ),
  })),
}));
</script>

<template>
  <section class="panel stack">
    <div class="panel-header">
      <h2>涨停池自身节点时间轴</h2>
      <div class="toolbar">
        <el-button :disabled="busy" @click="emit('refresh')">刷新节点 / 来源时间</el-button>
        <el-button
          v-if="editable"
          type="primary"
          :disabled="busy || !data.jobs.length"
          @click="emit('collect')"
          >补齐当日分时（{{ data.jobs.length }} 只）</el-button
        >
        <el-button v-if="busy" type="danger" plain @click="emit('stop')">停止采集</el-button>
      </div>
    </div>
    <p class="muted">
      {{ data.provisional ? '盘中暂定涨停池' : '当日收盘涨停池' }} {{ data.coverage.total }} 只 ·
      已分析 {{ data.coverage.analyzed }} 只 · 部分数据 {{ data.coverage.partial }} 只 · 待补齐
      {{ data.coverage.missing }} 只 · 展示 {{ rows.length }} 只 / {{ events.length }} 节点。09:25
      起，ST 固定屏蔽。
    </p>
    <el-alert v-if="progress" :title="progress" type="info" :closable="false" />
    <el-form inline label-position="left" class="timeline-controls">
      <el-form-item label="股票范围"
        ><el-select v-model="group"
          ><el-option label="全部" value="all" /><el-option
            label="连板股"
            value="relay" /><el-option label="首板股" value="first" /></el-select
      ></el-form-item>
      <el-form-item label="节点类型"
        ><el-select v-model="kind"
          ><el-option label="全部节点" value="all" /><el-option
            label="封板 / 回封"
            value="seal" /><el-option label="开板" value="break" /><el-option
            label="放量"
            value="volume" /></el-select
      ></el-form-item>
      <el-form-item label="放量倍数"
        ><el-select v-model="multiple" :disabled="busy" @change="emit('sensitivity', multiple)"
          ><el-option
            v-for="value in [2, 3, 5]"
            :key="value"
            :label="`${value} 倍`"
            :value="value" /></el-select
      ></el-form-item>
      <el-form-item
        ><el-checkbox
          :model-value="data.scope.exclude_gem"
          :disabled="busy"
          @change="(value) => emit('scope', value === true)"
          >屏蔽创业板</el-checkbox
        ><el-checkbox v-model="showTags">显示标签</el-checkbox></el-form-item
      >
      <el-form-item label="排序"
        ><el-select v-model="sort"
          ><el-option label="连板高度" value="boards" /><el-option
            label="首次涨停时间"
            value="first_time" /></el-select
      ></el-form-item>
      <el-form-item label="定位股票"
        ><el-select v-model="locate" filterable clearable @change="locateStock"
          ><el-option
            v-for="row in rows"
            :key="row.stock.code"
            :label="`${row.stock.name} ${row.stock.code}`"
            :value="row.stock.code" /></el-select
      ></el-form-item>
      <el-form-item label="排除股票"
        ><el-select v-model="excluded" multiple filterable clearable collapse-tags
          ><el-option
            v-for="stock in data.pool"
            :key="stock.code"
            :label="`${stock.name} ${stock.code}`"
            :value="stock.code" /></el-select
      ></el-form-item>
    </el-form>
    <div class="toolbar">
      <el-tag type="danger">封板 / 回封</el-tag><el-tag type="success">开板</el-tag
      ><el-tag type="warning">放量</el-tag
      ><el-time-picker
        v-model="jumpTime"
        value-format="HH:mm:ss"
        format="HH:mm:ss"
        :clearable="false"
        aria-label="定位时间"
      /><el-button @click="jump">跳转</el-button><el-button @click="zoom(100)">全天</el-button
      ><el-button @click="zoom(10)">分钟</el-button><el-button @click="zoom(2)">秒序</el-button
      ><span class="muted">拖动底部时间滑块缩放、平移</span>
    </div>
    <ChartPanel
      v-if="rows.length"
      :option="option"
      :reset-key="data.date"
      :height="Math.max(300, Math.min(760, rows.length * 32 + 110))"
      label="涨停股票封板、开板与放量节点时间轴"
      @click="chartClick"
    />
    <el-empty v-else description="当前范围暂无股票节点，可调整筛选或补齐分时" />
    <div v-if="selected" class="selected-event stack" aria-live="polite">
      <div class="toolbar">
        <strong>{{ selected.time }} {{ selected.name }} · {{ selected.label }}</strong
        ><el-tag>{{ selected.precision === 'source' ? '来源时间' : '分钟观察' }}</el-tag
        ><el-button @click="emit('open', selected)">查看该分钟分时</el-button
        ><el-button text @click="selected = null">清除选择</el-button>
      </div>
      <p>{{ selected.detail }}</p>
      <p v-if="selected.kind === 'volume'">
        {{ ((selected.volume || 0) / 100).toFixed(0) }} 手 · {{ selected.ratio }} 倍
      </p>
    </div>
    <el-collapse>
      <el-collapse-item :title="`全天 ${events.length} 条分时记录`" name="evidence">
        <el-table :data="events" max-height="420" stripe @row-click="select"
          ><el-table-column prop="time" label="时间" width="105" /><el-table-column
            label="股票"
            width="160"
            ><template #default="{ row }"
              ><StockLink :code="row.code" :name="row.name" /></template></el-table-column
          ><el-table-column prop="label" label="节点" width="120" /><el-table-column
            label="精度"
            width="110"
            ><template #default="{ row }">{{
              row.precision === 'source' ? '来源时间' : '分钟观察'
            }}</template></el-table-column
          ><el-table-column prop="detail" label="依据" /><el-table-column label="分时" width="80"
            ><template #default="{ row }"
              ><el-button link @click.stop="emit('open', row)">查看</el-button></template
            ></el-table-column
          ></el-table
        >
      </el-collapse-item>
    </el-collapse>
    <div v-if="showTags" class="tag-list">
      <div v-for="row in rows" :key="row.stock.code">
        <StockLink :code="row.stock.code" :name="row.stock.name" /><el-tag
          v-for="tag in visibleTags(row.stock, workspace.meta.value?.tag_hierarchy)"
          :key="tag"
          type="info"
          size="small"
          >{{ tag }}</el-tag
        ><span
          v-if="!visibleTags(row.stock, workspace.meta.value?.tag_hierarchy).length"
          class="muted"
          >暂无标签</span
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline-controls :deep(.el-select) {
  width: 160px;
}
.timeline-controls :deep(.el-form-item) {
  margin-bottom: 8px;
}
.selected-event {
  padding: 12px;
  background: var(--la-bg-subtle);
  border-left: 3px solid var(--la-action-primary);
}
.tag-list {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.tag-list > div {
  display: flex;
  gap: 4px;
  align-items: center;
}
h2 {
  font-size: 18px;
  margin: 0;
}
p {
  margin: 0;
}
.toolbar :deep(.el-date-editor) {
  width: 150px;
}
</style>
