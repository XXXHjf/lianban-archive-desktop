<script setup lang="ts">
import { computed, ref } from 'vue';
import { useWorkspace } from '@/shared/workspace';
import ShareholdersPanel from './ShareholdersPanel.vue';
import type { Stock } from './types';
defineProps<{ stock: Stock }>();
const workspace = useWorkspace(),
  hovered = ref(false);
const visible = computed({
  get: () => hovered.value && !workspace.editor.value,
  set: (value: boolean) => {
    hovered.value = value;
  },
});
</script>
<template>
  <el-popover
    v-model:visible="visible"
    :trigger="['hover', 'focus']"
    width="min(560px, 94vw)"
    :show-after="300"
    :hide-after="200"
    :persistent="false"
    ><template #reference><slot /></template>
    <div class="shareholder-preview">
      <ShareholdersPanel v-if="visible" :stock="stock" />
      <p class="muted">点击股东按钮可固定打开。</p>
    </div></el-popover
  >
</template>
<style scoped>
.shareholder-preview {
  max-height: min(520px, 75vh);
  overflow: auto;
}
</style>
