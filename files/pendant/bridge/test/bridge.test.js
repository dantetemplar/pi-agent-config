'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parse } = require('jsonc-parser');
const { KEYS, serialize, parseDocument, merge, FileStore, reconcile } = require('../core');
const { editSettings, readEditor, EditorHost } = require('../editor');
const { options } = require('../cli');

const A = 'pendant.sessionRailPosition';
const B = 'pendant.notifications.playSound';
const C = 'pendant.showThinking';

async function fixture(t, local = { [A]: 'right' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pendant-bridge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent');
  const state = path.join(agent, 'pendant-local-state');
  const editor = path.join(root, 'editor', 'settings.json');
  await fs.mkdir(path.dirname(editor), { recursive: true });
  const original = `{
    // preserve unrelated preferences and machine-local values
    "editor.fontSize": 19,
    "pendant.voice.modelPath": "/local/model.bin",
    "pendant.voice.inputDevice": "microphone-A",
    "pendant.notifications.soundFile": "/local/sound.mp3",
    "pendant.piEnvironment": {"LOCAL_ONLY": "private-value"},
    ${Object.entries(local).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n    ')},
}\n`;
  await fs.writeFile(editor, original);
  const store = new FileStore(agent, state);
  const host = new EditorHost(editor, path.join(state, 'baseline.json'), path.join(state, 'backups'));
  return { root, agent, state, editor, original, store, host };
}

async function setRemote(store, settings) {
  await store.write(settings, await store.read());
}

async function setLocal(host, settings) {
  await fs.writeFile(host.file, editSettings(await fs.readFile(host.file, 'utf8'), settings));
}

test('allowlist excludes paths, environment, hooks, sandbox and executable resources', () => {
  for (const key of ['pendant.agentDir', 'pendant.piEnvironment', 'pendant.voice.modelPath', 'pendant.voice.inputDevice',
    'pendant.notifications.soundFile', 'pendant.notifications.customHook', 'pendant.sandbox.mode',
    'pendant.worktrees.setupCommands', 'pendant.extraExtensions', 'pendant.systemPrompt']) {
    assert(!KEYS.includes(key), key);
    assert.throws(() => parseDocument(JSON.stringify({ version: 1, settings: { [key]: 'not-allowed' } })));
  }
  assert(KEYS.includes('pendant.subagents.profiles'));
  assert(KEYS.includes('pendant.pinnedModels'));
});

test('document roundtrip preserves null, false, empty strings and explicit defaults', () => {
  const settings = { 'pendant.fontSize': null, [C]: false, 'pendant.thinkingLevel': '', [A]: 'left' };
  assert.deepEqual(parseDocument(serialize(settings)), settings);
  assert.equal(serialize(settings), serialize(Object.fromEntries(Object.entries(settings).reverse())));
});

test('invalid values, unsupported versions and oversized documents fail closed', () => {
  for (const raw of ['{', '[]', '{"version":2,"settings":{}}', '{"version":1,"settings":{},"other":true}',
    '{"version":1,"settings":{"pendant.sessionRailPosition":"elsewhere"}}',
    '{"version":1,"settings":{"pendant.showThinking":"false"}}',
    '{"version":1,"settings":{"pendant.subagents.maxConcurrent":99}}', ' '.repeat(300000)]) {
    assert.throws(() => parseDocument(raw));
  }
});

test('first sync combines independent overrides but stops on conflicting additions', () => {
  assert.deepEqual(merge(undefined, { [A]: 'right' }, { [B]: 'always' }), {
    settings: { [A]: 'right', [B]: 'always' }, conflicts: [],
  });
  assert.deepEqual(merge(undefined, { [A]: 'right' }, { [A]: 'left' }).conflicts, [A]);
});

test('three-way merge combines independent changes and propagates deletion', () => {
  const base = { [A]: 'left', [B]: 'always', [C]: true };
  const local = { [A]: 'right', [B]: 'always', [C]: true };
  const remote = { [A]: 'left', [B]: 'never' };
  assert.deepEqual(merge(base, local, remote), { settings: { [A]: 'right', [B]: 'never' }, conflicts: [] });
});

test('explicit preference resolves only conflicts, retaining independent changes', () => {
  const base = { [A]: 'left', [B]: 'always' };
  const local = { [A]: 'right', [B]: 'never' };
  const remote = { [A]: 'hidden', [B]: 'always', [C]: false };
  assert.deepEqual(merge(base, local, remote, 'remote'), {
    settings: { [A]: 'hidden', [B]: 'never', [C]: false }, conflicts: [A],
  });
  assert.deepEqual(merge({ [A]: 'left' }, {}, { [A]: 'right' }, 'local').settings, {});
});

test('JSONC editing preserves comments, trailing commas, unrelated keys and CRLF', () => {
  const raw = '{\r\n\t// comment\r\n\t"editor.fontSize": 19,\r\n\t"pendant.showThinking": true,\r\n}\r\n';
  const edited = editSettings(raw, { [A]: 'right' });
  assert(edited.includes('// comment\r\n'));
  assert(edited.includes('"editor.fontSize": 19'));
  assert(edited.includes('\r\n\t"pendant.sessionRailPosition"'));
  assert.deepEqual(parse(edited, [], { allowTrailingComma: true }), { 'editor.fontSize': 19, [A]: 'right' });
});

test('fresh machine imports portable settings without touching other editor preferences', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.editor, '{\n  // a different machine\n  "editor.fontSize": 23,\n  "pendant.voice.inputDevice": "another-microphone",\n}\n');
  await setRemote(f.store, { [A]: 'hidden', [C]: false });
  const result = await reconcile(f);
  assert.equal(result.applied, true);
  assert.deepEqual(f.host.read(), { [A]: 'hidden', [C]: false });
  const all = readEditor(f.editor).all;
  assert.equal(all['editor.fontSize'], 23);
  assert.equal(all['pendant.voice.inputDevice'], 'another-microphone');
  assert((await fs.readFile(f.editor, 'utf8')).includes('// a different machine'));
});

