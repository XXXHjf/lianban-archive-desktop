<script setup lang="ts">
import { computed } from 'vue';
import StockLink from '@/components/StockLink.vue';
import { useWorkspace } from '@/shared/workspace';
import { hierarchy, region } from './helpers';
import type { Round } from './models';
const props = defineProps<{ rounds: Round[] }>();
const workspace = useWorkspace();
const tags = computed(() =>
  hierarchy(workspace.meta.value?.tag_hierarchy, workspace.meta.value?.tag_order),
);
const labels: Record<string, string> = {
  win: '胜出 1 轮',
  loss: '落后 1 轮',
  together: '共同晋级',
  cutoff: '待后续结果',
  missing: '数据待补',
  no_peers: '无同级对手',
  unresolved: '未形成单方胜负',
};
const segments = computed(() => {
  const result: { first: Round; last: Round; count: number }[] = [];
  for (const round of props.rounds) {
    const last = result.at(-1);
    if (
      round.outcome === 'no_peers' &&
      last?.first.outcome === 'no_peers' &&
      round.boards + 1 === last.first.boards &&
      (round.next_date || round.next_trading_date) === last.first.date
    ) {
      last.first = round;
      last.count++;
    } else result.push({ first: round, last: round, count: 1 });
  }
  return result;
});
function description(round: Round) {
  if (round.outcome === 'win')
    return `本票晋级 ${round.boards + 1} 板，本批次胜出记 1 轮，涉及 ${round.wins.length} 只对手。`;
  if (round.outcome === 'loss')
    return `本票次日未入池，同梯队 ${round.losses.length} 只对手晋级 ${round.boards + 1} 板，本批次落后记 1 轮。`;
  if (round.outcome === 'cutoff') return '后续结果超出当前收录范围，暂不计胜负。';
  if (round.outcome === 'missing') return '下一交易日涨停池数据未确认，暂不计胜负。';
  if (round.outcome === 'together')
    return `本票与 ${round.together_count || 0} 只同梯队股票共同晋级，未形成单方胜负。`;
  return round.outcome === 'no_peers' ? '' : '共同未入池或板数异常不计胜负。';
}
function cohorts(round: Round) {
  const rows = [...(round.cohort || [...round.wins, ...round.losses])];
  const latest = new Set(workspace.meta.value?.latest_limit_ups?.map((stock) => stock.code));
  rows.sort(
    (a, b) =>
      Number(latest.has(b.code)) - Number(latest.has(a.code)) ||
      Number('is_target' in b && b.is_target) - Number('is_target' in a && a.is_target) ||
      a.code.localeCompare(b.code),
  );
  return [
    {
      label: `晋级 ${round.boards + 1} 板`,
      rows: rows.filter((row) => 'promotion_status' in row && row.promotion_status === 'advanced'),
    },
    {
      label: '同梯队其他股票',
      rows: rows.filter(
        (row) => !('promotion_status' in row) || row.promotion_status !== 'advanced',
      ),
    },
  ].filter((group) => group.rows.length);
}
</script>
<template>
  <div class="rounds">
    <p class="muted">
      逐轮竞争 · 共 {{ rounds.length }} 轮{{
        segments.length < rounds.length ? ` · 合并展示 ${segments.length} 条` : ''
      }}
    </p>
    <article
      v-for="segment in segments"
      :key="`${segment.first.date}-${segment.first.boards}`"
      class="round"
    >
      <div class="row">
        <strong>{{ segment.first.boards }} 进 {{ segment.last.boards + 1 }}</strong
        ><el-tag
          size="small"
          :type="
            segment.first.outcome === 'win'
              ? 'danger'
              : segment.first.outcome === 'loss'
                ? 'success'
                : 'info'
          "
          >{{ labels[segment.first.outcome] || '待确认'
          }}{{ segment.count > 1 ? ` · ${segment.count} 轮` : '' }}</el-tag
        >
      </div>
      <div class="row">
        <el-button link type="primary" @click="workspace.openDate(segment.first.date)">{{
          segment.first.date
        }}</el-button
        ><span>→</span
        ><el-button
          v-if="segment.last.next_date || segment.last.next_trading_date"
          link
          type="primary"
          @click="workspace.openDate((segment.last.next_date || segment.last.next_trading_date)!)"
          >{{ segment.last.next_date || segment.last.next_trading_date }}</el-button
        ><span v-else>下一交易日待收录</span>
      </div>
      <p v-if="description(segment.first)">{{ description(segment.first) }}</p>
      <template v-if="segment.first.outcome !== 'no_peers'"
        ><section v-for="group in cohorts(segment.first)" :key="group.label">
          <h5>{{ group.label }} · {{ group.rows.length }} 只</h5>
          <div class="cohort">
            <div v-for="stock in group.rows" :key="stock.code" class="cohort-stock">
              <StockLink :code="stock.code" :name="stock.name" /><el-tag
                v-if="'is_target' in stock && stock.is_target"
                size="small"
                >本票</el-tag
              ><el-tag
                v-if="
                  workspace.meta.value?.latest_limit_ups?.some((row) => row.code === stock.code)
                "
                size="small"
                type="danger"
                >最新日涨停</el-tag
              >
              <div class="muted">{{ stock.code }} · {{ region(stock) }}</div>
              <div class="stock-tags">
                <el-tag v-for="tag in tags.leaves(stock)" :key="tag" size="small" type="info">{{
                  tag
                }}</el-tag>
              </div>
            </div>
          </div>
        </section></template
      >
    </article>
  </div>
</template>
<style scoped>
.rounds {
  display: grid;
  gap: 8px;
}
.round {
  padding: 12px;
  border: 1px solid #e2e4e8;
  background: #fff;
}
.round p {
  font-size: 12px;
  margin: 8px 0;
}
.round .row {
  justify-content: space-between;
}
.round h5 {
  margin: 12px 0 6px;
}
.cohort {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px;
}
.cohort-stock {
  padding: 8px;
  background: #f5f5f3;
  line-height: 1.8;
}
.cohort-stock > .el-tag {
  margin-left: 6px;
}
.cohort-stock .muted {
  font-size: 11px;
}
</style>
