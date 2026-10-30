<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { abort, query, request } from '@/shared/api';
import { errorMessage } from '@/shared/format';
import { useWorkspace } from '@/shared/workspace';
import { cycleStatus, hierarchy, region } from './helpers';
import type { Stock, StockData } from './models';
const props = defineProps<{ stock: Stock | null; day: string }>();
const emit = defineEmits<{ tool: [kind: 'note' | 'tags' | 'shareholders', stock: Stock] }>();
const ws = useWorkspace();
const data = ref<StockData | null>(null),
  loading = ref(false),
  error = ref('');
const channel = `daily-preview-${Math.random().toString(36).slice(2)}`;
let generation = 0;
const cycle = computed(
  () =>
    [...(data.value?.cycles || [])].sort(
      (a, b) => b.end.localeCompare(a.end) || b.start.localeCompare(a.start),
    )[0],
);
const asOf = computed(() => data.value?.as_of_date || data.value?.range_end || '—');
const labels = computed(() =>
  data.value
    ? hierarchy(ws.meta.value?.tag_hierarchy, ws.meta.value?.tag_order).leaves(data.value.stock)
    : [],
);
const rounds = computed(() => {
  if (!cycle.value || !data.value) return [];
  const current = cycle.value,
    dates = new Set(current.dates || []);
  return data.value.relationships.competition.rounds
    .filter((round) =>
      dates.size ? dates.has(round.date) : round.date >= current.start && round.date <= current.end,
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 1);
});
const outcomeLabels: Record<string, string> = {
  win: '本票晋级，对方未入池 · 待核实',
  loss: '对方晋级，本票未入池 · 待核实',
  together: '同梯队共同晋级',
  cutoff: '后续结果待收录',
  missing: '下一交易日资料待补',
  no_peers: '无同级对手',
  unresolved: '未形成单方胜负',
};
const observations = computed(() =>
  !cycle.value
    ? []
    : (data.value?.rows || [])
        .filter((row) => row.date >= cycle.value!.start && row.date <= cycle.value!.end)
        .sort((a, b) => a.date.localeCompare(b.date)),
);
async function load() {
  const token = ++generation;
  abort(channel);
  data.value = null;
  error.value = '';
  loading.value = false;
  if (!props.stock) return;
  loading.value = true;
  try {
    const result = await request<StockData>(
      query('/api/stock', { code: props.stock.code }),
      channel,
    );
    if (token === generation && result) data.value = result;
  } catch (cause) {
    if (token === generation) error.value = errorMessage(cause);
  } finally {
    if (token === generation) loading.value = false;
  }
}
watch(
  () => [props.stock?.code, props.day, ws.revision.value, ws.meta.value?.archive_updated_at],
  load,
  { immediate: true },
);
function research() {
  if (props.stock) ws.openStock(props.stock.code, props.stock.name);
}
function tool(command: 'note' | 'tags' | 'shareholders') {
  if (props.stock) emit('tool', command, data.value?.stock || props.stock);
}
onBeforeUnmount(() => {
  generation++;
  abort(channel);
});
</script>
<template>
  <div class="cycle-preview-content" :aria-busy="loading">
    <template v-if="stock">
      <header class="cycle-preview-heading">
        <p class="daily-eyebrow">个股周期预览</p>
        <h2>
          {{ stock.name }} <span class="daily-code">{{ stock.code }}</span>
        </h2>
        <p class="daily-meta">{{ region(stock) }} · 所选交易日 {{ day }}</p>
      </header>
      <div v-if="loading" class="preview-loading" role="status">
        <el-skeleton :rows="5" />
        <p class="daily-meta">正在读取周期与竞争记录…</p>
      </div>
      <div v-else-if="error" class="daily-state error" role="alert">
        <h3>周期预览未能读取</h3>
        <p>{{ error }}</p>
        <el-button @click="load">重试周期预览</el-button
        ><el-button link @click="research">打开完整档案</el-button>
      </div>
      <template v-else-if="data">
        <p class="daily-meta preview-asof">
          历史确认档案 · 截至 {{ asOf
          }}<span v-if="day !== asOf"><br />此预览为最近已收录周期，与所选交易日不同。</span>
        </p>
        <el-button type="primary" class="cycle-research" @click="research">{{
          cycle ? (cycle.ongoing ? '研究当前周期' : '研究最近周期') : '查看完整个股档案'
        }}</el-button>
        <div v-if="labels.length" class="preview-tags">
          <span v-for="label in labels" :key="label" class="daily-tag">{{ label }}</span>
        </div>
        <section v-if="cycle" class="preview-section">
          <div class="preview-section-title">
            <h3>{{ cycle.ongoing ? '当前连板周期' : '最近连板周期' }}</h3>
            <strong class="preview-height">{{ cycle.boards }}<small>板</small></strong>
          </div>
          <p class="daily-meta">{{ cycle.start }} — {{ cycle.end }}</p>
          <p class="cycle-status">{{ cycleStatus(cycle, asOf) }}</p>
          <ol class="cycle-observations" aria-label="已收录周期节点">
            <li v-for="row in observations" :key="row.date">
              <time>{{ row.date.slice(5) }}</time
              ><strong>{{ row.boards === 1 ? '首板' : `${row.boards}板` }}</strong>
            </li>
          </ol>
          <p v-if="cycle.note" class="daily-meta">{{ cycle.note }}</p>
        </section>
        <section v-else class="daily-state">
          <h3>暂无已收录周期</h3>
          <p>可进入完整档案查看已有涨停日。记录缺失不代表没有涨停。</p>
        </section>
        <section v-if="cycle" class="preview-section preview-rounds">
          <h3>逐轮竞争 · 最近一轮</h3>
          <div v-for="round in rounds" :key="round.date" class="preview-round-summary">
            <p class="daily-meta">
              {{ round.date }} → {{ round.next_date || round.next_trading_date || '待收录' }}
            </p>
            <p>
              <strong>{{ round.boards }}进{{ round.boards + 1 }}</strong> ·
              {{ outcomeLabels[round.outcome] || '结果待确认' }}
            </p>
          </div>
          <p v-if="!rounds.length" class="daily-meta">此周期暂无已收录的逐轮竞争记录。</p>
          <p class="daily-meta">仅按已收录涨停池比较，未入池不等于已确认断板。</p>
          <el-button link type="primary" @click="research">查看完整周期与逐轮记录</el-button>
        </section>
        <section class="preview-section">
          <div class="preview-section-title">
            <h3>股票工具</h3>
            <el-dropdown trigger="click" @command="tool"
              ><el-button aria-label="打开股票工具">备注 / 标签 / 股东</el-button
              ><template #dropdown
                ><el-dropdown-menu
                  ><el-dropdown-item command="note">查看与编辑备注</el-dropdown-item
                  ><el-dropdown-item
                    v-if="ws.meta.value?.capabilities?.edit_tags !== false"
                    command="tags"
                    >标签与黑名单</el-dropdown-item
                  ><el-dropdown-item command="shareholders"
                    >共同股东</el-dropdown-item
                  ></el-dropdown-menu
                ></template
              ></el-dropdown
            >
          </div>
          <details v-if="data.stock.note" class="daily-details">
            <summary>完整备注</summary>
            <p class="pre-wrap">{{ data.stock.note }}</p>
          </details>
          <details class="daily-details">
            <summary>资料与来源口径</summary>
            <p>{{ data.coverage_note }}</p>
            <p>分类资料为当前资料，不代表历史时点。</p>
          </details>
        </section>
      </template>
    </template>
    <div v-else class="preview-invitation">
      <p class="daily-eyebrow">从梯队进入研究</p>
      <h2>先看梯队，再看周期。</h2>
      <p>点击股票旁的“预览”，在这里查看当前或最近周期与关键竞争轮次。</p>
      <div class="preview-path">
        <span>选择股票</span><span>查看周期</span><span>研究逐轮竞争</span>
      </div>
      <p class="daily-meta">点击股票名称也可直接打开完整档案。</p>
    </div>
  </div>
</template>
