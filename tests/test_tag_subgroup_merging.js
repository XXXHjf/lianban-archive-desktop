const { install } = require('./frontend-harness.cjs');
// Child groups with identical stock sets share cards at every board height.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');

const context = vm.createContext({canManageTags: () => context.state.meta.capabilities?.manage_tags !== false, state: {grouping: 'industry', meta: {
  latest_date: '2026-10-28', tag_order: ['机器人', '减速器', '轴承', '分支', '电机<标签>'],
  tag_hierarchy: [{name: '机器人', parent: ''}, {name: '减速器', parent: '机器人'},
    {name: '轴承', parent: '机器人'}, {name: '分支', parent: '机器人'}, {name: '电机<标签>', parent: '分支'}]
}}});
install(context, ["escapeHTML","textValue","numberValue","normalizeRelationHeight","readRelationHeight","applyRelationHeight","normalizeRecentStocks","readRecentStocks","renderRecentStocks","rememberStock","marketValue","dateLabel","latestLimitUp","prioritizeLatest","latestLimitBadge","latestPriorityNote"], []);
install(context, ["stockTags","allStockTags","tagHierarchy","tagAncestors","tagRoot","renderHierarchyStockGroups","tagRanks","compareTags","sortedTags","applyTagOrder","refreshTagOrder","canEditTags","canEditNotes","renderStockNote","renderStockHeaderNote","regionLabel","nameInitials","codeDigits","orderMatchingGroups","orderPinyinGroups","orderCodeGroups","renderStockCard","renderSuspensionNote","renderSuspendedLeaders","industryTagBoardCounts","industryGroupRank","industryColumnHeading","mergeIdenticalFirstBoardGroups","renderIndustryColumns"], []);
const stock = (code, boards, tags) => ({code, name: '同名股票', boards, tags, date: '2026-10-28', note: '保留备注'});
const cards = (html, code) => (html.match(new RegExp(`data-card-code="${code}"`, 'g')) || []).length;
const sections = html => (html.match(/class="matrix-tag-subgroup"/g) || []).length;

const shared = stock('000678', 5, ['机器人', '减速器', '轴承']);
const original = JSON.stringify(shared);
const merged = context.renderHierarchyStockGroups([shared], '机器人', true);
assert.equal(sections(merged), 1);
assert.equal(cards(merged, '000678'), 1, 'five-board stock appears once instead of once per child tag');
assert.ok(merged.includes('data-child-tag="减速器 / 轴承"') && merged.includes('<small>1 只</small>'));
for (const tag of ['减速器', '轴承']) {
  assert.ok(merged.includes(`data-add-sector-tag="${tag}"`), 'each merged label keeps its own add-stocks action');
  assert.ok(merged.includes(`<span class="stock-tag">${tag}</span>`), 'card retains both underlying memberships');
}
assert.ok(merged.includes('保留备注') && !merged.includes('直接归属'));
assert.equal(JSON.stringify(shared), original, 'presentation does not modify the source stock');

const pair = [stock('000001', 1, ['减速器', '轴承']), stock('000002', 1, ['轴承', '减速器'])];
const pairHTML = context.renderHierarchyStockGroups(pair, '机器人', true);
assert.equal(sections(pairHTML), 1, 'identical multi-stock cohorts merge too');
assert.equal(cards(pairHTML, '000001'), 1);
assert.equal(cards(pairHTML, '000002'), 1);
assert.ok(pairHTML.includes('<small>2 只</small>'));

const overlap = [...pair, stock('000003', 1, ['轴承'])];
assert.equal(sections(context.renderHierarchyStockGroups(overlap, '机器人', true)), 2, 'partial overlap does not merge');
const equalCounts = [stock('000001', 1, ['减速器']), stock('000002', 1, ['轴承'])];
assert.equal(sections(context.renderHierarchyStockGroups(equalCounts, '机器人', true)), 2, 'same count/name but different codes do not merge');

const deeper = context.renderHierarchyStockGroups([stock('000001', 2, ['轴承', '电机<标签>'])], '机器人', true);
assert.equal(sections(deeper), 1);
assert.ok(deeper.includes('分支 / </small>') && deeper.includes('电机&lt;标签&gt;') && !deeper.includes('电机<标签>'), 'merged labels preserve escaped multi-level paths');
context.state.meta.capabilities = {manage_tags: false, edit_tags: false};
assert.ok(!context.renderHierarchyStockGroups([shared], '机器人', true).includes('data-add-sector-tag'), 'read-only mode has no write actions');
delete context.state.meta.capabilities;

const day = [shared, ...overlap];
const dayHTML = context.renderIndustryColumns(day, context.industryTagBoardCounts(day));
const high = dayHTML.slice(dayHTML.indexOf('data-board-height="5"'), dayHTML.indexOf('data-board-height="1"'));
assert.equal(cards(high, '000678'), 1, 'other heights may have different child cohorts without duplicating this height');
assert.equal(cards(dayHTML, '000001'), 2, 'partially overlapping first-board child groups remain separate');
assert.equal(cards(context.renderIndustryColumns([shared], context.industryTagBoardCounts(day)), '000678'), 1, 'board filtering preserves child merge behavior');
console.log('Child tag cohorts: high/first boards, exact sets, retained paths/actions/counts, partial overlaps, read-only mode and no data mutation passed.');
