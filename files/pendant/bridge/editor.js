'use strict';

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parse, parseTree, modify, applyEdits } = require('jsonc-parser');
const { KEYS, equal, validateSettings, parseDocument, serialize } = require('./core');

function readEditor(file) {
  let raw = null;
  try {
    const stat = fsSync.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Unsafe VS Code settings file.');
    raw = fsSync.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const errors = [];
  const all = raw === null ? {} : parse(raw, errors, { allowTrailingComma: true });
  if (errors.length || !all || typeof all !== 'object' || Array.isArray(all)) throw new Error('Invalid VS Code settings JSONC; no files changed.');
  if (raw !== null) assertNoDuplicates(parseTree(raw, [], { allowTrailingComma: true }));
  const settings = Object.fromEntries(KEYS.filter(key => Object.hasOwn(all, key)).map(key => [key, all[key]]));
  validateSettings(settings);
  return { raw, all, settings };
}

function assertNoDuplicates(node) {
  if (node?.type === 'object') {
    const keys = new Set();
    for (const property of node.children || []) {
      const key = property.children[0].value;
      if (keys.has(key)) throw new Error('Duplicate JSONC keys; resolve them before syncing.');
      keys.add(key);
    }
  }
  for (const child of node?.children || []) assertNoDuplicates(child);
}

function editSettings(raw, settings) {
  validateSettings(settings);
  let text = raw === null ? '{}\n' : raw;
  const current = parse(text, [], { allowTrailingComma: true });
  const firstIndent = text.match(/\n([\t ]+)"/);
  const formattingOptions = {
    insertSpaces: !firstIndent?.[1].includes('\t'),
    tabSize: firstIndent && !firstIndent[1].includes('\t') ? firstIndent[1].length : 4,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
  for (const key of KEYS) {
    if (Object.hasOwn(current, key) === Object.hasOwn(settings, key) && equal(current[key], settings[key])) continue;
    text = applyEdits(text, modify(text, [key], settings[key], { formattingOptions }));
  }
  return text;
}

async function atomicPrivateWrite(file, raw, expected) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.bridge-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
    if (expected !== undefined) {
      let current = null;
      try { current = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== expected) throw new Error('File changed during sync; retry.');
    }
    if (expected === null) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

class EditorHost {
  constructor(file, baselineFile, backupDir) {
    this.file = file;
    this.baselineFile = baselineFile;
    this.backupDir = backupDir;
  }

  read() { return readEditor(this.file).settings; }

  async baseline() {
    try {
      const stat = await fs.lstat(this.baselineFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Unsafe local baseline.');
      return parseDocument(await fs.readFile(this.baselineFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async apply(settings, original, guard) {
    const snapshot = readEditor(this.file);
    if (!equal(snapshot.settings, original)) throw new Error('VS Code settings changed during sync; retry.');
    const edited = editSettings(snapshot.raw, settings);
    if (edited === snapshot.raw || (snapshot.raw === null && equal(settings, {}))) return;
    if (snapshot.raw !== null) {
      await fs.mkdir(this.backupDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(this.backupDir, `${Date.now()}-${randomUUID()}.jsonc`), snapshot.raw, { flag: 'wx', mode: 0o600 });
    }
    await guard();
    if (readEditor(this.file).raw !== snapshot.raw) throw new Error('VS Code settings changed during sync; retry.');
    await atomicPrivateWrite(this.file, edited, snapshot.raw);
  }

  async saveBaseline(settings) {
    await atomicPrivateWrite(this.baselineFile, serialize(settings));
  }
}

module.exports = { readEditor, editSettings, atomicPrivateWrite, EditorHost };
