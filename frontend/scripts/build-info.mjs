import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(directory) {
  const results = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) results.push(...(await walk(path)));
    else results.push(path);
  }
  return results;
}
const inputs = [
  ...(await walk(join(root, 'src'))),
  ...(await walk(join(root, 'scripts'))),
  ...[
    'package.json',
    'package-lock.json',
    'index.html',
    'tsconfig.json',
    'vite.config.ts',
    '.node-version',
    '.npmrc',
  ].map((name) => join(root, name)),
].sort();
const files = {};
for (const path of inputs)
  files[relative(root, path).replaceAll('\\', '/')] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(
  join(root, '../web/assets/build-info.json'),
  JSON.stringify({ schema: 1, dependencies: pkg.dependencies, source_sha256: files }, null, 2) +
    '\n',
);

const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const notices = [
  '# Runtime third-party notices',
  '',
  'Bundled locally; end users do not connect to an external CDN.',
  '',
];
for (const [path, item] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || item.dev || !path.startsWith('node_modules/')) continue;
  const directory = join(root, path);
  try {
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    notices.push(
      `## ${metadata.name} ${metadata.version}`,
      '',
      `License: ${typeof metadata.license === 'string' ? metadata.license : 'See license below'}`,
      '',
    );
    // The npm package omits NOTICE; retain the notice from upstream v5.2.1.
    if (metadata.name === 'lightweight-charts')
      notices.push(
        'TradingView Lightweight Charts™',
        'Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/',
        '',
      );
    const names = (await readdir(directory)).filter((name) =>
      /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name),
    );
    for (const name of names) notices.push(await readFile(join(directory, name), 'utf8'), '');
    if (!names.length)
      notices.push(
        `Source and license: ${metadata.homepage || metadata.repository?.url || item.resolved || `https://www.npmjs.com/package/${metadata.name}`}`,
        '',
      );
  } catch (error) {
    throw new Error(`Unable to collect runtime license for ${path}`, { cause: error });
  }
}
const noticeText = notices
  .join('\n')
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .join('\n');
await writeFile(join(root, '../web/assets/third-party-notices.txt'), noticeText);
console.log(`Recorded ${inputs.length} frontend inputs and runtime third-party notices.`);
