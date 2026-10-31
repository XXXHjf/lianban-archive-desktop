<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { request, query, abort } from '@/shared/api';
import { errorMessage } from '@/shared/format';
import { useWorkspace } from '@/shared/workspace';
import StockLink from '@/components/StockLink.vue';
import {
  accountsBlocked,
  excludedAccountsKey,
  typeBlocked,
  setBlocked,
  preferenceError,
  filterShareholders,
} from './preferences';
import type { Shareholders, Stock, Subsidiaries } from './types';
const props = defineProps<{ stock: Stock }>();
const workspace = useWorkspace();
const data = ref<Shareholders | null>(null),
  error = ref(''),
  loading = ref(false),
  limit = ref(50);
const activeTab = ref('common');
const subsidiaries = ref<Subsidiaries | null>(null);
const subsidiaryLoading = ref(false),
  subsidiaryError = ref('');
let subsidiaryGeneration = 0;
let generation = 0;
const channel = `research-shareholders-${Math.random().toString(36).slice(2)}`;
const subsidiaryChannel = `${channel}-subsidiaries`;
const controllerKinds = [
  { kind: 'controller', label: '控股股东' },
  { kind: 'actual_controller', label: '实际控制人' },
] as const;
function controlNames(kind: string) {
  const names = data.value?.control_owners
    ?.filter((owner) => owner.kind === kind)
    .map((owner) => owner.name);
  if (names?.length) return names.join('、');
  if (loading.value) return '正在获取';
  if (error.value || data.value?.control_status === 'error') return '暂未获取成功';
  return data.value?.control_checked ? '来源未披露' : '资料正在获取';
}
function safeSource(value?: string) {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      [
        'data.eastmoney.com',
        'emweb.securities.eastmoney.com',
        'datacenter-web.eastmoney.com',
        'basic.10jqka.com.cn',
      ].includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
const controlSources = computed(() => [
  ...new Set(
    data.value?.control_owners
      ?.map((owner) => safeSource(owner.source_url))
      .filter((url): url is string => !!url) ?? [],
  ),
]);
const ownScope = computed(() => (activeTab.value === 'total' ? 'total' : 'float'));
const ownRows = computed(() => data.value?.own_holders?.[ownScope.value] ?? []);
const disclosedFloat = computed(() =>
  (data.value?.own_holders?.float ?? []).filter(
    (holder) => holder.holding_ratio !== null && Number.isFinite(holder.holding_ratio),
  ),
);
const floatTotal = computed(() =>
  disclosedFloat.value.reduce((sum, holder) => sum + (holder.holding_ratio ?? 0), 0),
);
const reportDate = computed(
  () =>
    [...new Set(ownRows.value.map((holder) => holder.report_date).filter(Boolean))].join(' / ') ||
    data.value?.profiles.find((profile) => profile.scope === ownScope.value)?.report_date ||
    '未披露',
);
function ratio(value: number | null) {
  return value === null || !Number.isFinite(value) ? '未披露' : `${value.toFixed(4)}%`;
}
async function loadSubsidiaries() {
  const current = ++subsidiaryGeneration;
  const code = props.stock.code;
  subsidiaryLoading.value = true;
  subsidiaryError.value = '';
  try {
    const result = await request<Subsidiaries>(
      query('/api/stock-subsidiaries', { code }),
      subsidiaryChannel,
    );
    if (!result || current !== subsidiaryGeneration || code !== props.stock.code) return;
    if (result.status === 'error') {
      subsidiaryError.value = '子公司资料更新失败，请稍后重试。';
      if (!subsidiaries.value?.rows.length) subsidiaries.value = result;
    } else subsidiaries.value = result;
  } catch (cause) {
    if (current === subsidiaryGeneration) subsidiaryError.value = errorMessage(cause);
  } finally {
    if (current === subsidiaryGeneration) subsidiaryLoading.value = false;
  }
}
watch(activeTab, (tab) => {
  if (tab === 'subs' && !subsidiaries.value && !subsidiaryLoading.value) void loadSubsidiaries();
});
const types = computed(() =>
  [
    ...new Set(data.value?.rows.flatMap((peer) => peer.holders.map((holder) => holder.type)) ?? []),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN')),
);
const rows = computed(() => filterShareholders(data.value?.rows ?? [], !accountsBlocked()));
const today = computed(() =>
  !data.value
    ? ''
    : data.value.today_status === 'unavailable'
      ? `${data.value.today} 暂无涨停数据，暂不标记最近交易日同涨停；历史档案及股东资料仍可查看`
      : `${data.value.today} 最近交易日 · ${data.value.today_status === 'provisional' ? '盘中暂定' : '收盘确认'}${data.value.today_stale ? ' · 涨停快照延迟' : ''}${data.value.today_fetched_at ? ` · ${data.value.today_fetched_at.slice(11, 16)} 获取` : ''}`,
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
    : '当前筛选下暂无关联股票，可调整屏蔽选项后查看';
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
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
watch(
  () => props.stock.code,
  () => {
    abort(channel);
    abort(subsidiaryChannel);
    subsidiaryGeneration++;
    subsidiaryLoading.value = false;
    subsidiaries.value = null;
    subsidiaryError.value = '';
    data.value = null;
    activeTab.value = 'common';
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  abort(channel);
  subsidiaryGeneration++;
  abort(subsidiaryChannel);
});
defineExpose({ finish: async () => true, dirty: false, saving: false });
</script>
<template>
  <div v-loading="loading" class="stack shareholder-panel">
    <section class="control-owners" aria-label="本股控制关系">
      <div v-for="item in controllerKinds" :key="item.kind">
        <div class="muted control-label">{{ item.label }}</div>
        <div>{{ controlNames(item.kind) }}</div>
      </div>
    </section>
    <div class="toolbar">
      <el-button size="small" :disabled="loading" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-tabs v-model="activeTab" aria-label="股东资料页签">
      <el-tab-pane label="共同股东" name="common">
        <p class="muted">{{ today }}</p>
        <template v-if="data">
          <div class="toolbar">
            <strong>屏蔽分类</strong
            ><el-checkbox
              v-for="type in types"
              :key="type"
              :model-value="typeBlocked(type)"
              @change="(value) => toggle(type, value === true)"
              >{{ type }}</el-checkbox
            ><el-checkbox
              :model-value="accountsBlocked()"
              @change="(value) => toggle(excludedAccountsKey, value === true)"
              >排除账户</el-checkbox
            ><span class="muted">{{ rows.length }} 只关联股票</span>
          </div>
          <el-alert
            v-if="preferenceError"
            :title="preferenceError"
            type="warning"
            :closable="false"
          />
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
                  ><el-table-column
                    prop="exclusion_reason"
                    label="排除原因"
                    min-width="130"
                  /> </el-table></template></el-table-column
            ><el-table-column label="股票" min-width="150"
              ><template #default="{ row }"
                ><StockLink
                  :code="row.code"
                  :name="row.name"
                  @click="workspace.editor.value = null" /></template></el-table-column
            ><el-table-column label="共同股东" width="105" prop="shared_count" /><el-table-column
              :label="`最近交易日同涨停${data.today ? ` · ${data.today}` : ''}`"
              min-width="140"
              ><template #default="{ row }"
                ><el-tag
                  v-if="row.today_together && data.today_status !== 'unavailable'"
                  type="warning"
                  size="small"
                  >最近交易日同涨停</el-tag
                ><span v-else class="muted">—</span></template
              ></el-table-column
            ></el-table
          >
          <el-button v-if="rows.length > limit" @click="limit += 50"
            >继续显示 · 已展示 {{ limit }} / {{ rows.length }} 只</el-button
          >
        </template>
      </el-tab-pane>
      <el-tab-pane
        v-for="scope in ['float', 'total']"
        :key="scope"
        :label="scope === 'float' ? '十大流通股东' : '十大股东'"
        :name="scope"
      >
        <div class="toolbar">
          <strong>{{ scope === 'float' ? '十大流通股东' : '十大股东' }}</strong
          ><span class="muted">报告期 {{ reportDate }}</span>
        </div>
        <div v-if="scope === 'float'" class="holding-summary">
          <div>
            合计持股占比
            <div class="muted">
              占总流通股本 · {{ disclosedFloat.length }} /
              {{ data?.own_holders?.float.length ?? 0 }} 位披露占比
            </div>
          </div>
          <strong class="holding-total">{{
            disclosedFloat.length ? `${floatTotal.toFixed(4)}%` : '未披露'
          }}</strong>
        </div>
        <el-table
          :data="ownRows"
          :empty-text="loading ? '正在获取股东资料' : '来源暂无可用股东名单'"
        >
          <el-table-column label="股东" min-width="220"
            ><template #default="{ row }"
              ><div>{{ row.name }}</div>
              <div class="muted">{{ row.type }}</div></template
            ></el-table-column
          >
          <el-table-column label="报告期" prop="report_date" min-width="110" />
          <el-table-column
            :label="scope === 'float' ? '占总流通股本' : '占总股本'"
            min-width="140"
            align="right"
            ><template #default="{ row }">{{ ratio(row.holding_ratio) }}</template></el-table-column
          >
        </el-table>
        <p class="muted">完整披露名单，不受共同股东页的屏蔽选项影响；未披露与 0 分开显示。</p>
      </el-tab-pane>
      <el-tab-pane label="子公司" name="subs">
        <div v-loading="subsidiaryLoading" class="stack">
          <div class="toolbar">
            <strong>子公司 · {{ subsidiaries?.rows.length ?? 0 }} 家</strong
            ><span class="muted">公告 {{ subsidiaries?.disclosure_date || '未披露' }}</span
            ><el-button size="small" :disabled="subsidiaryLoading" @click="loadSubsidiaries"
              >刷新子公司</el-button
            >
          </div>
          <el-alert
            v-if="subsidiaryError"
            :title="`${subsidiaryError}${subsidiaries?.rows.length ? ' 当前保留上次取得的资料。' : ''}`"
            type="warning"
            :closable="false"
          />
          <el-table
            :data="subsidiaries?.rows ?? []"
            :empty-text="
              subsidiaryLoading
                ? '正在获取子公司资料'
                : subsidiaryError
                  ? '子公司资料暂未获取成功'
                  : '来源暂无可用子公司资料'
            "
          >
            <el-table-column label="公司及参控关系" min-width="260"
              ><template #default="{ row }"
                ><div>{{ row.name }}</div>
                <div class="muted">
                  {{ row.relation || '参控关系未披露' }} · 持股 {{ row.holding_ratio || '未披露' }}
                </div></template
              ></el-table-column
            >
            <el-table-column label="主营业务" min-width="240"
              ><template #default="{ row }">{{
                row.business || '未披露'
              }}</template></el-table-column
            >
          </el-table>
          <p class="muted">
            {{ subsidiaries?.source }} · 业务按来源披露展示<span v-if="subsidiaries?.fetched_at">
              · 获取于 {{ subsidiaries.fetched_at.slice(0, 16).replace('T', ' ') }}</span
            ><a
              v-if="safeSource(subsidiaries?.source_url)"
              :href="safeSource(subsidiaries?.source_url)"
              target="_blank"
              rel="noopener noreferrer"
            >
              · 查看来源</a
            >
          </p>
        </div>
      </el-tab-pane>
    </el-tabs>
    <el-collapse v-if="data"
      ><el-collapse-item title="数据详情与来源" name="info"
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
        <p>{{ data.scope_note }}</p>
        <p>控制关系仅展示，不参与共同股东匹配；资料不代表实时持仓。</p>
        <p v-for="source in controlSources" :key="source">
          <a :href="source" target="_blank" rel="noopener noreferrer">控制关系来源</a>
        </p>
        <p>
          “排除账户”包括结算代持、客户汇总账户、指数基金/ETF，以及指定金融资产管理和政策性长期机构；分类屏蔽同时生效。具体原因见展开明细。
        </p>
      </el-collapse-item></el-collapse
    >
  </div>
</template>
<style scoped>
.control-owners {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border: 1px solid var(--la-border-subtle);
  border-radius: var(--la-radius-control);
  background: var(--la-bg-subtle);
}
.control-owners > div {
  padding: 14px 16px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.control-owners > div + div {
  border-left: 1px solid var(--la-border-subtle);
}
.control-label {
  margin-bottom: 4px;
}
.holding-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  margin: 16px 0;
  background: var(--la-bg-subtle);
  border-radius: var(--la-radius-control);
}
.holding-total {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.shareholder-panel a {
  color: var(--la-action-primary);
}
@media (max-width: 540px) {
  .control-owners {
    grid-template-columns: 1fr;
  }
  .control-owners > div + div {
    border-left: 0;
    border-top: 1px solid var(--la-border-subtle);
  }
}
</style>
