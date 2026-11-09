/**
 * Footer with the working-directory line kept, and the CLIProxyAPI quota docked.
 *
 * Pi's built-in footer stacks three lines under the editor: the current
 * directory ("~", with git branch and session name), the token/context stats,
 * and the extension statuses. This footer keeps that shape but docks the quota
 * onto the status row:
 *
 *   ~/Projects/dantetemplar (main) • session
 *   ↑… ↓… $… ctx%/window (auto)                          model • thinking
 *   sync ⇡  Claude │ 7d … left 96% │ 5h … left 88%
 *
 * Widgets placed "belowEditor" always render above the footer, so the
 * cliproxy-usage quota widget would sit between the editor and the stats. Its
 * setWidget calls are redirected into this footer instead, and the quota is
 * rendered on the extension status row, after the other statuses.
 *
 * The quota widget lays itself out for the width left beside the statuses
 * (shorter identity and meters first). If it still does not fit, statuses are
 * truncated; only on very narrow terminals does the quota take its own row
 * below them.
 *
 * Only the "cliproxy-usage" widget key is redirected. Every other widget, and
 * cliproxy-usage itself outside the interactive TUI, keeps Pi's behavior.
 *
 * The stats line mirrors the built-in one: token totals, cache hit rate, cost,
 * context percentage, auto-compaction indicator, and model with thinking level.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth, type Component, type TUI, type Theme } from "@earendil-works/pi-tui";

const DOCKED_WIDGET_KEY = "cliproxy-usage";
/** Separator between stats, quota and model on the usage line. */
const GAP = "  ";
/** Below this the quota widget cannot show a complete field inline. */
const MIN_QUOTA_WIDTH = 8;

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type Stats = {
	totals: Totals;
	latestCacheHitRate: number | undefined;
};

type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;
type WidgetContent = string[] | WidgetFactory | undefined;
type SetWidget = (key: string, content: WidgetContent, options?: unknown) => void;

/** Home-relative path, exactly like Pi's built-in footer. */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Identical rounding to Pi's built-in footer, so the line does not jump. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function addUsage(totals: Totals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost?.total ?? 0;
}

function collectStats(entries: readonly unknown[]): Stats {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const raw of entries) {
		const entry = raw as Record<string, any>;
		if (entry?.type === "usage") {
			addUsage(totals, entry.usage as Usage | undefined);
		} else if (entry?.type === "message" && entry.message?.role === "assistant") {
			const usage = entry.message.usage as Usage | undefined;
			addUsage(totals, usage);
			if (usage) {
				const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
				latestCacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
			}
		} else if (entry?.type === "message" && entry.message?.role === "toolResult") {
			addUsage(totals, entry.message.usage as Usage | undefined);
		} else if (entry?.type === "branch_summary" || entry?.type === "compaction") {
			addUsage(totals, entry.usage as Usage | undefined);
		}
	}
	return { totals, latestCacheHitRate };
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Holds the redirected widget. The component is created lazily on first render
 * (the footer owns the TUI and theme), and disposed whenever it is replaced.
 */
class DockedWidget {
	private content: WidgetContent;
	private component: WidgetComponent | undefined;
	private onChange: (() => void) | undefined;

	set(content: WidgetContent): void {
		this.disposeComponent();
		this.content = content;
		this.onChange?.();
	}

	active(): boolean {
		return this.content !== undefined;
	}

	subscribe(onChange: (() => void) | undefined): void {
		this.onChange = onChange;
	}

	render(width: number, tui: TUI, theme: Theme): string[] {
		const content = this.content;
		if (content === undefined) return [];
		if (Array.isArray(content)) {
			// Same 1-column padding Pi applies to string-array widgets.
			return content.map((line) => truncateToWidth(` ${line}`, width, "…"));
		}
		try {
			this.component ??= content(tui, theme);
			return this.component.render(width);
		} catch {
			return [];
		}
	}

