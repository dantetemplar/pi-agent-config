/**
 * Auto-discovery for the `router` provider (CLIProxyAPI, OpenAI-compatible).
 *
 * models.json keeps only provider settings (baseUrl, apiKey, api); the model
 * list and its metadata come from the proxy:
 *
 *   GET <base>/models                     -> { data: [{ id, owned_by }] }      full catalog
 *   GET <base>/models?client_version=...  -> { models: [{ slug, display_name,
 *        context_window, max_tokens, input_modalities,
 *        supported_reasoning_levels, ... }] }                                 rich metadata
 *
 * The rich payload is a Codex-client catalog: it uses `slug` and namespaced
 * aliases ("oze/gpt-6.1-sol"), so entries are matched against the plain catalog
 * by a normalized key. Fields the metadata omits fall back to family defaults.
 *
 * Discovery is cached in <agent-dir>/router-models-cache.json so startup
 * without network still has a usable model list instead of an empty one.
 */
import { execSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "router";
const API = "openai-completions";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const MODELS_FILE = join(AGENT_DIR, "models.json");
const AUTH_FILE = join(AGENT_DIR, "auth.json");
const CACHE_FILE = join(AGENT_DIR, "router-models-cache.json");
/** Codex client version the proxy switches to its rich catalog for. */
const CLIENT_VERSION = "0.163.0";
const FETCH_TIMEOUT_MS = 15000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Catalog entries that are media generators, not chat models. */
const NON_CHAT_ID = /(^|[-_.])image([-_.]|$)/i;

/** Served directly by Pi's built-in `deepseek` provider, not through the proxy. */
const DIRECT_PROVIDER_ID = /^deepseek/iu;

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiLevel = (typeof PI_LEVELS)[number];

/** Per-family wire protocol exposed by the proxy. */
const APIS = {
  completions: "openai-completions",
  responses: "openai-responses",
  anthropic: "anthropic-messages",
} as const;
type ProviderApi = (typeof APIS)[keyof typeof APIS];

interface Route {
  api: ProviderApi;
  baseUrl: string;
  /** `thinkingLevelMap` carries reasoning efforts; the Anthropic adapter uses budgets instead. */
  effortMap: boolean;
}

interface Spec {
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Limits for families whose metadata the proxy leaves empty: the rich catalog
 * reports `max_tokens: null` for deepseek-* and qwen-*, and its context numbers
 * for them look like placeholders.
 *
 * Sources:
 *  - deepseek: api.deepseek.com model cards, as bundled in Pi's own catalog
 *    (`@earendil-works/pi-ai` providers/data/deepseek.json: 1M context,
 *    384K output, text+image).
 *  - qwen: models.dev provider `alibaba`, qwen3.6 class (262144 context,
 *    65536 output), which covers qwen3.6-35b / qwen3.5-35b-a3b.
 */
const FAMILIES: Array<{ match: RegExp; spec: Spec }> = [
  { match: /^deepseek/i, spec: { reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 384_000 } },
  { match: /^(inh[-/])?qwen/i, spec: { reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 65_536 } },
];

/** Pi's own defaults for ids no family covers. */
const DEFAULT_SPEC: Spec = { reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384 };

function familySpec(id: string): Spec | undefined {
  return FAMILIES.find((family) => family.match.test(id))?.spec;
}

/**
 * Protocol per family:
 *  - Claude serves `/v1/messages` natively, and that is the only wire format
 *    that keeps its thinking blocks (chat/completions drops them).
 *  - GPT / Codex models are Responses-native, so speak that protocol directly.
 *  - Chat-only variants (`*-chat-thinking`), deepseek, qwen and the namespaced
 *    `oze-*` / `qgm-*` aliases stay on chat/completions.
 */
function routeFor(id: string, config: RouterConfig): Route {
  const root = config.baseUrl.replace(/\/v1$/u, "");
  if (/chat-thinking$/iu.test(id)) return { api: APIS.completions, baseUrl: config.baseUrl, effortMap: true };
  if (/^claude/iu.test(id)) return { api: APIS.anthropic, baseUrl: root, effortMap: false };
  if (/^(gpt|codex)[-.]/iu.test(id)) return { api: APIS.responses, baseUrl: config.baseUrl, effortMap: true };
  return { api: APIS.completions, baseUrl: config.baseUrl, effortMap: true };
}

interface RichModel {
  slug?: string;
  display_name?: string;
  context_window?: number | null;
  max_tokens?: number | null;
  input_modalities?: string[] | null;
  supported_reasoning_levels?: Array<{ effort?: string }> | null;
  /** Vendor ordering inside the GPT family (1 = the client's first pick). */
  priority?: number | null;
  visibility?: string | null;
  supported_in_api?: boolean | null;
}

/**
 * Display order in the `/model` picker: families alphabetically (claude,
 * deepseek, gpt, everything else), most capable first inside a family, and the
 * experimental entries at the very bottom.
 */
const GROUP_ORDER = ["claude", "deepseek", "gpt", "other"] as const;

const GROUP_PATTERNS: Array<{ group: (typeof GROUP_ORDER)[number]; match: RegExp }> = [
  { group: "claude", match: /^claude/iu },
  { group: "deepseek", match: /^deepseek/iu },
  { group: "gpt", match: /^(gpt|codex|oze|qgm)/iu },
];

/** Capability tiers, strongest first, for the families without a vendor order. */
const TIERS: Record<string, readonly string[]> = {
  claude: ["opus", "fable", "sonnet", "haiku"],
  // flash is the newer, faster line; it leads the family.
  deepseek: ["flash", "pro"],
};

/** Proxy flags that mark a model as experimental / not meant for the main picker. */
const EXPERIMENTAL_ID = /(chat-thinking|auto-review|experimental|preview)/iu;

function groupOf(id: string): (typeof GROUP_ORDER)[number] {
  return GROUP_PATTERNS.find((pattern) => pattern.match.test(id))?.group ?? "other";
}

function isExperimental(id: string, rich?: RichModel): boolean {
  return EXPERIMENTAL_ID.test(id) || rich?.visibility === "hide" || rich?.supported_in_api === false;
}

/** Version numbers in an id, most significant first: `gpt-6.1-sol` -> [6, 1]. */
function versionOf(id: string): number[] {
  const match = /(\d+(?:[.\-]\d+)*)/u.exec(id.replace(/^\D*?(?:claude|deepseek|gpt)[-.]?/iu, ""));
  if (!match?.[1]) return [];
  return match[1]
    .split(/[.\-]/u)
    .map((part) => Number.parseInt(part, 10))
    // Drop release dates such as `20250929`; only versions order models.
    .filter((part) => !Number.isNaN(part) && part < 10000)
    .slice(0, 3);
}

function compareVersionsDesc(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return right - left;
  }
  return 0;
}

interface Rank {
  experimental: number;
  group: number;
  tier: number;
  version: number[];
  id: string;
}

function rankOf(model: { id: string }, rich?: RichModel): Rank {
  const group = groupOf(model.id);
  const tiers = TIERS[group];
  const tierIndex = tiers ? tiers.findIndex((tier) => model.id.toLowerCase().includes(tier)) : -1;
  return {
    experimental: isExperimental(model.id, rich) ? 1 : 0,
    group: GROUP_ORDER.indexOf(group),
    // GPT ships its own preference order; elsewhere the tier table decides.
    tier: group === "gpt" && typeof rich?.priority === "number" ? rich.priority : tierIndex === -1 ? (tiers?.length ?? 0) : tierIndex,
    version: versionOf(model.id),
    id: model.id,
  };
}

function compareModels(a: Rank, b: Rank): number {
  return (
    a.experimental - b.experimental ||
    a.group - b.group ||
    a.tier - b.tier ||
    compareVersionsDesc(a.version, b.version) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Match key shared by the plain and the namespaced ids:
 * `oze/gpt-6.1-sol`, `oze-6.1-sol`, `gpt-6.1-sol` -> `<ns>|<rest>`.
 */
function matchKey(id: string): string {
  let namespace = "";
  let rest = id.toLowerCase();
  const namespaced = /^(oze|qgm|inh)[/-](.+)$/u.exec(rest);
  if (namespaced) {
    namespace = namespaced[1] ?? "";
    rest = namespaced[2] ?? "";
  }
  return `${namespace}|${rest.replace(/^gpt-/u, "")}`;
}

/** Map Pi thinking levels onto the efforts the model advertises. */
function thinkingLevelMap(levels: string[]): Record<string, string | null> | undefined {
  if (levels.length === 0) return undefined;
  const has = (...names: string[]) => names.find((name) => levels.includes(name));
  const map: Record<string, string | null> = { off: null };
  const assign = (level: PiLevel, effort: string | undefined) => {
    if (effort) map[level] = effort;
  };
  assign("minimal", has("minimal", "low"));
  assign("low", has("low", "minimal"));
  assign("medium", has("medium", "low"));
  assign("high", has("high", "medium"));
  assign("xhigh", has("xhigh", "high"));
  assign("max", has("max", "ultra", "xhigh", "high"));
  return map;
}

function modelFor(id: string, config: RouterConfig, rich?: RichModel) {
  // The proxy's numbers for these families are placeholders (500K context,
  // no output cap), so the family table wins over them for limits.
  const family = familySpec(id);
  const route = routeFor(id, config);
  const levels = (rich?.supported_reasoning_levels ?? [])
    .map((entry) => entry?.effort)
    .filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
  const modalities = (rich?.input_modalities ?? []).filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  const contextWindow = family?.contextWindow ?? rich?.context_window ?? DEFAULT_SPEC.contextWindow;
  const maxTokens = family?.maxTokens ?? rich?.max_tokens ?? DEFAULT_SPEC.maxTokens;
  const levelMap = route.effortMap ? thinkingLevelMap(levels) : undefined;
  return {
    id,
    name: rich?.display_name?.trim() || id,
    api: route.api,
    baseUrl: route.baseUrl,
    reasoning: levels.length > 0 || (family ?? DEFAULT_SPEC).reasoning,
    ...(levelMap ? { thinkingLevelMap: levelMap } : {}),
    input: modalities.length > 0 ? (modalities.includes("text") ? modalities : ["text", ...modalities]) : (family ?? DEFAULT_SPEC).input,
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens,
  };
}

/** Expand the subset of models.json value syntax discovery needs. */
function resolveValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$!") || value.startsWith("$$")) return value.slice(1);
  const env = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u.exec(value);
  if (env) return process.env[env[1] ?? env[2] ?? ""] || undefined;
  if (value.startsWith("!")) return undefined;
  return value;
}

interface RouterConfig {
  baseUrl: string;
  apiKey?: string;
}

function providerEntry(): { baseUrl?: string; apiKey?: string } | undefined {
  try {
    return (JSON.parse(readFileSync(MODELS_FILE, "utf8")) as {
      providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
    }).providers?.[PROVIDER_ID];
  } catch {
    return undefined;
  }
}

/** Same provider id, credential stored by `/login` in auth.json. */
function storedKey(): string | undefined {
  try {
    const credential = (JSON.parse(readFileSync(AUTH_FILE, "utf8")) as {
      [provider: string]: { type?: string; key?: string; env?: Record<string, string> } | undefined;
    })[PROVIDER_ID];
    if (!credential?.key) return undefined;
    if (!credential.key.startsWith("!")) return resolveValue(credential.key);
    // `!command` keys, as documented for auth.json.
    return execSync(credential.key.slice(1), { encoding: "utf8", timeout: 10000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function routerConfig(): RouterConfig | undefined {
  const provider = providerEntry();
  if (!provider?.baseUrl) return undefined;
  const base = provider.baseUrl.replace(/\/+$/u, "");
  return {
    baseUrl: /\/v1$/u.test(base) ? base : `${base}/v1`,
    apiKey: resolveValue(provider.apiKey) ?? storedKey(),
  };
}

async function getJson(url: string, config: RouterConfig, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = {
    "User-Agent": `pi/${CLIENT_VERSION}`,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/** Merge the plain catalog with the rich one; throws when the proxy returns nothing usable. */
async function discover(config: RouterConfig, signal?: AbortSignal) {
  const plain = (await getJson(`${config.baseUrl}/models`, config, signal)) as { data?: Array<{ id?: unknown }> };
  const ids = (plain.data ?? [])
    .map((entry) => entry?.id)
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && !NON_CHAT_ID.test(id) && !DIRECT_PROVIDER_ID.test(id),
    );
  if (ids.length === 0) throw new Error(`${config.baseUrl}/models returned no chat models`);

  // The rich catalog is a bonus: without it we still register the plain ids.
  const rich = new Map<string, RichModel>();
  try {
    const payload = (await getJson(`${config.baseUrl}/models?client_version=${CLIENT_VERSION}`, config, signal)) as {
      models?: RichModel[];
    };
    for (const entry of payload.models ?? []) {
      if (typeof entry?.slug === "string" && entry.slug.length > 0) rich.set(matchKey(entry.slug), entry);
    }
  } catch {
    // Keep going with family defaults.
  }

  const models = [...new Set(ids)].map((id) => ({ model: modelFor(id, config, rich.get(matchKey(id))), rank: rankOf({ id }, rich.get(matchKey(id))) }));
  return models.sort((a, b) => compareModels(a.rank, b.rank)).map((entry) => entry.model);
}

type DiscoveredModel = Awaited<ReturnType<typeof discover>>[number];

/** Bumped when routing or metadata logic changes, so stale caches are ignored. */
const CACHE_VERSION = 6;

function readCache(baseUrl: string): DiscoveredModel[] {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as {
      version?: number;
      baseUrl?: string;
      models?: DiscoveredModel[];
    };
    if (cache.version !== CACHE_VERSION || cache.baseUrl !== baseUrl || !Array.isArray(cache.models)) return [];
    return cache.models.filter((model) => typeof model?.id === "string" && model.id.length > 0);
  } catch {
    return [];
  }
}

function writeCache(baseUrl: string, models: DiscoveredModel[]): void {
  try {
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: CACHE_VERSION, baseUrl, updatedAt: new Date().toISOString(), models }, null, 2)}\n`,
    );
    renameSync(tmp, CACHE_FILE);
  } catch {
    // A read-only agent dir only costs us the offline fallback.
  }
}

export default async function (pi: ExtensionAPI) {
  const config = routerConfig();
  if (!config) return; // No provider entry in models.json: nothing to discover.

  let models = readCache(config.baseUrl);
  try {
    models = await discover(config);
    writeCache(config.baseUrl, models);
  } catch {
    // Offline or endpoint down: fall back to the cached list.
  }

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: config.baseUrl,
    api: API,
    models,
    async refreshModels(context) {
      // On failure keep the models already registered instead of dropping them.
      try {
        const fresh = await discover(config, context.signal);
        if (fresh.length > 0) {
          models = fresh;
          writeCache(config.baseUrl, models);
        }
      } catch {
        // Best effort: discovery failures must not empty the picker.
      }
      return models;
    },
  });
}
