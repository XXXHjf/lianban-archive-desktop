// Keep native Window getters and methods attached to their actual receiver.
// Storage stays lazy: a browser can deny it while the rest of the app works.
export function createBrowserEnvironment(host) {
  const value = name => Reflect.get(host, name, host);
  const environment = {};
  for (const name of [
    'document', 'window', 'location', 'history', 'AbortController', 'URL',
    'URLSearchParams', 'Date', 'Option', 'performance', 'CSS',
    'ResizeObserver', 'MutationObserver'
  ]) environment[name] = value(name);
  for (const name of [
    'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame'
  ]) {
    const method = value(name);
    environment[name] = typeof method === 'function' ? method.bind(host) : method;
  }
  environment.$ = id => environment.document.getElementById(id);
  environment.localStorage = {};
  for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
    environment.localStorage[name] = (...args) => {
      const storage = value('localStorage');
      return Reflect.apply(storage[name], storage, args);
    };
  }
  Object.defineProperty(environment.localStorage, 'length', {
    get() { return value('localStorage').length; }
  });
  return environment;
}
