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
const search = ref(''),
  recent = ref(recentStocks()),
  notice = ref<{ title?: string; content?: string; enabled?: boolean; updated_at?: string }>({});
const desktop = !!document.querySelector('meta[name="lianban-desktop"]');
const links = ref<Record<string, string>>({});
const active = computed(() => (route.value.view === 'stock' ? 'date' : route.value.view));
const title = computed(
  () =>
    ({
      date: '连板档案',
      stock: '个股档案',
      intraday: '主板分时',
      tags: '标签管理',
      blacklist: '黑名单',
    })[route.value.view],
);
const navigation = [
  { view: 'date', name: '历史连板', icon: Calendar },
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
  disposed = true;
  clearTimeout(poll);
  ws.dispose();
  abortAll();
});
</script>
<template>
  <el-config-provider :locale="zhCn" size="small">
    <a href="#main" class="skip-link">跳到主要内容</a>
    <div class="workbench">
      <aside class="app-sidebar" :class="{ 'is-open': menuOpen }" aria-label="主导航">
        <a class="brand" href="/" @click.prevent="navigate('date')"
          ><el-icon :size="25"><DataAnalysis /></el-icon>
          <div>连板档案<small>市场复盘工作台</small></div></a
        >
        <el-menu
          :default-active="active"
          class="main-menu"
          @select="(key) => navigate(key as View)"
        >
          <el-menu-item v-for="item in navigation" :key="item.view" :index="item.view"
            ><el-icon><component :is="item.icon" /></el-icon
            ><span>{{ item.name }}</span></el-menu-item
          >
        </el-menu>
        <div class="sidebar-bottom">
          <el-button text :icon="InfoFilled" @click="methodOpen = true">数据与统计说明</el-button
          ><a
            v-if="links.author_url"
            :href="links.author_url"
            target="_blank"
            rel="noopener noreferrer"
            >作者主页</a
          ><a
            v-if="links.feedback_url"
            :href="links.feedback_url"
            target="_blank"
            rel="noopener noreferrer"
            >反馈建议</a
          ><span class="local-label"><i></i> 本地运行 · 个人数据保存在本机</span>
        </div>
      </aside>
      <button
        v-if="menuOpen"
        class="nav-backdrop"
        aria-label="关闭导航"
        @click="menuOpen = false"
      ></button>
      <main id="main" class="main-content">
        <header class="topbar">
          <div class="row">
            <el-button
              class="mobile-menu"
              :icon="MenuIcon"
              aria-label="打开导航"
              @click="menuOpen = !menuOpen"
            /><span class="muted">市场研究 /</span><span>{{ title }}</span>
          </div>
          <div class="topbar-right">
            <UpdateInbox :desktop="desktop" /><el-button text :icon="Bell" @click="openAnnouncement"
              >公告</el-button
            ><el-button text :icon="Refresh" :loading="loading" @click="load">刷新状态</el-button>
          </div>
        </header>
        <section class="intro">
          <div>
            <h1>{{ title }}</h1>
            <p class="muted">从交易日看市场高度，从个股看连板轨迹。</p>
          </div>
          <div class="range">
            <span class="muted">历史数据范围</span
            ><strong
              >{{ dateLabel(meta?.available_start) }} — {{ dateLabel(meta?.available_end) }}</strong
            ><small class="muted"
              >{{ number(meta?.coverage?.days) }} 个交易日 ·
              {{ number(meta?.coverage?.stocks) }} 只股票</small
            >
          </div>
        </section>
        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"
          ><el-button link @click="load">重新连接</el-button></el-alert
        >
        <section class="disclaimer">
          本人自用网站 ·
          数据可能存在延迟、遗漏或错误，仅供查询、复盘与学习参考，不构成投资建议。<el-button
            link
            @click="methodOpen = true"
            >查看说明</el-button
          >
        </section>
        <section v-if="route.view === 'date'" class="panel global-query">
          <div class="toolbar">
            <StockSearch v-model="search" @select="selectStock" /><span class="muted"
              >按名称、代码或首字母检索全部历史</span
            >
          </div>
          <div v-if="recent.length" class="recent row">
            <small class="muted">最近查看</small
            ><el-button
              v-for="stock in recent"
              :key="stock.code"
              link
              @click="selectStock(stock)"
              >{{ stock.name }}</el-button
            >
          </div>
        </section>
        <el-skeleton v-if="loading && !meta" :rows="8" animated />
        <template v-else-if="meta">
          <DailyView v-if="route.view === 'date'" />
          <StockView v-else-if="route.view === 'stock'" />
          <IntradayView v-else-if="route.view === 'intraday'" />
          <TagsView v-else-if="route.view === 'tags'" />
          <BlacklistView v-else />
        </template>
        <el-empty v-else description="请启动本地服务后重新连接" />
        <footer class="app-footer">
          {{ meta?.coverage?.note || meta?.scope_note
          }}<span
            >历史表现不代表未来收益 ·
            {{ meta?.archive_updated_at?.replace('T', ' ').slice(0, 16) }}</span
          >
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
    <el-dialog v-model="methodOpen" title="数据与统计说明" width="min(700px, 94vw)"
      ><div class="stack">
        <p>
          本站仅提供数据查询、历史复盘与学习交流工具，所有数据、统计及相关内容仅供参考，不构成任何投资建议或收益承诺。请以官方披露及实际行情为准。
        </p>
        <p>{{ meta?.scope_note }}</p>
        <p>
          历史确认档案与盘中暂定快照分别展示。暂定数据在收盘后核验，采集失败或缺页不代表当天没有涨停。
        </p>
        <p>
          个股轨迹只显示已收录的涨停日；空白不代表断板。梯队竞争根据涨停池推导，一方晋级、另一方未入池仍需完整行情核实。
        </p>
        <p>
          标签、行业、地区和股东使用当前资料作展示，不代表历史时点分类。共同股东不代表控制关系，也不构成价格关联结论。
        </p>
        <p>
          分时以实际缓存和来源为准，缺失不补造；图中滚轮、拖动与下方滑块用于查看范围，点击恢复全部范围可复位。
        </p>
        <p>备注、标签、黑名单保存在当前本地数据库；浏览器偏好仅保存在本机。</p>
      </div></el-dialog
    >
    <el-backtop :right="24" :bottom="24" />
  </el-config-provider>
</template>
