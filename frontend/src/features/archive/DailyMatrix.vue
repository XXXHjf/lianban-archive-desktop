<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspace } from '@/shared/workspace';
import ArchiveCard from './ArchiveCard.vue';
import { hierarchy, subgroups } from './helpers';
import type { DailyData, Group, Stock } from './models';
const props = defineProps<{ data: DailyData; groups: Group[] }>();
const workspace = useWorkspace(),
  route = workspace.route;
const tags = computed(() =>
  hierarchy(workspace.meta.value?.tag_hierarchy, workspace.meta.value?.tag_order),
);
const heights = computed(() =>
  [...new Set(props.data.rows.map((row) => row.boards || 0))].sort((a, b) => b - a),
);
function selected(stocks: Stock[], height: number) {
  const rows = stocks.filter((stock) => stock.boards === height);
  if (['code', 'pinyin'].includes(route.value.layout) || props.data.provisional) return rows;
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
  <el-scrollbar
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
  background: #f8fafc;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.matrix-cell > header {
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.matrix-cell small {
  color: #475569;
  white-space: nowrap;
}
.subheading {
  font-size: 14px;
  border-top: 1px solid #dbe2ea;
  padding-top: 8px;
}
.empty-cell {
  text-align: center;
  padding: 16px;
  color: #596779;
}
</style>
