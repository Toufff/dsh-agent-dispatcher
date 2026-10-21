import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/plugin.js'], outfile: 'dist/index.js', bundle: true, platform: 'node',
  format: 'esm', packages: 'external' });
await build({ entryPoints: ['src/adapters/worker.js'], outfile: 'dist/adapters/worker.js', bundle: true,
  platform: 'node', format: 'esm', packages: 'external' });
// Worker resolves its own source modules, preserving the same official CLI path in packed installs.
const result = await build({ entryPoints: ['src/ui/client.jsx'], bundle: true, platform: 'browser', format: 'cjs',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-typert-protocol'], write: false,
  loader: { '.css': 'text' } });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-agent-dispatcher",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});`);
