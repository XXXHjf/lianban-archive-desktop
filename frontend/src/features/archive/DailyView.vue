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
import LadderNodes from './LadderNodes.vue';
import { dailyGroups, hierarchy } from './helpers';
import {
  dailyScope,
  dailyTopics,
  groupIdentity,
  isArchiveDate,
  ladderBands,
  topicPath,
} from './dailyPresentation';
import type { DailyData, Stock } from './models';
const emit = defineEmits<{ explain: [] }>();
const nodePanel = ref<InstanceType<typeof LadderNodes> | null>(null);
const workspace = useWorkspace(),
  route = workspace.route;
const archive = ref<DailyData | null>(null),
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
  expandedMatches = ref(false),
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
const industryMode = computed(() => route.value.layout === 'industry');
const matchingMode = computed(() => ['pinyin', 'code'].includes(route.value.layout));
const groupFirstMode = computed(() => matchingMode.value || route.value.layout === 'region');
// The topic controls are temporarily hidden; ignore saved topic filters until restored.
const topicFilterVisible = false;
const activeTopic = computed(() =>
  topicFilterVisible && industryMode.value ? route.value.dailyTag : '',
);
const topics = computed(() => dailyTopics(archive.value?.rows || [], tags.value));
const quickTopics = computed(() =>
  topics.value.filter((topic) => topic.root === topic.label).slice(0, 4),
);
const data = computed(() =>
  archive.value
    ? dailyScope(archive.value, activeTopic.value, route.value.boards, tags.value)
    : null,
);
const groups = computed(() =>
  dailyGroups(
    data.value?.rows || [],
    route.value.layout,
    data.value?.tag_board_counts || {},
    tags.value,
  ),
);
const visibleStocks = computed(() =>
  matchingMode.value ? groups.value.flatMap((group) => group.stocks) : data.value?.rows || [],
);
const bands = computed(() =>
  ladderBands(
    industryMode.value ? [{ labels: [], stocks: data.value?.rows || [] }] : groups.value,
    route.value.layout,
    tags.value,
    !!data.value?.provisional,
    new Set(workspace.meta.value?.latest_limit_ups?.map((row) => row.code)),
    workspace.meta.value?.latest_date || '',
  ),
);
const filterCount = computed(() => Number(route.value.excludeGEM));
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
          ? ''
          : '数据缺失',
);
const freshness = computed(() => {
  if (!data.value) return '';
  const live =
    workspace.meta.value?.live?.date === data.value.date
      ? workspace.meta.value.live
      : data.value.live;
  if (!data.value.provisional && !data.value.live) return '';
  const time = data.value.fetched_at?.slice(11, 19);
  return [
    time ? `更新于 ${time}` : '',
    live?.status === 'error' ? '更新失败' : live?.status === 'waiting' ? '等待更新' : '',
  ]
    .filter(Boolean)
    .join(' · ');
});
let generation = 0,
  lastQuery = '';
