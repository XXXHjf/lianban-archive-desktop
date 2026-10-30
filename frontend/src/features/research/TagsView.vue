<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { request, post, query, abort } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage } from '@/shared/format';
import StockLink from '@/components/StockLink.vue';
import StockSearch from '@/components/StockSearch.vue';
import StockActions from '@/components/StockActions.vue';
import type { Catalog, Members, Revision, Stock } from './types';
const workspace = useWorkspace();
const catalog = ref<Catalog | null>(null),
  members = ref<Members | null>(null);
const filter = ref(''),
  error = ref(''),
  feedback = ref(''),
  loading = ref(false),
  membersLoading = ref(false),
  saving = ref(false);
const renamed = ref(''),
  parent = ref(''),
  stock = ref<Stock | null>(null),
  search = ref('');
const nodeOpen = ref(false),
  nodeName = ref(''),
  nodeParent = ref('');
const batchOpen = ref(false),
  batchText = ref(''),
  batchTag = ref(''),
  batchBusy = ref(false),
  batchRevision = ref<Revision>(''),
  batchRows = ref<BatchRow[]>([]);
const batchCatalogReady = ref(false);
let batchRequestCount = 0;
interface BatchRow {
  token: string;
  options: Stock[];
  code: string;
  error: string;
}
interface TreeNode {
  name: string;
  label: string;
  children: TreeNode[];
}
interface RenameResult {
  needs_merge?: boolean;
  source: string;
  target: string;
  source_count?: number;
  target_count?: number;
  combined_count?: number;
  revision: Revision;
  name: string;
}
interface DeleteResult {
  needs_confirmation?: boolean;
  name: string;
  count: number;
  children?: number;
  revision: Revision;
  deleted?: boolean;
}
const selected = computed(() => workspace.route.value.tag);
const editable = computed(
  () =>
    workspace.meta.value?.capabilities?.manage_tags ??
    workspace.meta.value?.capabilities?.edit_tags !== false,
);
const tree = computed(() => {
  const parents = new Map((catalog.value?.hierarchy ?? []).map((node) => [node.name, node.parent]));
  const names = new Set((catalog.value?.tags ?? []).map((tag) => tag.name));
  const nodes = new Map(
    (catalog.value?.tags ?? []).map((tag) => [
      tag.name,
      { name: tag.name, label: `${tag.name} · ${tag.count}`, children: [] as TreeNode[] },
    ]),
  );
  const roots: TreeNode[] = [];
  for (const tag of catalog.value?.tags ?? []) {
    const node = nodes.get(tag.name)!;
    const ancestor = parents.get(tag.name);
    if (ancestor && names.has(ancestor) && ancestor !== tag.name)
      nodes.get(ancestor)!.children.push(node);
    else roots.push(node);
  }
  const term = filter.value.trim().toLocaleLowerCase();
  const prune = (node: TreeNode): TreeNode | null => {
    if (!term || node.name.toLocaleLowerCase().includes(term)) return node;
    const children = node.children.map(prune).filter((item): item is TreeNode => item !== null);
    return children.length ? { ...node, children } : null;
  };
  return roots.map(prune).filter((item): item is TreeNode => item !== null);
});
const parentChoices = computed(() =>
  (catalog.value?.tags ?? []).filter((tag) => {
    let name = tag.name;
    const seen = new Set<string>();
    while (name && !seen.has(name)) {
      if (name === selected.value) return false;
      seen.add(name);
      name = catalog.value?.hierarchy?.find((node) => node.name === name)?.parent ?? '';
    }
    return true;
  }),
);
const batchCodes = computed(() => [
  ...new Set(batchRows.value.map((row) => row.code).filter(Boolean)),
]);
let catalogGeneration = 0,
  memberGeneration = 0,
  batchGeneration = 0;
