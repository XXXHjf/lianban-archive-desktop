<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { useWorkspace, type EditorTarget } from '@/shared/workspace';
const NotesEditor = defineAsyncComponent(() => import('./NotesEditor.vue'));
const TagsEditor = defineAsyncComponent(() => import('./TagsEditor.vue'));
const ShareholdersPanel = defineAsyncComponent(() => import('./ShareholdersPanel.vue'));
interface EditorInstance {
  finish(): Promise<boolean>;
  discard?: () => Promise<boolean>;
  dirty: boolean;
  saving: boolean;
  busy?: boolean;
}
const workspace = useWorkspace();
const target = shallowRef<EditorTarget | null>(null),
  editor = ref<EditorInstance | null>(null),
  transitioning = ref(false);
const title = computed(
  () =>
    `${target.value?.kind === 'note' ? '股票备注' : target.value?.kind === 'tags' ? '股票标签' : '共同股东'} · ${target.value?.stock.name || target.value?.stock.code || ''}`,
);
let transition = 0;
function same(a: EditorTarget | null, b: EditorTarget | null) {
  return a?.kind === b?.kind && a?.stock.code === b?.stock.code;
}
watch(
  workspace.editor,
  async (next) => {
    if (same(next, target.value)) return;
    const current = ++transition;
    if (target.value && editor.value) {
      transitioning.value = true;
      const allowed = await editor.value.finish();
      if (current !== transition) return;
      transitioning.value = false;
      if (!allowed) {
        workspace.editor.value = target.value;
        return;
      }
    }
    target.value = next;
  },
  { immediate: true },
);
function forceClose() {
  transition++;
  transitioning.value = false;
  target.value = null;
  workspace.editor.value = null;
}
async function discard() {
  if (editor.value?.discard && (await editor.value.discard())) forceClose();
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (editor.value?.dirty || editor.value?.saving || editor.value?.busy) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>
<template>
  <el-dialog
    :model-value="!!target"
    :title="title"
    width="min(940px, 96vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!transitioning && !editor?.saving"
    :show-close="!transitioning && !editor?.saving"
    @update:model-value="
      (value) => {
        if (!value) workspace.editor.value = null;
      }
    "
  >
    <template v-if="target"
      ><NotesEditor
        v-if="target.kind === 'note'"
        :key="`note-${target.stock.code}`"
        ref="editor"
        :stock="target.stock" /><TagsEditor
        v-else-if="target.kind === 'tags'"
        :key="`tags-${target.stock.code}`"
        ref="editor"
        :stock="target.stock"
        @saved="forceClose" /><ShareholdersPanel
        v-else
        :key="`holders-${target.stock.code}`"
        ref="editor"
        :stock="target.stock"
    /></template>
    <template #footer
      ><el-button
        v-if="target?.kind === 'note' && editor?.dirty"
        type="danger"
        plain
        :disabled="transitioning || editor?.saving || editor?.busy"
        @click="discard"
        >放弃未保存草稿</el-button
      ><el-button
        :disabled="transitioning || editor?.saving"
        :loading="transitioning"
        @click="workspace.editor.value = null"
        >{{ target?.kind === 'note' ? '保存并关闭' : '关闭' }}</el-button
      ></template
    >
  </el-dialog>
</template>
