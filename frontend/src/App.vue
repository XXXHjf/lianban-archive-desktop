<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import {
  Calendar,
  TrendCharts,
  CollectionTag,
  CircleClose,
  DataAnalysis,
  Bell,
  InfoFilled,
  Refresh,
  Menu as MenuIcon,
} from '@element-plus/icons-vue';
import { createWorkspace, workspaceKey, type View } from './shared/workspace';
import { request, abortAll } from './shared/api';
import { dateLabel, errorMessage, number, safeLink } from './shared/format';
import { recentStocks } from './shared/preferences';
import StockSearch from './components/StockSearch.vue';
import ResearchDialogs from './features/research/ResearchDialogs.vue';
import UpdateInbox from './components/UpdateInbox.vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import './features/archive/daily.css';
const DailyView = defineAsyncComponent(() => import('./features/archive/DailyView.vue'));
const StockView = defineAsyncComponent(() => import('./features/archive/StockView.vue'));
const IntradayView = defineAsyncComponent(() => import('./features/intraday/IntradayView.vue'));
const TagsView = defineAsyncComponent(() => import('./features/research/TagsView.vue'));
const BlacklistView = defineAsyncComponent(() => import('./features/research/BlacklistView.vue'));
const ws = createWorkspace();
provide(workspaceKey, ws);
const { meta, route } = ws;
const loading = ref(true),
  error = ref(''),
  menuOpen = ref(false),
  methodOpen = ref(false),
  announcementOpen = ref(false),
  announcementBusy = ref(false),
  announcementError = ref('');
const shellWidth = ref(window.innerWidth);
const syncShellWidth = () => {
  shellWidth.value = window.innerWidth;
};
const search = ref(''),
  recent = ref(recentStocks()),
  notice = ref<{ title?: string; content?: string; enabled?: boolean; updated_at?: string }>({});
const desktop = !!document.querySelector('meta[name="lianban-desktop"]');
const links = ref<Record<string, string>>({});
const active = computed(() => (route.value.view === 'stock' ? 'date' : route.value.view));
const title = computed(
  () =>
    ({
      date: '当日梯队',
      stock: '个股档案',
      intraday: '主板分时',
      tags: '标签管理',
      blacklist: '黑名单',
    })[route.value.view],
);
const navigation = [
  { view: 'date', name: '当日梯队', icon: Calendar },
  { view: 'intraday', name: '主板分时', icon: TrendCharts },
  { view: 'tags', name: '标签管理', icon: CollectionTag },
  { view: 'blacklist', name: '黑名单', icon: CircleClose },
] as const;
let poll: ReturnType<typeof setTimeout> | undefined,
  disposed = false;
