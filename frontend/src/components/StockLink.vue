<script setup lang="ts">
import { useWorkspace } from '@/shared/workspace';
defineProps<{ code: string; name?: string }>();
const workspace = useWorkspace();
</script>
<template>
  <el-button link type="primary" class="stock-link" @click="workspace.openStock(code, name)"
    >{{ name || code }} <span v-if="name" class="mono muted">{{ code }}</span></el-button
  >
</template>
<style scoped>
.stock-link {
  font-weight: 600;
  white-space: normal;
  justify-content: flex-start;
  text-align: left;
}
.mono {
  margin-left: 6px;
  font-size: 13px;
  font-weight: 400;
}
</style>
