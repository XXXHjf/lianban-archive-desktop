<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ArrowLeft, ArrowRight } from '@element-plus/icons-vue';
import { abort, post, query, request } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage, number } from '@/shared/format';
import FinancialChart from './FinancialChart.vue';
import StockActions from '@/components/StockActions.vue';
import TimelinePanel from './TimelinePanel.vue';
import {
  acceptsRefresh,
  chartClock,
  chartPointAt,
  chartSlot,
  displayPoint,
  nearestChartSlot,
  stockRows,
  visibleTags,
} from './helpers';
import type {
  Comparison,
  MinuteDetail,
  MinuteOverview,
  TimelineData,
  TimelineEvent,
} from './types';

const workspace = useWorkspace();
const overview = ref<MinuteOverview | null>(null),
  detail = ref<MinuteDetail | null>(null),
  timeline = ref<TimelineData | null>(null);
const comparisons = reactive(new Map<string, Comparison>());
const search = ref(''),
  compareSearch = ref(''),
  listLimit = ref(150),
  compareLimit = ref(150),
  showAverage = ref(false);
const overviewLoading = ref(false),
  stockLoading = ref(false),
  timelineLoading = ref(false),
  collecting = ref(false),
  liveRefreshing = ref(false);
const error = ref(''),
  timelineError = ref(''),
  progress = ref(''),
  multiple = ref(3),
  pointSlot = ref(242),
  dateInput = ref('');
let active = true,
  generation = 0,
  stockGeneration = 0,
  timelineGeneration = 0,
  collectGeneration = 0;
let liveChecked = 0,
  liveKey = '',
  liveTimer: ReturnType<typeof setInterval> | undefined;
let requestedStock = '';
let pendingPoint: { date: string; code: string; slot: number } | null = null;
const attemptedTimes = new Set<string>(),
  channels = new Set<string>();
const day = computed(() => workspace.route.value.date),
  code = computed(() => workspace.route.value.minuteCode);