test('initial export never rewrites editor or exports local-only settings', async t => {
  const f = await fixture(t);
  const result = await reconcile(f);
  assert.equal(result.applied, true);
  assert.deepEqual((await f.store.read()).settings, { [A]: 'right' });
  assert.equal(await fs.readFile(f.editor, 'utf8'), f.original);
  assert.deepEqual(await f.host.baseline(), { [A]: 'right' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.store.file)).mode & 0o777, 0o600);
});

test('import and repeat sync preserve local-only values and do not churn files', async t => {
  const f = await fixture(t);
  await reconcile(f);
  await setRemote(f.store, { [A]: 'left', [B]: 'always' });
  await reconcile(f);
  const editor = await fs.readFile(f.editor, 'utf8');
  const all = parse(editor, [], { allowTrailingComma: true });
  assert.equal(all[A], 'left');
  assert.equal(all[B], 'always');
  assert.equal(all['pendant.voice.modelPath'], '/local/model.bin');
  assert.equal(all['pendant.notifications.soundFile'], '/local/sound.mp3');
  assert.deepEqual(all['pendant.piEnvironment'], { LOCAL_ONLY: 'private-value' });
  assert(editor.includes('// preserve unrelated'));
  const backups = await fs.readdir(f.host.backupDir);
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(f.host.backupDir, backups[0]), 'utf8'), f.original);
  const remote = (await f.store.read()).raw;
  await reconcile(f);
  assert.equal(await fs.readFile(f.editor, 'utf8'), editor);
  assert.equal((await f.store.read()).raw, remote);
  assert.equal((await fs.readdir(f.host.backupDir)).length, 1);
});

test('deleting a user override resets only the corresponding portable setting', async t => {
  const f = await fixture(t, { [A]: 'right', [C]: false });
  await reconcile(f);
  await setRemote(f.store, { [C]: false });
  await reconcile(f);
  assert.deepEqual(f.host.read(), { [C]: false });
  assert.equal(readEditor(f.editor).all['editor.fontSize'], 19);
});

