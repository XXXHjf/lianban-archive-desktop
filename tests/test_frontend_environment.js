const assert = require('node:assert/strict');
const { createBrowserEnvironment } = require('./legacy_frontend/modules/environment.mjs');
const { createApplication } = require('./legacy_frontend/modules/application.mjs');

const host = { Date, URL, URLSearchParams, AbortController, Option: function Option() {} };
host.window = host;
let storageReads = 0;
const document = { getElementById(id) { assert.equal(this, document); return { id }; } };
for (const name of ['document', 'location', 'history', 'performance', 'CSS']) {
  const result = name === 'document' ? document : { name };
  Object.defineProperty(host, name, { get() { assert.equal(this, host); return result; } });
}
for (const name of ['fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  host[name] = function (...args) { assert.equal(this, host); return { name, args }; };
}
Object.defineProperty(host, 'localStorage', { configurable: true, get() {
  assert.equal(this, host);
  storageReads++;
  const error = new Error('Storage is disabled');
  error.name = 'SecurityError';
  throw error;
} });

const environment = createBrowserEnvironment(host);
const application = createApplication(environment);
assert.equal(storageReads, 0, 'constructing all features must not access denied storage');
assert.equal(application.features.preferences.readRelationHeight(), 880);
assert.deepEqual(application.features.preferences.readRecentStocks(), []);
assert.equal(storageReads, 2, 'preference reads access storage inside their fallback guards');
assert.deepEqual(environment.$('trade-date'), { id: 'trade-date' });
for (const name of ['fetch', 'setTimeout', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame']) {
  assert.deepEqual(environment[name]('argument'), { name, args: ['argument'] });
}
assert.equal(environment.Date, Date);
assert.equal(environment.Date.now, Date.now, 'constructors keep their static methods');
assert.equal(environment.Option, host.Option);
assert.equal(environment.URL, URL);
assert.equal(new environment.URL('/path', 'https://example.test').pathname, '/path');

const storage = {
  values: new Map(),
  getItem(key) { assert.equal(this, storage); return this.values.get(key) || null; },
  setItem(key, value) { assert.equal(this, storage); this.values.set(key, value); }
};
Object.defineProperty(host, 'localStorage', { get() { assert.equal(this, host); return storage; } });
environment.localStorage.setItem('limit-up-archive.relation-height.v1', '1000');
assert.equal(application.features.preferences.readRelationHeight(), 1000,
  'the lazy storage facade preserves native method receivers and current storage');
console.log('frontend browser environment passed');
