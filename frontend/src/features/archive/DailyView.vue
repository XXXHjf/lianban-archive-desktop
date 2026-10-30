<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowLeft, ArrowRight, Filter, Refresh, MoreFilled, Close } from '@element-plus/icons-vue';
import { abort, query, request } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage } from '@/shared/format';
import ArchiveCard from './ArchiveCard.vue';
import DailyStockRow from './DailyStockRow.vue';
import DailyCyclePreview from './DailyCyclePreview.vue';
import DailyMatrix from './DailyMatrix.vue';
import { dailyGroups, hierarchy } from './helpers';
import { groupIdentity, isArchiveDate, ladderBands } from './dailyPresentation';
import type { DailyData, Stock } from './models';
const emit = defineEmits<{ explain: [] }>();
const workspace = useWorkspace(),
  route = workspace.route;
const data = ref<DailyData | null>(null),
  loading = ref(false),
  error = ref('');
const filtersOpen = ref(false),
  matrixOpen = ref(false),
  previewOpen = ref(false);
const wide = ref(window.innerWidth >= 1200),
  mobile = ref(window.innerWidth < 768);
const selectedStock = ref<Stock | null>(null);
let trigger: HTMLElement | null = null;
let pendingTool: { kind: 'note' | 'tags' | 'shareholders'; stock: Stock } | null = null;
const expandedBands = ref<number[]>([]),
  rowLimits = ref<Record<string, number>>({});
const dates = computed(
  () => workspace.meta.value?.query_dates || workspace.meta.value?.dates || [],
);
const calendarDate = computed(() =>
  isArchiveDate(workspace.date.value) ? workspace.date.value : '',
);
const previous = computed(() =>
  [...dates.value].reverse().find((day) => day < workspace.date.value),
);
const next = computed(() => dates.value.find((day) => day > workspace.date.value));
const tags = computed(() =>
  hierarchy(workspace.meta.value?.tag_hierarchy, workspace.meta.value?.tag_order),
);
const groups = computed(() =>
  dailyGroups(
    data.value?.rows || [],
    route.value.layout,
    data.value?.tag_board_counts || {},
    tags.value,
  ),
);
const bands = computed(() =>
  ladderBands(
    groups.value,
    route.value.layout,
    tags.value,
    !!data.value?.provisional,
    new Set(workspace.meta.value?.latest_limit_ups?.map((row) => row.code)),
    workspace.meta.value?.latest_date || '',
  ),
);
const filterCount = computed(() => Number(route.value.excludeST) + Number(route.value.excludeGEM));
const knownMode = computed(() => ['industry', 'region', 'pinyin'].includes(route.value.layout));
const boardOptions = computed(() => {
  const counts = [...(data.value?.board_counts || [])];
  if (route.value.boards && !counts.some((item) => String(item.boards) === route.value.boards))
    counts.push({ boards: Number(route.value.boards), count: 0 });
  return counts.sort((a, b) => a.boards - b.boards);
});
const uncertain = computed(
  () =>
    !!data.value &&
    (data.value.provisional ||
      !!data.value.live ||
      !['ok', 'provisional'].includes(data.value.data_status)),
);
const statusLabel = computed(() =>
  !data.value
    ? loading.value
      ? '正在读取'
      : error.value
        ? '读取失败'
        : '尚未取得档案'
    : data.value.provisional
      ? '盘中暂定'
      : data.value.live
        ? '来源待更新'
        : data.value.data_status === 'ok'
          ? '收盘归档'
          : '覆盖待核实',
);
const freshness = computed(() => {
  if (!data.value) return '';
  const live =
    workspace.meta.value?.live?.date === data.value.date
      ? workspace.meta.value.live
      : data.value.live;
  if (data.value.provisional)
    return `获取于 ${data.value.fetched_at?.slice(11, 19) || '时间待补充'} · 每分钟刷新 · 收盘后确认${live?.status === 'error' ? ' · 获取失败，保留上次数据并重试' : live?.status === 'waiting' ? ' · 来源待更新，保留上次数据并重试' : ''}`;
  return data.value.live
    ? '每分钟自动重试，缺失不等于没有涨停'
    : data.value.data_status === 'ok'
      ? '历史确认档案 · 分类资料以当前资料展示'
      : '来源覆盖未确认，请查看数据口径';
});
let generation = 0,
  lastQuery = '';
