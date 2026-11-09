/** Mirror native pi-usage measurements into Pendant's below-editor component surface.
 *
 * No queries, polling or provider imports: pi-usage still owns data and retries.
 * Its original status (including diagnostics) is always forwarded unchanged.
 * The extra widget excludes checking/error/auth/backoff messages. It never keeps
 * an old balance after failure, model change or session replacement.
 *
 * Pendant supports component factories in RPC mode; CLI RPC silently ignores
 * them. Pi TUI is untouched. Wrapping the shared ui.setStatus is a local adapter,
 * not a public pi-usage subscription API.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const STATUS_KEY = "usage";
const WIDGET_KEY = "pi-usage";
const PLACEMENT = { placement: "belowEditor" } as const;

type Widget = { invalidate(): void; render(width: number): string[] };
type WidgetContent = string[] | ((tui: unknown, theme: unknown) => Widget) | undefined;
type Ui = {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: WidgetContent, options?: typeof PLACEMENT): void;
};
type Scope = {
	session: ExtensionContext["sessionManager"];
	sessionId: string;
	provider: string;
	model: string;
	baseUrl: string;
};
type Mirror = { scope: Scope; lines: string[] };
type Binding = {
	ui: Ui;
	ctx: ExtensionContext;
	original: Ui["setStatus"];
	wrapper: Ui["setStatus"];
	scope: Scope | undefined;
	mirror: Mirror | undefined;
	active: boolean;
};

function scopeOf(ctx: ExtensionContext): Scope | undefined {
	try {
		const model = ctx.model;
		if (!model) return undefined;
		return {
			session: ctx.sessionManager,
			sessionId: ctx.sessionManager.getSessionId(),
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
		};
	} catch {
		return undefined;
	}
}

function sameScope(a: Scope | undefined, b: Scope | undefined): boolean {
	return a !== undefined && b !== undefined && a.session === b.session &&
		a.sessionId === b.sessionId && a.provider === b.provider &&
		a.model === b.model && a.baseUrl === b.baseUrl;
}

function clean(text: string): string {
	return text
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-Z\\-_]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/** This is a display filter, not an auth/identity proof or a report parser. */
function measurementLines(text: string | undefined, scope: Scope): string[] | undefined {
	if (!text || scope.provider === "router" || scope.provider === "cliproxyapi") return undefined;
	const lines = clean(text).split(/\r\n|\r|\n/)
		.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 4);
	if (!lines.length) return undefined;
	const joined = lines.join(" ");
	// pi-usage publishes these non-report chips via the same status key.
	if (/^(?:checking\b|usage\s+err(?:or)?\b|auth\s+unavailable\b|selection\s+required\b|error\b|backoff\b)/i.test(joined)) return undefined;
	// Require a numerical measurement, not just an informational label.
	if (!/\d/.test(joined)) return undefined;
	// A late DeepSeek string must never be attributed to a newly selected GPT model.
	if (/^deepseek\b/i.test(joined) && scope.provider !== "deepseek") return undefined;
	if (scope.provider === "deepseek" && !/^deepseek\s+(?:USD|CNY|RMB|JPY|[$¥])/i.test(joined)) return undefined;
	return lines;
}

export default function (pi: ExtensionAPI) {
	let binding: Binding | undefined;

	const clear = (owner: Binding) => {
		owner.mirror = undefined;
		try {
			owner.ui.setWidget(WIDGET_KEY, undefined, PLACEMENT);
		} catch {
			// Session surface may already be disposed.
		}
	};

	const syncScope = (owner: Binding): Scope | undefined => {
		const live = scopeOf(owner.ctx);
		if (!sameScope(live, owner.scope)) {
			owner.scope = live;
			clear(owner);
		}
		return live;
	};

	const publish = (owner: Binding, text: string | undefined) => {
		if (!owner.active || binding !== owner) return;
		const scope = syncScope(owner);
		const lines = scope ? measurementLines(text, scope) : undefined;
		if (!scope || !lines) {
			if (owner.mirror) clear(owner);
			return;
		}
		if (owner.mirror && sameScope(owner.mirror.scope, scope) &&
			owner.mirror.lines.join("\n") === lines.join("\n")) return;
		const candidate: Mirror = { scope, lines };
		owner.mirror = candidate;
		const applies = () => owner.active && binding === owner && owner.mirror === candidate &&
			sameScope(candidate.scope, scopeOf(owner.ctx));
		try {
			owner.ui.setWidget(WIDGET_KEY, () => ({
				invalidate() {},
				render(width: number): string[] {
					return width > 0 && applies()
						? lines.map((line) => truncateToWidth(line, width, "…")) : [];
				},
			}), PLACEMENT);
		} catch {
			// Text-only hosts still get the same measurement, with the same event clears.
			try { owner.ui.setWidget(WIDGET_KEY, lines, PLACEMENT); } catch { /* disposed */ }
		}
	};

	const detach = () => {
		const owner = binding;
		if (!owner) return;
		owner.active = false;
		clear(owner);
		// Don't undo another extension's wrapper installed after ours.
		if (owner.ui.setStatus === owner.wrapper) owner.ui.setStatus = owner.original;
		binding = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		detach();
		if (!ctx.hasUI || ctx.mode !== "rpc") return;
		const ui = ctx.ui as unknown as Ui;
		const original = ui.setStatus;
		const owner: Binding = {
			ui, ctx, original, scope: scopeOf(ctx), mirror: undefined, active: true,
			wrapper(key, text) {
				original.call(ui, key, text);
				if (key === STATUS_KEY) publish(owner, text);
			},
		};
		binding = owner;
		ui.setStatus = owner.wrapper;
		clear(owner);
	});

	pi.on("model_select", (_event, ctx) => {
		const owner = binding;
		if (!owner || !owner.active || owner.ui !== ctx.ui) return;
		owner.ctx = ctx;
		// A preceding handler may already have published for this scope. Don't
		// erase that fresh value just because our model_select handler runs later.
		syncScope(owner);
	});

	// session_before_switch is cancellable; only a committed shutdown clears us.
	pi.on("session_shutdown", () => detach());
}
