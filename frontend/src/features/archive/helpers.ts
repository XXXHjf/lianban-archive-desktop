import type { Cycle, Group, Peer, Relationships, Stock, TagNode } from './models';
export const region = (stock: Stock) =>
  (stock.registered_province || '地区待补充')
    .replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区/g, '')
    .replace(/[省市]$/, '');
export const initials = (stock: Stock) =>
  (stock.initials || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function hierarchy(nodes: TagNode[] = [], order: string[] = []) {
  const parents = new Map(
    nodes.filter((node) => node.parent).map((node) => [node.name.toLowerCase(), node.parent!]),
  );
  const parentKeys = new Set([...parents.values()].map((name) => name.toLowerCase()));
  const ranks = new Map(order.map((name, index) => [name.toLowerCase(), index]));
  function ancestors(tag: string) {
    const result: string[] = [],
      seen = new Set([tag.toLowerCase()]);
    while (parents.has(tag.toLowerCase())) {
      tag = parents.get(tag.toLowerCase())!;
      if (seen.has(tag.toLowerCase())) break;
      seen.add(tag.toLowerCase());
      result.push(tag);
    }
    return result;
  }
  const compare = (a: string, b: string) => {
    if (!order.length) return 0;
    const left = a.toLowerCase(),
      right = b.toLowerCase();
    return (
      (ranks.get(left) ?? Infinity) - (ranks.get(right) ?? Infinity) ||
      (left < right ? -1 : left > right ? 1 : 0)
    );
  };
  const all = (stock: Stock) =>
    [...new Set(stock.tags || (stock.industry ? [stock.industry] : []))].sort(compare);
  const root = (tag: string) => ancestors(tag).at(-1) || tag;
  const leaves = (stock: Stock) => {
    const tags = all(stock);
    return tags.filter(
      (tag) =>
        !tags.some((other) =>
          ancestors(other).some((parent) => parent.toLowerCase() === tag.toLowerCase()),
        ),
    );
  };
  return { ancestors, parentKeys, compare, all, root, leaves };
}
export type Hierarchy = ReturnType<typeof hierarchy>;
export function cycleStatus(cycle: Cycle, asOf: string) {
  return cycle.clipped || cycle.start_known === false
    ? '周期边界待确认'
    : cycle.ongoing
      ? `截至 ${asOf} 仍在连板`
      : cycle.end_known === true
        ? '已结束'
        : '后续状态待确认';
}
export function matchingGroups(
  groups: Map<string, Stock[]>,
  sequence: (s: Stock) => string,
  length: number,
  minLength = 1,
  acceptMatch: (stock: Stock, token: string, position: number) => boolean = () => true,
): Group[] {
  const matches = new Map<string, Map<string, { stock: Stock; position: number }>>();
  for (const [key, stocks] of groups) {
    if (key === '#') continue;
    for (const stock of stocks)
      for (let n = Math.min(length, key.length); n >= minLength; n--)
        for (let i = 0; i <= key.length - n; i++) {
          const token = key.slice(i, i + n);
          if (!acceptMatch(stock, token, i)) continue;
          if (!matches.has(token)) matches.set(token, new Map());
          const members = matches.get(token)!;
          if (!members.has(stock.code)) members.set(stock.code, { stock, position: i });
        }
  }
  const result = [...matches]
    .filter(([, stocks]) => stocks.size > 1)
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], 'en'))
    .map(([token, stocks]) => ({
      labels: [token],
      stocks: [...stocks.values()]
        .sort(
          (a, b) =>
            (b.stock.boards || 0) - (a.stock.boards || 0) ||
            a.position - b.position ||
            sequence(a.stock).localeCompare(sequence(b.stock), 'en') ||
            a.stock.code.localeCompare(b.stock.code),
        )
        .map(({ stock }) => stock),
    }));
  return result;
}
export function dailyGroups(
  rows: Stock[],
  mode: string,
  tagBoards: Record<string, Record<string, number>>,
  tags: Hierarchy,
): Group[] {
  const groups = new Map<string, Stock[]>(),
    unknown =
      mode === 'region' ? '地区待补充' : mode === 'pinyin' || mode === 'code' ? '#' : '独苗';
  const solitary = new Set(
    Object.entries(tagBoards)
      .filter(([, heights]) => Object.values(heights).reduce((a, b) => a + Math.max(0, b), 0) === 1)
      .map(([tag]) => tag),
  );
  for (const row of rows) {
    let labels =
      mode === 'region'
        ? [region(row)]
        : mode === 'pinyin'
          ? [initials(row) || '#']
          : mode === 'code'
            ? [/^\d{6}$/.test(row.code) ? row.code : '#']
            : [...new Set(tags.all(row).map(tags.root))];
    if (mode === 'industry') {
      if (labels.every((label) => solitary.has(label) && !tags.parentKeys.has(label.toLowerCase())))
        labels = [unknown];
      else if ((row.boards || 0) > 1) {
        const related = labels.filter((label) =>
          Object.entries(tagBoards[label] || {}).some(
            ([height, count]) => Number(height) !== row.boards && count > 0,
          ),
        );
        labels = [
          ...new Set([
            ...labels.filter((label) => tags.parentKeys.has(label.toLowerCase())),
            ...(related.length ? related : labels.slice(0, 1)),
          ]),
        ];
      }
    }
    for (const label of labels.length ? labels : [unknown]) {
      if (!groups.has(label)) groups.set(label, []);
      if (!groups.get(label)!.some((stock) => stock.code === row.code))
        groups.get(label)!.push(row);
    }
  }
  if (mode === 'pinyin' || mode === 'code')
    return matchingGroups(
      groups,
      mode === 'pinyin' ? initials : (stock) => stock.code,
      mode === 'pinyin' ? 4 : 6,
      mode === 'code' ? 3 : 1,
      mode === 'pinyin'
        ? (stock, token, position) =>
            !(
              Array.from(stock.name.normalize('NFKC')).length === 4 &&
              initials(stock).length === 4 &&
              token.length === 2 &&
              position === 1
            )
        : undefined,
    );
  function rank(label: string, stocks: Stock[]) {
    const counts = mode === 'industry' && label !== unknown ? tagBoards[label] : undefined;
    const entries = Object.entries(counts || {}).filter(([, count]) => count > 0);
    return entries.length
      ? [
          Math.max(...entries.map(([height]) => Number(height))),
          entries.reduce((sum, [, count]) => sum + count, 0),
        ]
      : [Math.max(0, ...stocks.map((stock) => stock.boards || 0)), stocks.length];
  }
  const ordered = [...groups].sort(([a, left], [b, right]) => {
    if (a === unknown) return 1;
    if (b === unknown) return -1;
    const l = rank(a, left),
      r = rank(b, right);
    return (
      r[0]! - l[0]! ||
      r[1]! - l[1]! ||
      (mode === 'industry' ? tags.compare(a, b) : 0) ||
      a.localeCompare(b, 'zh-CN')
    );
  });
  const result: Group[] = [],
    cohorts = new Map<string, Group>();
  for (const [name, stocks] of ordered) {
    const counts: Record<string, number> = {};
    stocks.forEach((stock) => {
      const height = String(stock.boards);
      counts[height] = (counts[height] || 0) + 1;
    });
    const daily = Object.entries(tagBoards[name] || counts).filter(([, count]) => count > 0);
    const complete =
      daily.length === Object.keys(counts).length &&
      daily.every(([height, count]) => counts[height] === count);
    const key =
      mode === 'industry' &&
      name !== unknown &&
      !tags.parentKeys.has(name.toLowerCase()) &&
      counts['1'] &&
      complete
        ? JSON.stringify(stocks.map((stock) => [stock.code, stock.boards]).sort())
        : null;
    const existing = key ? cohorts.get(key) : undefined;
    if (existing) existing.labels.push(name);
    else {
      const group = { labels: [name], stocks };
      result.push(group);
      if (key) cohorts.set(key, group);
    }
  }
  return result;
}
export function subgroups(stocks: Stock[], root: string, tags: Hierarchy): Group[] {
  if (!tags.parentKeys.has(root.toLowerCase())) return [{ labels: [], stocks }];
  const groups = new Map<string, Stock[]>();
  for (const stock of stocks)
    for (const tag of tags.leaves(stock).filter((tag) => tags.root(tag) === root)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push(stock);
    }
  const result: Group[] = [],
    cohorts = new Map<string, Group>();
  for (const [name, rows] of [...groups].sort(([a], [b]) => tags.compare(a, b))) {
    const key = rows
        .map((row) => row.code)
        .sort()
        .join('|'),
      existing = cohorts.get(key);
    if (existing) existing.labels.push(name);
    else {
      const group = { labels: [name], stocks: rows };
      result.push(group);
      cohorts.set(key, group);
    }
  }
  return result;
}
export function mergePeers(data: Relationships | null, target: string): Peer[] {
  const peers = new Map<string, Peer>();
  function get(row: Stock) {
    if (!/^\d{6}$/.test(row.code) || row.code === target) return null;
    if (!peers.has(row.code))
      peers.set(row.code, {
        ...row,
        wins: [],
        losses: [],
        commonDates: [],
        winCount: 0,
        lossCount: 0,
        commonCount: 0,
        lastDate: '',
      });
    const peer = peers.get(row.code)!;
    Object.assign(peer, row);
    return peer;
  }
  for (const kind of ['wins', 'losses'] as const)
    for (const row of data?.competition[kind] || []) {
      const peer = get(row);
      if (peer)
        peer[kind] = [
          ...new Map(
            [...peer[kind], ...(row.rounds || [])].map((round) => [
              `${round.date}|${round.next_date}|${round.boards}`,
              round,
            ]),
          ).values(),
        ];
    }
  for (const row of data?.cooccurrences.rows || []) {
    const peer = get(row);
    if (peer)
      peer.commonDates = [
        ...new Map(
          [...peer.commonDates, ...(row.dates || [])].map((day) => [day.date, day]),
        ).values(),
      ];
  }
  return [...peers.values()].map((peer) => ({
    ...peer,
    winCount: peer.wins.length,
    lossCount: peer.losses.length,
    commonCount: peer.commonDates.length,
    lastDate:
      [
        ...peer.commonDates.map((day) => day.date),
        ...peer.wins.map((round) => round.next_date || round.date),
        ...peer.losses.map((round) => round.next_date || round.date),
      ]
        .sort()
        .at(-1) || '',
  }));
}
