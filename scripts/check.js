import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
for (const file of [...await files('src'), ...await files('scripts'), ...await files('test')]) {
  if (!/\.(m?js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr}`);
}
const { domainSpec } = await import('../src/plugin.js');
domainSpec.global.schema.parse(domainSpec.global.initial);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (!pkg.dsh?.bundle?.patch?.includes('./cordis.patch.yml')) throw new Error('Plugin bundle manifest missing');
console.log('Source syntax, persistence schema and plugin manifest passed.');
