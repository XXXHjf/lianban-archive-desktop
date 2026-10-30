<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { EChartsOption } from 'echarts';
import StockSearch from '@/components/StockSearch.vue';
import StockLink from '@/components/StockLink.vue';
import StockActions from '@/components/StockActions.vue';
import ChartPanel from '@/components/ChartPanel.vue';
import { request, query, abort } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage, isGEM, isST } from '@/shared/format';
import { recentStocks, rememberStock } from '@/shared/preferences';
import { cycleStatus, hierarchy, initials, mergePeers, region } from './helpers';
import type { Comparison, Cycle, Peer, Relationships, StockData } from './models';
import CompetitionRounds from './CompetitionRounds.vue';
import PairComparison from './PairComparison.vue';
import { useArchivePagination } from './pagination';
const workspace = useWorkspace(),
  route = workspace.route;
const data = ref<StockData | null>(null),
  relations = ref<Relationships | null>(null),
  detail = ref<Comparison | null>(null);
const loading = ref(false),
  relationLoading = ref(false),
  comparisonLoading = ref(false),
  error = ref(''),
  relationError = ref(''),
  comparisonError = ref('');
const search = ref(''),
  recent = ref(recentStocks()),
  peerCode = ref(''),
  peerQuery = ref('');
type SortKey = 'winCount' | 'lossCount' | 'commonCount';
const sortKey = ref<SortKey>('commonCount'),
  ascending = ref(false);
const sortLabels: { value: SortKey; label: string }[] = [
  { value: 'winCount', label: '赢' },
  { value: 'lossCount', label: '输' },
  { value: 'commonCount', label: '同涨' },
];
const tags = computed(() =>
  hierarchy(workspace.meta.value?.tag_hierarchy, workspace.meta.value?.tag_order),
);
const latest = computed(
  () => new Map(workspace.meta.value?.latest_limit_ups?.map((row) => [row.code, row.boards])),
);
const peers = computed(() =>
  mergePeers(relations.value, route.value.code)
    .filter(
      (peer) =>
        (!route.value.relationExcludeST || !isST(peer.name)) &&
        (!route.value.relationExcludeGEM || !isGEM(peer.code)) &&
        (!peerQuery.value.trim() ||
          `${peer.name} ${peer.code}`.toLowerCase().includes(peerQuery.value.trim().toLowerCase())),
    )
    .sort(
      (a, b) =>
        Number(latest.value.has(b.code)) - Number(latest.value.has(a.code)) ||
        (ascending.value ? 1 : -1) * (a[sortKey.value] - b[sortKey.value]) ||
        b.lastDate.localeCompare(a.lastDate) ||
        a.code.localeCompare(b.code),
    ),
);
const selectedPeer = computed(() => peers.value.find((peer) => peer.code === peerCode.value));
const peerPageSize = 50;
const {
  page: peerPage,
  visible: visiblePeers,
  reveal: revealPeer,
} = useArchivePagination(
  () => peers.value,
  peerPageSize,
  () => [
    route.value.code,
    peerQuery.value,
    sortKey.value,
    ascending.value,
    route.value.relationExcludeST,
    route.value.relationExcludeGEM,
    route.value.relationExcludeLatest,
  ],
);
const expandedCycles = ref<string[]>([]);
const relationHeight = ref(readHeight());
function readHeight() {
  try {
    const raw = localStorage.getItem('limit-up-archive.relation-height.v1'),
      value = Number(raw);
    return raw?.trim() && Number.isFinite(value)
      ? Math.max(600, Math.min(1600, Math.round(value)))
      : 880;
  } catch {
    return 880;
  }
}
watch(relationHeight, (value) => {
  try {
    localStorage.setItem('limit-up-archive.relation-height.v1', String(value));
  } catch {
    /* Optional local preference. */
  }
});
let stockGeneration = 0,
  relationGeneration = 0,
  comparisonGeneration = 0;
const cache = new Map<string, Comparison>();
let relationScope = '',
  detailKey = '';
