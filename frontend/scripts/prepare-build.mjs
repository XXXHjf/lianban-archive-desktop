import { readdir, mkdir, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = resolve(root, 'web/assets');
const backup = resolve(root, '.build/frontend-assets', randomUUID());
if (
  !assets.startsWith(resolve(root, 'web') + sep) ||
  !backup.startsWith(resolve(root, '.build') + sep)
)
  throw new Error('Build paths leave the workspace');
await mkdir(assets, { recursive: true });
const files = await readdir(assets, { withFileTypes: true });
if (files.some((file) => !file.isFile()))
  throw new Error('Unexpected directory in generated assets; inspect it before building');
if (files.length) await mkdir(backup, { recursive: true });
// Only individual generated files are moved. No recursive removal or overwrite.
for (const file of files) await rename(join(assets, file.name), join(backup, file.name));
