export interface MinuteStock {
  code: string;
  name: string;
  boards: number;
  date?: string;
  initials?: string;
  market?: string;
  industry?: string;
  first_time?: string;
  last_time?: string;
  clock_source?: string;
  close?: number;
  pct_change?: number;
  status?: string;
  point_count?: number;
  tags?: string[];
  note?: string;
  blacklisted?: boolean;
  registration_province?: string;
  registered_province?: string;
  province?: string;
  region?: string;
}
export interface MinutePoint {
  time: string;
  slot: number;
  price: number;
  average?: number;
  volume: number;
  amount: number;
}
export interface MinuteDetail {
  date: string;
  stock: MinuteStock;
  status: string;
  points: MinutePoint[];
  previous_close?: number;
  auction?: { points?: MinutePoint[]; status?: string; note?: string; source?: string };
  note: string;
  source?: string;
  fetched_at?: string;
  reference_basis?: string;
  provisional?: boolean;
  refresh_error?: string;
  needs_collection?: boolean;
  needs_refresh?: boolean;
}
export interface MinuteOverview {
  date: string | null;
  dates: string[];
  rows: MinuteStock[];
  total: number;
  ready: number;
  partial: number;
  scope_note: string;
  provisional?: boolean;
  catalog_complete?: boolean;
}
export type EventKind = 'seal' | 'relock' | 'last_seal' | 'break' | 'volume';
export interface TimelineEvent {
  id: string;
  code: string;
  name: string;
  boards: number;
  kind: EventKind;
  time: string;
  label: string;
  precision: string;
  detail: string;
  price?: number;
  volume?: number;
  ratio?: number;
}
export interface TimelineData {
  date: string;
  pool: MinuteStock[];
  events: TimelineEvent[];
  provisional?: boolean;
  scope: { exclude_st: boolean; exclude_gem: boolean };
  coverage: { total: number; analyzed: number; partial: number; missing: number };
  jobs: { code: string; name: string; force: boolean }[];
  time_coverage?: { missing: number; cached: boolean };
}
export interface Comparison {
  loading: boolean;
  data?: MinuteDetail;
  error?: string;
}
