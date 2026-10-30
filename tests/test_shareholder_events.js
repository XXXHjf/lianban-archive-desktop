const assert = require('node:assert/strict');
const { createApplication } = require('./legacy_frontend/modules/application.mjs');

// Exercise the shipped event registrations, rather than replicas of handlers.
function surface(selectors = []) {
  const handlers = new Map();
  return {
    handlers, hidden: true, style: {}, innerHTML: '', scrollTop: 0,
    addEventListener(name, callback) { (handlers.get(name) || handlers.set(name, []).get(name)).push(callback); },
    emit(name, event = {}) { for (const callback of handlers.get(name) || []) callback(event); },
    closest(selector) { return selectors.includes(selector) ? this : null; },
    contains(target) { return target === this; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return {left: 20, top: 40, bottom: 64, right: 550, width: 530, height: 300}; },
    focus() { this.focused = true; },
  };
}
const document = surface(), window = {...surface(), innerWidth: 1200, innerHeight: 800};
const tooltip = surface(['#shareholder-tooltip']);
const dialog = {...surface(['#shareholder-info-dialog']), open: false,
  showModal() { this.open = true; }, close() { this.open = false; }};
const close = surface(), content = surface();
const elements = {'shareholder-tooltip': tooltip, 'shareholder-info-dialog': dialog,
  'shareholder-info-content': content, 'close-shareholder-info': close};
const saved = [], pending = [], chosen = [];
let observer;
const environment = {document, window, $: id => elements[id], URLSearchParams, setTimeout, clearTimeout,
  localStorage: {getItem: () => null, setItem: (...args) => saved.push(args)},
  MutationObserver: class {constructor(callback) { observer = callback; } observe() {} }};
const {features} = createApplication(environment);
features.api.request = url => new Promise(resolve => pending.push({url, resolve}));
features.stock.chooseStock = stock => chosen.push(stock);
features.shareholders.bindEvents();
const data = {profiles: [{scope: 'total', report_date: '2026-09-30', fetched_at: '2026-10-29T08:00:00+08:00'}], today: '2026-10-29', today_status: 'unavailable', status: 'updating',
  rows: [{code: '000002', name: '关联股票', today_together: false,
    holders: [{name: '股东', type: '个人', reports: []}]}]};
function icon(code) {
  return {...surface(['[data-shareholder-code]']), dataset: {shareholderCode: code}, isConnected: true,
    setAttribute() {}, removeAttribute() {}, getClientRects() { return [1]; }};
}
function event(target, extra = {}) {return {target, relatedTarget: null, preventDefault() {this.prevented = true;}, ...extra};}
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const a = icon('000001'), b = icon('000003');
  document.emit('pointerover', event(a));
  assert.equal(pending.length, 1);
  pending[0].resolve(data); await settle();
  const click = event(a); document.emit('click', click);
  assert.equal(click.prevented, true);
  assert.equal(features.shareholders.read('shareholderPinned'), true);
  document.emit('pointerout', event(a));
  document.emit('focusin', event(b));
  assert.equal(pending.length, 1, 'focus does not replace a pinned popup');
  const filter = {...surface(['[data-shareholder-block-type]']), dataset: {shareholderBlockType: '个人'}, checked: true};
  tooltip.emit('change', event(filter));
  assert.ok(tooltip.innerHTML.includes('共同股东已全部屏蔽'));
  assert.equal(saved[0][0], 'limit-up-archive.shareholder-blocked-types.v1');
  assert.deepEqual(JSON.parse(saved[0][1]), [['个人', true]]);
  const more = surface(['[data-shareholder-more]']);
  tooltip.scrollTop = 100; document.emit('click', event(more));
  assert.equal(features.shareholders.read('shareholderLimit'), 100);
  assert.equal(tooltip.scrollTop, 100);
  assert.equal(tooltip.focused, true);
  document.emit('click', event(surface(['[data-shareholder-info]'])));
  assert.equal(dialog.open, true);
  document.emit('keydown', event(tooltip, {key: 'Escape'}));
  assert.equal(dialog.open, false);
  assert.equal(tooltip.hidden, false, 'first Escape dismisses help only');
  document.emit('keydown', event(tooltip, {key: 'Escape'}));
  assert.equal(tooltip.hidden, true);
  assert.equal(a.focused, true);
  document.emit('focusin', event(b));
  assert.equal(pending.length, 2);
  pending[1].resolve(data); await settle();
  const arrow = event(b, {key: 'ArrowDown'}); document.emit('keydown', arrow); await settle();
  assert.equal(arrow.prevented, true);
  document.emit('click', event({...surface(['[data-shareholder-peer]']), dataset: {shareholderPeer: '000002', peerName: '关联股票'}}));
  assert.deepEqual(chosen, [{code: '000002', name: '关联股票'}]);
  assert.equal(tooltip.hidden, true);
  document.emit('click', event(a));
  pending[2].resolve(data); await settle();
  document.emit('scroll', event(tooltip));
  assert.equal(tooltip.hidden, false);
  window.emit('resize'); assert.equal(tooltip.hidden, true);
  document.emit('click', event(b)); pending[3].resolve(data); await settle();
  let aborted = 0; features.api.channels.shareholders = {abort() {aborted++;}};
  b.getClientRects = () => []; observer();
  assert.equal(tooltip.hidden, true, 'hiding the anchor view dismisses the popup');
  assert.equal(aborted, 1, 'dismissing a hidden view aborts its shareholder request');
  document.emit('click', event(a)); pending[4].resolve(data); await settle();
  a.isConnected = false; observer(); assert.equal(tooltip.hidden, true, 'removed cards dismiss the popup');
  assert.throws(() => features.shareholders.write('selectedStock', {}), /Unknown shareholders state/);
  console.log('Shareholder events: hover/focus, pinning, filters, pagination, help, keyboard, navigation and cleanup: passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
