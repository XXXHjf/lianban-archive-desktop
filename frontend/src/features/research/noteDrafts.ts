import type { NoteEntry } from './types';
export function noteModified(entry: NoteEntry, originals: readonly NoteEntry[]): boolean {
  const original = originals.find((item) => item.id === entry.id);
  return !original || entry.content !== original.content || entry.note_date !== original.note_date;
}
/** Carry independent local edits across a server response without replaying the saved entry. */
export function reconcileNotes(
  originals: readonly NoteEntry[],
  local: readonly NoteEntry[],
  latest: readonly NoteEntry[],
  savedId: number | null,
  submitted?: NoteEntry | null,
) {
  const drafts = local.filter((entry) =>
    entry.id === savedId
      ? submitted &&
        (entry.content !== submitted.content || entry.note_date !== submitted.note_date)
      : noteModified(entry, originals),
  );
  const ids = new Set(latest.map((entry) => entry.id));
  return {
    entries: latest.map((entry) => {
      const draft = drafts.find((draft) => draft.id === entry.id);
      return draft
        ? { ...entry, content: draft.content, note_date: draft.note_date }
        : { ...entry };
    }),
    missing: drafts.filter((draft) => !ids.has(draft.id)),
  };
}
/** Writes are sequential because every successful operation advances the stock-wide CAS revision. */
export async function flushNotes(
  entries: readonly NoteEntry[],
  originals: readonly NoteEntry[],
  save: (entry: NoteEntry | null) => Promise<boolean>,
  compose: boolean,
): Promise<boolean> {
  for (const entry of entries.filter((entry) => noteModified(entry, originals)))
    if (!(await save(entry))) return false;
  return compose ? save(null) : true;
}
