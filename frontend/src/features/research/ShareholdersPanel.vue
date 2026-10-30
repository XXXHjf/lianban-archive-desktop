<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { request, query, abort } from '@/shared/api';
import { errorMessage } from '@/shared/format';
import { useWorkspace } from '@/shared/workspace';
import StockLink from '@/components/StockLink.vue';
import { typeBlocked, setBlocked, preferenceError, filterShareholders } from './preferences';
import type { Shareholders, Stock } from './types';
const props = defineProps<{ stock: Stock }>();
const workspace = useWorkspace();
const data = ref<Shareholders | null>(null),
  error = ref(''),
  loading = ref(false),
  limit = ref(50);
let generation = 0;
const channel = `research-shareholders-${Math.random().toString(36).slice(2)}`;
const types = computed(() =>
  [
    ...new Set(data.value?.rows.flatMap((peer) => peer.holders.map((holder) => holder.type)) ?? []),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN')),
);
const rows = computed(() => filterShareholders(data.value?.rows ?? []));
const today = computed(() =>
  !data.value
    ? ''
    : data.value.today_status === 'unavailable'
      ? '今天的涨停数据尚未取得，暂不标记同涨停'
      : `${data.value.today} · ${data.value.today_status === 'provisional' ? '盘中暂定' : '收盘确认'}${data.value.today_stale ? ' · 涨停快照延迟' : ''}${data.value.today_fetched_at ? ` · ${data.value.today_fetched_at.slice(11, 16)} 获取` : ''}`,
);
const empty = computed(() => {
  if (!data.value) return '';
  if (!data.value.profiles.some((profile) => profile.report_date))
    return data.value.status === 'error'
      ? '股东资料暂未获取成功，稍后自动重试'
      : data.value.profiles.length === 2
        ? '来源暂无可用股东资料'
        : '股东资料正在获取，请稍后再查看';
  return !data.value.rows.length
    ? '在已取得资料的股票中，暂未发现共同股东'
    : '当前分类下的共同股东已全部屏蔽，可取消勾选后查看关联股票';
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  data.value = null;
  limit.value = 50;
  try {
    const result = await request<Shareholders>(
      query('/api/stock-shareholders', { code: props.stock.code }),
      channel,
    );
    if (result && current === generation) data.value = result;
  } catch (cause) {
    if (current === generation) error.value = errorMessage(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
function toggle(type: string, value: boolean) {
  setBlocked(type, value);
  limit.value = 50;
}
watch(() => props.stock.code, load, { immediate: true });
onBeforeUnmount(() => {
  generation++;
  abort(channel);
});
defineExpose({ finish: async () => true, dirty: false, saving: false });
</script>
<template>
  <div v-loading="loading" class="stack">
    <div class="toolbar">
      <span class="muted">{{ today }}</span
      ><el-button size="small" :disabled="loading" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="data">
      <el-collapse
        ><el-collapse-item title="数据详情" name="info"
          ><p>
            {{ data.source }} · 已取得 {{ data.coverage }} / {{ data.requested }} 只股票{{
              data.status === 'updating'
                ? ' · 正在更新'
                : data.status === 'error'
                  ? ' · 更新失败'
                  : ''
            }}
          </p>
          <p v-if="data.profiles.some((profile) => profile.report_date)">
            本股资料获取于
            {{
              data.profiles
                .filter((profile) => profile.report_date)
                .map((profile) => profile.fetched_at)
                .sort()[0]
                ?.slice(0, 16)
                .replace('T', ' ')
            }}
          </p>
        </el-collapse-item></el-collapse
      >
      <div class="toolbar">
        <strong>屏蔽分类</strong
        ><el-checkbox
          v-for="type in types"
          :key="type"
          :model-value="typeBlocked(type)"
          @change="(value) => toggle(type, value === true)"
          >{{ type }}</el-checkbox
        ><span class="muted">{{ rows.length }} 只关联股票</span>
      </div>
      <el-alert v-if="preferenceError" :title="preferenceError" type="warning" :closable="false" />
      <el-table :data="rows.slice(0, limit)" row-key="code" :empty-text="empty"
        ><el-table-column type="expand"
          ><template #default="{ row }"
            ><el-table :data="row.holders" size="small"
              ><el-table-column prop="name" label="共同股东" min-width="180" /><el-table-column
                prop="type"
                label="分类"
                width="90"
              /><el-table-column label="报告期" min-width="240"
                ><template #default="{ row: holder }"
                  ><span
                    v-for="(report, index) in holder.reports"
                    :key="`${report.scope}-${report.date}`"
                    >{{ index ? ' / ' : ''
                    }}{{
                      report.scope === 'total'
                        ? '十大股东'
                        : report.scope === 'float'
                          ? '十大流通'
                          : report.scope
                    }}
                    {{ report.date }}</span
                  ></template
                ></el-table-column
              ></el-table
            ></template
          ></el-table-column
        ><el-table-column label="股票" min-width="150"
          ><template #default="{ row }"
            ><StockLink
              :code="row.code"
              :name="row.name"
              @click="workspace.editor.value = null" /></template></el-table-column
        ><el-table-column label="共同股东" width="105" prop="shared_count" /><el-table-column
          label="最新涨停状态"
          min-width="140"
          ><template #default="{ row }"
            ><el-tag
              v-if="row.today_together && data.today_status !== 'unavailable'"
              type="warning"
              size="small"
              >今日同涨停</el-tag
            ><span v-else class="muted">—</span></template
          ></el-table-column
        ></el-table
      >
      <el-button v-if="rows.length > limit" @click="limit += 50"
        >继续显示 · 已展示 {{ limit }} / {{ rows.length }} 只</el-button
      >
    </template>
  </div>
</template>
