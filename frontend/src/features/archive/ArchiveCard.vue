<script setup lang="ts">
import { computed } from 'vue';
import StockLink from '@/components/StockLink.vue';
import StockActions from '@/components/StockActions.vue';
import { useWorkspace } from '@/shared/workspace';
import { hierarchy, initials, region } from './helpers';
import type { Stock } from './models';
const props = defineProps<{ stock: Stock; highlight?: boolean }>();
const workspace = useWorkspace();
const tags = computed(() =>
  hierarchy(workspace.meta.value?.tag_hierarchy, workspace.meta.value?.tag_order).leaves(
    props.stock,
  ),
);
const latest = computed(
  () =>
    props.highlight !== false &&
    props.stock.date !== workspace.meta.value?.latest_date &&
    workspace.meta.value?.latest_limit_ups?.find((row) => row.code === props.stock.code),
);
</script>
<template>
  <article class="archive-card" :class="{ latest, blacklisted: stock.blacklisted }">
    <div class="row">
      <StockLink :code="stock.code" :name="stock.name" /><el-tag
        size="small"
        :type="(stock.boards || 0) >= 5 ? 'danger' : 'info'"
        >{{ stock.boards || '—' }} 板</el-tag
      >
    </div>
    <div class="muted mono">
      {{ stock.code }} · {{ initials(stock) || '—' }} · {{ region(stock) }}
    </div>
    <el-tag v-if="latest" size="small" type="danger"
      >{{ workspace.meta.value?.latest_date }} 涨停 · {{ latest.boards }} 板</el-tag
    >
    <div v-if="stock.suspended" class="suspension">
      <strong>停牌中</strong>
      <div>末次涨停 {{ stock.board_date }}</div>
      <div>预计复牌 {{ stock.resume_date || '待公告' }}</div>
      <span>{{ stock.suspension_reason }}</span>
    </div>
    <div class="stock-tags">
      <el-tag v-for="node in stock.nodes || []" :key="node.id" size="small" type="warning"
        >{{ node.name }}节点</el-tag
      >
      <el-tag v-for="tag in tags" :key="tag" size="small" type="info">{{ tag }}</el-tag
      ><span v-if="!tags.length" class="muted">暂无标签</span>
    </div>
    <p v-if="stock.note" class="note">{{ stock.note }}</p>
    <StockActions :stock="stock" compact />
  </article>
</template>
<style scoped>
.archive-card {
  padding: 10px;
  border: 1px solid var(--la-border-subtle);
  background: white;
  display: grid;
  gap: 6px;
  min-width: 210px;
}
.archive-card .row {
  justify-content: space-between;
}
.latest {
  border-left: 3px solid var(--la-market-up);
}
.blacklisted {
  background: var(--la-bg-subtle);
}
.mono {
  font-size: 13px;
}
.note {
  font-size: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
}
.suspension {
  font-size: 14px;
  padding: 8px;
  background: var(--la-warning-bg);
  color: var(--la-warning-fg);
}
</style>
