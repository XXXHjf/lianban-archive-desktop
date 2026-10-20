const assert = require('node:assert/strict');
const {isUnread, safeReleaseUrl} = require('../web/updates.js');
const notice = {id:'release:2026.10.21', version:'2026.10.21',
  url:'https://github.com/x107108/lianban-archive-desktop/releases/tag/v2026.10.21'};
assert.equal(isUnread(null,''),false);
assert.equal(isUnread(notice,''),true);
assert.equal(isUnread(notice,notice.id),false);
assert.equal(isUnread({...notice,id:'release:2026.10.22'},notice.id),true);
assert.equal(safeReleaseUrl(notice),notice.url);
for (const url of ['javascript:alert(1)','https://evil.example/download',notice.url+'/../../settings',notice.url+'?token=x']) {
  assert.equal(safeReleaseUrl({...notice,url}),null);
}
assert.equal(safeReleaseUrl({...notice,version:'../main'}),null);
console.log('Update notice unread state and release-link validation passed.');