	invalidate(): void {
		this.component?.invalidate?.();
	}

	clear(): void {
		this.disposeComponent();
		this.content = undefined;
	}

	private disposeComponent(): void {
		try {
			this.component?.dispose?.();
		} catch {
			// A failing widget must not break the footer.
		}
		this.component = undefined;
	}
}

type FooterSources = {
	context(): ExtensionContext | undefined;
	autoCompactEnabled(): boolean;
	thinkingLevel(): string | undefined;
	docked: DockedWidget;
};

class UsageFooter {
	private cache: { key: string; stats: Stats } | undefined;

	constructor(
		private readonly sources: FooterSources,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly footerData: ReadonlyFooterDataProvider,
	) {
		sources.docked.subscribe(() => tui.requestRender());
	}

	invalidate(): void {
		this.sources.docked.invalidate();
	}

	dispose(): void {
		this.sources.docked.subscribe(undefined);
	}

	private stats(): Stats {
		const ctx = this.sources.context();
		const entries = ctx?.sessionManager.getEntries() ?? [];
		const key = `${ctx?.sessionManager.getSessionId() ?? ""}:${ctx?.sessionManager.getLeafId() ?? ""}:${entries.length}`;
		if (this.cache?.key === key) return this.cache.stats;
		const stats = collectStats(entries);
		this.cache = { key, stats };
		return stats;
	}

	/** Left (stats) and right (model) halves of the usage line, unpadded. */
	private statsParts(width: number): { left: string; right: string } {
		const { theme } = this;
		const ctx = this.sources.context();
		const { totals, latestCacheHitRate } = this.stats();
		const context = ctx?.getContextUsage();
		const contextWindow = context?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
		const percentValue = context?.percent ?? 0;
		const percent = context?.percent != null ? percentValue.toFixed(1) : "?";

		const parts: string[] = [];
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);

		const auto = this.sources.autoCompactEnabled() ? " (auto)" : "";
		const display = percent === "?" ? `?/${formatTokens(contextWindow)}${auto}` : `${percent}%/${formatTokens(contextWindow)}${auto}`;
		const colored = percentValue > 90 ? theme.fg("error", display)
			: percentValue > 70 ? theme.fg("warning", display)
			: theme.fg("dim", display);

		// The colored context part carries its own reset, so dim it separately
		// from the token/cost prefix to keep the whole line dim.
		const prefix = parts.length ? `${parts.join(" ")} ` : "";
		let left = theme.fg("dim", prefix) + colored;

