import { describe, expect, it } from 'vitest';
import { flushNotes, noteModified, reconcileNotes } from './noteDrafts';
import type { NoteEntry } from './types';
function entry(id: number, content: string, note_date = ''): NoteEntry {
  return { id, content, note_date, occurred_at: '2026-10-29T12:00:00+08:00', updated_at: '' };
}
describe('note editing and CAS lifecycle', () => {
  it('saving one historical entry keeps other drafts and their independent optional dates', () => {
    const originals = [entry(2, 'old second'), entry(1, 'old first', '2026-10-20')];
    const local = [entry(2, 'edited second'), entry(1, 'edited first', '')];
    const latest = [entry(1, 'old first', '2026-10-20'), entry(2, 'edited second')];
    const result = reconcileNotes(originals, local, latest, 2);
    expect(result.entries).toEqual([entry(1, 'edited first'), entry(2, 'edited second')]);
    expect(result.missing).toEqual([]);
    expect(noteModified(result.entries[0]!, latest)).toBe(true);
    expect(noteModified(result.entries[1]!, latest)).toBe(false);
  });
  it('conflict reload reports remotely deleted drafts instead of silently dropping their text', () => {
    const draft = entry(1, '<script>literal private draft</script>');
    const result = reconcileNotes([entry(1, 'old')], [draft], [entry(2, 'remote')], null);
    expect(result.missing).toEqual([draft]);
    expect(result.entries).toEqual([entry(2, 'remote')]);
  });
  it('an autosave response cannot erase typing or date changes made while that request was in flight', () => {
    const original = entry(1, 'old');
    const submitted = entry(1, 'first edit', '2026-10-29');
    const newerDraft = entry(1, 'second edit during request', '');
    const result = reconcileNotes([original], [newerDraft], [submitted], 1, submitted);
    expect(result.entries).toEqual([newerDraft]);
    expect(noteModified(result.entries[0]!, [submitted])).toBe(true);
  });
  it('reverting to the original text during an in-flight save remains a pending edit against the saved response', () => {
    const original = entry(1, 'original');
    const submitted = entry(1, 'temporary change');
    const result = reconcileNotes([original], [original], [submitted], 1, submitted);
    expect(result.entries).toEqual([original]);
    expect(noteModified(result.entries[0]!, [submitted])).toBe(true);
  });
  it('close flush waits for each response before the next CAS write and adds compose last', async () => {
    const calls: (number | null)[] = [];
    let release: ((value: boolean) => void) | undefined;
    const pending = flushNotes(
      [entry(1, 'edited'), entry(2, 'edited')],
      [entry(1, 'old'), entry(2, 'old')],
      async (item) => {
        calls.push(item?.id ?? null);
        if (item?.id === 1)
          return new Promise<boolean>((resolve) => {
            release = resolve;
          });
        return true;
      },
      true,
    );
    await Promise.resolve();
    expect(calls).toEqual([1]);
    release!(true);
    expect(await pending).toBe(true);
    expect(calls).toEqual([1, 2, null]);
  });
  it('a conflict stops closing without sending a second historical or compose write', async () => {
    const calls: (number | null)[] = [];
    expect(
      await flushNotes(
        [entry(1, 'draft'), entry(2, 'draft')],
        [entry(1, 'old'), entry(2, 'old')],
        async (item) => {
          calls.push(item?.id ?? null);
          return false;
        },
        true,
      ),
    ).toBe(false);
    expect(calls).toEqual([1]);
  });
});