async function load() {
  const id = ++generation;
  if (!workspace.date.value) {
    abort('archive-date');
    data.value = null;
    loading.value = false;
    return;
  }
  if (!calendarDate.value) {
    abort('archive-date');
    data.value = null;
    selectedStock.value = null;
    previewOpen.value = false;
    loading.value = false;
    error.value = '日期无效，请重新选择有效的交易日期。';
    lastQuery = '';
    return;
  }
  const path = query('/api/date', {
    date: workspace.date.value,
    boards: route.value.boards,
    exclude_st: route.value.excludeST ? '1' : '0',
    exclude_gem: route.value.excludeGEM ? '1' : '0',
  });
  if (path !== lastQuery) {
    data.value = null;
    selectedStock.value = null;
    previewOpen.value = false;
    expandedBands.value = [];
    rowLimits.value = {};
  }
  lastQuery = path;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<DailyData>(path, 'archive-date');
    if (id === generation && result) {
      data.value = result;
      if (selectedStock.value) {
        selectedStock.value =
          [...result.rows, ...(result.suspended_rows || [])].find(
            (row) => row.code === selectedStock.value?.code,
          ) || null;
        if (!selectedStock.value) previewOpen.value = false;
      }
    }
  } catch (cause) {
    if (id === generation) error.value = errorMessage(cause);
  } finally {
    if (id === generation) loading.value = false;
  }
}
watch(
  () => [
    workspace.date.value,
    route.value.boards,
    route.value.excludeST,
    route.value.excludeGEM,
    workspace.revision.value,
    workspace.meta.value?.archive_updated_at,
    workspace.meta.value?.live?.fetched_at,
    workspace.meta.value?.suspension_revision,
  ],
  load,
  { immediate: true },
);
watch(
  () => route.value.layout,
  () => {
    expandedBands.value = [];
    rowLimits.value = {};
  },
);
const interval = window.setInterval(() => {
  if (
    data.value?.provisional ||
    data.value?.live ||
    ['unknown', 'updating'].includes(data.value?.suspension_status || '')
  )
    void load();
}, 60000);
function resize() {
  wide.value = window.innerWidth >= 1200;
  mobile.value = window.innerWidth < 768;
}
onMounted(() => window.addEventListener('resize', resize));
onBeforeUnmount(() => {
  generation++;
  abort('archive-date');
  window.clearInterval(interval);
  window.removeEventListener('resize', resize);
});
function select(stock: Stock, element: HTMLElement) {
  selectedStock.value = stock;
  trigger = element;
  previewOpen.value = true;
}
async function restoreFocus() {
  if (pendingTool) {
    const target = pendingTool;
    pendingTool = null;
    workspace.openEditor(target.kind, target.stock);
    return;
  }
  await nextTick();
  if (trigger?.isConnected) trigger.focus();
}
function openTool(kind: 'note' | 'tags' | 'shareholders', stock: Stock) {
  if (wide.value) workspace.openEditor(kind, stock);
  else {
    pendingTool = { kind, stock };
    previewOpen.value = false;
  }
}
function more(command: string) {
  if (command === 'code') workspace.patchRoute({ layout: 'code' });
  else if (command === 'matrix') matrixOpen.value = true;
  else emit('explain');
}
function path(label: string) {
  return [...tags.value.ancestors(label)].reverse().concat(label).join(' / ');
}
function limit(height: number, root: string[], sub: string[]) {
  return rowLimits.value[JSON.stringify([height, root, sub])] || 12;
}
function showRows(height: number, root: string[], sub: string[], count: number) {
  rowLimits.value[JSON.stringify([height, root, sub])] = count;
}
function clearFilters() {
  workspace.patchRoute({ excludeST: false, excludeGEM: false, boards: '' });
}
</script>
<template>
  <div class="daily-workspace">
    <header class="daily-task-header">
      <div class="daily-title-row">
        <div class="daily-title">
          <p class="daily-eyebrow">从市场高度，进入个股周期</p>
          <h1>当日梯队</h1>
        </div>
        <div class="daily-date-controls">
          <el-button
            :icon="ArrowLeft"
            :disabled="!previous"
            aria-label="上一个有数据的交易日"
            @click="previous && workspace.openDate(previous)"
          /><el-date-picker
            :model-value="calendarDate"
            placeholder="重新选择日期"
            value-format="YYYY-MM-DD"
            type="date"
            aria-label="查询交易日期"
            :clearable="false"
            @update:model-value="(value: string) => workspace.openDate(value)"
          /><el-button
            :icon="ArrowRight"
            :disabled="!next"
            aria-label="下一个有数据的交易日"
            @click="next && workspace.openDate(next)"
          /><el-button
            :disabled="!dates.length || workspace.date.value === dates.at(-1)"
            @click="workspace.openDate(dates.at(-1) || '')"
            >最新日期</el-button
          >
        </div>
      </div>
      <div class="daily-status-line" role="status">
        <strong>{{ workspace.date.value || '选择交易日' }}</strong
        ><span class="daily-badge" :class="{ warning: uncertain }">{{ statusLabel }}</span
        ><span class="daily-meta">{{ freshness }}</span
        ><el-button link @click="emit('explain')">来源口径</el-button>
      </div>
      <p v-if="route.boards || filterCount" class="daily-meta">
        统计范围：{{ route.boards ? `精确${route.boards}板` : '全部板数'
        }}{{ route.excludeST ? ' · 剔除ST' : '' }}{{ route.excludeGEM ? ' · 剔除创业板' : '' }}
      </p>
      <dl class="daily-stats" aria-label="当前筛选统计">
        <div>
          <dt>涨停</dt>
          <dd>{{ data?.stats.total ?? '—' }}<small>只</small></dd>
        </div>
        <div>
          <dt>连板</dt>
          <dd>{{ data?.stats.consecutive ?? '—' }}<small>只</small></dd>
        </div>
        <div>
          <dt>最高</dt>
          <dd>{{ data?.stats.max_boards ?? '—' }}<small>板</small></dd>
        </div>
        <div>
          <dt>首板</dt>
          <dd>{{ data?.stats.first_boards ?? '—' }}<small>只</small></dd>
        </div>
      </dl>
      <p v-if="data?.suspended_rows?.length" class="daily-meta">
        最高含停牌保留高度 · 当日交易最高 {{ data.trading_max_boards }} 板 · 停牌未计入涨停家数
      </p>
      <p
        v-else-if="data && ['unknown', 'updating', 'error'].includes(data.suspension_status || '')"
        class="daily-meta"
      >
        停牌资料待核实，当前筛选最高高度仅供参考。
      </p>
    </header>
    <div class="daily-main-layout">
      <div class="daily-primary-column">
        <div class="daily-control-bar">
          <div class="daily-group-switch" role="group" aria-label="切换分组">
            <el-button
              v-for="mode in [
                { value: 'industry', label: '行业 / 标签' },
                { value: 'region', label: '地区' },
                { value: 'pinyin', label: '拼音' },
              ]"
              :key="mode.value"
              :type="route.layout === mode.value ? 'primary' : 'default'"
              :plain="route.layout === mode.value"
              :aria-pressed="route.layout === mode.value"
              @click="workspace.patchRoute({ layout: mode.value })"
              >{{ mode.label }}</el-button
            ><el-dropdown trigger="click" @command="more"
              ><el-button
                :icon="MoreFilled"
                :type="knownMode ? 'default' : 'primary'"
                :plain="!knownMode"
                >{{ knownMode ? '更多' : '代码分组' }}</el-button
              ><template #dropdown
                ><el-dropdown-menu
                  ><el-dropdown-item command="code">代码连续匹配分组</el-dropdown-item
                  ><el-dropdown-item command="matrix" :disabled="!data || !data.rows.length"
                    >完整分组对照</el-dropdown-item
                  ><el-dropdown-item command="explain"
                    >数据与统计说明</el-dropdown-item
                  ></el-dropdown-menu
                ></template
              ></el-dropdown
            >
          </div>
          <div class="daily-control-actions">
            <el-button
              :icon="Filter"
              :aria-expanded="filtersOpen"
              @click="filtersOpen = !filtersOpen"
              >筛选{{ filterCount ? ` ${filterCount}项` : '' }}</el-button
            ><el-button :icon="Refresh" :loading="loading" aria-label="刷新当日档案" @click="load"
              >刷新</el-button
            >
          </div>
        </div>
        <div v-if="filtersOpen" class="daily-filter-panel">
          <div class="daily-filter-checks">
            <el-checkbox
              :model-value="route.excludeST"
              @update:model-value="(value) => workspace.patchRoute({ excludeST: !!value })"
              >剔除 ST</el-checkbox
            ><el-checkbox
              :model-value="route.excludeGEM"
              @update:model-value="(value) => workspace.patchRoute({ excludeGEM: !!value })"
              >剔除创业板</el-checkbox
            ><el-button link @click="clearFilters">清除筛选与板数</el-button>
          </div>
          <p class="daily-meta">更改条件立即查询；统计随当前筛选变化，日期与分组保持不变。</p>
        </div>
        <div class="daily-board-bar" role="group" aria-label="按精确板数筛选">
          <button
            :aria-pressed="!route.boards"
            :class="{ active: !route.boards }"
            @click="workspace.patchRoute({ boards: '' })"
          >
            全部 <span>{{ data?.available_total ?? '—' }}</span></button
          ><button
            v-for="option in boardOptions"
            :key="option.boards"
            :aria-pressed="route.boards === String(option.boards)"
            :class="{ active: route.boards === String(option.boards) }"
            @click="workspace.patchRoute({ boards: String(option.boards) })"
          >
            {{ option.boards === 1 ? '首板' : `${option.boards}板` }}
            <span>{{ option.count }}</span></button
          ><span v-if="filterCount" class="daily-filter-summary"
            >已剔除
            {{
              [route.excludeST ? 'ST' : '', route.excludeGEM ? '创业板' : '']
                .filter(Boolean)
                .join('、')
            }}</span
          >
        </div>
        <div v-if="error" class="daily-state error" role="alert">
          <h2>当日档案读取失败</h2>
          <p>{{ error }}</p>
          <p v-if="data">仍展示 {{ data.date }} 的上次可用结果。</p>
          <el-button @click="load">重试当日档案</el-button>
        </div>
        <div v-if="data && uncertain" class="daily-state warning" role="status">
          <strong>{{ statusLabel }} · 请留意数据范围</strong>
          <p>{{ data.coverage_note }}</p>
        </div>
        <details v-if="data?.suspended_rows?.length" class="daily-suspensions">
          <summary>
            停牌保留高度 · {{ data.suspended_rows.length }}只 <span>不计入当日涨停家数</span>
          </summary>
          <div class="daily-suspended-grid">
            <ArchiveCard
              v-for="stock in data.suspended_rows"
              :key="stock.code"
              :stock="stock"
              :highlight="!data.provisional"
            />
          </div>
        </details>
        <section class="daily-ladder" aria-label="当日梯队股票" :aria-busy="loading">
          <div class="daily-results-caption">
            <span
              >{{ groups.length }}个分组 ·
              {{ data ? new Set(data.rows.map((row) => row.code)).size : '—' }}只股票（去重）</span
            ><span
              >{{
                route.layout === 'pinyin'
                  ? '4→1个连续字母匹配'
                  : route.layout === 'code'
                    ? '6→1位连续数字匹配'
                    : '按高度从高到低'
              }}
              · 跨组归属保留</span
            >
          </div>
          <div v-if="loading && !data" class="daily-loading" role="status">
            <el-skeleton :rows="8" />
            <p>正在读取 {{ workspace.date.value }} 的梯队…</p>
          </div>
          <div v-else-if="!bands.length && !error" class="daily-state daily-empty">
            <h2>
              {{
                route.boards || filterCount
                  ? '当前条件下没有匹配记录'
                  : workspace.date.value
                    ? '这个日期暂无已收录记录'
                    : '先选择一个交易日'
              }}
            </h2>
            <p>无记录不等于当天没有涨停。可调整筛选、切换日期或查看来源覆盖。</p>
            <el-button v-if="route.boards || filterCount" @click="clearFilters"
              >查看全部记录</el-button
            ><el-button
              v-else
              :disabled="!dates.length"
              @click="workspace.openDate(dates.at(-1) || '')"
              >返回最新收录日</el-button
            >
          </div>
          <section
            v-for="band in bands"
            :key="band.height"
            class="ladder-band"
            :aria-label="`${band.height}板梯队`"
          >
            <header class="ladder-height">
              <h2>
                {{ band.height === 1 ? '首板' : band.height
                }}<small v-if="band.height !== 1">板</small>
              </h2>
              <span>{{ band.count }}只</span>
            </header>
            <div class="ladder-band-groups">
              <section
                v-for="group in expandedBands.includes(band.height)
                  ? band.groups
                  : band.groups.slice(0, 6)"
                :key="groupIdentity(group.labels)"
                class="ladder-group"
              >
                <header class="ladder-group-heading">
                  <h3>{{ group.labels.join(' / ') }}</h3>
                  <el-dropdown
                    v-if="
                      route.layout === 'industry' &&
                      group.labels[0] !== '独苗' &&
                      workspace.meta.value?.capabilities?.manage_tags !== false
                    "
                    trigger="click"
                    @command="(tag: string) => workspace.patchRoute({ view: 'tags', tag })"
                    ><el-button
                      text
                      :icon="MoreFilled"
                      :aria-label="`管理${group.labels.join('/')}标签`"
                    /><template #dropdown
                      ><el-dropdown-menu
                        ><el-dropdown-item
                          v-for="label in group.labels"
                          :key="label"
                          :command="label"
                          >管理标签：{{ label }}</el-dropdown-item
                        ></el-dropdown-menu
                      ></template
                    ></el-dropdown
                  >
                </header>
                <div v-for="sub in group.sections" :key="groupIdentity(sub.labels)">
                  <div
                    v-if="sub.labels.length && sub.labels[0] !== group.labels[0]"
                    class="ladder-subheading"
                  >
                    <span>{{ sub.labels.map(path).join(' / ') }}</span
                    ><el-dropdown
                      v-if="workspace.meta.value?.capabilities?.manage_tags !== false"
                      trigger="click"
                      @command="(tag: string) => workspace.patchRoute({ view: 'tags', tag })"
                      ><el-button
                        text
                        :icon="MoreFilled"
                        :aria-label="`管理${sub.labels.join('/')}子标签`"
                      /><template #dropdown
                        ><el-dropdown-menu
                          ><el-dropdown-item
                            v-for="label in sub.labels"
                            :key="label"
                            :command="label"
                            >管理子标签：{{ label }}</el-dropdown-item
                          ></el-dropdown-menu
                        ></template
                      ></el-dropdown
                    >
                  </div>
                  <DailyStockRow
                    v-for="stock in sub.stocks.slice(
                      0,
                      limit(band.height, group.labels, sub.labels),
                    )"
                    :key="stock.code"
                    :stock="stock"
                    :active="selectedStock?.code === stock.code"
                    :highlight="!data?.provisional"
                    @preview="select"
                  /><el-button
                    v-if="sub.stocks.length > limit(band.height, group.labels, sub.labels)"
                    link
                    class="daily-show-more"
                    @click="showRows(band.height, group.labels, sub.labels, sub.stocks.length)"
                    >查看本组全部{{ sub.stocks.length }}只</el-button
                  >
                </div>
              </section>
              <el-button
                v-if="band.groups.length > 6 && !expandedBands.includes(band.height)"
                class="daily-show-more"
                @click="expandedBands.push(band.height)"
                >展开{{ band.height === 1 ? '首板' : `${band.height}板` }}全部{{
                  band.groups.length
                }}个分组</el-button
              >
            </div>
          </section>
          <details v-if="data" class="daily-details daily-source">
            <summary>来源与数据口径</summary>
            <p>{{ data.coverage_note }}</p>
            <p>分组可重复归属，统计按股票去重。仅供查询与复盘，不构成投资建议。</p>
          </details>
        </section>
      </div>
      <aside v-if="wide" class="daily-cycle-preview" aria-label="个股周期预览">
        <DailyCyclePreview :stock="selectedStock" :day="workspace.date.value" @tool="openTool" />
      </aside>
    </div>
    <el-drawer
      v-if="!wide"
      v-model="previewOpen"
      :direction="mobile ? 'btt' : 'rtl'"
      :size="mobile ? '78%' : 'min(400px, 100vw)'"
      title="个股周期预览"
      class="daily-preview-drawer daily-overlay"
      :with-header="true"
      @closed="restoreFocus"
      ><DailyCyclePreview
        v-if="previewOpen"
        :stock="selectedStock"
        :day="workspace.date.value"
        @tool="openTool"
    /></el-drawer>
    <el-dialog
      v-model="matrixOpen"
      title="完整分组对照"
      width="min(1360px, 96vw)"
      class="daily-overlay"
      :close-on-click-modal="false"
      ><DailyMatrix v-if="data && matrixOpen" :data="data" :groups="groups" /><template #footer
        ><el-button :icon="Close" @click="matrixOpen = false">关闭对照</el-button></template
      ></el-dialog
    >
  </div>
</template>