const compareCodes = computed(() => workspace.route.value.minuteCompare);
const editable = computed(() => workspace.meta.value?.capabilities?.edit_tags === true);
const busy = computed(() => collecting.value || liveRefreshing.value);
const dates = computed(() => [...new Set(overview.value?.dates || [])].sort());
const timelinePool = computed(() => timeline.value?.pool || []);
const latestCodes = computed(
  () => new Set(workspace.meta.value?.latest_limit_ups?.map((stock) => stock.code) || []),
);
const rows = computed(() =>
  stockRows(
    overview.value?.rows || [],
    search.value,
    latestCodes.value,
    workspace.meta.value?.latest_date,
  ),
);
const visibleRows = computed(() => {
  const visible = rows.value.slice(0, listLimit.value),
    selected = rows.value.find((row) => row.code === code.value);
  if (selected && !visible.includes(selected)) visible.push(selected);
  return visible;
});
const compareRows = computed(() =>
  stockRows(
    [
      ...new Map(
        [
          ...(overview.value?.rows || []),
          ...(timeline.value?.scope.exclude_gem === false
            ? timeline.value.pool.filter((stock) => /^(300|301)\d{3}$/.test(stock.code))
            : []),
        ].map((stock) => [stock.code, stock]),
      ).values(),
    ],
    compareSearch.value,
    latestCodes.value,
    workspace.meta.value?.latest_date,
  ),
);
const visibleCompareRows = computed(() =>
  compareRows.value.filter(
    (row, index) => index < compareLimit.value || compareCodes.value.includes(row.code),
  ),
);
const chartDetails = computed(() =>
  detail.value
    ? [
        detail.value,
        ...compareCodes.value.flatMap((value) => {
          const data = comparisons.get(value)?.data;
          return data?.points.length && data.previous_close ? [data] : [];
        }),
      ]
    : [],
);
const readings = computed(() =>
  chartDetails.value.map((data) => {
    const raw = chartPointAt(data, pointSlot.value);
    const point = raw ? displayPoint(data, raw) : null;
    const pct = point && data.previous_close ? (point.price / data.previous_close - 1) * 100 : null;
    return {
      code: data.stock.code,
      name: data.stock.name,
      price: point?.price,
      average: point?.average,
      volume: point ? point.volume / 100 : null,
      amount: point?.amount,
      pct,
      difference: pct !== null && primaryPct.value !== null ? pct - primaryPct.value : null,
    };
  }),
);
const primaryPct = computed(() => {
  const data = detail.value,
    raw = chartPointAt(data, pointSlot.value);
  return raw && data?.previous_close ? (raw.price / data.previous_close - 1) * 100 : null;
});
const liveLabel = computed(() => {
  const live = workspace.meta.value?.live;
  if (!editable.value || !live?.enabled || day.value !== live.today) return '';
  return live.polling
    ? `盘中每分钟自动获取${liveRefreshing.value ? ' · 更新中' : liveChecked ? ` · 最近检查 ${new Date(liveChecked).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : ''}`
    : '当前非采集时段，自动获取已暂停';
});
function current(dayValue: string, token: number) {
  return active && dayValue === day.value && token === generation;
}
async function tracked<T>(path: string, channel: string, options?: Parameters<typeof request>[2]) {
  channels.add(channel);
  return request<T>(path, channel, options);
}
async function minuteData(
  dayValue: string,
  stockCode: string,
  channel: string,
  valid: () => boolean,
) {
  let data = await tracked<MinuteDetail>(
    query('/api/intraday/stock', { date: dayValue, code: stockCode }),
    channel,
  );
  if (!valid()) return null;
  if (data && (data.needs_collection || data.needs_refresh) && editable.value) {
    data = await tracked<MinuteDetail>('/api/intraday/collect', channel, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dayValue, code: stockCode }),
    });
  }
  return valid() ? data : null;
}
function record(data: MinuteDetail) {
  if (data.date !== day.value || !overview.value) return;
  const row = overview.value.rows.find((row) => row.code === data.stock.code);
  if (row) {
    row.status = data.status;
    row.point_count = data.points.length;
  }
  overview.value.ready = overview.value.rows.filter((row) => row.status === 'ok').length;
  overview.value.partial = overview.value.rows.filter((row) => row.status === 'partial').length;
}
function stopCollection(refresh = true) {
  const wasBusy = collecting.value;
  collectGeneration++;
  collecting.value = false;
  for (let worker = 0; worker < 3; worker++) abort(`timeline-collect-${worker}`);
  if (wasBusy && refresh) {
    progress.value = '已停止启动新请求，已取得的数据保留在当天缓存。';
    void loadTimeline();
  }
}
async function loadOverview() {
  const selectedDay = day.value,
    selectedCode = code.value,
    token = ++generation;
  stopCollection(false);
  stockGeneration++;
  timelineGeneration++;
  for (const channel of channels) abort(channel);
  overviewLoading.value = true;
  stockLoading.value = false;
  timelineLoading.value = false;
  liveRefreshing.value = false;
  error.value = '';
  timelineError.value = '';
  progress.value = '';
  detail.value = null;
  timeline.value = null;
  comparisons.clear();
  try {
    const data = await tracked<MinuteOverview>(
      query('/api/intraday', { date: selectedDay || undefined }),
      'intraday',
    );
    if (!data || !active || token !== generation) return;
    overview.value = data;
    if (data.date !== selectedDay) workspace.patchRoute({ date: data.date || '' }, true);
    dateInput.value = data.date || '';
    await loadTimeline();
    if (!active || token !== generation) return;
    const available = new Set([...data.rows, ...timelinePool.value].map((row) => row.code));
    const nextCode = available.has(selectedCode)
      ? selectedCode
      : stockRows(data.rows, '')[0]?.code || '';
    workspace.patchRoute(
      {
        minuteCode: nextCode,
        minuteCompare: [...new Set(compareCodes.value)].filter(
          (value) => value !== nextCode && available.has(value),
        ),
      },
      true,
    );
    overviewLoading.value = false;
    await Promise.all([nextCode ? loadStock(nextCode) : Promise.resolve(), syncComparisons()]);
  } catch (cause) {
    if (active && token === generation) error.value = errorMessage(cause);
  } finally {
    if (token === generation) {
      overviewLoading.value = false;
      void refreshLive();
    }
  }
}
async function loadStock(stockCode: string) {
  if (!stockCode || overviewLoading.value || (stockLoading.value && requestedStock === stockCode))
    return;
  requestedStock = stockCode;
  const selectedDay = day.value,
    token = generation,
    stockToken = ++stockGeneration;
  const valid = () =>
    current(selectedDay, token) && stockCode === code.value && stockToken === stockGeneration;
  stockLoading.value = true;
  error.value = '';
  if (compareCodes.value.includes(stockCode))
    setCompareCodes(compareCodes.value.filter((value) => value !== stockCode));
  try {
    const data = await minuteData(selectedDay, stockCode, 'intraday-stock', valid);
    if (data && valid()) {
      detail.value = data;
      record(data);
      pointSlot.value =
        pendingPoint?.date === selectedDay && pendingPoint.code === stockCode
          ? nearestChartSlot(data, pendingPoint.slot)
          : data.points.length
            ? chartSlot(data.points[data.points.length - 1]!.time)
            : 242;
      pendingPoint = null;
    }
  } catch (cause) {
    if (valid()) error.value = errorMessage(cause);
  } finally {
    if (stockToken === stockGeneration) stockLoading.value = false;
  }
}
function selectStock(stockCode: string) {
  if (stockCode === code.value) void loadStock(stockCode);
  else workspace.patchRoute({ minuteCode: stockCode });
}
function setCompareCodes(codes: string[]) {
  workspace.patchRoute({
    minuteCompare: [...new Set(codes)].filter((value) => value !== code.value),
  });
}
function toggleComparison(stockCode: string, selected: boolean) {
  setCompareCodes(
    selected
      ? [...compareCodes.value, stockCode]
      : compareCodes.value.filter((value) => value !== stockCode),
  );
}
async function syncComparisons() {
  for (const value of comparisons.keys())
    if (!compareCodes.value.includes(value)) {
      abort(`minute-compare-${value}`);
      comparisons.delete(value);
    }
  await Promise.all(
    compareCodes.value
      .filter((value) => value !== code.value && !comparisons.has(value))
      .map(async (stockCode) => {
        const selectedDay = day.value,
          token = generation,
          entry: Comparison = reactive({ loading: true });
        comparisons.set(stockCode, entry);
        const valid = () =>
          current(selectedDay, token) &&
          compareCodes.value.includes(stockCode) &&
          comparisons.get(stockCode) === entry;
        try {
          const data = await minuteData(
            selectedDay,
            stockCode,
            `minute-compare-${stockCode}`,
            valid,
          );
          if (data && valid()) {
            entry.data = data;
            record(data);
          }
        } catch (cause) {
          if (valid()) entry.error = errorMessage(cause);
        } finally {
          if (valid()) entry.loading = false;
        }
      }),
  );
}
async function loadTimeline(refreshTimes = false) {
  const selectedDay = day.value,
    token = generation,
    timelineToken = ++timelineGeneration;
  if (!selectedDay) return;
  const valid = () => current(selectedDay, token) && timelineToken === timelineGeneration;
  const path = query('/api/intraday/timeline', {
    date: selectedDay,
    window: 2,
    multiple: multiple.value,
    exclude_gem: workspace.route.value.timelineGEM ? 0 : 1,
  });
  timelineLoading.value = true;
  timelineError.value = '';
  try {
    const data = await tracked<TimelineData>(path, 'minute-timeline');
    if (!data || !valid()) return;
    timeline.value = data;
    if (
      !data.provisional &&
      editable.value &&
      data.time_coverage?.missing &&
      (refreshTimes || (!data.time_coverage.cached && !attemptedTimes.has(selectedDay)))
    ) {
      attemptedTimes.add(selectedDay);
      try {
        channels.add('minute-timeline-times');
        await post(
          '/api/intraday/timeline/times',
          { date: selectedDay, force: refreshTimes },
          'minute-timeline-times',
        );
        if (!valid()) return;
        const enriched = await tracked<TimelineData>(path, 'minute-timeline');
        if (enriched && valid()) timeline.value = enriched;
      } catch (cause) {
        if (valid() && refreshTimes)
          progress.value = `秒级封板时间暂未补齐：${errorMessage(cause)}；分钟记录按原精度展示。`;
      }
    }
  } catch (cause) {
    if (valid()) timelineError.value = errorMessage(cause);
  } finally {
    if (valid()) timelineLoading.value = false;
  }
}
async function collectTimeline() {
  if (busy.value || !editable.value) return;
  const selectedDay = day.value,
    token = generation,
    collectToken = ++collectGeneration,
    jobs = [...(timeline.value?.jobs || [])];
  const valid = () => current(selectedDay, token) && collectToken === collectGeneration;
  if (!jobs.length) return;
  collecting.value = true;
  let next = 0,
    done = 0,
    failed = 0;
  const update = () => {
    progress.value = `正在补齐 ${selectedDay}：${done} / ${jobs.length} 只${failed ? ` · ${failed} 只未取得完整分时` : ''}`;
  };
  update();
  await Promise.all(
    Array.from({ length: Math.min(3, jobs.length) }, async (_, worker) => {
      while (valid() && next < jobs.length) {
        const job = jobs[next++];
        if (!job) break;
        try {
          const data = await tracked<MinuteDetail>(
            '/api/intraday/collect',
            `timeline-collect-${worker}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ date: selectedDay, code: job.code, force: job.force }),
            },
          );
          if (!valid()) return;
          if (!data?.points.length || data.status !== 'ok') failed++;
          if (data) {
            record(data);
            if (code.value === data.stock.code && acceptsRefresh(detail.value, data))
              detail.value = data;
            const entry = comparisons.get(data.stock.code);
            if (entry && acceptsRefresh(entry.data, data)) entry.data = data;
          }
        } catch {
          if (!valid()) return;
          failed++;
        }
        done++;
        update();
      }
    }),
  );
  if (!valid()) return;
  collecting.value = false;
  progress.value = `当日分时处理完成：${done} 只${failed ? ` · ${failed} 只未取得完整分时` : ''}，股票节点已更新。`;
  await loadTimeline();
}
async function refreshLive() {
  const live = workspace.meta.value?.live,
    selectedDay = day.value,
    token = generation;
  if (
    !active ||
    document.hidden ||
    overviewLoading.value ||
    stockLoading.value ||
    busy.value ||
    !live?.enabled ||
    selectedDay !== live.today
  )
    return;
  const key = `${selectedDay}|${workspace.route.value.timelineGEM}`;
  if (key === liveKey && Date.now() - liveChecked < 60000) return;
  liveKey = key;
  liveChecked = Date.now();
  liveRefreshing.value = true;
  const excludeGEM = workspace.route.value.timelineGEM,
    timelineEnabled = editable.value && live.polling === true;
  const valid = () =>
    current(selectedDay, token) &&
    !document.hidden &&
    excludeGEM === workspace.route.value.timelineGEM;
  try {
    const data = await tracked<MinuteOverview>(
      query('/api/intraday', { date: selectedDay }),
      'minute-live-overview',
    );
    if (!data || !valid()) return;
    overview.value = data;
    if (timelineEnabled) await loadTimeline();
    if (!valid()) return;
    const primary = code.value,
      stockToken = stockGeneration,
      poolCodes = new Set(timelineEnabled ? timeline.value?.pool.map((stock) => stock.code) : []);
    const codes = [...new Set([primary, ...compareCodes.value, ...poolCodes])].filter(Boolean);
    let next = 0,
      done = 0,
      failed = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, codes.length) }, async () => {
        while (valid() && next < codes.length) {
          const value = codes[next++];
          if (!value) break;
          const selected = () =>
            valid() &&
            (value === code.value || compareCodes.value.includes(value) || poolCodes.has(value));
          try {
            const minute = await minuteData(selectedDay, value, `minute-live-${value}`, selected);
            if (minute && selected()) {
              const entry = comparisons.get(value),
                existing = value === primary ? detail.value : entry?.data;
              if (!minute.points.length || minute.refresh_error) failed++;
              if (acceptsRefresh(existing, minute)) {
                record(minute);
                if (value === primary && code.value === primary && stockToken === stockGeneration)
                  detail.value = minute;
                if (entry) entry.data = minute;
              }
            }
          } catch {
            if (valid()) failed++;
          }
          done++;
          if (valid() && timelineEnabled)
            progress.value = `盘中自动获取 ${done} / ${codes.length} 只${failed ? ` · ${failed} 只暂未更新，下分钟重试` : ''}`;
        }
      }),
    );
    if (valid() && timelineEnabled) await loadTimeline();
  } catch (cause) {
    if (valid()) timelineError.value = errorMessage(cause);
  } finally {
    if (token === generation) liveRefreshing.value = false;
  }
}
function navigateDate(direction: 'previous' | 'next' | 'latest') {
  const target =
    direction === 'latest'
      ? dates.value.at(-1)
      : direction === 'previous'
        ? [...dates.value].reverse().find((value) => value < day.value)
        : dates.value.find((value) => value > day.value);
  if (target) workspace.patchRoute({ date: target });
}
function changeDate() {
  if (dates.value.includes(dateInput.value)) workspace.patchRoute({ date: dateInput.value });
  else {
    error.value = '请选择项目已知交易日，周末和休市日没有分时数据';
    dateInput.value = day.value;
  }
}
function disabledDate(value: Date) {
  const candidate = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return !dates.value.includes(candidate);
}
function changeScope(exclude: boolean) {
  workspace.patchRoute({ timelineGEM: !exclude });
}
function changeSensitivity(value: number) {
  multiple.value = value;
  void loadTimeline();
}
function openEvent(event: TimelineEvent) {
  pendingPoint = { date: day.value, code: event.code, slot: chartSlot(event.time) };
  selectStock(event.code);
}
function catalogKey(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !rows.value.length) return;
  event.preventDefault();
  const index = rows.value.findIndex((row) => row.code === code.value);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.value.length - 1
        : Math.max(
            0,
            Math.min(rows.value.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
          );
  listLimit.value = Math.max(listLimit.value, next + 1);
  const row = rows.value[next];
  if (row) selectStock(row.code);
}
watch(
  day,
  (value) => {
    dateInput.value = value;
    if (overviewLoading.value && (overview.value?.date || '') === value) return;
    void loadOverview();
  },
  { immediate: true },
);
watch(code, (value) => {
  if (!overviewLoading.value) void loadStock(value);
});
watch(
  () => compareCodes.value.join(','),
  () => {
    if (!overviewLoading.value) void syncComparisons();
  },
);
watch(
  () => workspace.route.value.timelineGEM,
  () => {
    if (!overviewLoading.value) void loadTimeline();
  },
);
watch(workspace.revision, () => {
  void loadOverview();
});
watch(search, () => {
  listLimit.value = 150;
});
watch(compareSearch, () => {
  compareLimit.value = 150;
});
onMounted(() => {
  liveTimer = setInterval(() => {
    void refreshLive();
  }, 15000);
});
onBeforeUnmount(() => {
  active = false;
  generation++;
  stockGeneration++;
  timelineGeneration++;
  stopCollection(false);
  if (liveTimer) clearInterval(liveTimer);
  for (const channel of channels) abort(channel);
});
</script>