async function load() {
  const id = ++stockGeneration,
    code = route.value.code,
    changedStock = data.value?.stock.code !== code;
  ++relationGeneration;
  ++comparisonGeneration;
  abort('archive-relations');
  abort('archive-comparison');
  relationLoading.value = false;
  comparisonLoading.value = false;
  if (changedStock) {
    data.value = null;
    relations.value = null;
    detail.value = null;
    relationScope = '';
    detailKey = '';
    cache.clear();
  }
  error.value = '';
  relationError.value = '';
  comparisonError.value = '';
  if (!code) {
    abort('archive-stock');
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await request<StockData>(query('/api/stock', { code }), 'archive-stock');
    if (id !== stockGeneration || !result) return;
    data.value = result;
    search.value = `${result.stock.name} ${code}`;
    if (result.rows.length && result.stock.name !== '尚未收录') {
      rememberStock(result.stock);
      recent.value = recentStocks();
    }
    await loadRelations();
  } catch (cause) {
    if (id === stockGeneration) error.value = errorMessage(cause);
  } finally {
    if (id === stockGeneration) loading.value = false;
  }
}
async function loadRelations() {
  const id = ++relationGeneration,
    code = route.value.code,
    scope = JSON.stringify([code, route.value.relationExcludeLatest]);
  ++comparisonGeneration;
  abort('archive-comparison');
  abort('archive-relations');
  cache.clear();
  if (relationScope !== scope) {
    detail.value = null;
    relations.value = null;
    detailKey = '';
  }
  relationError.value = '';
  comparisonError.value = '';
  if (!data.value || data.value.stock.code !== code) return;
  if (!route.value.relationExcludeLatest) {
    relationLoading.value = false;
    relations.value = data.value.relationships;
    relationScope = scope;
    return;
  }
  relationLoading.value = true;
  try {
    const result = await request<StockData>(
      query('/api/stock', { code, exclude_latest: '1' }),
      'archive-relations',
    );
    if (id === relationGeneration && result) {
      relations.value = result.relationships;
      relationScope = scope;
    }
  } catch (cause) {
    if (id === relationGeneration) relationError.value = errorMessage(cause);
  } finally {
    if (id === relationGeneration) relationLoading.value = false;
  }
}
async function loadComparison(retry = false) {
  const id = ++comparisonGeneration,
    code = route.value.code,
    peer = selectedPeer.value?.code;
  abort('archive-comparison');
  comparisonError.value = '';
  comparisonLoading.value = false;
  if (!peer || !relations.value) {
    detail.value = null;
    detailKey = '';
    return;
  }
  const params = {
    code,
    peer,
    exclude_st: route.value.relationExcludeST ? '1' : '0',
    exclude_gem: route.value.relationExcludeGEM ? '1' : '0',
    exclude_latest: route.value.relationExcludeLatest ? '1' : '0',
  };
  const key = JSON.stringify(params),
    stored = cache.get(key);
  if (detailKey !== key) detail.value = null;
  if (stored && !retry) {
    detail.value = stored;
    detailKey = key;
    return;
  }
  comparisonLoading.value = true;
  try {
    const result = await request<Comparison>(
      query('/api/comparison', params),
      'archive-comparison',
    );
    if (id === comparisonGeneration && result) {
      cache.set(key, result);
      detail.value = result;
      detailKey = key;
    }
  } catch (cause) {
    if (id === comparisonGeneration) comparisonError.value = errorMessage(cause);
  } finally {
    if (id === comparisonGeneration) comparisonLoading.value = false;
  }
}
watch(
  () => route.value.code,
  () => {
    peerCode.value = '';
    peerQuery.value = '';
    void load();
  },
  { immediate: true },
);
watch(
  () => [workspace.revision.value, workspace.meta.value?.archive_updated_at],
  () => {
    void load();
  },
);
watch(() => route.value.relationExcludeLatest, loadRelations);
watch(peers, (rows) => {
  if (relations.value && !rows.some((peer) => peer.code === peerCode.value))
    peerCode.value = rows[0]?.code || '';
});
watch(peerPage, () => {
  if (!visiblePeers.value.some((peer) => peer.code === peerCode.value))
    peerCode.value = visiblePeers.value[0]?.code || '';
});
watch(
  () => route.value.code,
  () => {
    expandedCycles.value = [];
  },
);
watch(
  () => [
    selectedPeer.value?.code,
    relations.value,
    route.value.relationExcludeST,
    route.value.relationExcludeGEM,
  ],
  () => {
    void loadComparison();
  },
);
function storage(event: StorageEvent) {
  if (event.key === null || event.key === 'limit-up-archive.recent-stocks.v1')
    recent.value = recentStocks();
}
window.addEventListener('storage', storage);
onBeforeUnmount(() => {
  ++stockGeneration;
  ++relationGeneration;
  ++comparisonGeneration;
  ['archive-stock', 'archive-relations', 'archive-comparison'].forEach(abort);
  window.removeEventListener('storage', storage);
});
function changeSort(key: SortKey) {
  ascending.value = sortKey.value === key && !ascending.value;
  sortKey.value = key;
}
async function choosePeer(event: KeyboardEvent, peer: Peer) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = peers.value.findIndex((row) => row.code === peer.code),
    next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? peers.value.length - 1
          : Math.max(
              0,
              Math.min(peers.value.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
            );
  const stock = peers.value[next];
  if (stock) {
    peerCode.value = stock.code;
    revealPeer(next);
    await nextTick();
    const button = document.getElementById(`archive-peer-${stock.code}`);
    button?.focus();
    button?.scrollIntoView({ block: 'nearest' });
  }
}
const historyRows = computed(() => [...(data.value?.rows || [])].reverse());
const heightChart = computed<EChartsOption>(() => ({
  animation: false,
  tooltip: { trigger: 'axis', renderMode: 'richText' },
  grid: { left: 40, right: 20, top: 25, bottom: 75 },
  xAxis: { type: 'category', data: historyRows.value.map((row) => row.date) },
  yAxis: { type: 'value', minInterval: 1, name: '板' },
  dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8 }],
  series: [
    {
      name: '连板高度',
      type: 'bar',
      data: historyRows.value.map((row) => row.boards),
      itemStyle: { color: '#d84c42' },
      barMaxWidth: 28,
    },
  ],
}));
function chartClick(event: unknown) {
  if (event && typeof event === 'object' && 'name' in event && typeof event.name === 'string')
    workspace.openDate(event.name);
}
function status(cycle: Cycle) {
  return cycleStatus(cycle, data.value?.as_of_date || data.value?.range_end || '—');
}
function cycleRounds(cycle: Cycle) {
  const dates = new Set(cycle.dates);
  return (data.value?.relationships.competition.rounds || []).filter((round) =>
    dates.size ? dates.has(round.date) : round.date >= cycle.start && round.date <= cycle.end,
  );
}
</script>
<template>
  <div class="stack">
    <section class="panel">
      <div class="panel-header">
        <h2>个股档案</h2>
        <el-button @click="workspace.openDate(workspace.date.value)">返回日期</el-button>
      </div>
      <div class="toolbar">
        <StockSearch
          v-model="search"
          placeholder="股票名称 / 代码 / 首字母"
          @select="(stock) => workspace.openStock(stock.code, stock.name)"
        /><el-button :loading="loading" @click="load">重新加载</el-button>
      </div>
      <div class="recent row">
        <span class="muted">最近查询</span
        ><el-button
          v-for="stock in recent"
          :key="stock.code"
          link
          type="primary"
          @click="workspace.openStock(stock.code, stock.name)"
          >{{ stock.name }}</el-button
        ><span v-if="!recent.length" class="muted">暂无记录</span>
      </div>
    </section>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-empty v-if="!route.code && !loading" description="搜索股票，查看涨停历史与同期竞争" />
    <template v-if="data"
      ><section class="panel">
        <div class="panel-header">
          <div>
            <h2>
              {{ data.stock.name }} <small class="mono">{{ data.stock.code }}</small>
            </h2>
            <p class="muted">
              {{ initials(data.stock) || '—' }} · {{ region(data.stock) }} ·
              {{ data.stock.market || '—' }}
            </p>
            <div class="stock-tags">
              <el-tag v-for="tag in tags.leaves(data.stock)" :key="tag" type="info" size="small">{{
                tag
              }}</el-tag
              ><span v-if="!tags.leaves(data.stock).length" class="muted">暂无标签</span
              ><el-tag v-if="latest.has(data.stock.code)" size="small" type="danger"
                >{{ workspace.meta.value?.latest_date }} 涨停 ·
                {{ latest.get(data.stock.code) }} 板</el-tag
              >
            </div>
          </div>
          <StockActions :stock="data.stock" />
        </div>
        <p v-if="data.stock.note" class="stock-note">{{ data.stock.note }}</p>
        <div class="stat-grid">
          <div class="stat">
            <span>涨停日</span><strong>{{ data.stats.limit_days }}</strong>
          </div>
          <div class="stat">
            <span>最高连板</span><strong>{{ data.stats.max_boards }}</strong>
          </div>
          <div class="stat">
            <span>连板周期</span><strong>{{ data.stats.cycles }}</strong>
          </div>
        </div>
      </section>
      <el-alert :title="data.coverage_note" type="info" :closable="false" show-icon />
      <section class="panel">
        <h3>涨停高度轨迹</h3>
        <ChartPanel
          v-if="data.rows.length"
          :option="heightChart"
          :height="260"
          label="已收录涨停日连板高度，点击柱形查看日期"
          @click="chartClick"
        /><el-empty v-else description="暂无已收录的涨停轨迹" /><el-collapse
          ><el-collapse-item title="逐日涨停记录" name="history"
            ><el-table :data="data.rows" stripe max-height="360"
              ><el-table-column label="交易日期"
                ><template #default="scope"
                  ><el-button link type="primary" @click="workspace.openDate(scope.row.date)">{{
                    scope.row.date
                  }}</el-button></template
                ></el-table-column
              ><el-table-column prop="boards" label="当日高度" /><el-table-column
                prop="name"
                label="当时名称" /></el-table></el-collapse-item
        ></el-collapse>
      </section>
      <section class="panel">
        <h3>连板周期与逐轮竞争</h3>
        <p class="muted">{{ data.relationships.competition.scope_note }}</p>
        <el-alert
          title="按涨停池比较：未入池不等于未涨停，单方晋级结果仍需完整行情核实。"
          type="warning"
          :closable="false"
          show-icon
        /><el-empty v-if="!data.cycles.length" description="暂无已收录的连板周期" /><el-collapse
          v-model="expandedCycles"
          ><el-collapse-item
            v-for="cycle in data.cycles"
            :key="`${cycle.start}-${cycle.end}`"
            :name="cycle.start"
            ><template #title
              ><span class="cycle-title"
                ><strong>{{ cycle.boards }} 板</strong
                ><span>{{ cycle.start }} → {{ cycle.end }}</span
                ><el-tag size="small" :type="cycle.ongoing ? 'danger' : 'info'">{{
                  status(cycle)
                }}</el-tag></span
              ></template
            >
            <template v-if="expandedCycles.includes(cycle.start)">
              <p v-if="cycle.note" class="muted">{{ cycle.note }}</p>
              <p class="muted">周期内已收录的最高高度；空白不代表断板。</p>
              <CompetitionRounds :rounds="cycleRounds(cycle)" /><el-empty
                v-if="!cycleRounds(cycle).length"
                description="该周期暂无已收录的竞争记录" /></template></el-collapse-item
        ></el-collapse>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h3>历史关联对比</h3>
          <el-button :loading="relationLoading" @click="loadRelations">刷新关联</el-button>
        </div>
        <div class="toolbar">
          <el-checkbox
            :model-value="route.relationExcludeST"
            @update:model-value="(value) => workspace.patchRoute({ relationExcludeST: !!value })"
            >剔除 ST</el-checkbox
          ><el-checkbox
            :model-value="route.relationExcludeGEM"
            @update:model-value="(value) => workspace.patchRoute({ relationExcludeGEM: !!value })"
            >剔除创业板</el-checkbox
          ><el-checkbox
            :model-value="route.relationExcludeLatest"
            @update:model-value="
              (value) => workspace.patchRoute({ relationExcludeLatest: !!value })
            "
            >剔除最新交易日</el-checkbox
          >
        </div>
        <p class="muted">
          {{
            route.relationExcludeLatest
              ? '历史数据 · 已剔除 ' + workspace.meta.value?.latest_date
              : '全部数据'
          }}
          ·
          {{
            relations
              ? (relations.range_end < relations.range_start
                  ? '暂无可用历史交易日'
                  : `${relations.range_start} — ${relations.range_end}`) +
                ` · 本票 ${relations.target_limit_days} 个涨停日`
              : '正在整理同期竞争和同日涨停记录…'
          }}
        </p>
        <el-alert
          title="汇总胜出、落后与同日涨停记录，关联股票去重展示。最新日涨停优先；未入池不等于未涨停，胜负待行情核实。"
          type="info"
          :closable="false"
        /><el-alert v-if="relationError" :title="relationError" type="error" :closable="false" />
        <div class="toolbar height-control">
          <span class="muted">工作区高度 {{ relationHeight }} px</span
          ><el-slider
            v-model="relationHeight"
            :min="600"
            :max="1600"
            :step="20"
            aria-label="关联对比区域高度"
          /><el-button size="small" @click="relationHeight = 880">重置</el-button>
        </div>
        <div
          v-loading="relationLoading"
          class="relation-workspace"
          :style="{ '--relation-height': `${relationHeight}px` }"
        >
          <aside class="peer-sidebar">
            <h4>关联股票 · {{ peers.length }} 只</h4>
            <el-input
              v-model="peerQuery"
              placeholder="股票名称 / 代码"
              clearable
              aria-label="筛选关联股票"
            />
            <div class="toolbar">
              <el-button
                v-for="option in sortLabels"
                :key="option.value"
                size="small"
                :type="sortKey === option.value ? 'primary' : 'default'"
                :aria-pressed="sortKey === option.value"
                @click="changeSort(option.value)"
                >{{ option.label }}
                {{ sortKey === option.value ? (ascending ? '↑' : '↓') : '↕' }}</el-button
              >
            </div>
            <p class="muted">最新日涨停优先 · 次数{{ ascending ? '升序' : '降序' }}</p>
            <el-scrollbar class="peer-list"
              ><button
                v-for="peer in visiblePeers"
                :id="`archive-peer-${peer.code}`"
                :key="peer.code"
                class="peer-button"
                :class="{ selected: peer.code === peerCode, latest: latest.has(peer.code) }"
                :aria-pressed="peer.code === peerCode"
                :tabindex="peer.code === peerCode ? 0 : -1"
                @click="peerCode = peer.code"
                @keydown="choosePeer($event, peer)"
              >
                <strong>{{ peer.name }}</strong> <small>{{ peer.code }}</small>
                <div v-if="latest.has(peer.code)" class="latest-note">
                  {{ workspace.meta.value?.latest_date }} 涨停
                </div>
                <div class="metrics">
                  <span>赢 {{ peer.winCount }}</span
                  ><span>输 {{ peer.lossCount }}</span
                  ><span>同涨 {{ peer.commonCount }}</span>
                </div></button
              ><el-empty v-if="!peers.length" description="没有匹配的关联股票" :image-size="60"
            /></el-scrollbar>
            <el-pagination
              v-if="peers.length > peerPageSize"
              v-model:current-page="peerPage"
              :page-size="peerPageSize"
              :total="peers.length"
              layout="prev, pager, next"
              :pager-count="5"
              size="small"
              aria-label="关联股票分页"
            />
          </aside>
          <el-scrollbar class="peer-detail"
            ><template v-if="selectedPeer"
              ><div class="peer-heading">
                <h3>
                  <StockLink :code="selectedPeer.code" :name="selectedPeer.name" />
                  <small class="mono">{{ selectedPeer.code }}</small>
                </h3>
                <p class="muted">
                  {{ initials(selectedPeer) || '—' }} · {{ region(selectedPeer) }} · 与
                  {{ data.stock.name }} 的历史对比
                </p>
                <div class="stock-tags">
                  <el-tag
                    v-for="tag in tags.leaves(selectedPeer)"
                    :key="tag"
                    size="small"
                    type="info"
                    >{{ tag }}</el-tag
                  >
                </div>
                <StockActions :stock="selectedPeer" compact />
                <div class="stat-grid">
                  <div class="stat">
                    <span>本票胜出</span><strong>{{ selectedPeer.winCount }} 轮</strong>
                  </div>
                  <div class="stat">
                    <span>本票落后</span><strong>{{ selectedPeer.lossCount }} 轮</strong>
                  </div>
                  <div class="stat">
                    <span>同日涨停</span><strong>{{ selectedPeer.commonCount }} 次</strong>
                  </div>
                </div>
              </div>
              <div v-loading="comparisonLoading" class="comparison">
                <el-alert
                  v-if="comparisonError"
                  :title="comparisonError"
                  type="error"
                  :closable="false"
                /><el-button v-if="comparisonError" @click="loadComparison(true)"
                  >重新加载对比</el-button
                ><PairComparison
                  v-if="detail"
                  :target="data.stock"
                  :peer="selectedPeer"
                  :segments="detail.segments"
                /><el-empty
                  v-if="!comparisonLoading && !detail && !comparisonError"
                  description="暂无对比记录"
                /></div></template
            ><el-empty v-else description="暂无对比记录，可调整筛选条件"
          /></el-scrollbar>
        </div>
      </section>
    </template>
  </div>
