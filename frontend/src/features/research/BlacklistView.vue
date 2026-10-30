<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { request, post, abort } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage } from '@/shared/format';
import StockSearch from '@/components/StockSearch.vue';
import StockLink from '@/components/StockLink.vue';
import StockActions from '@/components/StockActions.vue';
import type { Blacklist, Stock } from './types';
const workspace = useWorkspace();
const data = ref<Blacklist | null>(null),
  selected = ref<Stock | null>(null),
  search = ref(''),
  error = ref(''),
  loading = ref(false),
  saving = ref(false);
const editable = computed(() => workspace.meta.value?.capabilities?.edit_blacklist === true);
let generation = 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<Blacklist>('/api/blacklist', 'research-blacklist');
    if (result && current === generation) data.value = result;
  } catch (cause) {
    if (current === generation) error.value = errorMessage(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function change(code: string, action: 'add' | 'remove') {
  if (!editable.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await post<Blacklist>(
      '/api/blacklist',
      { code, action },
      'research-blacklist-write',
    );
    if (!result) throw new Error('未能确认黑名单状态，请刷新核实。');
    data.value = result;
    selected.value = null;
    search.value = '';
    await workspace.changed();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
watch(() => workspace.revision.value, load, { immediate: true });
onBeforeUnmount(() => {
  generation++;
  abort('research-blacklist');
});
</script>
<template>
  <section v-loading="loading" class="panel stack">
    <div class="panel-header">
      <h2>
        黑名单 <small>{{ data?.total ?? 0 }} 只</small>
      </h2>
      <el-button :disabled="saving" @click="load">刷新列表</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="editable" class="toolbar">
      <StockSearch
        v-model="search"
        :disabled="saving"
        @update:model-value="selected = null"
        @select="selected = $event"
      /><el-button
        type="primary"
        :disabled="!selected || saving"
        :loading="saving"
        @click="selected && change(selected.code, 'add')"
        >加入黑名单</el-button
      >
    </div>
    <el-alert v-else title="当前为只读模式。" type="info" :closable="false" />
    <el-table :data="data?.rows ?? []" empty-text="黑名单还是空的" row-key="code">
      <el-table-column label="股票" min-width="150"
        ><template #default="{ row }"
          ><StockLink :code="row.code" :name="row.name" />
          <div class="muted mono">{{ row.code }}</div></template
        ></el-table-column
      >
      <el-table-column label="注册省份" min-width="100"
        ><template #default="{ row }">{{
          row.registered_province || row.province || row.region || '—'
        }}</template></el-table-column
      >
      <el-table-column label="标签" min-width="200"
        ><template #default="{ row }"
          ><div class="stock-tags">
            <el-tag v-for="tag in row.tags" :key="tag" size="small">{{ tag }}</el-tag>
          </div></template
        ></el-table-column
      >
      <el-table-column label="加入时间" min-width="165"
        ><template #default="{ row }">{{
          row.created_at?.replace('T', ' ').slice(0, 16)
        }}</template></el-table-column
      >
      <el-table-column label="操作" min-width="230"
        ><template #default="{ row }"
          ><StockActions :stock="row as Stock" compact /><el-button
            v-if="editable"
            size="small"
            text
            type="danger"
            :disabled="saving"
            @click="change(row.code, 'remove')"
            >移除</el-button
          ></template
        ></el-table-column
      >
    </el-table>
  </section>
</template>
