<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { request, post, query, abort, ApiError } from '@/shared/api';
import { useWorkspace } from '@/shared/workspace';
import { errorMessage } from '@/shared/format';
import type { NoteData, NoteEntry, Stock } from './types';
import { flushNotes, noteModified, reconcileNotes } from './noteDrafts';
const props = defineProps<{ stock: Stock }>();
const workspace = useWorkspace();
const data = ref<NoteData | null>(null),
  entries = ref<NoteEntry[]>([]),
  content = ref(''),
  date = ref(''),
  error = ref(''),
  status = ref(''),
  loading = ref(false),
  saving = ref(false),
  conflict = ref(false),
  undo = ref<number | null>(null);
const orphanDrafts = ref<NoteEntry[]>([]);
const autoSaving = ref(false);
const finishing = ref(false);
const lockInputs = computed(() => (saving.value && !autoSaving.value) || finishing.value);
const closingBlocked = computed(() => saving.value && !autoSaving.value);
const editable = computed(() => workspace.meta.value?.capabilities?.edit_notes !== false);
const modified = (entry: NoteEntry) => noteModified(entry, data.value?.entries ?? []);
const dirty = computed(
  () => !!content.value.trim() || entries.value.some(modified) || orphanDrafts.value.length > 0,
);
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  composing = false;
function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
async function load(keepDrafts = false) {
  if (saving.value) return;
  const current = ++generation;
  loading.value = true;
  error.value = '';
  const originals = data.value?.entries ?? [],
    local = keepDrafts ? entries.value.map((entry) => ({ ...entry })) : [];
  try {
    const result = await request<NoteData>(
      query('/api/stock-note', { code: props.stock.code }),
      'research-note',
    );
    if (!result || current !== generation) return;
    const merged = reconcileNotes(originals, local, result.entries, null);
    data.value = result;
    entries.value = merged.entries;
    orphanDrafts.value = [
      ...orphanDrafts.value,
      ...merged.missing.filter((draft) => !orphanDrafts.value.some((item) => item.id === draft.id)),
    ];
    if (merged.missing.length)
      error.value = merged.missing
        .map(
          (draft) =>
            `草稿 ${draft.id} 对应的备注已被其他窗口删除，请复制保留后核对。\n${draft.content}`,
        )
        .join('\n\n');
    conflict.value = false;
    status.value = keepDrafts ? '已读取最新版本并保留草稿，请核对后再保存。' : '';
  } catch (cause) {
    if (current === generation) error.value = errorMessage(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
function apply(result: NoteData, savedId: number | null, submitted?: NoteEntry | null) {
  const merged = reconcileNotes(
    data.value?.entries ?? [],
    entries.value,
    result.entries,
    savedId,
    submitted,
  );
  data.value = result;
  entries.value = merged.entries;
  void workspace.changed().catch((cause) => {
    error.value = errorMessage(cause);
  });
}
async function persist(entry: NoteEntry | null, automatic = false) {
  stopTimer();
  if (!editable.value || !data.value || saving.value || loading.value || conflict.value)
    return false;
  if (entry && !modified(entry)) return true;
  if (!entry && !content.value.trim()) return true;
  const submitted = entry ? { ...entry } : null;
  saving.value = true;
  autoSaving.value = automatic;
  error.value = '';
  status.value = '正在保存…';
  try {
    const result = await post<NoteData>(
      '/api/stock-note',
      {
        code: props.stock.code,
        content: entry?.content ?? content.value,
        note_date: entry?.note_date ?? date.value,
        revision: data.value.revision,
        entry_id: entry?.id ?? null,
        new_entry: !entry,
      },
      'research-note-write',
    );
    if (!result) throw new Error('备注未确认保存，请重试。');
    apply(result, entry?.id ?? null, submitted);
    if (!entry) {
      content.value = '';
      date.value = '';
    }
    status.value = entry ? '该条备注已保存。' : '已添加备注，可继续输入。';
    return true;
  } catch (cause) {
    error.value = errorMessage(cause);
    conflict.value = cause instanceof ApiError && cause.status === 409;
    status.value = '输入内容已保留。';
    return false;
  } finally {
    saving.value = false;
    autoSaving.value = false;
    if (!error.value && entries.value.some(modified)) schedule();
  }
}
async function changeEntry(entryId: number, action: 'delete' | 'restore') {
  stopTimer();
  if (!editable.value || !data.value || saving.value || conflict.value) return;
  if (action === 'delete') {
    try {
      await ElMessageBox.confirm('删除这条备注？可在本窗口撤销。', '删除备注', {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      });
    } catch (cause) {
      if (cause === 'cancel' || cause === 'close') return;
      error.value = errorMessage(cause);
      return;
    }
  }
  saving.value = true;
  error.value = '';
  try {
    const result = await post<NoteData>(
      '/api/stock-note',
      { code: props.stock.code, revision: data.value.revision, entry_id: entryId, action },
      'research-note-write',
    );
    if (!result) throw new Error('备注操作未确认完成，请重试。');
    apply(result, entryId);
    undo.value = action === 'delete' ? entryId : null;
    status.value = action === 'delete' ? '已删除，可撤销。' : '已恢复备注。';
  } catch (cause) {
    error.value = errorMessage(cause);
    conflict.value = cause instanceof ApiError && cause.status === 409;
  } finally {
    saving.value = false;
  }
}
function schedule() {
  stopTimer();
  if (composing || finishing.value || saving.value || conflict.value || !editable.value) return;
  timer = setTimeout(async () => {
    const entry = entries.value.find(modified);
    if (entry) await persist(entry, true);
  }, 900);
}
function endComposition() {
  composing = false;
  schedule();
}
function keydown(event: Event | KeyboardEvent, entry: NoteEntry | null) {
  if (
    event instanceof KeyboardEvent &&
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    !composing
  ) {
    event.preventDefault();
    void persist(entry);
  }
}
async function finish(): Promise<boolean> {
  stopTimer();
  if (loading.value) return false;
  finishing.value = true;
  try {
    if (saving.value)
      await new Promise<void>((resolve) => {
        const stop = watch(
          saving,
          (busy) => {
            if (!busy) {
              stop();
              resolve();
            }
          },
          { flush: 'sync' },
        );
      });
    if (!editable.value || !dirty.value) return true;
    if (orphanDrafts.value.length) {
      error.value = '其他窗口已删除部分备注，遗留草稿仍在下方。请保留为新备注或明确放弃后关闭。';
      return false;
    }
    if (conflict.value) {
      error.value = '存在版本冲突，草稿已保留。请读取最新版本并核对后保存，或明确放弃草稿。';
      return false;
    }
    return await flushNotes(entries.value, data.value?.entries ?? [], persist, true);
  } finally {
    finishing.value = false;
  }
}
async function discard(): Promise<boolean> {
  if (saving.value) return false;
  try {
    await ElMessageBox.confirm('放弃尚未保存的输入？已保存的备注保持不变。', '放弃草稿', {
      type: 'warning',
      confirmButtonText: '放弃',
      cancelButtonText: '返回',
    });
    content.value = '';
    orphanDrafts.value = [];
    entries.value = data.value?.entries.map((entry) => ({ ...entry })) ?? [];
    return true;
  } catch (cause) {
    if (cause !== 'cancel' && cause !== 'close') error.value = errorMessage(cause);
    return false;
  }
}
watch(
  () => props.stock.code,
  () => {
    content.value = '';
    date.value = '';
    undo.value = null;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  stopTimer();
  abort('research-note');
});
defineExpose({ finish, discard, dirty, saving: closingBlocked, busy: saving });
</script>
<template>
  <div v-loading="loading" class="stack">
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="preserve" />
    <div v-if="error" class="toolbar">
      <el-button :disabled="saving" @click="load(true)">读取最新版本（保留草稿）</el-button>
    </div>
    <el-alert v-if="!editable" title="当前为只读模式。" type="info" :closable="false" />
    <p class="muted">
      {{
        status ||
        (editable
          ? '历史备注修改后自动保存；Enter 保存，Shift + Enter 换行。关闭窗口会保存全部草稿。'
          : '备注和日期按原始内容显示。')
      }}
    </p>
    <div v-if="editable && data" class="note-entry compose">
      <el-date-picker
        v-model="date"
        type="date"
        value-format="YYYY-MM-DD"
        clearable
        placeholder="可选日期（默认无日期）"
        :disabled="lockInputs"
      />
      <el-input
        v-model="content"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 8 }"
        maxlength="5000"
        show-word-limit
        placeholder="添加一条新备注"
        :disabled="lockInputs"
        @keydown="keydown($event, null)"
      />
      <el-button
        type="primary"
        :disabled="saving || !content.trim() || conflict"
        :loading="saving"
        @click="persist(null)"
        >添加备注</el-button
      >
    </div>
    <div v-if="undo && editable" class="toolbar">
      <el-button :disabled="saving || conflict" @click="changeEntry(undo!, 'restore')"
        >撤销删除</el-button
      >
    </div>
    <div v-for="(draft, index) in orphanDrafts" :key="draft.id" class="note-entry">
      <strong>已被其他窗口删除的备注草稿 · {{ draft.note_date || '无日期' }}</strong
      ><el-input
        :model-value="draft.content"
        type="textarea"
        readonly
        :autosize="{ minRows: 2, maxRows: 8 }"
      />
      <div class="toolbar">
        <el-button
          :disabled="saving || !!content.trim()"
          @click="
            content = draft.content;
            date = draft.note_date;
            orphanDrafts.splice(index, 1);
          "
          >保留为新备注草稿</el-button
        ><el-button :disabled="saving" type="danger" text @click="orphanDrafts.splice(index, 1)"
          >放弃该草稿</el-button
        >
      </div>
    </div>
    <el-empty v-if="data && !entries.length" description="暂无备注" />
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="note-entry"
      @compositionstart="
        composing = true;
        stopTimer();
      "
      @compositionend="endComposition"
    >
      <template v-if="editable"
        ><div class="toolbar">
          <el-date-picker
            v-model="entry.note_date"
            type="date"
            value-format="YYYY-MM-DD"
            clearable
            placeholder="无日期"
            :disabled="lockInputs"
            @change="
              entry.note_date ||= '';
              schedule();
            "
          /><el-button
            size="small"
            :disabled="saving || !modified(entry) || conflict"
            @click="persist(entry)"
            >保存此条</el-button
          ><el-button
            size="small"
            text
            type="danger"
            :disabled="saving || conflict"
            @click="changeEntry(entry.id, 'delete')"
            >删除</el-button
          ><span v-if="modified(entry)" class="muted">待保存</span>
        </div>
        <el-input
          v-model="entry.content"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 10 }"
          maxlength="5000"
          :disabled="lockInputs"
          @input="schedule"
          @keydown="keydown($event, entry)"
      /></template>
      <template v-else
        ><span v-if="entry.note_date" class="muted">{{ entry.note_date }}</span>
        <p class="preserve">{{ entry.content }}</p></template
      >
    </div>
  </div>
</template>
<style scoped>
.note-entry {
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  padding: 12px;
  display: grid;
  gap: 8px;
}
.compose {
  background: var(--la-bg-subtle);
}
.preserve {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
