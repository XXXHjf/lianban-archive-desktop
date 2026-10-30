import { computed, ref, watch } from 'vue';

/** Keep the complete result in memory while mounting only the requested page. */
export function useArchivePagination<T>(
  items: () => T[],
  pageSize: number,
  resetKey: () => unknown,
) {
  const page = ref(1);
  const pageCount = computed(() => Math.max(1, Math.ceil(items().length / pageSize)));
  const visible = computed(() => items().slice((page.value - 1) * pageSize, page.value * pageSize));
  watch(
    resetKey,
    () => {
      page.value = 1;
    },
    { flush: 'sync' },
  );
  watch(
    pageCount,
    (count) => {
      page.value = Math.min(page.value, count);
    },
    { flush: 'sync' },
  );
  function reveal(index: number) {
    page.value = Math.max(1, Math.min(pageCount.value, Math.floor(index / pageSize) + 1));
  }
  return { page, pageCount, visible, reveal };
}
