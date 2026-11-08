# Pi Configuration

This repository stores my personal Pi configuration, synchronized with [Pi Sync](https://www.npmjs.com/package/@narumitw/pi-sync). Synced files live under `files/` and include agent settings, extensions, prompts, skills, and themes; credentials, sessions, caches, and local recovery state are excluded from this setup. I use [Pendant](https://pendant.sh/) as the VS Code interface to Pi. Pendant preferences are configred manually and documented below, not synchronized; no additional settings bridge, CLI, or background service is required.

## Pendant Settings

These are the explicitly configured settings that differ from the defaults in Pendant **0.94.2**. Settings not listed here keep their defaults.

| Setting | My value | Default |
| --- | --- | --- |
| `pendant.subagents.delegation` | `"requested"` — delegate only when explicitly requested | `"disabled"` |
| `pendant.voice.model` | `"base.en-q5_1"` | `"base"` |
| `pendant.pinnedModels` | `[{"provider":"router","modelId":"gpt-6.1-sol"}]` | `[]` |
| `pendant.notifications.playSound` | `"whenSessionPing"` | `"whenUnfocused"` |
| `pendant.notifications.soundFile` | An absolute, machine-local path to `meow.mp3` | `""` |
| `pendant.markdownDiffViewMode` | `"diff"` — show raw Markdown diffs | `"preview"` |
| `pendant.sessionRailPosition` | `"right"` | `"left"` |
| `pendant.generationSpeedUpdateInterval` | `1000` ms | `150` ms |
| `pendant.restoreLastSessionOnStartup` | `true` | `false` |

The pinned model requires the corresponding `router` provider and model to be available. Choose the notification sound file separately on each machine; the audio file and its local path are not synchronized.

Pendant has been moved to the **Secondary Side Bar** and hidden from the other UI locations, keeping a single place to open and use it. This is an editor layout preference, separate from Pendant's session rail position, and is configured manually rather than synchronized by Pi Sync.

Pendant's **Add Selection to Chat** command is remapped to **Ctrl+L** in VS Code.
