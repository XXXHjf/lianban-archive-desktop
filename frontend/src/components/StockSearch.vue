<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Search } from '@element-plus/icons-vue';
import { request, query, abort } from '@/shared/api';
interface Stock {
  code: string;
  name: string;
  market?: string;
  initials?: string;
  value?: string;
}
const props = withDefaults(
  defineProps<{ modelValue?: string; placeholder?: string; disabled?: boolean }>(),
  { modelValue: '', placeholder: '名称、代码或首字母', disabled: false },
);
const emit = defineEmits<{ 'update:modelValue': [string]; select: [Stock] }>();
const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
});
const channel = `stock-search-${Math.random().toString(36).slice(2)}`,
  message = ref('');
async function suggestions(text: string, callback: (rows: Stock[]) => void) {
  message.value = '';
  if (!text.trim()) {
    callback([]);
    return;
  }
  try {
    const data = await request<{ rows: Stock[] }>(
      query('/api/stocks', { q: text.trim() }),
      channel,
    );
    if (data)
      callback(data.rows.slice(0, 20).map((row) => ({ ...row, value: `${row.name} ${row.code}` })));
  } catch {
    message.value = '检索暂不可用，仍可输入六位代码';
    callback([]);
  }
}
function select(item: Record<string, unknown>) {
  if (typeof item.code === 'string' && typeof item.name === 'string')
    emit('select', { code: item.code, name: item.name });
}
function enter() {
  const code = value.value.trim().match(/(?:^|\s)(\d{6})$/)?.[1];
  if (code) {
    abort(channel);
    emit('select', { code, name: '' });
  }
}
onBeforeUnmount(() => abort(channel));
</script>
<template>
  <div class="stock-search">
    <el-autocomplete
      v-model="value"
      :disabled="disabled"
      :fetch-suggestions="suggestions"
      :trigger-on-focus="false"
      :debounce="220"
      :placeholder="placeholder"
      clearable
      :prefix-icon="Search"
      @select="select"
      @keyup.enter="enter"
      ><template #default="{ item }"
        ><div class="search-result">
          <span>{{ item.name }}</span
          ><span class="mono muted">{{ item.code }} · {{ item.market }}</span>
        </div></template
      ></el-autocomplete
    ><small v-if="message" role="status" class="muted">{{ message }}</small>
  </div>
</template>
<style scoped>
.stock-search {
  min-width: 220px;
  max-width: 480px;
}
.el-autocomplete {
  width: 100%;
}
.search-result {
  display: flex;
  gap: 24px;
  justify-content: space-between;
}
small {
  display: block;
}
</style>
