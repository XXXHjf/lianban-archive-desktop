<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspace } from '@/shared/workspace';
import { shareholderAlertVisible } from '@/features/research/preferences';
import type { Stock } from '@/features/research/types';
import NotePreview from '@/features/research/NotePreview.vue';
import ShareholderPreview from '@/features/research/ShareholderPreview.vue';
const props = defineProps<{ stock: Stock; compact?: boolean }>();
const workspace = useWorkspace();
const alert = computed(() =>
  shareholderAlertVisible(
    workspace.meta.value?.shareholder_alerts?.rows?.find((row) => row.code === props.stock.code),
  ),
);
</script>
<template>
  <span class="stock-actions">
    <NotePreview :stock="stock"
      ><el-button size="small" text @click="workspace.openEditor('note', stock)">{{
        compact ? '备注' : stock.note ? '备注 ·' : '备注'
      }}</el-button></NotePreview
    >
    <el-button
      v-if="workspace.meta.value?.capabilities?.edit_tags !== false"
      size="small"
      text
      @click="workspace.openEditor('tags', stock)"
      >标签</el-button
    >
    <ShareholderPreview :stock="stock"
      ><el-button
        size="small"
        text
        :type="alert ? 'warning' : 'default'"
        :aria-label="alert ? '共同股东：今日有未屏蔽的共同股东同涨停' : '查看共同股东'"
        @click="workspace.openEditor('shareholders', stock)"
        >股东{{ alert ? ' ●' : '' }}</el-button
      ></ShareholderPreview
    >
    <el-tag v-if="stock.blacklisted" type="danger" size="small">黑名单</el-tag>
  </span>
</template>
<style scoped>
.stock-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}
.stock-actions .el-button + .el-button {
  margin-left: 0;
}
</style>
