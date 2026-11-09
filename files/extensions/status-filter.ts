/**
 * Hides selected extension statuses.
 *
 * pi-thinking-steps always publishes `thinking: <mode>` through setStatus and
 * offers no setting to hide it, so the label sits in Pi's footer and in
 * Pendant's status bar whether or not you care about the current view mode.
 * The thinking panels themselves are unaffected — only the status entry goes.
 *
 * The status is dropped by wrapping the shared `ctx.ui.setStatus` that Pi hands
 * to every extension in one session. The key is cleared once when the redirect
 * installs and then ignored, so the value never reaches the footer, Pendant, or
 * any later wrapper. Add a key to HIDDEN_STATUS_KEYS to hide another status.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HIDDEN_STATUS_KEYS = ["thinking-steps"];

type SetStatus = (key: string, text: string | undefined) => void;

export default function (pi: ExtensionAPI) {
	const redirected = new WeakMap<object, SetStatus>();

	const redirect = (ctx: ExtensionContext) => {
		const ui = ctx.ui as unknown as { setStatus: SetStatus };
		if (redirected.has(ui)) return;
		const original = ui.setStatus;
		redirected.set(ui, original);
		// Clear anything the source extension published before this redirect.
		for (const key of HIDDEN_STATUS_KEYS) {
			try {
				original(key, undefined);
			} catch {
				// A host that refuses teardown writes is still filtered below.
			}
		}
		ui.setStatus = (key, text) => {
			if (HIDDEN_STATUS_KEYS.includes(key)) {
				// Keep the host's own state clean without publishing text.
				if (text !== undefined) {
					try {
						original(key, undefined);
					} catch {
						// Nothing to clear.
					}
				}
				return;
			}
			original(key, text);
		};
	};

	const restore = (ctx: ExtensionContext) => {
		const ui = ctx.ui as unknown as { setStatus: SetStatus };
		const original = redirected.get(ui);
		if (!original) return;
		ui.setStatus = original;
		redirected.delete(ui);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		redirect(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) restore(ctx);
	});
}