</template>
<style scoped>
.recent {
  font-size: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
.stock-note {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cycle-title {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 4px;
}
.cycle-title strong {
  color: #c84038;
}
.height-control {
  margin: 12px 0;
}
.height-control .el-slider {
  width: 200px;
}
.relation-workspace {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  height: var(--relation-height);
  min-height: 600px;
  border: 1px solid #dce0e5;
}
.peer-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid #dce0e5;
  padding: 12px;
  background: #fafaf8;
  gap: 8px;
}
.peer-sidebar h4,
.peer-sidebar p {
  margin: 0;
}
.peer-sidebar .toolbar {
  margin: 0;
}
.peer-list {
  flex: 1;
}
.peer-button {
  display: block;
  width: 100%;
  text-align: left;
  background: white;
  border: 1px solid #e0e3e8;
  padding: 12px;
  margin: 6px 0;
  cursor: pointer;
  color: #242b36;
  font: inherit;
}
.peer-button.selected {
  border-color: #2563eb;
  background: #edf3ff;
}
.peer-button.latest {
  border-left: 3px solid #d84c42;
}
.peer-button small {
  color: #727b86;
}
.metrics {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
}
.latest-note {
  font-size: 11px;
  color: #c84038;
  margin-top: 4px;
}
.peer-detail {
  min-width: 0;
}
.peer-heading {
  padding: 16px;
}
.comparison {
  padding: 0 16px 16px;
  min-height: 180px;
}
.peer-heading h3 {
  margin: 0;
}
.peer-heading .stat-grid {
  margin-top: 12px;
}
.peer-heading .stat strong {
  font-size: 20px;
}
@media (max-width: 1100px) {
  .relation-workspace {
    grid-template-columns: 210px minmax(0, 1fr);
  }
}
@media (max-width: 760px) {
  .relation-workspace {
    grid-template-columns: 1fr;
    height: auto;
  }
  .peer-sidebar {
    height: 340px;
    border-right: 0;
    border-bottom: 1px solid #ddd;
  }
  .peer-detail {
    height: var(--relation-height);
  }
  .cycle-title {
    gap: 8px;
    font-size: 12px;
  }
}
</style>
