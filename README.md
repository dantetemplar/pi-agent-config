# Pi Configuration

This repository stores my personal Pi configuration, synchronized with [Pi Sync](https://www.npmjs.com/package/@narumitw/pi-sync). Synced files live under [`files/` on the `pi-sync` branch](https://github.com/dantetemplar/pi-agent-config/tree/pi-sync/files) and include agent settings, extensions, prompts, skills, and themes. The default `main` branch contains this documentation; configure Pi Sync to use the `pi-sync` branch. I use [Pendant](https://pendant.sh/) as the VS Code interface to Pi.

## CLIProxyAPI

We use [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) through Pi's `router` provider, with [dillonzq/cpa-deepseek](https://github.com/dillonzq/cpa-deepseek) for DeepSeek support. Our Codex and Claude Code subscriptions are connected through the proxy. The [autodiscovery extension](https://github.com/dantetemplar/pi-agent-config/blob/pi-sync/files/extensions/router-autodiscovery.ts) loads available models and selects the appropriate API. Authenticate with `/login`, choose `router`, then select a model with `/model`.

[cliproxy-usage](https://github.com/Zigerry/cliproxy-usage) shows account quotas. Run `/cliproxy-usage setup` in a Pi terminal using the proxy's Management URL and management password—not the inference API key. Open `/cliproxy-usage` for details.

## Web Search and Web Fetch

- **Web search:** the [web search plugin](https://github.com/dantetemplar/pi-agent-config/tree/pi-sync/files/extensions/pi-web-search-local) provides `web_search` using provider-native Claude web search, Codex web search, or DeepSeek search.
- **Web fetch:** [@pi-lab/webfetch](https://www.npmjs.com/package/@pi-lab/webfetch) provides `webfetch` to read URLs as clean Markdown, with pagination and inline-script inspection.

## Working from Russia Without a VPN

This stack runs from Russia without a VPN because CLIProxyAPI runs on an intermediate server. This machine only talks to the proxy, and the proxy makes the upstream requests. Pendant (a local VS Code extension), Pi, and its extensions all run locally.

- **Models:** everything comes from Pi's `router` provider pointed at the proxy — DeepSeek through `cpa-deepseek`, and the Claude Code and Codex subscriptions connected to the same proxy.
- **Web search:** provider-native search with the selected model ([web search plugin](https://github.com/dantetemplar/pi-agent-config/tree/pi-sync/files/extensions/pi-web-search-local)).
- **Web fetch:** [@pi-lab/webfetch](https://www.npmjs.com/package/@pi-lab/webfetch) downloads pages with ordinary HTTPS requests, so it depends only on the target site.

Proxy and provider availability can change over time and is not guaranteed; verify it on your own connection.

## Pendant Settings

These are the explicitly configured settings that differ from the defaults in Pendant **0.94.2**.

| Setting | My value | Default |
| --- | --- | --- |
| `pendant.subagents.delegation` | `"requested"` — delegate only when explicitly requested | `"disabled"` |
| `pendant.context.attachSelectionOnFocus` | `false` — do not automatically attach the selection on focus | `true` |
| `pendant.voice.model` | `"base.en-q5_1"` | `"base"` |
| `pendant.pinnedModels` | `[{"provider":"router","modelId":"gpt-6.1-sol"}]` | `[]` |
| `pendant.notifications.playSound` | `"whenSessionPing"` | `"whenUnfocused"` |
| `pendant.notifications.soundFile` | An absolute, machine-local path to `meow.mp3` | `""` |
| `pendant.markdownDiffViewMode` | `"diff"` — show raw Markdown diffs | `"preview"` |
| `pendant.sessionRailPosition` | `"right"` | `"left"` |
| `pendant.generationSpeedUpdateInterval` | `1000` ms | `150` ms |
| `pendant.restoreLastSessionOnStartup` | `true` | `false` |

Pendant has been moved to the **Secondary Side Bar** and hidden from the other UI locations, keeping a single place to open and use it. Pendant's **Add Selection to Chat** command is remapped to **Ctrl+L** in VS Code.
