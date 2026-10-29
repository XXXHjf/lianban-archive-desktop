const { install } = require('./frontend-harness.cjs');
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const context = vm.createContext({state:{}});
install(context, ["stockTags","allStockTags","tagHierarchy","tagAncestors","tagRoot","renderHierarchyStockGroups","tagRanks","compareTags","sortedTags","applyTagOrder","refreshTagOrder"], []);
install(context, ["defaultEditorTags","hideTagSuggestions","matchesExistingTag","positionTagSuggestions","renderTagSuggestions","loadTagSuggestionCatalog","chooseExistingTag","onTagSuggestionInput","onTagSuggestionKeydown"], []);
const plural = context.defaultEditorTags({source_tag: "旧行业", source_tags: ["机器人", "风电"]});
assert.deepEqual(Array.from(plural), ["机器人", "风电"]);
assert.deepEqual(Array.from(context.defaultEditorTags({source_tag: "旧行业", source_tags: []})), []);
assert.deepEqual(Array.from(context.defaultEditorTags({source_tag: "旧行业"})), ["旧行业"]);
const data = {source_tags: ["机器人", "风电"]};
context.defaultEditorTags(data).push("修改草稿");
assert.deepEqual(data.source_tags, ["机器人", "风电"], "restoring defaults does not mutate the loaded source list");
assert.equal(typeof context.defaultEditorTags, "function");
console.log("Plural concept defaults, empty intersection, legacy compatibility and independent drafts: passed.");
