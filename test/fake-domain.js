import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal stand-in for an open DSH storage domain (table/global API). With `directory` it also mirrors the
 * json backend's per-record files (`<table>/<key>.json`, `global.json`, each `{ version, record }`).
 */
export class FakeDomain {
  constructor({ directory, initial = {}, version = 1, tables = ['tasks', 'outbox'] } = {}) {
    this.directory = directory; this.version = version; this.value = initial; this.stored = false;
    this.tables = new Map(tables.map(t => [t, new Map()])); this.puts = 0; this.closed = false;
    if (directory && existsSync(path.join(directory, 'global.json'))) {
      this.value = JSON.parse(readFileSync(path.join(directory, 'global.json'), 'utf8')).record; this.stored = true;
      for (const t of tables) for (const f of existsSync(path.join(directory, t)) ? readdirSync(path.join(directory, t)) : [])
        this.tables.get(t).set(f.slice(0, -5), JSON.parse(readFileSync(path.join(directory, t, f), 'utf8')).record);
    }
    const self = this;
    this.global = { get: () => self.value, set: async value => { self.check('global'); self.file('global.json', value); self.value = value; self.stored = true; } };
  }
  check(what) { if (this.failOn?.(what)) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' }); }
  file(name, value) {
    if (!this.directory) return;
    mkdirSync(path.dirname(path.join(this.directory, name)), { recursive: true });
    writeFileSync(path.join(this.directory, name), `${JSON.stringify({ version: this.version, record: value }, null, 2)}\n`);
  }
  table(name) {
    const records = this.tables.get(name), self = this;
    return {
      get: key => records.get(key), entries: () => [...records.entries()][Symbol.iterator](), keys: () => [...records.keys()][Symbol.iterator](),
      get size() { return records.size; },
      put: async (key, value) => { self.check(`put:${name}:${key}`); self.puts++; self.file(`${name}/${key}.json`, value); records.set(key, value); },
      delete: async key => { self.check(`delete:${name}:${key}`); if (self.directory) rmSync(path.join(self.directory, name, `${key}.json`), { force: true }); return records.delete(key); },
      deleteMany: async keys => { let n = 0; for (const key of keys) if (await this.table(name).delete(key)) n++; return n; }
    };
  }
  async close() { this.closed = true; }
}