<template>
  <div class="stack intraday-view">
    <section class="panel stack page-controls">
      <div class="panel-header">
        <div class="toolbar">
          <el-button
            :icon="ArrowLeft"
            :disabled="!dates.some((value) => value < day)"
            aria-label="上一交易日"
            @click="navigateDate('previous')"
          /><el-date-picker
            v-model="dateInput"
            type="date"
            value-format="YYYY-MM-DD"
            format="YYYY-MM-DD"
            :clearable="false"
            :disabled-date="disabledDate"
            @change="changeDate"
          /><el-button
            :icon="ArrowRight"
            :disabled="!dates.some((value) => value > day)"
            aria-label="下一交易日"
            @click="navigateDate('next')"
          /><el-button :disabled="!dates.length" @click="navigateDate('latest')">最新日期</el-button
          ><el-button :loading="overviewLoading" @click="loadOverview">刷新数据</el-button>
        </div>
      </div>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
    </section>
    <div class="minute-workspace">
      <aside class="panel catalog stack" aria-label="分时股票目录">
        <div class="panel-header">
          <h2>股票目录</h2>
          <span class="muted">{{ rows.length }} / {{ overview?.total || 0 }}</span>
        </div>
        <el-input
          v-model="search"
          clearable
          placeholder="名称 / 代码 / 首字母"
          aria-label="搜索分时股票"
        />
        <el-scrollbar height="580px"
          ><div class="catalog-list" @keydown="catalogKey">
            <el-button
              v-for="stock in visibleRows"
              :key="stock.code"
              class="catalog-row"
              :type="stock.code === code ? 'primary' : 'default'"
              :plain="stock.code === code"
              :aria-pressed="stock.code === code"
              @click="selectStock(stock.code)"
              ><span
                >{{ stock.name }} <small class="mono">{{ stock.code }}</small></span
              ><span
                ><b>{{ stock.boards ? `${stock.boards} 板` : '主板' }}</b
                ><small>{{
                  stock.status === 'ok'
                    ? '已采集'
                    : stock.status === 'partial'
                      ? '部分数据'
                      : '按需采集'
                }}</small></span
              ></el-button
            ><el-button v-if="rows.length > listLimit" @click="listLimit += 150"
              >显示更多（剩余 {{ rows.length - listLimit }} 只）</el-button
            ><el-empty v-if="!rows.length && !overviewLoading" description="没有匹配的股票" /></div
        ></el-scrollbar>
      </aside>
      <section class="panel stack chart-workbench" :aria-busy="stockLoading">
        <template v-if="detail">
          <div class="panel-header">
            <div>
              <h2>
                {{ detail.stock.name }} <small class="mono">{{ detail.stock.code }}</small
                ><el-tag v-if="detail.stock.boards">{{ detail.stock.boards }} 板</el-tag
                ><el-tag v-if="detail.stock.blacklisted" type="danger">黑名单</el-tag>
              </h2>
              <p class="muted">
                {{ detail.date }} · 不复权{{ detail.provisional ? ' · 盘中暂定' : ''
                }}<span v-if="detail.stock.first_time"> · 首封 {{ detail.stock.first_time }}</span>
                · {{ detail.stock.initials }}
                {{
                  detail.stock.registered_province ||
                  detail.stock.registration_province ||
                  detail.stock.province ||
                  detail.stock.region
                }}
              </p>
            </div>
            <div class="toolbar">
              <el-button
                :disabled="stockLoading"
                @click="workspace.openStock(detail.stock.code, detail.stock.name)"
                >历史档案</el-button
              ><StockActions :stock="detail.stock" compact />
            </div>
          </div>
          <div class="stock-tags">
            <el-tag
              v-for="tag in visibleTags(detail.stock, workspace.meta.value?.tag_hierarchy)"
              :key="tag"
              type="info"
              size="small"
              >{{ tag }}</el-tag
            ><span v-if="detail.stock.note" class="muted">{{ detail.stock.note }}</span>
            <el-checkbox v-model="showAverage" :disabled="stockLoading" class="average-toggle"
              >显示主图均价</el-checkbox
            >
            <el-tag v-if="stockLoading">读取中…</el-tag>
          </div>
          <FinancialChart
            v-if="detail.points.length"
            :details="chartDetails"
            :average="showAverage"
            :shared-volume="true"
            :selected-slot="pointSlot"
            :reset-key="`${day}-${code}`"
            @select="pointSlot = $event"
          />
          <el-empty v-else :description="detail.note || '该日暂无可用分时'" />
          <template v-if="detail.points.length">
            <div class="minute-scrubber">
              <span class="mono">{{ chartClock(pointSlot) }}</span
              ><el-slider
                v-model="pointSlot"
                :min="0"
                :max="242"
                :step="1"
                :format-tooltip="chartClock"
                aria-label="逐分钟查看（首点为09:25竞价）"
              />
            </div>
            <el-table :data="readings" size="small"
              ><el-table-column prop="name" label="分钟读数" min-width="110" /><el-table-column
                label="价格"
                ><template #default="{ row }">{{
                  row.price == null ? '该分钟缺失' : number(row.price, 2)
                }}</template></el-table-column
              ><el-table-column label="涨幅"
                ><template #default="{ row }"
                  ><span :class="row.pct >= 0 ? 'positive' : 'negative'">{{
                    row.pct == null ? '—' : `${number(row.pct, 2)}%`
                  }}</span></template
                ></el-table-column
              ><el-table-column label="与主图差 / 百分点"
                ><template #default="{ row }">{{
                  row.difference == null ? '—' : number(row.difference, 2)
                }}</template></el-table-column
              ><el-table-column label="均价"
                ><template #default="{ row }">{{
                  row.average == null ? '—' : number(row.average, 2)
                }}</template></el-table-column
              ><el-table-column label="成交量 / 手"
                ><template #default="{ row }">{{
                  row.volume == null ? '—' : number(row.volume)
                }}</template></el-table-column
              ><el-table-column label="成交额 / 元"
                ><template #default="{ row }">{{
                  row.amount == null ? '—' : number(row.amount)
                }}</template></el-table-column
              ></el-table
            >
          </template>
          <p class="muted" :title="detail.reference_basis">
            昨收 {{ detail.previous_close ? number(detail.previous_close, 2) : '—' }}
          </p>
          <p class="muted">
            {{ detail.source || ''
            }}<span v-if="detail.fetched_at">
              · 更新于 {{ detail.fetched_at.slice(0, 19).replace('T', ' ') }}</span
            ><span v-if="detail.refresh_error"> · 更新失败：{{ detail.refresh_error }}</span>
          </p>
          <p v-if="detail.auction?.note" class="muted">
            竞价：{{ detail.auction.note }}（{{ detail.auction.status }}）
          </p> </template
        ><el-empty
          v-else
          :description="overviewLoading || stockLoading ? '正在读取分时…' : '暂无可查看的数据'"
        />
      </section>
      <aside class="panel stack comparisons">
        <div class="panel-header">
          <h2>叠加对比 {{ compareCodes.length }}</h2>
          <el-button link :disabled="!compareCodes.length" @click="setCompareCodes([])"
            >清空</el-button
          >
        </div>
        <el-input
          v-model="compareSearch"
          clearable
          placeholder="名称 / 代码 / 首字母"
          aria-label="搜索对比股票"
        /><el-scrollbar height="580px"
          ><div class="compare-list">
            <div v-for="stock in visibleCompareRows" :key="stock.code" class="compare-row">
              <el-checkbox
                :model-value="compareCodes.includes(stock.code)"
                :disabled="stock.code === code"
                @change="(value) => toggleComparison(stock.code, value === true)"
                >{{ stock.name }} <small class="mono">{{ stock.code }}</small></el-checkbox
              ><small class="muted">{{
                stock.code === code
                  ? '主图'
                  : comparisons.get(stock.code)?.loading
                    ? '读取中'
                    : comparisons.get(stock.code)?.error
                      ? '读取失败，请重选'
                      : comparisons.get(stock.code)?.data?.status === 'partial'
                        ? '部分数据'
                        : comparisons.get(stock.code)?.data?.points.length
                          ? '已叠加'
                          : compareCodes.includes(stock.code)
                            ? '暂无分时'
                            : ''
              }}</small>
            </div>
            <el-button v-if="compareRows.length > compareLimit" @click="compareLimit += 150"
              >显示更多</el-button
            >
          </div></el-scrollbar
        >
      </aside>
    </div>
    <p v-if="liveLabel" class="muted" role="status">{{ liveLabel }}</p>
    <el-alert
      v-if="timelineError"
      :title="`节点读取失败：${timelineError}`"
      type="error"
      :closable="false"
    />
    <TimelinePanel
      v-if="timeline"
      :data="timeline"
      :busy="busy"
      :editable="editable"
      :progress="progress"
      @refresh="loadTimeline(true)"
      @collect="collectTimeline"
      @stop="stopCollection()"
      @scope="changeScope"
      @sensitivity="changeSensitivity"
      @open="openEvent"
    />
    <el-empty v-else :description="timelineLoading ? '正在读取当日股票节点…' : '时间轴暂无数据'" />
  </div>
