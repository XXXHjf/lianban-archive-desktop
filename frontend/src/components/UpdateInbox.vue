<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Message } from '@element-plus/icons-vue';
import { request, abort } from '@/shared/api';
interface Notice {
  id: string;
  version: string;
  title: string;
  notes: string;
  url: string;
  published_at: string;
}
interface Inbox {
  current_version: string;
  notice: Notice | null;
  checking: boolean;
  checked_at: string | null;
  unavailable: boolean;
}
const props = defineProps<{ desktop: boolean }>();
const open = ref(false),
  busy = ref(false),
  state = ref<Inbox>({
    current_version: '',
    notice: null,
    checking: true,
    checked_at: null,
    unavailable: false,
  });
const readKey = 'lianban-desktop-read-release';
function readId() {
  try {
    return localStorage.getItem(readKey) || '';
  } catch {
    return '';
  }
}
const read = ref(readId());
const notice = computed(() => {
  const item = state.value.notice;
  return item &&
    /^20\d{2}\.\d{2}\.\d{2}(?:\.\d{1,6})?$/.test(item.version) &&
    item.url === `https://github.com/x107108/lianban-archive-desktop/releases/tag/v${item.version}`
    ? item
    : null;
});
const unread = computed(() => !!notice.value && notice.value.id !== read.value);
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;
function markRead() {
  if (!notice.value) return;
  read.value = notice.value.id;
  try {
    localStorage.setItem(readKey, read.value);
  } catch {
    /* Read status is an optional browser preference. */
  }
}
async function check(manual = false) {
  if (busy.value || !props.desktop) return;
  clearTimeout(timer);
  busy.value = true;
  try {
    const result = await request<Inbox>(
      `/__desktop__/updates${manual ? '?check=1' : ''}`,
      'update-inbox',
      { signal: AbortSignal.timeout(8000) },
    );
    if (result) {
      state.value = result;
      if (open.value) markRead();
    }
  } catch {
    state.value = { ...state.value, checking: false, unavailable: true };
  } finally {
    busy.value = false;
    if (!disposed) timer = setTimeout(() => check(), state.value.checking ? 1500 : 1800000);
  }
}
function show() {
  open.value = true;
  markRead();
  void check();
}
function storage(event: StorageEvent) {
  if (event.key === readKey) read.value = event.newValue || '';
}
onMounted(() => {
  window.addEventListener('storage', storage);
  void check();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  abort('update-inbox');
  window.removeEventListener('storage', storage);
});
</script>
<template>
  <template v-if="desktop"
    ><el-badge :is-dot="unread"
      ><el-button
        text
        :icon="Message"
        :aria-label="unread ? '站内信，1 条未读更新' : '站内信'"
        @click="show"
        >站内信</el-button
      ></el-badge
    ><el-dialog v-model="open" title="站内信" width="min(600px, 94vw)" append-to-body
      ><div class="stack">
        <small class="muted">当前版本 {{ state.current_version || '读取中' }}</small
        ><el-alert
          :title="
            busy || state.checking
              ? '正在检查新版本…'
              : state.unavailable
                ? '暂时无法联网检查，已有消息仍可查看。'
                : notice
                  ? '有一个新版本可供下载。'
                  : '暂无更新通知。'
          "
          :type="state.unavailable ? 'warning' : 'info'"
          :closable="false"
        />
        <section v-if="notice" class="panel stack">
          <h3>{{ notice.title }}</h3>
          <small class="muted"
            >{{ notice.version }} · {{ notice.published_at?.slice(0, 10) }}</small
          >
          <p class="pre-wrap">{{ notice.notes }}</p>
          <a :href="notice.url" target="_blank" rel="noopener noreferrer">查看新版与下载</a
          ><small class="muted">下载前请停止网站并备份数据。</small>
        </section>
        <el-button :loading="busy" @click="check(true)">检查更新</el-button>
      </div></el-dialog
    ></template
  >
</template>