test('conflicts change neither editor, portable file nor baseline', async t => {
  const f = await fixture(t);
  await reconcile(f);
  await setLocal(f.host, { [A]: 'left' });
  await setRemote(f.store, { [A]: 'hidden' });
  const editor = await fs.readFile(f.editor, 'utf8');
  const remote = (await f.store.read()).raw;
  const baseline = await f.host.baseline();
  const result = await reconcile(f);
  assert.equal(result.applied, false);
  assert.deepEqual(result.conflicts, [A]);
  assert.equal(await fs.readFile(f.editor, 'utf8'), editor);
  assert.equal((await f.store.read()).raw, remote);
  assert.deepEqual(await f.host.baseline(), baseline);
});

test('missing established portable file is not silently recreated', async t => {
  const f = await fixture(t);
  await reconcile(f);
  await fs.unlink(f.store.file);
  await assert.rejects(reconcile(f), /file was removed/);
  await assert.rejects(fs.stat(f.store.file), { code: 'ENOENT' });
});

test('malformed editor, duplicate keys and malformed remote are left unchanged', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.editor, '{ "pendant.showThinking": false, "pendant.showThinking": true }');
  assert.throws(() => f.host.read(), /Duplicate/);
  await fs.writeFile(f.editor, '{bad');
  await assert.rejects(reconcile(f), /Invalid VS Code/);
  assert.equal(await fs.readFile(f.editor, 'utf8'), '{bad');
  await fs.writeFile(f.editor, f.original);
  await f.store.prepare();
  await fs.writeFile(f.store.file, '{bad');
  await assert.rejects(reconcile(f));
  assert.equal(await fs.readFile(f.editor, 'utf8'), f.original);
  assert.equal(await fs.readFile(f.store.file, 'utf8'), '{bad');
});

test('symlinked settings and symlinked portable directory are refused', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other.json');
  await fs.writeFile(other, serialize({ [A]: 'left' }));
  await f.store.prepare();
  await fs.symlink(other, f.store.file);
  await assert.rejects(reconcile(f), /Unsafe portable/);
  await fs.unlink(f.store.file);
  await fs.rmdir(f.store.dir);
  await fs.symlink(path.dirname(other), f.store.dir);
  await assert.rejects(reconcile(f), /real directory/);
  await fs.unlink(f.store.dir);
  await fs.unlink(f.editor);
  await fs.symlink(other, f.editor);
  assert.throws(() => f.host.read(), /Unsafe VS Code/);
});

test('concurrent CLI runs do not remove another process lock', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.state, 'bridge.lock'), { recursive: true });
  await assert.rejects(reconcile(f), /Another bridge/);
  assert((await fs.stat(path.join(f.state, 'bridge.lock'))).isDirectory());
});

test('stale portable snapshot cannot overwrite a newer file', async t => {
  const f = await fixture(t);
  await reconcile(f);
  const stale = await f.store.read();
  await setRemote(f.store, { [A]: 'hidden' });
  await assert.rejects(f.store.write({ [A]: 'left' }, stale), /changed during sync/);
  assert.deepEqual((await f.store.read()).settings, { [A]: 'hidden' });
});

test('concurrent editor edit during backup is detected without replacement', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.apply({ [A]: 'left' }, f.host.read(), async () => {
    await fs.writeFile(f.editor, f.original.replace('19', '21'));
  }), /changed during sync/);
  assert.equal(readEditor(f.editor).all['editor.fontSize'], 21);
});

test('CLI status is read-only and normal sync works in a separate process', async t => {
  const f = await fixture(t);
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--agent-dir', f.agent, '--settings', f.editor], { encoding: 'utf8' });
  let result = run('status');
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(fs.stat(f.state), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.store.dir), { code: 'ENOENT' });
  result = run('sync');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await f.store.read()).settings, { [A]: 'right' });
  await setLocal(f.host, { [A]: 'left' });
  await setRemote(f.store, { [A]: 'hidden' });
  result = run('sync');
  assert.equal(result.status, 2);
  result = run('sync', '--prefer', 'synced');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.host.read(), { [A]: 'hidden' });
});

test('CLI rejects unknown, missing, repeated and unsafe preference options', () => {
  for (const args of [['--wat'], ['--settings'], ['pull'], ['sync', '--prefer', 'x'],
    ['status', '--prefer', 'local'], ['--settings', '/x', '--settings', '/y']]) {
    assert.throws(() => options([...args]));
  }
});
