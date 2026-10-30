import { computed, effectScope, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { useArchivePagination } from './pagination';

describe('archive result pagination', () => {
  it('bounds mounted records and keeps every record reachable without truncation', () => {
    const scope = effectScope();
    scope.run(() => {
      const items = Array.from({ length: 2606 }, (_, index) => index);
      const { page, visible, reveal } = useArchivePagination(
        () => items,
        50,
        () => 'same',
      );
      expect(visible.value).toEqual(items.slice(0, 50));
      reveal(2605);
      expect(page.value).toBe(53);
      expect(visible.value).toEqual(items.slice(2600));
      const visited: number[] = [];
      for (let current = 1; current <= 53; current++) {
        page.value = current;
        visited.push(...visible.value);
      }
      expect(visited).toEqual(items);
    });
    scope.stop();
  });
  it('resets comparison pages independently when either target or peer changes', () => {
    const scope = effectScope();
    scope.run(() => {
      const target = ref('000678'),
        peer = ref('002164');
      const { page } = useArchivePagination(
        () => Array.from({ length: 17 }),
        5,
        () => [target.value, peer.value],
      );
      page.value = 3;
      peer.value = '600001';
      expect(page.value).toBe(1);
      page.value = 4;
      target.value = '600002';
      expect(page.value).toBe(1);
    });
    scope.stop();
  });
  it('clamps the page when results shrink and supports empty results', () => {
    const scope = effectScope();
    scope.run(() => {
      const count = ref(104),
        items = computed(() => Array.from({ length: count.value }));
      const { page, visible, pageCount } = useArchivePagination(
        () => items.value,
        5,
        () => 'same',
      );
      page.value = 20;
      count.value = 7;
      expect(page.value).toBe(2);
      expect(visible.value).toHaveLength(2);
      count.value = 0;
      expect(page.value).toBe(1);
      expect(pageCount.value).toBe(1);
      expect(visible.value).toEqual([]);
    });
    scope.stop();
  });
});
