const { install } = require('./frontend-harness.cjs');
// Identical first-board cohorts can share a presentation column without rewriting tags.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");

const context = vm.createContext({state: {grouping: "industry", meta: {latest_date: "2026-10-26",
  tag_order: ["3D打印", "体育产业", "稀土永磁", "定制<标签>", "甲", "乙", "丙", "领涨甲", "领涨乙", "共同甲", "共同乙"]}}});
install(context, ["escapeHTML","textValue","numberValue","normalizeRelationHeight","readRelationHeight","applyRelationHeight","normalizeRecentStocks","readRecentStocks","renderRecentStocks","rememberStock","marketValue","dateLabel","latestLimitUp","prioritizeLatest","latestLimitBadge","latestPriorityNote"], []);
install(context, ["stockTags","allStockTags","tagHierarchy","tagAncestors","tagRoot","renderHierarchyStockGroups","tagRanks","compareTags","sortedTags","applyTagOrder","refreshTagOrder","canEditTags","canEditNotes","renderStockNote","renderStockHeaderNote","regionLabel","nameInitials","codeDigits","orderMatchingGroups","orderPinyinGroups","orderCodeGroups","renderStockCard","renderSuspensionNote","renderSuspendedLeaders","industryTagBoardCounts","industryGroupRank","industryColumnHeading","mergeIdenticalFirstBoardGroups","renderIndustryColumns"], []);
const stock = (code, boards, tags) => ({code, boards, tags, name: "同名样本", date: "2026-10-26", initials: "HYW"});
const headers = html => [...html.matchAll(/data-group-label="([^"]+)"/g)].map(match => match[1]);
const occurrences = (html, code) => (html.match(new RegExp(`data-card-code="${code}"`, "g")) || []).length;
const comparison = html => html.split('<div class="board-comparison"')[1];

const oneStock = [stock("600980", 1, ["稀土永磁", "3D打印", "定制<标签>"]), stock("600981", 1, ["3D打印", "稀土永磁", "定制<标签>"]),
  stock("600826", 1, ["体育产业"]), stock("600827", 1, ["体育产业"])];
const unchanged = JSON.stringify(oneStock), counts = context.industryTagBoardCounts(oneStock), unchangedCounts = JSON.stringify(counts);
const combined = context.renderIndustryColumns(oneStock, counts);
assert.deepEqual(headers(combined), ["3D打印 / 稀土永磁 / 定制&lt;标签&gt;", "体育产业"],
  "equal cohorts merge even when their original columns were not adjacent; all names retain global tag order");
assert.equal(occurrences(combined, "600980"), 1, "the same first-board stock is shown only once in its combined column");
assert.ok(combined.includes('--matrix-columns:2') && combined.includes('<strong>4</strong> 个行业')
  && combined.includes('<strong>4</strong> 只股票') && combined.includes('相同首板合并为 2 列'),
  "tag totals, unique stock totals and the reduced presentation width remain distinct");
assert.ok(combined.includes('matrix-cell-merged') && !combined.includes('<标签>'), "merged headers safely escape custom tag names");
for (const label of ["3D打印", "稀土永磁"]) assert.ok(combined.includes(`data-add-sector-tag="${label}"`), "each label in a merged header has its own add-stocks button");
assert.ok(combined.includes('<span class="stock-tag">3D打印</span>') && combined.includes('<span class="stock-tag">稀土永磁</span>'),
  "cards retain all original tags instead of renaming or merging stored memberships");
assert.equal(comparison(context.renderIndustryColumns([...oneStock].reverse(), counts)), comparison(combined));
assert.equal(JSON.stringify(oneStock), unchanged);
assert.equal(JSON.stringify(counts), unchangedCounts);

const shared = [stock("000001", 1, ["甲", "乙", "丙"]), stock("000002", 1, ["甲", "乙"]), stock("000003", 1, ["丙"])];
const sharedHTML = context.renderIndustryColumns(shared);
assert.deepEqual(headers(sharedHTML), ["甲 / 乙", "丙"], "a multi-stock cohort needs exact code-set equality, not equal counts or overlapping names");
assert.equal(occurrences(sharedHTML, "000001"), 2, "partially overlapping cohorts still each include their shared stock");
assert.equal(occurrences(sharedHTML, "000002"), 1);
assert.equal(occurrences(sharedHTML, "000003"), 1);

const hierarchy = [stock("000010", 5, ["领涨甲"]), stock("000011", 3, ["领涨乙"]), stock("000012", 1, ["领涨甲", "领涨乙"])];
const hierarchyCounts = context.industryTagBoardCounts(hierarchy);
assert.deepEqual(headers(context.renderIndustryColumns(hierarchy, hierarchyCounts)), [5, 3, 1].flatMap(() => ["领涨甲", "领涨乙"]),
  "equal first-board followers do not merge columns whose higher-board leaders differ");
assert.deepEqual(headers(context.renderIndustryColumns(hierarchy.filter(row => row.boards === 1), hierarchyCounts)), ["领涨甲", "领涨乙"],
  "first-board filtering still checks hidden daily leaders before merging");

const identicalHierarchy = [stock("000020", 3, ["共同甲", "共同乙"]), stock("000021", 1, ["共同甲", "共同乙"])];
const identicalCounts = context.industryTagBoardCounts(identicalHierarchy);
const identicalHTML = context.renderIndustryColumns(identicalHierarchy, identicalCounts);
assert.deepEqual(headers(identicalHTML), ["共同甲 / 共同乙", "共同甲 / 共同乙"], "identical entire cohorts can share one aligned column across heights");
assert.equal(occurrences(identicalHTML, "000020"), 1);
assert.equal(occurrences(identicalHTML, "000021"), 1);
assert.deepEqual(headers(context.renderIndustryColumns(identicalHierarchy.filter(row => row.boards === 1), identicalCounts)), ["共同甲", "共同乙"],
  "counts alone cannot prove that hidden leaders are the same stocks");

const withoutFirst = [stock("000030", 3, ["甲", "乙"]), stock("000031", 2, ["甲", "乙"])];
assert.deepEqual(headers(context.renderIndustryColumns(withoutFirst)), [3, 2].flatMap(() => ["甲", "乙"]), "the new merge rule requires first-board membership");
const changed = [...oneStock, stock("600982", 1, ["3D打印"])];
assert.ok(headers(context.renderIndustryColumns(changed)).includes("3D打印"), "a changed daily cohort automatically splits the column again");
assert.equal(occurrences(context.renderIndustryColumns([]), "600980"), 0);
for (const grouping of ["pinyin", "code", "region"]) {
  context.state.grouping = grouping;
  assert.ok(!context.renderIndustryColumns(oneStock).includes('matrix-cell-merged'), `${grouping} keeps its own matching rules`);
}
console.log("Identical first-board cohorts: exact code sets, retained names/order, unique counts, leader alignment, board filters, escaping, split-on-change and other layouts: passed.");
