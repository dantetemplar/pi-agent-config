# Sync Pendant Settings with Pi Sync

A standalone CLI bridge: no additional VS Code extension, daemon, or separate cloud storage.

- `settings.json` contains portable, **explicitly configured user-level** Pendant settings.
- `bridge/` contains the `pendant-settings` CLI source, tests, and pinned dependencies.
- Pi Sync transfers the entire `pendant` directory through your existing storage setup. Pi Sync excludes `node_modules` automatically.
- The CLI makes no network requests: it reconciles VS Code user settings with `settings.json`. Uploads and downloads happen separately through `/sync`.

## Usage

```bash
# Before publishing configuration from this computer:
pendant-settings sync
# Then, in Pi/Pendant: /sync diff, review the changes, and /sync push

# After downloading configuration on another computer:
# In Pi/Pendant: /sync pull
pendant-settings sync

# Inspect differences without writing files or printing setting values:
pendant-settings status
```

The portable file is `~/.pi/agent/pendant/settings.json`. It is **not** a VS Code settings file: do not copy it over `User/settings.json`.

The first sync combines independent overrides. Subsequent syncs use a machine-local baseline from the last successful sync: independent changes on either side are merged, and deleting an individual key resets only that user-level override.

If the same key changes differently on both sides, the command exits with code **2** without changing the settings. After reviewing both versions, resolve conflicting keys explicitly:

```bash
pendant-settings sync --prefer local   # Prefer VS Code values for conflicting keys
pendant-settings sync --prefer synced  # Prefer portable-file values for conflicting keys
```

These options resolve conflicts only; independent changes are still merged. Other errors return **1**, and success returns **0**. Removing the entire portable file after establishing a baseline is treated as an error, not a settings reset.

## What Is Portable

The allowlist in `bridge/policy.json` is based on the Pendant **0.94.2** configuration schema. It covers pinned models, thinking preferences, interface options, notifications, dictation language/model selection, and subagent preferences. Defaults are not exported unless explicitly configured. Newly introduced, unknown settings are not included automatically.

**The following remain local:**

- `pendant.agentDir` and `pendant.piEnvironment`;
- voice model paths, microphone selection, and notification sound file paths;
- shell hooks and worktree setup commands;
- sandbox policy and allowed/denied paths;
- paths to additional extensions, skills, and prompt templates;
- `pendant.systemPrompt` and `pendant.appendSystemPrompts`;
- unrelated VS Code settings, workspace settings, and other profile/language overrides;
- authentication files, history, sessions, caches, and temporary state.

Subagent profiles can contain user-written text: do not put secrets in them. An allowlist is not a general-purpose secret detector; keep Pi Sync secret scanning enabled.

The JSONC editor preserves unrelated keys, comments, and formatting as far as a targeted property edit allows. Malformed JSONC, duplicate keys, unsupported portable-document versions, and symlinked target files are rejected without replacing the settings.

## Install on Another Computer

After receiving the directory through Pi Sync, install its dependencies with Node.js **22+** and npm:

```bash
AGENT="$HOME/.pi/agent" # Adjust this if you use a different agent directory
npm ci --ignore-scripts --no-audit --no-fund --prefix "$AGENT/pendant/bridge"
node "$AGENT/pendant/bridge/cli.js" status
node "$AGENT/pendant/bridge/cli.js" sync

# Optional short command on Linux/macOS:
mkdir -p "$HOME/.local/bin"
chmod +x "$AGENT/pendant/bridge/cli.js"
ln -s "$AGENT/pendant/bridge/cli.js" "$HOME/.local/bin/pendant-settings"
```

By default, the CLI uses the standard VS Code user settings file: `$XDG_CONFIG_HOME/Code/User/settings.json` on Linux, falling back to `~/.config/Code/User/settings.json`; `~/Library/Application Support/Code/User/settings.json` on macOS; and `%APPDATA%/Code/User/settings.json` on Windows.

For Cursor, VSCodium, VS Code Insiders, a custom user-data directory, or a specific profile, select the settings file explicitly:

```bash
pendant-settings sync --settings /absolute/path/to/User/settings.json
```

The agent directory is selected in this order: `--agent-dir`, the user-level `pendant.agentDir` in the selected settings file, `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. Paths must be absolute or start with `~/`. Each editor settings file has its own local baseline. **Do not include `pendant-local-state` in Pi Sync.**

## Safety and Recovery

Before changing the VS Code settings file, the CLI creates a private backup of the entire file. Backups and baselines live under `<agent-dir>/pendant-local-state/`, outside the synchronized `pendant/` directory; files are created with `0600` permissions. Backups may contain secrets from unrelated VS Code settings: do not publish them. They are not removed automatically.

Writes use temporary files and atomic replacement, with an additional check of the original contents. Concurrent CLI runs share the `<agent-dir>/pendant-local-state/bridge.lock` directory. A crash can leave this lock behind: first verify that no `pendant-settings` command is running, then remove the empty lock directory with `rmdir`. Do not delete baselines or backups to recover a stale lock.

The lock does not block VS Code or Pi Sync. Avoid editing settings or running `/sync pull` while the CLI is running: a short external-write race remains between the final check and replacement. If a change is detected, the command stops; retry after restoring a consistent state. The portable file is ordinary custom content for Pi Sync, so cross-machine conflicts in that file are handled by Pi Sync separately from the CLI's local three-way merge.

Synchronization runs **on demand**, not continuously. The CLI does not change Pi Sync automatic-transfer preferences or restart Pendant/VS Code. Most editor preferences apply automatically; Pi startup options may require a session restart.

## Tests

```bash
cd ~/.pi/agent/pendant/bridge
npm test
```
