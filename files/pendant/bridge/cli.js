#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { KEYS, equal, merge, FileStore, reconcile } = require('./core');
const { readEditor, EditorHost } = require('./editor');

function absolute(value) {
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error('Configuration paths must be absolute (or start with ~/).');
  return path.normalize(expanded);
}

function defaultSettings() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('APPDATA is unset; specify --settings.');
    return path.join(process.env.APPDATA, 'Code', 'User', 'settings.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Code', 'User', 'settings.json');
}

function options(args) {
  const result = { command: 'sync' };
  if (args[0] && !args[0].startsWith('--')) result.command = args.shift();
  while (args.length) {
    const flag = args.shift();
    if (flag === '--help' || flag === '-h') { result.command = 'help'; continue; }
    if (!['--agent-dir', '--settings', '--prefer'].includes(flag) || !args[0] || args[0].startsWith('--')) {
      throw new Error(`Unknown option or missing value: ${flag}`);
    }
    if (result[flag] !== undefined) throw new Error(`Repeated option: ${flag}`);
    result[flag] = args.shift();
  }
  if (!['sync', 'status', 'help'].includes(result.command)) throw new Error('Expected sync or status.');
  if (result['--prefer'] && !['local', 'synced'].includes(result['--prefer'])) throw new Error('--prefer must be local or synced.');
  if (result.command !== 'sync' && result['--prefer']) throw new Error('--prefer is only valid for sync.');
  return result;
}

async function main(args = process.argv.slice(2)) {
  const opts = options(args);
  if (opts.command === 'help') {
    console.log(`Pendant settings bridge (no VS Code extension, daemon, or network requests)

  pendant-settings status
  pendant-settings sync
  pendant-settings sync --prefer local|synced

Optional: --agent-dir /absolute/pi/agent --settings /absolute/editor/settings.json

Sync merges user-level portable preferences in both directions. Conflicts stop
without writes; --prefer resolves conflicting keys only, not the entire file.
Run sync before pushing with Pi Sync and again after pulling. See README.md.
Local paths, devices, sandbox policy, credentials, workspaces and profiles are
never copied to other settings files. Select a VS Code profile explicitly using
--settings when needed. The default is VS Code's standard User/settings.json.`);
    return;
  }
  const settingsFile = absolute(opts['--settings'] || defaultSettings());
  const editor = readEditor(settingsFile);
  const configuredDir = editor.all['pendant.agentDir'];
  if (configuredDir !== undefined && typeof configuredDir !== 'string') throw new Error('pendant.agentDir must be a string.');
  const agentDir = absolute(opts['--agent-dir'] || configuredDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'));
  const stateDir = path.join(agentDir, 'pendant-local-state');
  const identity = createHash('sha256').update(settingsFile).digest('hex').slice(0, 24);
  const host = new EditorHost(settingsFile, path.join(stateDir, `${identity}.json`), path.join(stateDir, 'backups', identity));
  const store = new FileStore(agentDir, stateDir);
  const base = await host.baseline();
  const snapshot = await store.read();
  const plan = merge(base, editor.settings, snapshot.settings || {});
  if (opts.command === 'status') {
    console.log(`VS Code: ${settingsFile}\nPortable: ${store.file}`);
    console.log(`Local: ${Object.keys(editor.settings).length} portable overrides; synced: ${Object.keys(snapshot.settings || {}).length}.`);
    if (snapshot.raw === null) console.log(base === undefined ? 'Portable file has not been created yet.' : 'Portable file is missing: restore it before syncing.');
    const differences = KEYS.filter(key => Object.hasOwn(editor.settings, key) !== Object.hasOwn(snapshot.settings || {}, key)
      || !equal(editor.settings[key], snapshot.settings?.[key]));
    if (differences.length) console.log(`Differences (values hidden):\n${differences.map(key => `  ${key}`).join('\n')}`);
    else console.log('No portable setting differences.');
    if (plan.conflicts.length) { console.log(`Conflicts: ${plan.conflicts.join(', ')}`); process.exitCode = 2; }
    return;
  }
  const result = await reconcile({ host, store, base, prefer: opts['--prefer'] === 'synced' ? 'remote' : opts['--prefer'] });
  if (!result.applied) {
    console.error(`Conflicting settings (no files changed):\n${result.conflicts.map(key => `  ${key}`).join('\n')}`);
    console.error('Review both versions, then run sync --prefer local or sync --prefer synced.');
    process.exitCode = 2;
    return;
  }
  console.log(`Synced ${Object.keys(result.settings).length} portable Pendant overrides.\n${store.file}`);
  console.log('Pi Sync uploads/downloads this file separately; this command makes no network requests.');
}

if (require.main === module) main().catch(error => { console.error(`pendant-settings: ${error.message}`); process.exitCode = 1; });
module.exports = { main, options, absolute, defaultSettings };
