<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { request, query, abort } from '@/shared/api';
import { errorMessage } from '@/shared/format';
import type { NoteData, Stock } from './types';
const props = defineProps<{ stock: Stock }>();
const data = ref<NoteData | null>(null),
  loading = ref(false),
  error = ref('');
const channel = `note-preview-${Math.random().toString(36).slice(2)}`;
let generation = 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  data.value = null;
  try {
    const result = await request<NoteData>(
      query('/api/stock-note', { code: props.stock.code }),
      channel,
    );
    if (result && current === generation) data.value = result;
  } catch (cause) {
    if (current === generation) error.value = errorMessage(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
function close() {
  generation++;
  abort(channel);
  loading.value = false;
}
onBeforeUnmount(close);
</script>
<template>
  <el-popover
    :trigger="['hover', 'focus']"
    width="min(360px, 94vw)"
    :show-after="300"
    @show="load"
    @hide="close"
    ><template #reference><slot /></template>
    <div class="note-preview" role="list">
      <p v-if="loading" class="muted">正在读取全部备注…</p>
      <p v-else-if="error">{{ error }}</p>
      <p v-else-if="!data?.entries.length" class="muted">暂无备注</p>
      <div
        v-for="entry in data?.entries ?? []"
        :key="entry.id"
        role="listitem"
        class="preview-entry"
      >
        <time v-if="entry.note_date" class="muted">{{ entry.note_date }}</time>
        <p>{{ entry.content || '（空备注）' }}</p>
      </div>
    </div></el-popover
  >
</template>
<style scoped>
.note-preview {
  max-height: 360px;
  overflow: auto;
}
.preview-entry + .preview-entry {
  border-top: 1px solid var(--el-border-color-light);
  margin-top: 8px;
  padding-top: 8px;
}
.preview-entry p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 4px 0;
}
</style>
