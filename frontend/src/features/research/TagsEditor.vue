<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { request, post, query, abort } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage } from '@/shared/format';
import type { Catalog, Stock, TagEditor } from './types';
const props = defineProps<{ stock: Stock }>();
const emit = defineEmits<{ saved: [] }>();
const workspace = useWorkspace();
const data = ref<TagEditor | null>(null),
  catalog = ref<Catalog | null>(null),
  draft = ref<string[]>([]),
  newTag = ref(''),
  useSource = ref(false),
  error = ref(''),
  status = ref(''),
  catalogError = ref(''),
  loading = ref(false),
  saving = ref(false);
const editable = computed(() => workspace.meta.value?.capabilities?.edit_tags !== false);
const blacklistEditable = computed(
  () => workspace.meta.value?.capabilities?.edit_blacklist === true,
);
const defaults = computed(
  () => data.value?.source_tags ?? (data.value?.source_tag ? [data.value.source_tag] : []),
);
const dirty = computed(
  () =>
    !!newTag.value.trim() ||
    useSource.value ||
    JSON.stringify(draft.value) !== JSON.stringify(data.value?.tags ?? []),
);
const suggestions = computed(() =>
  (catalog.value?.tags ?? [])
    .map((tag) => ({ ...tag, path: path(tag.name) }))
    .filter(
      (tag) =>
        !draft.value.some(
          (value) =>
            value.split('/').at(-1)?.trim().toLocaleLowerCase() === tag.name.toLocaleLowerCase(),
        ),
    ),
);
function suggestTags(text: string, callback: (rows: { value: string; label: string }[]) => void) {
  const term = text
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*\/\s*/g, ' / ');
  callback(
    suggestions.value
      .filter((tag) => !term || tag.path.toLocaleLowerCase().includes(term))
      .map((tag) => ({ value: tag.name, label: `${tag.path} · ${tag.count} 只` })),
  );
}
let generation = 0;
function path(name: string) {
  const names = [name],
    seen = new Set(names);
  let parent = catalog.value?.hierarchy?.find((node) => node.name === name)?.parent;
  while (parent && !seen.has(parent)) {
    names.unshift(parent);
    seen.add(parent);
    parent = catalog.value?.hierarchy?.find((node) => node.name === parent)?.parent;
  }
  return names.join(' / ');
}
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  catalogError.value = '';
  const results = await Promise.allSettled([
    request<TagEditor>(query('/api/stock-tags', { code: props.stock.code }), 'research-stock-tags'),
    request<Catalog>('/api/tags', 'research-editor-catalog'),
  ]);
  if (current !== generation) return;
  const [tags, tree] = results;
  if (tags.status === 'fulfilled' && tags.value) {
    data.value = tags.value;
    draft.value = [...tags.value.tags];
    useSource.value = false;
  } else if (tags.status === 'rejected') error.value = errorMessage(tags.reason);
  if (tree.status === 'fulfilled') catalog.value = tree.value;
  else catalogError.value = `已有标签暂时无法读取，仍可手动输入。${errorMessage(tree.reason)}`;
  loading.value = false;
}
function add(): boolean {
  const value = newTag.value.trim();
  if (!value) return true;
  const parts = value.split('/').map((part) => part.trim());
  const limit = Math.max(
    20,
    data.value?.tags.length ?? 0,
    defaults.value.length + (data.value?.merge_defaults ? 20 : 0),
  );
  if (parts.some((part) => !part || part.length > 30)) {
    error.value = '每级标签名称需为 1 至 30 个字符，斜杠前后不能为空。';
    return false;
  }
  if (draft.value.length >= limit) {
    error.value = `每只股票最多保留 ${limit} 个标签。`;
    return false;
  }
  if (
    draft.value.some(
      (tag) =>
        tag.split('/').at(-1)?.trim().toLocaleLowerCase() === parts.at(-1)?.toLocaleLowerCase(),
    )
  ) {
    error.value = '这个标签已存在。';
    return false;
  }
  draft.value.push(
    parts
      .map(
        (part) =>
          catalog.value?.tags.find(
            (tag) => tag.name.toLocaleLowerCase() === part.toLocaleLowerCase(),
          )?.name ?? part,
      )
      .join('/'),
  );
  newTag.value = '';
  useSource.value = false;
  error.value = '';
  return true;
}
function restore() {
  draft.value = [...defaults.value];
  newTag.value = '';
  useSource.value = true;
}
function enter(event: KeyboardEvent) {
  if (!event.isComposing) {
    event.preventDefault();
    add();
  }
}
async function save() {
  if (!editable.value || !data.value || saving.value || !add()) return false;
  const leaves = draft.value.map((tag) => tag.split('/').at(-1)?.trim().toLocaleLowerCase());
  if (
    draft.value.some((tag) =>
      tag.split('/').some((part) => !part.trim() || part.trim().length > 30),
    ) ||
    new Set(leaves).size !== leaves.length
  ) {
    error.value = '标签名称为空、过长或重复，请核对。';
    return false;
  }
  saving.value = true;
  error.value = '';
  try {
    const result = await post<TagEditor>(
      '/api/stock-tags',
      {
        code: props.stock.code,
        tags: draft.value,
        revision: data.value.revision,
        tag_alias_revision: data.value.tag_alias_revision,
        use_source: useSource.value,
      },
      'research-stock-tags-write',
    );
    if (!result) throw new Error('未能确认标签已保存，请重新读取核实。');
    data.value = result;
    draft.value = [...result.tags];
    useSource.value = false;
    await workspace.changed();
    emit('saved');
    return true;
  } catch (cause) {
    error.value = errorMessage(cause);
    return false;
  } finally {
    saving.value = false;
  }
}
async function toggleBlacklist(value: boolean) {
  if (!data.value || !blacklistEditable.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await post<unknown>(
      '/api/blacklist',
      { code: props.stock.code, action: value ? 'add' : 'remove' },
      'research-editor-blacklist',
    );
    if (!result) throw new Error('未能确认黑名单状态，请重新打开核实。');
    data.value.blacklisted = value;
    status.value = value ? '已加入黑名单' : '已移出黑名单';
    await workspace.changed();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function finish(): Promise<boolean> {
  if (saving.value) return false;
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('标签草稿尚未保存，确认放弃？', '未保存的标签', {
      type: 'warning',
      confirmButtonText: '放弃草稿',
      cancelButtonText: '继续编辑',
    });
    return true;
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') error.value = errorMessage(cause);
    return false;
  }
}
watch(
  () => props.stock.code,
  () => {
    newTag.value = '';
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  abort('research-stock-tags');
  abort('research-editor-catalog');
});
defineExpose({ finish, dirty, saving, save });
</script>
<template>
  <div v-loading="loading" class="stack">
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="catalogError" :title="catalogError" type="warning" :closable="false" />
    <el-button v-if="!data && error" @click="load">重试读取</el-button>
    <template v-if="data">
      <div class="muted">
        {{
          data.merge_defaults
            ? '来源标签与个人标签合并，移除来源标签会保留排除设置。'
            : data.customized
              ? '当前使用个人标签。'
              : '当前使用来源默认标签。'
        }}<br />默认标签：{{ defaults.map(path).join('、') || '暂无' }}<br />{{ data.tags_source }}
        {{ data.tags_as_of?.slice(0, 10) }}
      </div>
      <el-form :disabled="saving || !editable"
        ><div v-for="(tag, index) in draft" :key="index" class="draft-row">
          <el-input
            :model-value="tag"
            maxlength="200"
            :aria-label="`标签 ${index + 1}`"
            @update:model-value="
              draft[index] = $event;
              useSource = false;
            "
          /><el-button
            type="danger"
            text
            @click="
              draft.splice(index, 1);
              useSource = false;
            "
            >移除</el-button
          >
        </div>
        <p v-if="!draft.length" class="muted">暂无标签，保存后将归入“独苗”。</p>
        <div class="toolbar">
          <el-autocomplete
            v-model="newTag"
            :fetch-suggestions="suggestTags"
            clearable
            placeholder="选择已有标签，或输入 父级/子级"
            class="tag-picker"
            @keyup.enter="enter"
            ><template #default="{ item }">{{ item.label }}</template></el-autocomplete
          ><el-button @click="add">添加</el-button>
        </div>
        <div class="toolbar">
          <el-button @click="restore">恢复来源默认标签</el-button
          ><el-button type="primary" :loading="saving" @click="save">保存标签</el-button>
        </div></el-form
      >
      <el-divider />
      <el-checkbox
        v-if="blacklistEditable"
        :model-value="data.blacklisted"
        :disabled="saving"
        @change="(value) => toggleBlacklist(value === true)"
        >加入黑名单（立即保存）</el-checkbox
      ><span v-else-if="data.blacklisted">已加入黑名单</span><span class="muted">{{ status }}</span>
    </template>
  </div>
</template>
<style scoped>
.draft-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.tag-picker {
  min-width: 240px;
  flex: 1;
}
.el-form {
  display: grid;
  gap: 12px;
}
</style>
