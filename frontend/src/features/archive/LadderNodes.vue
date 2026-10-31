<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { post, query, request } from '@/shared/api';
import { errorMessage } from '@/shared/format';
import { useWorkspace } from '@/shared/workspace';
import { tradingDateDisabled } from '@/shared/tradingCalendar';
import type { DailyData, LadderNode } from './models';

const props = defineProps<{ data: DailyData }>();
const ws = useWorkspace();
const disabledDate = (value: Date) =>
  tradingDateDisabled(value, ws.meta.value, ws.meta.value?.dates || []);
const emit = defineEmits<{ changed: [] }>();
const recordsOpen = ref(false),
  createOpen = ref(false),
  history = ref(false);
const selected = ref(''),
  error = ref(''),
  busy = ref(false);
const name = ref(''),
  day = ref(''),
  boards = ref(1),
  cohort = ref<DailyData | null>(null);
const editable = computed(() => ws.meta.value?.capabilities?.edit_tags !== false);
const labels: Record<string, string> = {
  active: '有效',
  expired: '已失效',
  deleted: '已手动删除',
  pending: '数据待确认',
  superseded: '来源已修正',
};
const nodes = computed(() =>
  (props.data.nodes || []).filter((n) =>
    selected.value
      ? n.id === selected.value
      : history.value || ['active', 'pending'].includes(n.status),
  ),
);
const members = computed(() => cohort.value?.rows.filter((r) => r.boards === boards.value) || []);
const options = computed(() => cohort.value?.board_counts || []);
const canCreate = computed(
  () =>
    cohort.value?.data_status === 'ok' && !cohort.value?.provisional && members.value.length > 0,
);
let generation = 0;
watch(day, async (value) => {
  const token = ++generation;
  cohort.value = null;
  if (!value) return;
  try {
    const data = await request<DailyData>(query('/api/date', { date: value }), 'node-cohort');
    if (token === generation) cohort.value = data;
  } catch (cause) {
    if (token === generation) error.value = errorMessage(cause);
  }
});
watch(
  () => props.data.date,
  () => {
    recordsOpen.value = false;
    createOpen.value = false;
    selected.value = '';
  },
);
function open(id = '') {
  selected.value = id;
  recordsOpen.value = true;
  error.value = '';
}
function adding() {
  day.value = props.data.date;
  cohort.value = props.data;
  boards.value = 1;
  name.value = '';
  error.value = '';
  createOpen.value = true;
}
async function save() {
  if (!canCreate.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await post(
      '/api/ladder-nodes',
      { action: 'create', date: day.value, boards: boards.value, name: name.value },
      'node-write',
    );
    createOpen.value = false;
    emit('changed');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function remove(node: LadderNode, code?: string) {
  try {
    await ElMessageBox.confirm(
      `从 ${props.data.date} 起${code ? '移除此股票的' : '删除整个'}“${node.name}节点”。此前历史保留，后续刷新不会恢复。`,
      '删除节点',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await post(
      '/api/ladder-nodes',
      { action: 'remove', id: node.id, date: props.data.date, ...(code ? { code } : {}) },
      'node-write',
    );
    emit('changed');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function identify() {
  busy.value = true;
  error.value = '';
  try {
    const result = await post<{ note: string; status: string }>(
      '/api/ladder-nodes/identify',
      { date: props.data.date },
      'node-identify',
    );
    if (result?.status === 'pending') error.value = result.note;
    emit('changed');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
defineExpose({ open });
</script>
<template>
  <div class="node-toolbar">
    <span v-if="data.provisional" class="daily-meta">节点在收盘确认后更新</span>
    <span v-else-if="data.node_check?.status === 'pending'" class="daily-meta"
      >节点待判定 · 可在记录中重试</span
    >
    <el-button v-if="editable" size="small" @click="adding">添加节点</el-button>
    <el-button size="small" @click="open()">节点记录</el-button>
  </div>
  <el-drawer v-model="recordsOpen" title="梯队节点记录" size="min(640px, 96vw)">
    <p>截至 {{ data.date }} · 失效节点仅在记录中留存。</p>
    <div class="row">
      <el-checkbox v-model="history" @change="selected = ''">包含已失效／已删除节点</el-checkbox>
      <el-button v-if="selected" link @click="selected = ''">查看全部</el-button>
      <el-button v-if="editable" :loading="busy" @click="identify">识别／重试本日</el-button>
    </div>
    <p v-if="error" role="alert" class="node-error">{{ error }}</p>
    <p v-if="data.node_check" class="daily-meta">{{ data.node_check.note }}</p>
    <el-empty v-if="!nodes.length" description="此范围暂无节点，可手动添加或识别本日" />
    <section v-for="node in nodes" :key="node.id" class="node-record">
      <header>
        <strong>{{ node.name }}节点</strong
        ><el-tag size="small" :type="node.status === 'active' ? 'warning' : 'info'">{{
          labels[node.status] || node.status
        }}</el-tag>
      </header>
      <p class="daily-meta">
        {{ node.date }} · {{ node.boards }}板起始 · {{ node.kind === 'manual' ? '手动' : '自动' }} ·
        当日有效 {{ node.codes.length }}/{{ node.members.length }}只
      </p>
      <p v-if="node.evidence" class="daily-meta">{{ node.evidence }}</p>
      <el-button
        v-if="node.anchor && /^(60|00)\d{4}$/.test(node.anchor)"
        link
        type="primary"
        @click="ws.openIntraday(node.anchor, node.date)"
        >查看锚定股当日分时</el-button
      >
      <p v-if="node.deleted_from" class="daily-meta">{{ node.deleted_from }} 起已手动删除</p>
      <div v-for="member in node.members" :key="member.code" class="node-member">
        <span
          >{{ member.name }} <small>{{ member.code }}</small></span
        >
        <span class="daily-meta">{{
          member.active
            ? '延续'
            : member.excluded_from && member.excluded_from <= data.date
              ? '手动移除'
              : node.status === 'pending'
                ? '待确认'
                : '已退出'
        }}</span>
        <el-button
          v-if="editable && member.active && node.status === 'active'"
          link
          type="danger"
          :disabled="busy"
          @click="remove(node, member.code)"
          >移除此节点</el-button
        >
      </div>
      <el-button
        v-if="editable && !['deleted', 'superseded'].includes(node.status)"
        size="small"
        type="danger"
        plain
        :disabled="busy || data.data_status !== 'ok' || data.provisional"
        @click="remove(node)"
        >删除整个节点</el-button
      >
    </section>
  </el-drawer>
  <el-dialog
    v-model="createOpen"
    title="添加梯队节点"
    width="min(480px, 94vw)"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="起始交易日"
        ><el-date-picker
          v-model="day"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          :disabled-date="disabledDate"
      /></el-form-item>
      <el-form-item label="起始梯队"
        ><el-select v-model="boards"
          ><el-option
            v-for="option in options"
            :key="option.boards"
            :value="option.boards"
            :label="`${option.boards === 1 ? '首板' : option.boards + '板'} · ${option.count}只`" /></el-select
      ></el-form-item>
      <el-form-item label="节点名称"
        ><el-input v-model="name" maxlength="60" placeholder="例如：襄阳轴承爆量"
      /></el-form-item>
      <p>
        {{
          canCreate
            ? `绑定该日此梯队 ${members.length} 只股票，后续仅保留连续晋级成员。`
            : '请先选择已确认收盘且有股票的日期和梯队。'
        }}
      </p>
      <p class="daily-meta">{{ members.map((m) => m.name).join('、') }}</p>
      <p v-if="error" role="alert" class="node-error">{{ error }}</p>
    </el-form>
    <template #footer
      ><el-button @click="createOpen = false">取消</el-button
      ><el-button
        type="primary"
        :disabled="!canCreate || !name.trim()"
        :loading="busy"
        @click="save"
        >添加节点</el-button
      ></template
    >
  </el-dialog>
</template>
<style scoped>
.node-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
}
.node-toolbar .el-button + .el-button {
  margin-left: 0;
}
.node-record {
  padding: 16px 0;
  border-bottom: 1px solid #dbe2ea;
}
.node-record header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.node-member {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}
.node-member small {
  color: #596779;
}
.node-error {
  color: #b91c1c;
}
</style>