		let right = ctx?.model?.id ?? "no-model";
		if (ctx?.model?.reasoning) {
			const level = this.sources.thinkingLevel() ?? "off";
			right = level === "off" ? `${right} • thinking off` : `${right} • ${level}`;
		}
		if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
		return { left, right };
	}

	/** Stats on the left, model on the right, padded to the full width. */
	private statsLine(width: number): string {
		const { left, right } = this.statsParts(width);
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		if (leftWidth + GAP.length + rightWidth > width) {
			const room = width - leftWidth - GAP.length;
			if (room <= 0) return left;
			return left + GAP + this.theme.fg("dim", truncateToWidth(right, room, ""));
		}
		return left + " ".repeat(width - leftWidth - rightWidth) + this.theme.fg("dim", right);
	}

	/**
	 * The quota widget lays itself out for a given width (shorter identity and
	 * meters first). Accept it inline only when it fits on one complete row.
	 */
	private inlineQuota(budget: number): string | undefined {
		if (budget < MIN_QUOTA_WIDTH) return undefined;
		const lines = this.sources.docked.render(budget, this.tui, this.theme);
		if (lines.length !== 1) return undefined;
		const line = lines[0]!;
		if (visibleWidth(line) > budget || /omitted\]/.test(line)) return undefined;
		return line;
	}

	/** Extension statuses joined like Pi's built-in footer (sorted by key). */
	private statusText(): string {
		return Array.from(this.footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, value]) => sanitizeStatus(value))
			.filter(Boolean)
			.join(" ");
	}

	/**
	 * Other statuses first, then the quota on the same row. The quota keeps its
	 * complete fields; statuses are truncated to what is left. Only when the
	 * quota cannot fit a single row does it take its own rows below the statuses.
	 */
	private statusLines(width: number): string[] {
		const text = this.statusText();
		const ellipsis = this.theme.fg("dim", "...");
		if (!this.sources.docked.active()) return text ? [truncateToWidth(text, width, ellipsis)] : [];
		if (text) {
			// Prefer showing statuses in full; shrink the quota layout first.
			const beside = this.inlineQuota(width - GAP.length - visibleWidth(text));
			if (beside !== undefined) return [text + GAP + beside];
		}
		const alone = this.inlineQuota(width);
		if (alone !== undefined) {
			if (!text) return [alone];
			const room = width - visibleWidth(alone) - GAP.length;
			if (room >= MIN_QUOTA_WIDTH) return [truncateToWidth(text, room, ellipsis) + GAP + alone];
		}
		const quota = this.sources.docked.render(width, this.tui, this.theme);
		return text ? [truncateToWidth(text, width, ellipsis), ...quota] : quota;
	}

	/** Directory line: home-relative cwd, git branch, session name. */
	private pwdLine(width: number): string {
		const ctx = this.sources.context();
		const cwd = ctx?.sessionManager.getCwd() ?? ctx?.cwd ?? process.cwd();
		let pwd = formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = ctx?.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;
		return truncateToWidth(this.theme.fg("dim", pwd), width, this.theme.fg("dim", "..."));
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines: string[] = [];
		try {
			lines.push(this.pwdLine(width));
		} catch {
			// The stats and statuses are still worth showing without the path.
		}
		try {
			lines.push(this.statsLine(width));
		} catch {
			// Keep the quota and statuses even if stats fail.
		}
		lines.push(...this.statusLines(width));
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let current: ExtensionContext | undefined;
	const docked = new DockedWidget();
	// Pi rebuilds the shared UI object when extensions are rebound, so the
	// redirect is installed once per object and restored on shutdown.
	const redirected = new WeakMap<object, SetWidget>();

	const redirect = (ctx: ExtensionContext) => {
		const ui = ctx.ui as unknown as { setWidget: SetWidget };
		if (redirected.has(ui)) return;
		const original = ui.setWidget;
		redirected.set(ui, original);
		ui.setWidget = (key, content, options) => {
			if (key !== DOCKED_WIDGET_KEY) return original(key, content, options);
			docked.set(content);
			// Drop anything Pi already placed for this key before the redirect.
			original(key, undefined);
		};
	};

	const restore = (ctx: ExtensionContext) => {
		const ui = ctx.ui as unknown as { setWidget: SetWidget };
		const original = redirected.get(ui);
		if (!original) return;
		ui.setWidget = original;
		redirected.delete(ui);
	};

	const install = (ctx: ExtensionContext) => {
		current = ctx;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		redirect(ctx);
		const sources: FooterSources = {
			context: () => current,
			autoCompactEnabled: () => pi.getSettings().compaction?.enabled ?? true,
			thinkingLevel: () => pi.getThinkingLevel(),
			docked,
		};
		ctx.ui.setFooter((tui, theme, footerData) => new UsageFooter(sources, tui, theme, footerData));
	};

	pi.on("session_start", async (_event, ctx) => install(ctx));
	pi.on("model_select", (_event, ctx) => { current = ctx; });
	pi.on("thinking_level_select", (_event, ctx) => { current = ctx; });
	pi.on("session_shutdown", (_event, ctx) => {
		current = undefined;
		docked.clear();
		if (!ctx.hasUI) return;
		restore(ctx);
		ctx.ui.setFooter(undefined);
	});
}
