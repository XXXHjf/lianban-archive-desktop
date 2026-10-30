import { computed, inject, ref, type InjectionKey } from 'vue';
import { request } from './api';
import { rememberStock } from './preferences';
export interface StockIdentity {
  code: string;
  name?: string;
}
export interface Metadata {
  dates: string[];
  query_dates?: string[];
  latest_date?: string;
  available_start?: string;
  available_end?: string;
  range_start?: string;
  range_end?: string;
  scope_note?: string;
  archive_updated_at?: string;
  updated_at?: string;
  industry_fetched_at?: string;
  registration_fetched_at?: string;
  concept_fetched_at?: string;
  suspension_revision?: string;
  capabilities?: {
    edit_tags?: boolean;
    edit_notes?: boolean;
    edit_blacklist?: boolean;
    manage_tags?: boolean;
  };
  coverage?: { days: number; stocks: number; records: number; status: string; note?: string };
  tag_order?: string[];
  tag_hierarchy?: { name: string; parent: string }[];
  tag_catalog_revision?: string;
  tag_alias_revision?: string;
  examples?: { code: string; name: string; highest: number; observations: number }[];
  latest_limit_ups?: { code: string; boards: number }[];
  live?: {
    enabled?: boolean;
    date?: string;
    today?: string;
    polling?: boolean;
    dates?: string[];
    fetched_at?: string;
    status?: string;
    next_refresh?: string;
    note?: string;
  };
  shareholder_alerts?: {
    rows?: { code: string; types: string[] }[];
    today?: string;
    date?: string;
    note?: string;
  };
}
export type View = 'date' | 'stock' | 'intraday' | 'tags' | 'blacklist';
export interface RouteState {
  view: View;
  code: string;
  date: string;
  boards: string;
  layout: string;
  excludeST: boolean;
  excludeGEM: boolean;
  relationExcludeST: boolean;
  relationExcludeGEM: boolean;
  relationExcludeLatest: boolean;
  minuteCode: string;
  minuteCompare: string[];
  timelineGEM: boolean;
  tag: string;
  dailyTag: string;
}
export type EditorKind = 'note' | 'tags' | 'shareholders';
export interface EditorTarget {
  kind: EditorKind;
  stock: StockIdentity;
}
export function parseRoute(search: string): RouteState {
  const p = new URLSearchParams(search);
  const code = /^\d{6}$/.test(p.get('code') || '') ? p.get('code')! : '';
  const view = p.get('view');
  return {
    view: ['intraday', 'tags', 'blacklist'].includes(view || '')
      ? (view as View)
      : code
        ? 'stock'
        : 'date',
    code,
    date: /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '') ? p.get('date')! : '',
    boards: /^(?:[1-9]\d?|100)$/.test(p.get('boards') || '') ? p.get('boards')! : '',
    layout: ['region', 'pinyin', 'code'].includes(p.get('layout') || '')
      ? p.get('layout')!
      : 'industry',
    excludeST: p.get('exclude_st') === '1',
    excludeGEM: p.get('exclude_gem') === '1',
    relationExcludeST: p.get('relation_exclude_st') === '1',
    relationExcludeGEM: p.get('relation_exclude_gem') === '1',
    relationExcludeLatest: p.get('relation_exclude_latest') === '1',
    minuteCode: /^\d{6}$/.test(p.get('minute_code') || '') ? p.get('minute_code')! : '',
    minuteCompare: [
      ...new Set((p.get('minute_compare') || '').split(',').filter((code) => /^\d{6}$/.test(code))),
    ],
    timelineGEM: p.get('timeline_gem') === '1',
    tag: p.get('tag') || '',
    dailyTag: p.get('daily_tag') || '',
  };
}
export function routeURL(route: RouteState, pathname = '/') {
  const p = new URLSearchParams();
  if (route.date) p.set('date', route.date);
  if (route.view === 'stock' && route.code) p.set('code', route.code);
  if (['intraday', 'tags', 'blacklist'].includes(route.view)) p.set('view', route.view);
  if (route.view === 'intraday') {
    if (route.minuteCode) p.set('minute_code', route.minuteCode);
    if (route.minuteCompare.length) p.set('minute_compare', route.minuteCompare.join(','));
    if (route.timelineGEM) p.set('timeline_gem', '1');
  }
  if (route.view === 'tags' && route.tag) p.set('tag', route.tag);
  if (route.dailyTag) p.set('daily_tag', route.dailyTag);
  if (route.boards) p.set('boards', route.boards);
  if (route.layout !== 'industry') p.set('layout', route.layout);
  for (const [key, flag] of [
    ['exclude_st', route.excludeST],
    ['exclude_gem', route.excludeGEM],
    ['relation_exclude_st', route.relationExcludeST],
    ['relation_exclude_gem', route.relationExcludeGEM],
    ['relation_exclude_latest', route.relationExcludeLatest],
  ] as const)
    if (flag) p.set(key, '1');
  return pathname + (p.size ? `?${p}` : '');
}
export function createWorkspace() {
  const meta = ref<Metadata | null>(null),
    route = ref(parseRoute(location.search)),
    revision = ref(0),
    editor = ref<EditorTarget | null>(null);
  const date = computed({
    get: () => route.value.date,
    set: (value: string) => patchRoute({ date: value }),
  });
  function patchRoute(patch: Partial<RouteState>, replace = false) {
    route.value = { ...route.value, ...patch };
    const url = routeURL(route.value, location.pathname);
    if (url !== location.pathname + location.search)
      history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }
  function navigate(view: View) {
    patchRoute({ view });
  }
  function openStock(code: string, name = '') {
    if (!/^\d{6}$/.test(code)) return;
    rememberStock({ code, name });
    patchRoute({ view: 'stock', code });
  }
  function openDate(day: string) {
    patchRoute({ view: 'date', date: day, boards: '' });
  }
  async function refreshMeta() {
    const next = await request<Metadata>('/api/meta', 'metadata');
    if (!next) return;
    const previousLatest = meta.value?.query_dates?.at(-1) || meta.value?.latest_date;
    const following = !date.value || date.value === previousLatest;
    meta.value = next;
    const latest = next.query_dates?.at(-1) || next.latest_date || '';
    if (following && latest && latest !== date.value) patchRoute({ date: latest }, true);
  }
  async function changed() {
    revision.value++;
    await refreshMeta();
  }
  const onPopState = () => {
    route.value = parseRoute(location.search);
  };
  window.addEventListener('popstate', onPopState);
  return {
    meta,
    route,
    date,
    revision,
    editor,
    navigate,
    openStock,
    openDate,
    patchRoute,
    refreshMeta,
    changed,
    openEditor(kind: EditorKind, stock: StockIdentity) {
      editor.value = { kind, stock };
    },
    dispose() {
      window.removeEventListener('popstate', onPopState);
    },
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;
export const workspaceKey: InjectionKey<Workspace> = Symbol('workspace');
export function useWorkspace() {
  const workspace = inject(workspaceKey);
  if (!workspace) throw new Error('Workspace provider is missing');
  return workspace;
}
