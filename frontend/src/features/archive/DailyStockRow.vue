<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspace } from '@/shared/workspace';
import { hierarchy, initials, region } from './helpers';
import type { Stock } from './models';
const props = defineProps<{ stock: Stock; active: boolean; highlight: boolean }>();
const emit = defineEmits<{ preview: [stock: Stock, trigger: HTMLElement] }>();
const ws = useWorkspace();
const labels = computed(() =>
  hierarchy(ws.meta.value?.tag_hierarchy, ws.meta.value?.tag_order).leaves(props.stock),
);
const latest = computed(
  () =>
    props.highlight &&
    props.stock.date !== ws.meta.value?.latest_date &&
    ws.meta.value?.latest_limit_ups?.find((row) => row.code === props.stock.code),
);
function preview(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) emit('preview', props.stock, event.currentTarget);
}
</script>
<template>
  <article class="ladder-stock" :class="{ 'is-selected': active }">
    <div class="ladder-stock-identity">
      <button class="daily-stock-link" @click="ws.openStock(stock.code, stock.name)">
        {{ stock.name }}<span class="daily-code">{{ stock.code }}</span>
      </button>
      <span class="daily-meta">{{ region(stock) }} · {{ initials(stock) || '首字母待补充' }}</span>
    </div>
    <div class="ladder-stock-labels">
      <span v-if="stock.blacklisted" class="daily-badge warning">黑名单</span>
      <span v-if="latest" class="daily-badge warning"
        >{{ ws.meta.value?.latest_date }} · {{ latest.boards }}板涨停</span
      >
      <span v-for="label in labels.slice(0, 2)" :key="label" class="daily-tag">{{ label }}</span>
      <span v-if="labels.length > 2" class="daily-meta">另{{ labels.length - 2 }}项</span>
      <span v-if="stock.note" class="daily-meta">有备注</span>
    </div>
    <el-button
      class="preview-stock"
      :type="active ? 'primary' : 'default'"
      :plain="active"
      :aria-label="`预览${stock.name}周期`"
      :aria-pressed="active"
      @click="preview"
      >预览</el-button
    >
  </article>
</template>
