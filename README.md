# Pi Configuration

This repository stores my personal Pi configuration, synchronized with [Pi Sync](https://www.npmjs.com/package/@narumitw/pi-sync). Synced files live under [`files/` on the `pi-sync` branch](https://github.com/dantetemplar/pi-agent-config/tree/pi-sync/files) and include agent settings, extensions, prompts, skills, and themes. The default `main` branch contains this documentation; configure Pi Sync to use the `pi-sync` branch. I use [Pendant](https://pendant.sh/) as the VS Code interface to Pi.

## CLIProxyAPI

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) is our model gateway. This setup connects Pi and Pendant to the remote instance at `https://cpa.belkov.su`; running a local proxy is not required. Upstream accounts are configured on the proxy itself.

### Provider and Model Discovery

The provider configuration in [`models.json`](https://github.com/dantetemplar/pi-agent-config/blob/pi-sync/files/models.json) is intentionally small:

```json
{
  "providers": {
    "router": {
      "name": "CLIProxyAPI (cpa.belkov.su)",
      "baseUrl": "https://cpa.belkov.su/v1",
      "api": "openai-completions"
    }
  }
}
```

Run `/login` in Pi and select `router` to save the proxy's inference API key locally in `auth.json`, then run `/reload`. The key is not stored in `models.json`. Use `/model` to select a model from the `router` provider; Pendant uses the same provider and model catalog.

Our [`router-autodiscovery.ts`](https://github.com/dantetemplar/pi-agent-config/blob/pi-sync/files/extensions/router-autodiscovery.ts) extension discovers models instead of maintaining a hardcoded model list. It reads `/v1/models`, enriches the catalog with `/v1/models?client_version=0.163.0`, and maps model limits, image-input support, and reasoning levels into Pi. Missing metadata uses fallback values. The extension chooses the wire protocol per model, overriding the provider's default:

| Model family | Pi API | Proxy endpoint |
| --- | --- | --- |
| Claude | `anthropic-messages` | `/v1/messages` |
| GPT / Codex | `openai-responses` | `/v1/responses` |
| Other chat models and `*-chat-thinking` variants | `openai-completions` | `/v1/chat/completions` |

DeepSeek models are excluded from this router catalog and use Pi's built-in `deepseek` provider directly. Image-generation models are also excluded from the chat picker. The discovered catalog is cached locally in `router-models-cache.json` so an unavailable proxy does not discard an existing model list. Discovery runs on startup/reload and through Pi's model-refresh hook.

### Quotas and Daily Use

We use [`cliproxy-usage`](https://github.com/Zigerry/cliproxy-usage), installed as `npm:cliproxy-usage` in Pi's package settings, to monitor the active model's provider quota. Model selection and inference use the `router` API key; quota checks use separate CLIProxyAPI Management API access.

On a new machine, run setup in an interactive Pi terminal session:

```text
/cliproxy-usage setup
/cliproxy-usage status
/cliproxy-usage
```

Use `https://cpa.belkov.su` as the Management URL and the password accepted by `management.html`, **not** the inference API key. The extension stores this configuration locally in `pi-cliproxy-usage.json`; it is not part of the synced files. Our settings enable the quota widget, use a **5-minute** refresh interval, and show up to **4 accounts**. `/cliproxy-usage` opens details for the current provider; in Pendant's default dialog mode it falls back to a text notification. The terminal details view supports `r` to refresh.

The router extension currently assigns zero cost metadata to discovered models; this is a display placeholder, not a claim that requests are free. Use the quota view and the upstream account's billing information rather than Pi's displayed cost to track actual limits and spending.

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
