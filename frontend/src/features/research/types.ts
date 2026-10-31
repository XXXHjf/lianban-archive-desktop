export type Revision = string | number;
export interface Stock {
  code: string;
  name?: string;
  initials?: string;
  tags?: string[];
  blacklisted?: boolean;
  note?: string;
  province?: string;
  region?: string;
  registered_province?: string;
  created_at?: string;
  direct?: boolean;
}
export interface Tag {
  name: string;
  count: number;
}
export interface Catalog {
  tags: Tag[];
  hierarchy?: { name: string; parent: string }[];
  total: number;
  stocks: number;
  revision: Revision;
}
export interface Members {
  name: string;
  rows: Stock[];
  count: number;
  revision: Revision;
}
export interface TagEditor {
  code: string;
  name: string;
  tags: string[];
  source_tags?: string[];
  source_tag?: string;
  revision: Revision;
  tag_alias_revision: Revision;
  blacklisted: boolean;
  merge_defaults?: boolean;
  customized?: boolean;
  tags_source?: string;
  tags_as_of?: string;
}
export interface NoteEntry {
  id: number;
  content: string;
  note_date: string;
  occurred_at: string;
  updated_at: string;
}
export interface NoteData {
  code: string;
  name: string;
  content: string;
  revision: number;
  entries: NoteEntry[];
  latest_entry_id: number | null;
}
export interface Blacklist {
  rows: Stock[];
  total: number;
}
export interface Holder {
  name: string;
  type: string;
  exclusion_reason?: string;
  reports: { scope: string; date: string }[];
}
export interface Peer {
  code: string;
  name: string;
  holders: Holder[];
  shared_count: number;
  today_together: boolean;
}
export interface Shareholders {
  rows: Peer[];
  name?: string;
  own_holders?: { float: OwnHolder[]; total: OwnHolder[] };
  control_owners?: ControlOwner[];
  control_status?: string;
  control_checked?: boolean;
  profiles: { scope?: string; report_date?: string; fetched_at: string }[];
  today: string;
  today_status: string;
  today_stale: boolean;
  today_fetched_at?: string;
  source: string;
  coverage: number;
  requested: number;
  status: string;
  scope_note: string;
}

export interface OwnHolder {
  name: string;
  type: string;
  report_date: string;
  holding_ratio: number | null;
}
export interface ControlOwner {
  kind: 'controller' | 'actual_controller';
  name: string;
  type: string;
  source_url: string;
  fetched_at: string;
}
export interface Subsidiaries {
  code: string;
  name: string;
  source: string;
  status: 'error' | 'current' | 'empty';
  disclosure_date: string;
  fetched_at: string;
  source_url: string;
  rows: { name: string; relation: string; holding_ratio: string; business: string }[];
}
