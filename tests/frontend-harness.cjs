// Tests import real feature factories. No application source fragments are evaluated.
const { createApplication } = require('../web/modules/application.mjs');
const { functionOwners, stateOwners, bindingOwners } = require('./frontend-contract.cjs');
const applications = new WeakMap();

function install(context, functions = [], bindings = []) {
  let record = applications.get(context);
  if (!record) {
    const forwarded = new Map();
    const environment = new Proxy(context, {
      get(target, key) {
        const current = () => key in target ? target[key] : globalThis[key];
        if (key === 'Date' || typeof current() === 'function') {
          if (!forwarded.has(key)) forwarded.set(key, new Proxy(function () {}, {
            apply(_fn, _self, args) { return Reflect.apply(current(), target, args); },
            construct(_fn, args) { return Reflect.construct(current(), args); },
            get(_fn, name) { return current()?.[name]; }
          }));
          return forwarded.get(key);
        }
        return current();
      }
    });
    const application = createApplication(environment);
    const state = context.state || (context.state = {});
    for (const [key, owner] of Object.entries(stateOwners)) {
      const feature = application.features[owner];
      if (key === 'requests') {
        feature.channels = state[key] || {};
        Object.defineProperty(state, key, { configurable: true, enumerable: true,
          get: () => feature.channels, set: value => { feature.channels = value; } });
      } else {
        if (Object.hasOwn(state, key)) feature.write(key, state[key]);
        Object.defineProperty(state, key, { configurable: true, enumerable: true,
          get: () => feature.read(key), set: value => feature.write(key, value) });
      }
    }
    const originals = {};
    for (const [name, owner] of Object.entries(functionOwners)) {
      const feature = application.features[owner];
      originals[name] = feature[name];
      Object.defineProperty(feature, name, { configurable: true,
        get: () => context[name] });
    }
    record = { application, originals };
    applications.set(context, record);
  }
  for (const name of functions) {
    if (!Object.hasOwn(record.originals, name)) throw new Error('Unknown public function: ' + name);
    context[name] = record.originals[name];
  }
  for (const name of bindings) {
    const owner = bindingOwners[name];
    if (!owner) throw new Error('Unknown event binding: ' + name);
    record.application.features[owner].bindings[name]();
  }
  return record.application;
}

module.exports = { install };
