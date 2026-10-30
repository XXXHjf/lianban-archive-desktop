<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsOption } from 'echarts';
import ChartPanel from '@/components/ChartPanel.vue';
import StockLink from '@/components/StockLink.vue';
import { useWorkspace } from '@/shared/workspace';
import type { ComparisonSegment, Peer, Stock } from './models';
import { useArchivePagination } from './pagination';
const props = defineProps<{ target: Stock; peer: Peer; segments: ComparisonSegment[] }>();
const workspace = useWorkspace();
const pageSize = 5;
const { page, visible } = useArchivePagination(
  () => props.segments,
  pageSize,
  () => [props.target.code, props.peer.code],
);
const evidence = computed(() =>
  [
    ...props.peer.wins.map((round) => ({ ...round, kind: 'win' })),
    ...props.peer.losses.map((round) => ({ ...round, kind: 'loss' })),
  ].sort((a, b) => b.date.localeCompare(a.date)),
);
function rows(segment: ComparisonSegment) {
  return [
    { stock: props.target, dates: segment.target_dates, label: '本票' },
    { stock: props.peer, dates: segment.peer_dates, label: '对比票' },
    ...(segment.leader
      ? [{ stock: segment.leader, dates: segment.leader.dates, label: '同期最高板' }]
      : []),
  ];
}
function days(segment: ComparisonSegment) {
  return [...new Set(rows(segment).flatMap((row) => row.dates.map((day) => day.date)))].sort();
}
function option(segment: ComparisonSegment): EChartsOption {
  const dates = days(segment);
  return {
    animation: false,
    tooltip: { trigger: 'axis', renderMode: 'richText' },
    legend: { type: 'scroll' },
    grid: { left: 40, right: 20, top: 40, bottom: 70 },
    xAxis: { type: 'category', data: dates },
    yAxis: { type: 'value', minInterval: 1, name: '板' },
    dataZoom: [
      { type: 'inside', filterMode: 'none' },
      { type: 'slider', bottom: 8 },
    ],
    series: rows(segment).map((row) => ({
      name: `${row.label} ${row.stock.name}`,
      type: 'line',
      symbolSize: 9,
      connectNulls: false,
      data: dates.map((date) => row.dates.find((day) => day.date === date)?.boards ?? null),
      emphasis: { focus: 'series' },
    })),
  };
}
function chartClick(event: unknown) {
  if (
    typeof event === 'object' &&
    event !== null &&
    'name' in event &&
    typeof event.name === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(event.name)
  )
    workspace.openDate(event.name);
}
function wheel(event: WheelEvent) {
  if (!event.ctrlKey || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.scrollLeft += event.deltaY || event.deltaX;
}
</script>
<template>
  <div class="stack">
    <el-empty v-if="!segments.length" description="暂无已收录的共同涨停周期" />
    <el-pagination
      v-if="segments.length > pageSize"
      v-model:current-page="page"
      :page-size="pageSize"
      :total="segments.length"
      layout="total, prev, pager, next"
      size="small"
      aria-label="对比周期分页"
    />
    <article v-for="segment in visible" :key="`${segment.start}-${segment.end}`" class="segment">
      <header class="row">
        <div>
          <el-button link type="primary" @click="workspace.openDate(segment.start)">{{
            segment.start
          }}</el-button>
          —
          <el-button link type="primary" @click="workspace.openDate(segment.end)">{{
            segment.end
          }}</el-button>
        </div>
        <el-tag size="small" type="info">同涨 {{ segment.common_dates.length }} 天</el-tag>
      </header>
      <ChartPanel
        :option="option(segment)"
        :height="260"
        label="双方完整涨停周期与同期最高板高度对比，点击节点查看日期"
        @click="chartClick"
      />
      <div
        class="node-scroll"
        tabindex="0"
        aria-label="完整周期逐日节点，Ctrl 加滚轮横向浏览"
        @wheel="wheel"
      >
        <table>
          <thead>
            <tr>
              <th>完整周期</th>
              <th v-for="day in days(segment)" :key="day">
                <el-button link size="small" @click="workspace.openDate(day)">{{
                  day.slice(5)
                }}</el-button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in rows(segment)" :key="run.stock.code">
              <th>
                <span class="muted">{{ run.label }}</span
                ><br /><StockLink :code="run.stock.code" :name="run.stock.name" /><small
                  v-if="run.label === '同期最高板' && segment.leader"
                  ><br />{{ segment.leader.start }} — {{ segment.leader.end }}</small
                >
              </th>
              <td
                v-for="day in days(segment)"
                :key="day"
                :class="{ common: segment.common_dates.includes(day) }"
              >
                <el-button
                  v-if="run.dates.some((row) => row.date === day)"
                  size="small"
                  text
                  @click="workspace.openDate(day)"
                  >{{ run.dates.find((row) => row.date === day)?.boards }} 板</el-button
                ><span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!segment.leader" class="muted">暂无同期最高板</p>
      <div
        v-for="round in evidence.filter(
          (row) => row.date >= segment.start && row.date <= segment.end,
        )"
        :key="`${round.kind}-${round.date}-${round.boards}`"
        class="evidence"
      >
        <el-button link type="primary" @click="workspace.openDate(round.date)">{{
          round.date
        }}</el-button>
        →
        <el-button
          v-if="round.next_date"
          link
          type="primary"
          @click="workspace.openDate(round.next_date)"
          >{{ round.next_date }}</el-button
        ><span v-else>待收录</span
        ><span
          >{{
            round.kind === 'win'
              ? `本票晋级 ${round.boards + 1} 板，对方未入池`
              : `对方晋级 ${round.boards + 1} 板，本票未入池`
          }}
        </span>
      </div>
    </article>
  </div>
</template>
<style scoped>
.segment {
  border: 1px solid #dfe2e7;
  padding: 12px;
  background: white;
}
.segment > header {
  justify-content: space-between;
}
.node-scroll {
  overflow-x: auto;
  overscroll-behavior: contain;
}
table {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
  font-size: 12px;
}
th,
td {
  border: 1px solid #e4e5e7;
  padding: 6px;
  min-width: 65px;
  text-align: center;
}
th:first-child {
  position: sticky;
  left: 0;
  background: #fafaf8;
  min-width: 170px;
  z-index: 1;
}
.common {
  background: #fff2db;
}
.segment p {
  font-size: 11px;
  line-height: 1.7;
}
.evidence {
  font-size: 12px;
  border-top: 1px solid #eee;
  padding: 8px 0;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
</style>