async function load() {
  const current = ++catalogGeneration;
  loading.value = true;
  error.value = '';
  try {
    const result = await request<Catalog>('/api/tags', 'research-tags');
    if (!result || current !== catalogGeneration) return;
    catalog.value = result;
    if (selected.value && !result.tags.some((tag) => tag.name === selected.value))
      workspace.patchRoute({ tag: '' }, true);
  } catch (cause) {
    if (current === catalogGeneration) error.value = errorMessage(cause);
  } finally {
    if (current === catalogGeneration) loading.value = false;
  }
}
async function loadMembers(name: string) {
  const current = ++memberGeneration;
  abort('research-tag-members');
  members.value = null;
  renamed.value = name;
  parent.value = catalog.value?.hierarchy?.find((node) => node.name === name)?.parent ?? '';
  stock.value = null;
  search.value = '';
  if (!name) {
    membersLoading.value = false;
    return;
  }
  membersLoading.value = true;
  try {
    const result = await request<Members>(
      query('/api/tag-stocks', { tag: name }),
      'research-tag-members',
    );
    if (result && current === memberGeneration && selected.value === name) members.value = result;
  } catch (cause) {
    if (current === memberGeneration) error.value = errorMessage(cause);
  } finally {
    if (current === memberGeneration) membersLoading.value = false;
  }
}
async function afterWrite(name = selected.value) {
  workspace.patchRoute({ tag: name }, true);
  await load();
  await loadMembers(selected.value);
  void workspace.changed().catch((cause) => {
    error.value = errorMessage(cause);
  });
}
async function writeMembership(code: string, action: 'add' | 'remove') {
  if (!editable.value || saving.value || !members.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await post<unknown>(
      '/api/tag-stocks',
      { tag: selected.value, code, action, revision: members.value.revision },
      'research-tag-write',
    );
    if (!result) throw new Error('未能确认股票标签已保存，请刷新核实。');
    feedback.value = action === 'add' ? '已加入标签。' : '已移除标签。';
    await afterWrite();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function confirm(message: string, title: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      type: 'warning',
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      closeOnClickModal: false,
    });
    return true;
  } catch (cause) {
    if (cause === 'cancel' || cause === 'close') return false;
    throw cause;
  }
}
async function rename() {
  if (!editable.value || saving.value || !members.value || !renamed.value.trim()) return;
  saving.value = true;
  error.value = '';
  try {
    let result = await post<RenameResult>(
      '/api/tag-rename',
      {
        source: selected.value,
        target: renamed.value.trim(),
        revision: members.value.revision,
        merge: false,
      },
      'research-tag-write',
    );
    if (!result) throw new Error('未能确认改名结果，请刷新核实。');
    if (result.needs_merge) {
      if (
        !(await confirm(
          `“${result.target}”已存在（${result.target_count} 只）。将“${result.source}”（${result.source_count} 只）合并后共 ${result.combined_count} 只股票，重复归属会去重。`,
          '合并标签',
        ))
      )
        return;
      result = await post<RenameResult>(
        '/api/tag-rename',
        { source: result.source, target: result.target, revision: result.revision, merge: true },
        'research-tag-write',
      );
      if (!result) throw new Error('未能确认合并结果，请刷新核实。');
    }
    feedback.value = '标签名称已保存，全部股票已同步。';
    await afterWrite(result.name);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function deleteTag() {
  if (!editable.value || saving.value || !members.value) return;
  saving.value = true;
  error.value = '';
  try {
    let result = await post<DeleteResult>(
      '/api/tag-delete',
      { tag: selected.value, revision: members.value.revision, confirm: false },
      'research-tag-write',
    );
    if (!result) throw new Error('未能确认删除结果，请刷新核实。');
    if (result.needs_confirmation) {
      if (
        !(await confirm(
          `删除“${result.name}”会从 ${result.count} 只股票移除此标签，其他标签和备注保留，默认数据更新也不会补回。${result.children ? `${result.children} 个直属子级会保留并移到上一级。` : ''}`,
          '删除标签',
        ))
      )
        return;
      result = await post<DeleteResult>(
        '/api/tag-delete',
        { tag: result.name, revision: result.revision, confirm: true },
        'research-tag-write',
      );
    }
    if (!result?.deleted) throw new Error('未能确认删除结果，请刷新核实。');
    feedback.value = `已删除“${result.name}”。`;
    await afterWrite('');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function saveNode(action: 'create' | 'parent') {
  if (!editable.value || saving.value || !catalog.value) return;
  const name = action === 'create' ? nodeName.value.trim() : selected.value;
  if (!name) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await post<{ name: string }>(
      '/api/tag-node',
      {
        name,
        parent: action === 'create' ? nodeParent.value : parent.value,
        action,
        revision: catalog.value.revision,
      },
      'research-tag-write',
    );
    if (!result) throw new Error('未能确认层级关系已保存。');
    nodeOpen.value = false;
    feedback.value = '标签层级已保存。';
    await afterWrite(action === 'create' ? nodeParent.value || result.name : result.name);
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
function openNode(parentName = '') {
  nodeName.value = '';
  nodeParent.value = parentName;
  nodeOpen.value = true;
}
async function openBatch() {
  if (!editable.value || saving.value) return;
  batchOpen.value = true;
  batchTag.value = selected.value;
  batchText.value = '';
  batchRows.value = [];
  error.value = '';
  batchBusy.value = true;
  batchCatalogReady.value = false;
  try {
    const result = await request<Catalog>('/api/tags', 'research-batch-catalog');
    if (result && batchOpen.value) {
      catalog.value = result;
      batchRevision.value = result.revision;
      batchCatalogReady.value = true;
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    batchBusy.value = false;
  }
}
async function resolveBatch() {
  const current = ++batchGeneration;
  batchBusy.value = true;
  error.value = '';
  batchRows.value = [];
  const tokens = [
    ...new Set(
      batchText.value
        .split(/[\s,，;；、]+/)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
  if (tokens.length > 200) {
    error.value = '每批最多解析 200 只股票，请分批处理。';
    batchBusy.value = false;
    return;
  }
  batchRequestCount = tokens.length;
  try {
    const rows: BatchRow[] = [];
    let cursor = 0;
    const worker = async () => {
      while (current === batchGeneration && batchOpen.value && cursor < tokens.length) {
        const index = cursor++,
          token = tokens[index]!;
        try {
          const result = await request<{ rows: Stock[] }>(
            query('/api/stocks', { q: token }),
            `research-batch-search-${index}`,
          );
          if (!result) {
            rows[index] = { token, options: [], code: '', error: '查询已取消，请重新解析' };
            continue;
          }
          const exact = result.rows.filter(
            (row) =>
              row.code === token || row.name === token || row.initials === token.toUpperCase(),
          );
          const code =
            exact.length === 1
              ? exact[0]!.code
              : result.rows.length === 1
                ? result.rows[0]!.code
                : '';
          rows[index] = {
            token,
            options: result.rows,
            code,
            error: result.rows.length ? '' : '未找到已收录股票',
          };
        } catch (cause) {
          rows[index] = { token, options: [], code: '', error: errorMessage(cause) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, tokens.length) }, worker));
    if (current === batchGeneration && batchOpen.value) batchRows.value = rows;
  } finally {
    if (current === batchGeneration) batchBusy.value = false;
  }
}
function invalidateBatch() {
  batchGeneration++;
  for (let index = 0; index < batchRequestCount; index++) abort(`research-batch-search-${index}`);
  batchRows.value = [];
  batchBusy.value = false;
}
async function saveBatch() {
  if (
    !editable.value ||
    saving.value ||
    !batchCatalogReady.value ||
    !batchTag.value.trim() ||
    !batchCodes.value.length ||
    batchRows.value.some((row) => !row.code)
  )
    return;
  saving.value = true;
  error.value = '';
  try {
    const result = await post<{ catalog: Catalog }>(
      '/api/tag-stocks',
      { tag: batchTag.value.trim(), codes: batchCodes.value, revision: batchRevision.value },
      'research-batch-write',
    );
    if (!result) throw new Error('未能确认批量标签已保存。');
    batchRevision.value = result.catalog.revision;
    batchOpen.value = false;
    feedback.value = `已为 ${batchCodes.value.length} 只股票加入标签。`;
    await afterWrite(batchTag.value.trim());
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
watch(selected, loadMembers, { immediate: true });
watch(
  () => workspace.revision.value,
  async () => {
    if (!saving.value) {
      await load();
      await loadMembers(selected.value);
    }
  },
  { immediate: true },
);
watch(catalog, () => {
  parent.value =
    catalog.value?.hierarchy?.find((node) => node.name === selected.value)?.parent ?? '';
});
onBeforeUnmount(() => {
  catalogGeneration++;
  memberGeneration++;
  invalidateBatch();
  abort('research-tags');
  abort('research-tag-members');
  abort('research-batch-catalog');
});
</script>
<template>
  <section class="stack">
    <div class="panel toolbar page-controls">
      <h2>标签目录</h2>
      <span class="muted">{{ catalog?.total ?? 0 }} 个标签 · {{ catalog?.stocks ?? 0 }} 只股票</span
      ><el-button :disabled="saving" @click="load().then(() => loadMembers(selected))"
        >刷新列表</el-button
      ><template v-if="editable"
        ><el-button :disabled="saving || !catalog" @click="openNode()">新建父级</el-button
        ><el-button type="primary" :disabled="saving || !catalog" @click="openBatch"
          >批量加入股票</el-button
        ></template
      >
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="feedback" :title="feedback" type="success" closable @close="feedback = ''" />
    <el-alert v-if="!editable" title="当前为只读模式。" type="info" :closable="false" />
    <div class="tag-layout">
      <aside v-loading="loading" class="panel stack">
        <el-input v-model="filter" clearable placeholder="筛选标签（包含父级路径）" /><el-tree
          :data="tree"
          node-key="name"
          :current-node-key="selected"
          highlight-current
          default-expand-all
          :expand-on-click-node="false"
          empty-text="没有匹配的标签"
          @node-click="(node: TreeNode) => !saving && workspace.patchRoute({ tag: node.name })"
        />
      </aside>
      <div v-loading="membersLoading" class="panel stack">
        <template v-if="selected">
          <div class="panel-header">
            <h3>
              {{ selected }} <small>{{ members?.count ?? '—' }} 只（含子级）</small>
            </h3>
            <el-button
              v-if="editable"
              :disabled="saving || !members"
              type="danger"
              plain
              @click="deleteTag"
              >删除标签</el-button
            >
          </div>
          <template v-if="editable"
            ><el-form label-width="64px" :disabled="saving || !members"
              ><el-form-item label="名称"
                ><el-input v-model="renamed" maxlength="30" /><el-button @click="rename"
                  >改名 / 合并</el-button
                ></el-form-item
              ><el-form-item label="父级"
                ><el-select v-model="parent" filterable clearable placeholder="无父级"
                  ><el-option
                    v-for="tag in parentChoices"
                    :key="tag.name"
                    :value="tag.name" /></el-select
                ><el-button @click="saveNode('parent')">保存父级</el-button
                ><el-button @click="openNode(selected)">新建子级</el-button></el-form-item
              ></el-form
            >
            <div class="toolbar">
              <StockSearch
                v-model="search"
                :disabled="saving || !members"
                @update:model-value="stock = null"
                @select="stock = $event"
              /><el-button
                :disabled="!stock || saving || !members"
                @click="stock && writeMembership(stock.code, 'add')"
                >加入标签</el-button
              >
            </div></template
          >
          <el-table :data="members?.rows ?? []" row-key="code" empty-text="暂无所属股票"
            ><el-table-column label="股票" min-width="160"
              ><template #default="{ row }"
                ><StockLink :code="row.code" :name="row.name" /><span class="muted mono">
                  {{ row.code }}</span
                ><el-tag v-if="row.direct === false" size="small" type="info"
                  >来自子级</el-tag
                ></template
              ></el-table-column
            ><el-table-column label="操作" min-width="240"
              ><template #default="{ row }"
                ><StockActions :stock="row as Stock" compact /><el-button
                  v-if="editable && row.direct !== false"
                  size="small"
                  text
                  type="danger"
                  :disabled="saving"
                  @click="writeMembership(row.code, 'remove')"
                  >移除标签</el-button
                ></template
              ></el-table-column
            ></el-table
          > </template
        ><el-empty v-else description="选择一个标签查看所属股票" />
      </div>
    </div>
    <el-dialog
      v-model="nodeOpen"
      title="新建标签"
      width="min(520px, 94vw)"
      :close-on-click-modal="false"
      :show-close="!saving"
      :close-on-press-escape="!saving"
      ><el-form label-width="64px" :disabled="saving"
        ><el-form-item label="名称"><el-input v-model="nodeName" maxlength="30" /></el-form-item
        ><el-form-item label="父级"
          ><el-select v-model="nodeParent" clearable filterable placeholder="无父级"
            ><el-option
              v-for="tag in catalog?.tags ?? []"
              :key="tag.name"
              :value="tag.name" /></el-select></el-form-item></el-form
      ><el-alert v-if="error" :title="error" type="error" :closable="false" /><template #footer
        ><el-button :disabled="saving" @click="nodeOpen = false">取消</el-button
        ><el-button
          type="primary"
          :loading="saving"
          :disabled="!nodeName.trim()"
          @click="saveNode('create')"
          >创建</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      v-model="batchOpen"
      title="批量加入标签"
      width="min(760px, 94vw)"
      :close-on-click-modal="false"
      :show-close="!saving"
      :close-on-press-escape="!saving"
      @closed="invalidateBatch"
      ><div class="stack">
        <p class="muted">
          输入股票代码、全名或拼音首字母，以空格、换行、逗号分隔。先解析并核对，再批量保存。
        </p>
        <el-select
          v-model="batchTag"
          filterable
          default-first-option
          placeholder="选择已有标签"
          :disabled="saving || batchBusy"
          ><el-option
            v-for="tag in catalog?.tags ?? []"
            :key="tag.name"
            :value="tag.name" /></el-select
        ><el-input
          v-model="batchText"
          type="textarea"
          :rows="4"
          :disabled="saving"
          placeholder="000001 样本股票"
          @input="invalidateBatch"
        /><el-button
          :loading="batchBusy"
          :disabled="saving || !batchText.trim()"
          @click="resolveBatch"
          >解析股票</el-button
        ><el-alert v-if="error" :title="error" type="error" :closable="false" /><el-table
          :data="batchRows"
          max-height="330"
          ><el-table-column prop="token" label="输入" /><el-table-column
            label="匹配结果"
            min-width="240"
            ><template #default="{ row }"
              ><span v-if="row.error" class="negative">{{ row.error }}</span
              ><el-select
                v-else
                v-model="row.code"
                filterable
                placeholder="请选择准确股票"
                :disabled="saving"
                ><el-option
                  v-for="option in row.options"
                  :key="option.code"
                  :label="`${option.name} ${option.code}`"
                  :value="option.code" /></el-select></template></el-table-column></el-table
        ><span class="muted">已确认 {{ batchCodes.length }} 只</span>
      </div>
      <template #footer
        ><el-button :disabled="saving" @click="batchOpen = false">取消</el-button
        ><el-button
          type="primary"
          :loading="saving"
          :disabled="
            batchBusy ||
            !batchCatalogReady ||
            !batchTag.trim() ||
            !batchCodes.length ||
            batchRows.some((row) => !row.code)
          "
          @click="saveBatch"
          >保存标签</el-button
        ></template
      ></el-dialog
    >
  </section>
</template>
<style scoped>
.tag-layout {
  display: grid;
  grid-template-columns: minmax(230px, 28%) minmax(0, 1fr);
  gap: 24px;
}
.el-form-item :deep(.el-form-item__content) {
  gap: 8px;
}
.el-form-item .el-input,
.el-form-item .el-select {
  width: 240px;
}
.el-tree {
  max-height: 70vh;
  overflow: auto;
}
@media (max-width: 767px) {
  .tag-layout {
    grid-template-columns: 1fr;
  }
  .el-tree {
    max-height: 260px;
  }
}
</style>
