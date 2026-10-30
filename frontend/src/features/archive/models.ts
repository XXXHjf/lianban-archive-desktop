export interface Stock {
  code: string;
  name: string;
  market?: string;
  initials?: string;
  industry?: string;
  tags?: string[];
  tags_customized?: boolean;
  registered_province?: string;
  blacklisted?: boolean;
  note?: string;
  date?: string;
  boards?: number;
  suspended?: boolean;
  board_date?: string;
  resume_date?: string;
  suspension_reason?: string;
}
export interface Observation {
  date: string;
  boards: number;
  name?: string;
  code?: string;
}
export interface RoundEvidence {
  date: string;
  next_date?: string;
  boards: number;
}
export interface Round extends RoundEvidence {
  next_trading_date?: string;
  outcome: string;
  status?: string;
  wins: Stock[];
  losses: Stock[];
  cohort?: (Stock & { is_target?: boolean; promotion_status?: string })[];
  together_count?: number;
}
export interface CommonDay {
  date: string;
  target_boards?: number;
  peer_boards?: number;
}
export interface RelationPeer extends Stock {
  rounds?: RoundEvidence[];
  dates?: CommonDay[];
}
export interface Relationships {
  range_start: string;
  range_end: string;
  target_limit_days: number;
  competition: {
    scope_note?: string;
    rounds: Round[];
    wins: RelationPeer[];
    losses: RelationPeer[];
    win_round_count?: number;
    loss_round_count?: number;
  };
  cooccurrences: { rows: RelationPeer[]; scope_note?: string };
}
export interface Peer extends Stock {
  wins: RoundEvidence[];
  losses: RoundEvidence[];
  commonDates: CommonDay[];
  winCount: number;
  lossCount: number;
  commonCount: number;
  lastDate: string;
}
export interface Cycle {
  start: string;
  end: string;
  boards: number;
  dates?: string[];
  clipped?: boolean;
  start_known?: boolean;
  end_known?: boolean;
  ongoing?: boolean;
  note?: string;
}
export interface StockData {
  stock: Stock;
  rows: Observation[];
  cycles: Cycle[];
  range_start: string;
  range_end: string;
  as_of_date?: string;
  coverage_note: string;
  stats: { limit_days: number; max_boards: number; cycles: number };
  relationships: Relationships;
}
export interface ComparisonSegment {
  start: string;
  end: string;
  target_dates: Observation[];
  peer_dates: Observation[];
  common_dates: string[];
  leader:
    (Stock & { start: string; end: string; max_boards?: number; dates: Observation[] }) | null;
}
export interface Comparison {
  segments: ComparisonSegment[];
}
export interface DailyData {
  date: string;
  rows: Stock[];
  suspended_rows: Stock[];
  coverage_note: string;
  data_status: string;
  provisional?: boolean;
  fetched_at?: string;
  live?: { status?: string; stale?: boolean };
  suspension_status?: string;
  trading_max_boards: number;
  available_total: number;
  board_counts: { boards: number; count: number }[];
  tag_board_counts: Record<string, Record<string, number>>;
  stats: { total: number; consecutive: number; max_boards: number; first_boards: number };
}
export interface TagNode {
  name: string;
  parent?: string | null;
}
export interface Group {
  labels: string[];
  stocks: Stock[];
}