async function load() {
  error.value = '';
  try {
    await ws.refreshMeta();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
async function refresh() {
  if (document.visibilityState !== 'hidden') {
    const before = JSON.stringify(meta.value);
    await load();
    if (before !== JSON.stringify(meta.value)) ws.revision.value++;
  }
  if (!disposed) poll = setTimeout(refresh, meta.value?.live?.enabled ? 60000 : 300000);
}
function navigate(view: View) {
  ws.navigate(view);
  menuOpen.value = false;
  recent.value = recentStocks();
}
function selectStock(stock: { code: string; name?: string }) {
  ws.openStock(stock.code, stock.name);
  recent.value = recentStocks();
}
async function openAnnouncement() {
  announcementOpen.value = true;
  announcementBusy.value = true;
  announcementError.value = '';
  try {
    const data = await request<{ announcement?: typeof notice.value }>(
      '/api/announcement',
      'announcement',
    );
    if (data) notice.value = data.announcement || {};
  } catch (e) {
    announcementError.value = errorMessage(e);
  } finally {
    announcementBusy.value = false;
  }
}
onMounted(async () => {
  window.addEventListener('resize', syncShellWidth);
  await load();
  if (!disposed) poll = setTimeout(refresh, 60000);
  try {
    const data = await request<{ links: Record<string, string> }>('/api/site-links', 'site-links');
    if (data)
      links.value = Object.fromEntries(
        Object.entries(data.links).map(([k, v]) => [k, safeLink(v)]),
      );
  } catch {
    /* Link configuration is optional; unavailable links stay hidden. */
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncShellWidth);
  disposed = true;
  clearTimeout(poll);
  ws.dispose();
  abortAll();
});
</script>
<template>
  <el-config-provider :locale="zhCn" size="default">
    <a href="#main" class="skip-link">跳到主要内容</a>
    <div class="workbench workspace-theme">
      <aside
        class="app-sidebar"
        :class="{ 'is-open': menuOpen }"
        :inert="!menuOpen && shellWidth < 768"
        aria-label="主导航"
      >
        <a class="brand" href="/" @click.prevent="navigate('date')"
          ><el-icon :size="25"><DataAnalysis /></el-icon>
          <div>连板档案<small>市场复盘工作台</small></div></a
        >
        <el-menu
          :default-active="active"
          class="main-menu"
          @select="(key) => navigate(key as View)"
        >
          <el-menu-item
            v-for="item in navigation"
            :key="item.view"
            :index="item.view"
            :title="item.name"
            :aria-label="item.name"
            ><el-icon><component :is="item.icon" /></el-icon
            ><span>{{ item.name }}</span></el-menu-item
          >
        </el-menu>
        <div class="sidebar-bottom">
          <el-button text :icon="InfoFilled" @click="methodOpen = true">数据概况</el-button
          ><a
            v-if="links.feedback_url"
            :href="links.feedback_url"
            target="_blank"
            rel="noopener noreferrer"
            >反馈建议</a
          >
        </div>
      </aside>
      <button
        v-if="menuOpen"
        class="nav-backdrop"
        aria-label="关闭导航"
        @click="menuOpen = false"
      ></button>
      <main id="main" class="main-content" tabindex="-1">
        <header class="topbar">
          <div class="row">
            <el-button
              class="mobile-menu"
              :icon="MenuIcon"
              aria-label="打开导航"
              @click="menuOpen = !menuOpen"
            />
            <StockSearch v-model="search" @select="selectStock" /><el-popover
              trigger="click"
              width="280"
              ><template #reference
                ><el-button text aria-label="最近查看的股票">最近</el-button></template
              >
              <div class="daily-recent">
                <strong>最近查看</strong
                ><el-button
                  v-for="stock in recent"
                  :key="stock.code"
                  link
                  @click="selectStock(stock)"
                  >{{ stock.name }} {{ stock.code }}</el-button
                >
                <p v-if="!recent.length">暂无最近查看记录</p>
              </div></el-popover
            >
          </div>
          <div class="topbar-right">
            <UpdateInbox :desktop="desktop" /><el-button text :icon="Bell" @click="openAnnouncement"
              >公告</el-button
            ><el-button text :icon="Refresh" :loading="loading" @click="load">刷新状态</el-button>
          </div>
        </header>
        <section v-if="route.view !== 'date'" class="intro workspace-intro">
          <div>
            <h1>{{ title }}</h1>
          </div>
        </section>
        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"
          ><el-button link @click="load">重新连接</el-button></el-alert
        >
        <el-skeleton v-if="loading && !meta" :rows="8" animated />
        <template v-else-if="meta">
          <DailyView v-if="route.view === 'date'" @explain="methodOpen = true" />
          <StockView v-else-if="route.view === 'stock'" />
          <IntradayView v-else-if="route.view === 'intraday'" />
          <TagsView v-else-if="route.view === 'tags'" />
          <BlacklistView v-else />
        </template>
        <el-empty v-else description="请启动本地服务后重新连接" />
        <footer v-if="meta?.archive_updated_at" class="app-footer">
          更新于 {{ meta.archive_updated_at.replace('T', ' ').slice(0, 16) }}
        </footer>
      </main>
    </div>
    <ResearchDialogs />
    <el-dialog
      v-model="announcementOpen"
      :title="notice.enabled ? notice.title || '公告' : '公告'"
      width="min(620px, 94vw)"
      ><el-skeleton v-if="announcementBusy" :rows="3" animated /><el-alert
        v-else-if="announcementError"
        :title="announcementError"
        type="error"
        :closable="false"
        ><el-button @click="openAnnouncement">重试</el-button></el-alert
      >
      <p v-else class="pre-wrap">{{ notice.enabled ? notice.content : '暂无公告' }}</p>
      <small class="muted">{{
        notice.updated_at?.replace('T', ' ').slice(0, 16)
      }}</small></el-dialog
    >
    <el-dialog v-model="methodOpen" title="数据概况" width="min(700px, 94vw)"
      ><div class="stack">
        <p>
          历史数据范围：{{ dateLabel(meta?.available_start) }} —
          {{ dateLabel(meta?.available_end) }} · {{ number(meta?.coverage?.days) }} 个交易日 ·
          {{ number(meta?.coverage?.stocks) }} 只股票。
        </p>
        <p>
          TradingView Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc.
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer"
            >TradingView</a
          >
          ·
          <a href="/assets/third-party-notices.txt" target="_blank" rel="noopener noreferrer"
            >第三方许可</a
          >
        </p>
      </div></el-dialog
    >
    <el-backtop :right="24" :bottom="24" />
  </el-config-provider>
</template>
