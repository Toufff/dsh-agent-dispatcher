import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/dispatcher.js';
import { initialState, parseSettings, unknownSettingKeys } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { FileStore } from '../src/store.js';

const base = () => { const s = initialState().settings;
  s.projects = [{ id: 'p', label: 'Example', cwd: process.cwd(), followup: { enabled: true, commentAuthorIds: ['me'], maxWakeups: 8 } }];
  return s; };

test('unknown top-level and nested settings keys are kept verbatim and listed', () => {
  const raw = base();
  raw.futureFlag = { mode: 'x' };
  raw.projects[0].followup.futureRounds = 3;
  raw.projects[0].linearLabel = 'later';
  raw.executors[0].futureOption = true;
  const parsed = parseSettings(raw);
  assert.deepEqual(parsed.futureFlag, { mode: 'x' });
  assert.equal(parsed.projects[0].followup.futureRounds, 3);
  assert.equal(parsed.projects[0].linearLabel, 'later');
  assert.equal(parsed.executors[0].futureOption, true);
  assert.deepEqual(unknownSettingKeys(parsed).sort(),
    ['executors[codex].futureOption', 'futureFlag', 'projects[p].followup.futureRounds', 'projects[p].linearLabel']);
  assert.deepEqual(unknownSettingKeys(parseSettings(base())), []);
});
test('known keys keep strict validation even next to unknown ones', () => {
  const raw = base(); raw.futureFlag = 1;
  raw.projects[0].followup.maxWakeups = 'eight';
  assert.throws(() => parseSettings(raw), /maxWakeups|expected number/i);
  const wrongType = base(); wrongType.concurrency = 0;
  assert.throws(() => parseSettings(wrongType));
  const notObject = base(); notObject.projects[0].followup = 'on';
  assert.throws(() => parseSettings(notObject));
});
test('configure accepts unknown keys, reports them, and they survive a reload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dispatcher-unknown-'));
  try {
    const store = await new FileStore(directory).open();
    const state = initialState(); state.settings = base(); await store.save(state);
    const runtime = await new Runtime({ store, directory: os.tmpdir() }).init();
    let snapshot = await runtime.snapshot();
    assert.deepEqual(snapshot.settingsUnknownKeys, []);
    const settings = structuredClone(snapshot.settings);
    settings.futureFlag = true; settings.projects[0].followup.futureRounds = 3;
    snapshot = await runtime.command({ action: 'configure', settings, revision: snapshot.revision });
    assert.deepEqual(snapshot.settingsUnknownKeys.sort(), ['futureFlag', 'projects[p].followup.futureRounds']);
    await store.close();
    const reopened = await new FileStore(directory).open();
    try {
      const again = await (await new Runtime({ store: reopened, directory: os.tmpdir() }).init()).snapshot();
      assert.equal(again.settings.futureFlag, true);
      assert.equal(again.settings.projects[0].followup.futureRounds, 3);
      assert.deepEqual(again.settingsUnknownKeys.sort(), ['futureFlag', 'projects[p].followup.futureRounds']);
    } finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('configure still rejects a known key with the wrong type', async () => {
  const store = new MemoryStore(), state = initialState(); state.settings = base(); await store.save(state);
  const runtime = await new Runtime({ store, directory: os.tmpdir() }).init();
  const snapshot = await runtime.snapshot();
  const settings = structuredClone(snapshot.settings); settings.futureFlag = 1; settings.concurrency = 'many';
  await assert.rejects(runtime.configure(settings, snapshot.revision));
  assert.equal((await runtime.snapshot()).settings.futureFlag, undefined);
});

test('reserved keys (__proto__, constructor, prototype) are rejected instead of rewriting the prototype', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = JSON.parse(JSON.stringify(base()));
    const withKey = JSON.parse(JSON.stringify(raw).replace(/^\{/, `{"${key}":{"focus":{"judge":{"command":123,"timeoutMs":-5}}},`));
    assert.ok(Object.hasOwn(withKey, key), key);
    assert.throws(() => parseSettings(withKey), /not allowed/, key);
  }
  const nested = JSON.parse(JSON.stringify(base()));
  nested.projects[0] = JSON.parse(JSON.stringify(nested.projects[0]).replace(/^\{/, '{"__proto__":{"x":1},'));
  assert.throws(() => parseSettings(nested), /projects\[p\]\.__proto__/);
  const ok = parseSettings(base());
  assert.equal(Object.getPrototypeOf(ok), Object.prototype);
});
