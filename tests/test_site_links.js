const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const links = ["author_url", "author_url", "feedback_url"].map(key => ({dataset: {siteLink: key},
  removeAttribute(name) {delete this[name];}, setAttribute(name, value) {this[name] = value;}}));
const requests = [];
const context = vm.createContext({URL, state: {}, document: {querySelectorAll() {return links;}},
  request: () => new Promise((resolve, reject) => requests.push({resolve, reject}))});
vm.runInContext(source.slice(source.indexOf("function validSiteLink"), source.indexOf("async function openAnnouncement")), context);
(async () => {
  const initial = context.loadSiteLinks();
  requests[0].resolve({links: {author_url: "https://www.tgb.cn/blog/5894557", feedback_url: ""}});
  await initial;
  assert.equal(links[0].href, "https://www.tgb.cn/blog/5894557");
  assert.equal(links[1].href, links[0].href, "both author mentions share one configured URL");
  assert.equal(links[2].href, undefined);
  assert.equal(links[2]["aria-disabled"], "true", "an unset topic never jumps to a placeholder page");
  const configured = context.loadSiteLinks();
  requests[1].resolve({links: {author_url: "", feedback_url: "https://example.org/post#comments"}});
  await configured;
  assert.equal(links[0].href, undefined, "clearing a configured URL disables the former link");
  assert.equal(links[1].href, undefined);
  assert.equal(links[2].href, "https://example.org/post#comments");
  assert.equal(links[2]["aria-disabled"], undefined);
  for (const url of ["javascript:alert(1)", "//example.org", "https:example.org", "https://user@host.test", "https://@host.test",
    "https://host.test:bad/", "https://host.test/\ntext", "https://host.test\\path", "https://host.test/a b"]) {
    assert.equal(context.validSiteLink(url), "", url);
  }
  const failure = context.loadSiteLinks(); requests[2].reject(new Error("offline")); await failure;
  assert.equal(links[2].href, "https://example.org/post#comments", "temporary failures retain the last confirmed links");
  const old = context.loadSiteLinks(), latest = context.loadSiteLinks();
  requests[4].resolve({links: {author_url: "https://example.org/new", feedback_url: ""}}); await latest;
  requests[3].resolve({links: {author_url: "https://example.org/old", feedback_url: "https://example.org/old-post"}}); await old;
  assert.equal(links[0].href, "https://example.org/new");
  assert.equal(links[2].href, undefined, "stale requests cannot restore an obsolete topic link");
  console.log("Shared notice links, blank states, configured refresh, URL validation, errors and stale responses: passed.");
})().catch(error => {console.error(error); process.exitCode = 1;});
