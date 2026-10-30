<script setup lang="ts">
import { computed, ref } from 'vue';
import { topicPath } from './dailyPresentation';
import { useWorkspace } from '@/shared/workspace';
import { hierarchy, initials, region } from './helpers';
import type { Stock } from './models';
const props = defineProps<{
  stock: Stock;
  active: boolean;
  highlight: boolean;
  topicFilter?: boolean;
}>();
const emit = defineEmits<{
  preview: [stock: Stock, trigger: HTMLElement];
  topic: [label: string];
}>();
const ws = useWorkspace();
const tagsOpen = ref(false),
  moreTags = ref<HTMLButtonElement | null>(null);
const tags = computed(() => hierarchy(ws.meta.value?.tag_hierarchy, ws.meta.value?.tag_order));
const labels = computed(() => tags.value.leaves(props.stock));
const latest = computed(
  () =>
    props.highlight &&
    props.stock.date !== ws.meta.value?.latest_date &&
    ws.meta.value?.latest_limit_ups?.find((row) => row.code === props.stock.code),
);
function preview(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) emit('preview', props.stock, event.currentTarget);
}
function closeTags() {
  tagsOpen.value = false;
  moreTags.value?.focus();
}
function chooseTopic(label: string) {
  if (tagsOpen.value) closeTags();
  emit('topic', label);
}
</script>
<template>
  <article class="ladder-stock" :class="{ 'is-selected': active }">
    <div class="ladder-stock-identity">
      <button class="daily-stock-link" @click="ws.openStock(stock.code, stock.name)">
        {{ stock.name }}<span class="daily-code">{{ stock.code }}</span>
      </button>
      <span class="daily-meta">{{ region(stock) }} · {{ initials(stock) || '首字母待补充' }}</span>
    </div>
    <div class="ladder-stock-labels">
      <span v-if="stock.blacklisted" class="daily-badge warning">黑名单</span>
      <span v-if="latest" class="daily-badge warning"
        >{{ ws.meta.value?.latest_date }} · {{ latest.boards }}板涨停</span
      >
      <template v-for="label in labels.slice(0, 4)" :key="label">
        <button
          v-if="topicFilter"
          class="daily-tag daily-tag-filter"
          :title="topicPath(label, tags)"
          :aria-label="`筛选标签：${label}`"
          @click="chooseTopic(label)"
        >
          {{ label }}
        </button>
        <span v-else class="daily-tag" :title="topicPath(label, tags)">{{ label }}</span>
      </template>
      <el-popover
        v-if="labels.length > 4"
        v-model:visible="tagsOpen"
        trigger="click"
        role="dialog"
        title="全部标签"
        placement="bottom"
        :width="280"
      >
        <template #reference
          ><button
            ref="moreTags"
            class="daily-more-tags"
            :aria-label="`查看${stock.name}全部${labels.length}个标签`"
            :aria-expanded="tagsOpen"
            @keydown.esc.stop="closeTags"
          >
            +{{ labels.length - 4 }}
          </button></template
        >
        <div class="daily-all-tags" @keydown.esc.stop="closeTags">
          <template v-for="label in labels" :key="label"
            ><button v-if="topicFilter" @click="chooseTopic(label)">
              {{ topicPath(label, tags) }}</button
            ><span v-else>{{ topicPath(label, tags) }}</span></template
          >
        </div>
      </el-popover>
      <span v-if="stock.note" class="daily-meta">有备注</span>
    </div>
    <el-button
      class="preview-stock"
      :type="active ? 'primary' : 'default'"
      :plain="active"
      :aria-label="`预览${stock.name}周期`"
      :aria-pressed="active"
      @click="preview"
      >预览</el-button
    >
  </article>
</template>
