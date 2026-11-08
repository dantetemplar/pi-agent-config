'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const { properties: policy } = require('./policy.json');
const KEYS = Object.freeze(Object.keys(policy).sort());
const MAX_BYTES = 256 * 1024;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateValue(value, schema, label) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![].concat(schema.type).includes(type)) throw new Error(`Invalid type: ${label}`);
  if (schema.enum && !schema.enum.some(item => equal(item, value))) throw new Error(`Invalid choice: ${label}`);
  if (type === 'number' && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`Invalid number: ${label}`);
  if (type === 'array' && schema.items) value.forEach(item => validateValue(item, schema.items, label));
  if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Unsafe member: ${label}`);
      if (schema.properties?.[key]) validateValue(item, schema.properties[key], label);
      else if (schema.additionalProperties === false) throw new Error(`Unknown member: ${label}`);
      else validateValue(item, {}, label);
    }
  }
}

function validateSettings(settings) {
  if (!object(settings)) throw new Error('Portable settings must be an object.');
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(policy, key)) throw new Error(`Nonportable or unsupported setting: ${key}`);
    validateValue(value, policy[key], key);
  }
  if (Buffer.byteLength(JSON.stringify(settings)) > MAX_BYTES) throw new Error('Portable settings exceed size limit.');
  return settings;
}

function parseDocument(raw) {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Portable settings exceed size limit.');
  const document = JSON.parse(raw);
  if (!object(document) || document.version !== 1 || Object.keys(document).some(k => !['version', 'settings'].includes(k))) {
    throw new Error('Unsupported portable settings document. Expected version 1.');
  }
  return validateSettings(document.settings);
}

function serialize(settings) {
  validateSettings(settings);
  const ordered = Object.fromEntries(KEYS.filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
  return `${JSON.stringify({ version: 1, settings: ordered }, null, 2)}\n`;
}

// Missing is distinct from null, false, the empty string, and an explicit default.
function sameEntry(a, b, key) {
  return Object.hasOwn(a, key) === Object.hasOwn(b, key) && equal(a[key], b[key]);
}

function merge(base, local, remote, prefer) {
  [local, remote].forEach(validateSettings);
  if (base !== undefined) validateSettings(base);
  const settings = {};
  const conflicts = [];
  for (const key of KEYS) {
    let source;
    if (sameEntry(local, remote, key)) source = local;
    else if (base === undefined) {
      if (!Object.hasOwn(local, key)) source = remote;
      else if (!Object.hasOwn(remote, key)) source = local;
    } else if (sameEntry(local, base, key)) source = remote;
    else if (sameEntry(remote, base, key)) source = local;
    if (!source) {
      conflicts.push(key);
      source = prefer === 'local' ? local : prefer === 'remote' ? remote : undefined;
    }
    if (source && Object.hasOwn(source, key)) settings[key] = source[key];
  }
  return { settings, conflicts };
}

async function assertDirectory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Settings directory must be a real directory.');
}

class FileStore {
  constructor(agentDir, stateDir) {
    this.agentDir = agentDir;
    this.dir = path.join(agentDir, 'pendant');
    this.file = path.join(this.dir, 'settings.json');
    this.stateDir = stateDir;
  }

  async prepare() {
    await fs.mkdir(this.agentDir, { recursive: true });
    await assertDirectory(this.agentDir);
    await fs.mkdir(this.dir, { recursive: true });
    await assertDirectory(this.dir);
  }

  async read() {
    try {
      await assertDirectory(this.agentDir);
      await assertDirectory(this.dir);
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Unsafe portable settings file.');
      const raw = await fs.readFile(this.file, 'utf8');
      return { raw, settings: parseDocument(raw) };
    } catch (error) {
      if (error.code === 'ENOENT') return { raw: null, settings: undefined };
      throw error;
    }
  }

  async assertUnchanged(expected) {
    const current = await this.read();
    if (current.raw !== expected.raw) throw new Error('Portable settings changed during sync; retry.');
  }

  async write(settings, expected) {
    await this.prepare();
    const raw = serialize(settings);
    if (expected.raw !== null && equal(expected.settings, settings)) {
      await this.assertUnchanged(expected);
      return;
    }
    const temporary = path.join(this.dir, `.bridge-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
      await this.assertUnchanged(expected);
      if (expected.raw === null) {
        // Exclusive first publication: never replace a concurrently pulled file.
        await fs.link(temporary, this.file);
      } else {
        await fs.rename(temporary, this.file);
      }
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async withLock(run) {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await assertDirectory(this.stateDir);
    const lock = path.join(this.stateDir, 'bridge.lock');
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another bridge is syncing (or left a lock). Retry; see the bridge README for recovery.');
      throw error;
    }
    try {
      return await run();
    } finally {
      await fs.rmdir(lock);
    }
  }
}

// Host applies only user-level allowed keys. Conflicts stop the whole operation.
async function reconcile({ host, store, base, prefer }) {
  return store.withLock(async () => {
    const baseline = host.baseline ? await host.baseline() : base;
    const local = validateSettings(host.read());
    const snapshot = await store.read();
    if (snapshot.raw === null && baseline !== undefined) {
      throw new Error('Portable settings file was removed. Restore it from Pi Sync; deletion is not a reset command.');
    }
    const remote = snapshot.settings || {};
    const plan = merge(baseline, local, remote, prefer);
    if (plan.conflicts.length && !prefer) return { ...plan, applied: false };
    await store.assertUnchanged(snapshot);
    await host.apply(plan.settings, local, () => store.assertUnchanged(snapshot));
    if (!equal(host.read(), plan.settings)) throw new Error('User settings changed during sync; retry.');
    await store.write(plan.settings, snapshot);
    if (!equal((await store.read()).settings, plan.settings) || !equal(host.read(), plan.settings)) {
      throw new Error('Settings changed before baseline publication; retry.');
    }
    await host.saveBaseline(plan.settings);
    return { ...plan, applied: true };
  });
}

module.exports = { KEYS, equal, validateSettings, parseDocument, serialize, merge, FileStore, reconcile };