async function load() {
  const id = ++generation;
  if (!workspace.date.value) {
    abort('archive-date');
    archive.value = null;
    loading.value = false;
    return;
  }
  if (!calendarDate.value) {
    abort('archive-date');
    archive.value = null;
    selectedStock.value = null;
    previewOpen.value = false;
    loading.value = false;
    error.value = '日期无效，请重新选择有效的交易日期。';
    lastQuery = '';
    return;
  }
  const path = query('/api/date', {
    date: workspace.date.value,
    boards: '',
    exclude_st: '1',
    exclude_gem: route.value.excludeGEM ? '1' : '0',
  });
  if (path !== lastQuery) {
    archive.value = null;
    selectedStock.value = null;
    previewOpen.value = false;
    expandedBands.value = [];
    expandedMatches.value = false;
    rowLimits.value = {};
  }
  lastQuery = path;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<DailyData>(path, 'archive-date');
    if (id === generation && result) {
      archive.value = result;
      if (selectedStock.value) {
        selectedStock.value =
          [...visibleStocks.value, ...(data.value?.suspended_rows || [])].find(
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
  [
    () => workspace.date.value,
    () => route.value.excludeGEM,
    () => workspace.revision.value,
    () => workspace.meta.value?.archive_updated_at,
    () => workspace.meta.value?.node_updated_at,
    () => workspace.meta.value?.live?.fetched_at,
    () => workspace.meta.value?.suspension_revision,
  ],
  load,
  { immediate: true },
);
watch([() => route.value.layout, () => route.value.boards, () => route.value.dailyTag], () => {
  expandedBands.value = [];
  expandedMatches.value = false;
  rowLimits.value = {};
  if (
    selectedStock.value &&
    ![...visibleStocks.value, ...(data.value?.suspended_rows || [])].some(
      (stock) => stock.code === selectedStock.value?.code,
    )
  ) {
    selectedStock.value = null;
    previewOpen.value = false;
  }
});
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
  if (command === 'matrix') matrixOpen.value = true;
  else emit('explain');
}
function path(label: string) {
  return topicPath(label, tags.value);
}
function chooseTopic(label: string) {
  workspace.patchRoute({ layout: 'industry', dailyTag: label || '' });
}
function limit(height: number, root: string[], sub: string[]) {
  return rowLimits.value[JSON.stringify([height, root, sub])] || 12;
}
function showRows(height: number, root: string[], sub: string[], count: number) {
  rowLimits.value[JSON.stringify([height, root, sub])] = count;
}
function clearFilters() {
  workspace.patchRoute({ excludeST: false, excludeGEM: false, boards: '', dailyTag: '' });
}
</script>
<template>
  <div class="daily-workspace">
    <header class="daily-task-header">
      <div class="daily-title-row">
        <div class="daily-title">
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
        ><span v-if="statusLabel" class="daily-badge" :class="{ warning: uncertain }">{{
          statusLabel
        }}</span
        ><span v-if="freshness" class="daily-meta">{{ freshness }}</span>
      </div>
      <p v-if="route.boards || filterCount || activeTopic" class="daily-meta">
        统计范围：{{ route.boards ? `精确${route.boards}板` : '全部板数'
        }}{{ activeTopic ? ` · ${activeTopic}` : '' }}{{ route.excludeGEM ? ' · 剔除创业板' : '' }}
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
        当日最高 {{ data.trading_max_boards }} 板 · 停牌 {{ data.suspended_rows.length }}只
      </p>
      <p
        v-else-if="data && ['unknown', 'updating', 'error'].includes(data.suspension_status || '')"
        class="daily-meta"
      >
        {{ data.suspension_status === 'error' ? '停牌资料更新失败' : '停牌资料更新中' }}
      </p>
    </header>
    <div class="daily-main-layout">
      <div class="daily-primary-column">
        <div class="daily-control-bar">
          <div class="daily-group-switch" role="group" aria-label="切换分组">
            <el-button
              v-for="mode in [
                { value: 'industry', label: '连板梯队' },
                { value: 'region', label: '地区' },
                { value: 'pinyin', label: '拼音' },
                { value: 'code', label: '代码匹配' },
              ]"
              :key="mode.value"
              :type="route.layout === mode.value ? 'primary' : 'default'"
              :plain="route.layout === mode.value"
              :aria-pressed="route.layout === mode.value"
              @click="workspace.patchRoute({ layout: mode.value })"
              >{{ mode.label }}</el-button
            ><el-dropdown trigger="click" @command="more"
              ><el-button :icon="MoreFilled">更多</el-button
              ><template #dropdown
                ><el-dropdown-menu
                  ><el-dropdown-item command="matrix" :disabled="!data || !data.rows.length"
                    >完整分组对照</el-dropdown-item
                  ><el-dropdown-item command="explain">数据概况</el-dropdown-item></el-dropdown-menu
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
          ><span v-if="filterCount" class="daily-filter-summary">已剔除 创业板</span>
        </div>
        <div
          :hidden="!topicFilterVisible || !industryMode"
          class="daily-topic-filter"
          aria-label="行业与标签筛选"
        >
          <span class="daily-topic-label">行业 / 标签</span>
          <el-select
            :model-value="activeTopic"
            class="daily-topic-search"
            placeholder="搜索行业或标签"
            aria-label="搜索行业或标签"
            filterable
            clearable
            :disabled="loading && !data"
            no-data-text="当日暂无标签"
            no-match-text="没有匹配标签"
            @update:model-value="chooseTopic"
          >
            <el-option
              v-if="activeTopic && !topics.some((topic) => topic.label === activeTopic)"
              :label="activeTopic"
              :value="activeTopic"
            />
            <el-option
              v-for="topic in topics"
              :key="topic.label"
              :label="path(topic.label)"
              :value="topic.label"
            >
              <span>{{ path(topic.label) }}</span
              ><span class="daily-topic-count">{{ topic.count }}</span>
            </el-option>
          </el-select>
          <div class="daily-topic-pills" role="group" aria-label="常用行业与标签">
            <button
              :class="{ active: !activeTopic }"
              :aria-pressed="!activeTopic"
              :disabled="loading && !data"
              @click="chooseTopic('')"
            >
              全部
            </button>
            <button
              v-for="topic in quickTopics"
              :key="topic.label"
              :class="{ active: activeTopic === topic.label }"
              :aria-pressed="activeTopic === topic.label"
              :disabled="loading && !data"
              @click="chooseTopic(topic.label)"
            >
              {{ topic.label }}
            </button>
          </div>
          <el-dropdown
            v-if="activeTopic && workspace.meta.value?.capabilities?.manage_tags !== false"
            trigger="click"
            @command="workspace.patchRoute({ view: 'tags', tag: activeTopic })"
          >
            <el-button text :icon="MoreFilled" :aria-label="`管理${activeTopic}标签`" /><template
              #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item>管理标签：{{ activeTopic }}</el-dropdown-item></el-dropdown-menu
              ></template
            >
          </el-dropdown>
        </div>
        <div v-if="error" class="daily-state error" role="alert">
          <h2>当日档案读取失败</h2>
          <p>{{ error }}</p>
          <p v-if="data">仍展示 {{ data.date }} 的上次可用结果。</p>
          <el-button @click="load">重试当日档案</el-button>
        </div>
        <details v-if="data?.suspended_rows?.length" class="daily-suspensions">
          <summary>停牌保留高度 · {{ data.suspended_rows.length }}只</summary>
          <div class="daily-suspended-grid">
            <ArchiveCard
              v-for="stock in data.suspended_rows"
              :key="stock.code"
              :stock="stock"
              :highlight="!data.provisional"
            />
          </div>
        </details>
        <LadderNodes v-if="data" ref="nodePanel" :data="data" @changed="load" />
        <section class="daily-ladder" aria-label="当日梯队股票" :aria-busy="loading">
          <div v-if="loading && !data" class="daily-loading" role="status">
            <el-skeleton :rows="8" />
            <p>正在读取 {{ workspace.date.value }} 的梯队…</p>
          </div>
          <div
            v-else-if="!(groupFirstMode ? groups.length : bands.length) && !error"
            class="daily-state daily-empty"
          >
            <h2>
              {{
                matchingMode && data?.rows.length
                  ? '当前条件下没有符合要求的匹配分组'
                  : route.boards || filterCount || activeTopic
                    ? '当前条件下没有匹配记录'
                    : workspace.date.value
                      ? '这个日期暂无已收录记录'
                      : '先选择一个交易日'
              }}
            </h2>
            <el-button v-if="route.boards || filterCount || activeTopic" @click="clearFilters"
              >查看全部记录</el-button
            ><el-button
              v-else-if="!data?.rows.length"
              :disabled="!dates.length"
              @click="workspace.openDate(dates.at(-1) || '')"
              >返回最新收录日</el-button
            >
          </div>
          <template v-else-if="groupFirstMode">
            <section
              v-for="group in expandedMatches ? groups : groups.slice(0, 6)"
              :key="groupIdentity(group.labels)"
              class="matching-group"
              :aria-label="`${matchingMode ? '匹配分组' : '地区分组'} ${group.labels.join(' / ')}`"
            >
              <header class="matching-group-label">
                <h2>{{ group.labels.join(' / ') }}</h2>
                <span>{{ group.stocks.length }}只</span>
              </header>
              <div class="matching-group-content">
                <div class="matching-column-headings" aria-hidden="true">
                  <span>股票</span><span>行业与标签</span><span>板数</span><span>操作</span>
                </div>
                <DailyStockRow
                  v-for="stock in group.stocks.slice(0, limit(0, group.labels, []))"
                  :key="stock.code"
                  :stock="stock"
                  :active="selectedStock?.code === stock.code"
                  :highlight="!data?.provisional"
                  :show-boards="true"
                  @preview="select"
                  @node="(id) => nodePanel?.open(id)"
                />
                <el-button
                  v-if="group.stocks.length > limit(0, group.labels, [])"
                  link
                  class="daily-show-more"
                  @click="showRows(0, group.labels, [], group.stocks.length)"
                  >查看本组全部{{ group.stocks.length }}只</el-button
                >
              </div>
            </section>
            <el-button
              v-if="groups.length > 6 && !expandedMatches"
              class="daily-show-more"
              @click="expandedMatches = true"
              >展开全部{{ groups.length }}个分组</el-button
            >
          </template>
          <template v-else>
            <section
              v-for="band in bands"
              :key="band.height"
              class="ladder-band"
              :class="{ 'topic-band': industryMode }"
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
                <div
                  v-if="data?.rows.some((row) => row.boards === band.height && row.nodes?.length)"
                  class="ladder-node-list"
                  role="group"
                  :aria-label="`${band.height}板梯队节点`"
                >
                  <span class="ladder-node-caption">梯队节点</span>
                  <button
                    v-for="node in data?.nodes?.filter(
                      (n) =>
                        n.status === 'active' &&
                        n.height === band.height &&
                        n.codes.some((code) => data?.rows.some((row) => row.code === code)),
                    ) || []"
                    :key="node.id"
                    class="ladder-node"
                    :title="`${node.date} · ${node.name}节点`"
                    @click="nodePanel?.open(node.id)"
                  >
                    {{ node.name }}
                  </button>
                </div>
                <div v-if="industryMode" class="ladder-column-headings" aria-hidden="true">
                  <span>股票</span><span>行业与标签</span><span>操作</span>
                </div>
                <section
                  v-for="group in expandedBands.includes(band.height)
                    ? band.groups
                    : band.groups.slice(0, 6)"
                  :key="groupIdentity(group.labels)"
                  class="ladder-group"
                >
                  <header v-if="!industryMode" class="ladder-group-heading">
                    <h3>{{ group.labels.join(' / ') }}</h3>
                  </header>
                  <div v-for="sub in group.sections" :key="groupIdentity(sub.labels)">
                    <DailyStockRow
                      v-for="stock in sub.stocks.slice(
                        0,
                        limit(band.height, group.labels, sub.labels),
                      )"
                      :key="stock.code"
                      :stock="stock"
                      :active="selectedStock?.code === stock.code"
                      :highlight="!data?.provisional"
                      :topic-filter="topicFilterVisible && industryMode"
                      @preview="select"
                      @node="(id) => nodePanel?.open(id)"
                      @topic="chooseTopic"
                    /><el-button
                      v-if="sub.stocks.length > limit(band.height, group.labels, sub.labels)"
                      link
                      class="daily-show-more"
                      @click="showRows(band.height, group.labels, sub.labels, sub.stocks.length)"
                      >{{ industryMode ? '展开全部' : '查看本组全部'
                      }}{{ sub.stocks.length }}只</el-button
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
          </template>
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