</template>

<style scoped>
h2 {
  font-size: 18px;
  margin: 0;
}
h2 .el-tag {
  margin-left: 8px;
}
p {
  margin: 0;
}
.minute-workspace {
  display: grid;
  grid-template-columns: 230px minmax(420px, 1fr) 230px;
  gap: 24px;
  align-items: start;
}
.catalog-list,
.compare-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 8px;
}
.catalog-row {
  height: auto;
  min-height: 54px;
  margin: 0;
  width: 100%;
  padding: 8px;
  text-align: left;
}
.catalog-row :deep(span) {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.catalog-row :deep(span > span) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}
.catalog-row :deep(span > span:last-child) {
  align-items: flex-end;
  max-width: 90px;
}
.catalog-row small {
  font-size: 13px;
}
.compare-row {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-height: 48px;
  border-bottom: 1px solid var(--la-divider);
}
.compare-row :deep(.el-checkbox) {
  height: 28px;
}
.compare-row small {
  font-size: 13px;
}
.minute-scrubber {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 12px;
}
.minute-scrubber .el-slider {
  flex: 1;
}
.chart-workbench {
  min-width: 0;
}
.stock-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.average-toggle {
  margin-left: auto;
}
.page-controls .toolbar {
  margin-left: auto;
  gap: 8px;
}
.toolbar :deep(.el-date-editor) {
  width: 152px;
}
.page-controls {
  padding-bottom: 16px;
}
@media (max-width: 1400px) {
  .minute-workspace {
    grid-template-columns: 200px minmax(400px, 1fr);
  }
  .comparisons {
    grid-column: 1/-1;
  }
  .comparisons :deep(.el-scrollbar__wrap) {
    max-height: 220px;
  }
  .compare-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
}
@media (max-width: 900px) {
  .minute-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .catalog :deep(.el-scrollbar__wrap) {
    max-height: 240px;
  }
  .comparisons {
    grid-column: auto;
  }
  .catalog-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
}
</style>
