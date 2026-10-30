<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { abort, query, request } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage } from '@/shared/format';
import ArchiveCard from './ArchiveCard.vue';
import { dailyGroups, hierarchy, subgroups } from './helpers';
import type { DailyData, Stock } from './models';
const workspace = useWorkspace(),
  data = ref<DailyData | null>(null),
  loading = ref(false),
  error = ref('');
const route = workspace.route;
const dates = computed(
  () => workspace.meta.value?.query_dates || workspace.meta.value?.dates || [],
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
const heights = computed(() =>
  [...new Set((data.value?.rows || []).map((row) => row.boards || 0))].sort((a, b) => b - a),
);
const boardOptions = computed(() => {
  const counts = [...(data.value?.board_counts || [])];
  if (route.value.boards && !counts.some((item) => String(item.boards) === route.value.boards))
    counts.push({ boards: Number(route.value.boards), count: 0 });
  return counts.sort((a, b) => a.boards - b.boards);
});
const freshness = computed(() => {
  if (!data.value) return '';
  const live =
    workspace.meta.value?.live?.date === data.value.date
      ? workspace.meta.value.live
      : data.value.live;
  return data.value.provisional
    ? `盘中暂定 · 获取于 ${data.value.fetched_at?.slice(11, 19) || '—'} · 每分钟刷新${live?.status === 'error' ? ' · 获取失败，保留上次数据并重试' : live?.status === 'waiting' ? ' · 来源待更新，保留上次数据并重试' : ''} · 收盘后确认`
    : data.value.live
      ? '盘中来源待更新 · 每分钟自动重试'
      : '仅供参考';
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
  const path = query('/api/date', {
    date: workspace.date.value,
    boards: route.value.boards,
    exclude_st: route.value.excludeST ? '1' : '0',
    exclude_gem: route.value.excludeGEM ? '1' : '0',
  });
  if (path !== lastQuery) data.value = null;
  lastQuery = path;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<DailyData>(path, 'archive-date');
    if (id === generation && result) data.value = result;
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
const interval = window.setInterval(() => {
  if (
    data.value?.provisional ||
    data.value?.live ||
    ['unknown', 'updating'].includes(data.value?.suspension_status || '')
  )
    void load();
}, 60000);
onBeforeUnmount(() => {
  generation++;
  abort('archive-date');
  window.clearInterval(interval);
});
function selected(stocks: Stock[], height: number) {
  const rows = stocks.filter((stock) => stock.boards === height);
  if (['code', 'pinyin'].includes(route.value.layout) || data.value?.provisional) return rows;
  const latest = new Set(workspace.meta.value?.latest_limit_ups?.map((row) => row.code));
  return rows.sort(
    (a, b) =>
      Number(latest.has(b.code) && b.date !== workspace.meta.value?.latest_date) -
        Number(latest.has(a.code) && a.date !== workspace.meta.value?.latest_date) ||
      a.code.localeCompare(b.code),
  );
}
</script>
<template>
  <div class="stack">
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>每日涨停档案</h2>
          <p class="muted">{{ workspace.date.value }} · {{ freshness }}</p>
        </div>
        <el-button :loading="loading" @click="load">重新加载</el-button>
      </div>
      <div class="toolbar">
        <el-button :disabled="!previous" @click="previous && workspace.openDate(previous)"
          >上一日</el-button
        ><el-date-picker
          :model-value="workspace.date.value"
          value-format="YYYY-MM-DD"
          type="date"
          placeholder="查询日期"
          :clearable="false"
          @update:model-value="(value: string) => workspace.openDate(value)"
        /><el-button :disabled="!next" @click="next && workspace.openDate(next)">下一日</el-button
        ><el-button @click="workspace.openDate(dates.at(-1) || '')">最新日期</el-button
        ><el-checkbox
          :model-value="route.excludeST"
          @update:model-value="(value) => workspace.patchRoute({ excludeST: !!value })"
          >剔除 ST</el-checkbox
        ><el-checkbox
          :model-value="route.excludeGEM"
          @update:model-value="(value) => workspace.patchRoute({ excludeGEM: !!value })"
          >剔除创业板</el-checkbox
        >
      </div>
      <div class="toolbar">
        <el-radio-group
          :model-value="route.boards"
          size="small"
          @update:model-value="(value) => workspace.patchRoute({ boards: String(value) })"
          ><el-radio-button value="">全部 {{ data?.available_total ?? '—' }}</el-radio-button
          ><el-radio-button
            v-for="option in boardOptions"
            :key="option.boards"
            :value="String(option.boards)"
            >{{ option.boards === 1 ? '首板' : `${option.boards} 板` }}
            {{ option.count }}</el-radio-button
          ></el-radio-group
        >
      </div>
      <div class="toolbar">
        <span class="muted">分组</span
        ><el-radio-group
          :model-value="route.layout"
          size="small"
          @update:model-value="(value) => workspace.patchRoute({ layout: String(value) })"
          ><el-radio-button value="industry">行业 / 标签</el-radio-button
          ><el-radio-button value="region">地区</el-radio-button
          ><el-radio-button value="pinyin">拼音</el-radio-button
          ><el-radio-button value="code">代码</el-radio-button></el-radio-group
        >
      </div>
    </section>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <div v-if="data" class="stat-grid">
      <div class="stat">
        <span>涨停家数</span><strong>{{ data.stats.total }}</strong>
      </div>
      <div class="stat">
        <span>连板家数</span><strong>{{ data.stats.consecutive }}</strong>
      </div>
      <div class="stat">
        <span>最高连板</span><strong>{{ data.stats.max_boards }}</strong
        ><small>{{
          data.suspended_rows?.length
            ? `含停牌保留高度 · 当日最高 ${data.trading_max_boards} 板`
            : ['unknown', 'updating', 'error'].includes(data.suspension_status || '')
              ? '停牌资料待核实'
              : '当前筛选最高高度'
        }}</small>
      </div>
      <div class="stat">
        <span>首板家数</span><strong>{{ data.stats.first_boards }}</strong>
      </div>
    </div>
    <el-alert
      v-if="data?.coverage_note"
      :title="data.coverage_note"
      :type="
        data.provisional || !['ok', 'provisional'].includes(data.data_status) ? 'warning' : 'info'
      "
      :closable="false"
      show-icon
    />
    <section v-if="data?.suspended_rows?.length" class="panel">
      <h3>停牌保留高度</h3>
      <p class="muted">保留停牌前连板高度，未计入当日涨停家数</p>
      <div class="suspended-grid">
        <ArchiveCard
          v-for="stock in data.suspended_rows"
          :key="stock.code"
          :stock="stock"
          :highlight="!data.provisional"
        />
      </div>
    </section>
    <section v-loading="loading" class="panel">
      <div class="panel-header">
        <h3>{{ groups.length }} 个分组 · {{ data?.rows.length || 0 }} 只股票</h3>
        <span class="muted">{{
          route.layout === 'code'
            ? '6 → 1 位连续数字匹配，可跨组展示'
            : route.layout === 'pinyin'
              ? '4 → 1 个连续字母匹配，可跨组展示'
              : '按连板高度分行 · 多标签可跨列显示'
        }}</span>
      </div>
      <el-empty
        v-if="!heights.length && !loading"
        :description="
          route.boards && data?.available_total
            ? `没有 ${route.boards} 板股票，点击全部查看其他记录`
            : workspace.date.value
              ? '没有符合条件的涨停记录；无记录不能据此判断没有涨停'
              : '请选择查询日期'
        "
      />
      <el-scrollbar v-else
        ><div class="matrix" :style="{ '--columns': groups.length }">
          <section v-for="height in heights" :key="height" class="height-row">
            <h4>
              {{ height === 1 ? '首板' : `${height} 板` }} ·
              {{ data?.rows.filter((row) => row.boards === height).length }} 只
            </h4>
            <div class="matrix-row">
              <section v-for="group in groups" :key="group.labels.join('|')" class="matrix-cell">
                <header>
                  <span>{{ group.labels.join(' / ') }}</span
                  ><small>{{ selected(group.stocks, height).length }} 只</small>
                </header>
                <div
                  v-if="
                    route.layout === 'industry' &&
                    group.labels[0] !== '独苗' &&
                    workspace.meta.value?.capabilities?.manage_tags !== false
                  "
                  class="row"
                >
                  <el-button
                    v-for="label in group.labels"
                    :key="label"
                    size="small"
                    text
                    type="primary"
                    :title="'管理此标签股票：' + label"
                    @click="workspace.patchRoute({ view: 'tags', tag: label })"
                    >＋ {{ label }}</el-button
                  >
                </div>
                <template
                  v-for="sub in route.layout === 'industry'
                    ? subgroups(selected(group.stocks, height), group.labels[0] || '', tags)
                    : [{ labels: [], stocks: selected(group.stocks, height) }]"
                  :key="sub.labels.join('|')"
                  ><div
                    v-if="sub.labels.length && sub.labels[0] !== group.labels[0]"
                    class="subheading"
                  >
                    <span>{{
                      sub.labels
                        .map((label) =>
                          [...tags.ancestors(label)].reverse().slice(1).concat(label).join(' / '),
                        )
                        .join(' / ')
                    }}</span
                    ><el-button
                      v-for="label in sub.labels"
                      v-show="workspace.meta.value?.capabilities?.manage_tags !== false"
                      :key="label"
                      size="small"
                      text
                      type="primary"
                      :title="'管理此标签股票：' + label"
                      @click="workspace.patchRoute({ view: 'tags', tag: label })"
                      >＋</el-button
                    >
                  </div>
                  <ArchiveCard
                    v-for="stock in sub.stocks"
                    :key="stock.code"
                    :stock="stock"
                    :highlight="!data?.provisional"
                /></template>
                <div v-if="!selected(group.stocks, height).length" class="empty-cell">—</div>
              </section>
            </div>
          </section>
        </div></el-scrollbar
      >
    </section>
  </div>
</template>
<style scoped>
.matrix {
  min-width: 100%;
  width: max-content;
}
.height-row > h4 {
  position: sticky;
  left: 0;
  margin: 16px 0 8px;
}
.matrix-row {
  display: grid;
  grid-template-columns: repeat(var(--columns), 250px);
  gap: 8px;
}
.matrix-cell {
  background: #f1f2f3;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.matrix-cell > header {
  font-weight: 650;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.matrix-cell small {
  color: #737b85;
  white-space: nowrap;
}
.subheading {
  font-size: 12px;
  border-top: 1px solid #ddd;
  padding-top: 8px;
}
.empty-cell {
  text-align: center;
  padding: 16px;
  color: #a0a5af;
}
.suspended-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 8px;
}
</style>
