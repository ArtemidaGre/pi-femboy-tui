/**
 * femboy — one extension + one theme that own pi's whole terminal chrome.
 *
 * Slots taken over (details in chrome.ts):
 *   welcome panel · chibi dock on the right (companion.ts) · status bar
 *   editor ribbon · metrics bar · blank footer
 *   (kept only to capture footerData) · pastel tool rows · streaming loader
 *
 * Plus:
 *   /femboy        the interactive closet overlay (animated chibi)
 *   ctrl+alt+f     open the closet from anywhere
 *   /femboy-off    hand every slot back to pi
 *   femboy_vibe    the model can check the vibe or hand you a headpat
 *   uwu transcript registerMarkdownTransformer, display-only
 *
 * Everything is driven by one store (`vibe.ts`): components read it at render
 * time and subscribe for repaints, so a toggle lands on the next frame without
 * rebuilding the editor or re-registering a tool — and an idle session runs no
 * timers at all.
 *
 * Config: the `femboy` key in settings.json (project overrides user):
 *   { "pastel": true, "uwu": false, "welcome": "header" | "overlay" | "off",
 *     "outfit": "Oversized Hoodie", "toolRows": true, "ribbonEditor": true,
 *     "companion": true }
 *
 * `pi --use-theme femboy` (or /settings → Theme) matches the palette, but the
 * chrome works with any theme because chrome colours come from theme tokens.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type OverlayOptions, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type ChromeHandle,
	type PanelData,
	installChrome,
	loadedCounts,
	makeFemboyEditor,
	recentSessions,
} from "./chrome";
import { FemboyOverlay } from "./overlay";
import { GLYPH } from "./palette";
import { initPairing, shutdownPairing } from "./pairing";
import { clearSpeech, speakMarkdown } from "./speech";
import { OUTFITS, findOutfitIndex } from "./sprites";
import { pastelToolRows } from "./tool-rows";
import {
	DEFAULT_VIBE,
	ENTRY_TYPE,
	type VibeState,
	type WelcomeMode,
	getVibe,
	hydrateVibe,
	moodLabel,
	patchVibe,
	savedVibe,
	settingsVibe,
	setVibePersister,
	vibeShort,
	vibeSummary,
} from "./vibe";
import { markUserMessage, uwuifyMarkdown } from "./uwu";

const STATUS_KEY = "femboy";
const METRICS_KEY = "femboy-metrics";

let chrome: ChromeHandle | undefined;
let editorInstalled = false;

// ------------------------------------------------------------------- helpers --

function openOverlay(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`the closet needs interactive mode · ${vibeSummary()}`, "info");
		return;
	}
	const overlayOptions: OverlayOptions = {
		width: "82%",
		minWidth: 30,
		maxHeight: "88%",
		anchor: "center",
		margin: 1,
	};
	void ctx.ui
		.custom<void>(
			(tui, theme, _keybindings, done) => new FemboyOverlay(tui, theme, done),
			{ overlay: true, overlayOptions },
		)
		.catch((error) => console.debug("[femboy] overlay failed:", error));
}

async function buildPanelData(ctx: ExtensionContext): Promise<PanelData> {
	return {
		counts: loadedCounts(ctx.cwd, getAgentDir()),
		sessions: await recentSessions(ctx.cwd),
		cwd: ctx.cwd,
		piVersion: VERSION,
	};
}

/**
 * Install the pastel editor shell exactly once per session. The ribbon reads
 * the vibe at render time, so toggling it later needs no rebuild — which is
 * what keeps your draft alive.
 */
function installEditorShell(ctx: ExtensionContext): void {
	if (editorInstalled) return;
	const Shell = makeFemboyEditor(CustomEditor);
	if (!Shell) {
		console.debug("[femboy] CustomEditor unavailable; skipping editor ribbon");
		return;
	}
	try {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new Shell(tui, theme, keybindings));
		editorInstalled = true;
	} catch (error) {
		console.debug("[femboy] editor shell install failed:", error);
	}
}

function patOnce(ctx: ExtensionContext): void {
	const next = getVibe().headpats + 1;
	patchVibe({ headpats: next });
	chrome?.celebrate();
	ctx.ui.notify(`headpat #${next} — ${moodLabel(next)} ${GLYPH.heart}`, "info");
}

function wearOutfit(ctx: ExtensionContext, arg: string): void {
	const index = findOutfitIndex(arg);
	if (index === undefined) {
		ctx.ui.notify(`unknown outfit — options: ${OUTFITS.map((outfit) => outfit.name).join(", ")}`, "warning");
		return;
	}
	patchVibe({ outfit: index });
	ctx.ui.notify(`now wearing ${OUTFITS[index]!.name} ${GLYPH.heart}`, "info");
}

function cycleWelcome(ctx: ExtensionContext, mode?: WelcomeMode): void {
	const current = getVibe().welcome;
	const next: WelcomeMode =
		mode ?? (current === "header" ? "overlay" : current === "overlay" ? "off" : "header");
	patchVibe({ welcome: next });
	ctx.ui.notify(`welcome panel → ${next}`, "info");
}

function toggleVibe(ctx: ExtensionContext, key: "toolRows" | "ribbonEditor" | "companion"): void {
	const label = key === "toolRows" ? "pastel tool rows" : key === "ribbonEditor" ? "editor ribbon" : "chibi companion";
	const next = !getVibe()[key];
	patchVibe({ [key]: next } as Partial<VibeState>);
	ctx.ui.notify(`${label} ${next ? "on" : "off"}`, "info");
}

/** Hand every slot back to pi, explicitly, and keep the editor draft. */
function restoreBuiltins(ctx: ExtensionContext): void {
	chrome?.dispose();
	chrome = undefined;
	if (ctx.mode !== "tui") return;
	try {
		ctx.ui.setHeader(undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
		ctx.ui.setWidget(METRICS_KEY, undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
		if (editorInstalled) {
			const draft = ctx.ui.getEditorText?.();
			ctx.ui.setEditorComponent(undefined);
			if (draft) ctx.ui.setEditorText(draft);
			editorInstalled = false;
		}
	} catch (error) {
		console.debug("[femboy] restore failed:", error);
	}
}

const VIBE_ACTIONS = [
	"check",
	"headpat",
	"wear",
	"uwu_on",
	"uwu_off",
	"chrome_on",
	"chrome_off",
	"companion_on",
	"companion_off",
] as const;

const VIBE_PARAMS = Type.Object({
	action: StringEnum(VIBE_ACTIONS, { description: "What to do with the vibe" }),
	outfit: Type.Optional(
		Type.String({
			description: `Outfit name or 1-based index for action "wear": ${OUTFITS.map((outfit) => outfit.name).join(", ")}`,
		}),
	),
});

// ============================================================= entry point ==

export default function femboy(pi: ExtensionAPI): void {
	// Patches write a session entry (extension-private, never LLM context) so
	// /reload, resume and fork restore the same vibe.
	setVibePersister((vibe) => pi.appendEntry(ENTRY_TYPE, vibe));

	// Display-only transcript rendering: the model still reads and writes plain
	// English. A blossom caret marks user turns; code never gets rewritten.
	// Side effect: the assistant branch also feeds the chibi's speech bubble —
	// this transformer is the only per-frame view of the live stream, so it is
	// the producer for speech.ts (the companion consumes on its own tick).
	pi.registerMarkdownTransformer((markdown, info) => {
		try {
			const vibe = getVibe();
			if (info.messageType === "assistant" && vibe.pastelMode && vibe.companion) {
				speakMarkdown(markdown, info.isStreaming);
			}
			if (info.messageType === "user") clearSpeech();
			if (info.messageType === "assistant-thinking") return markdown;
			const marked = vibe.pastelMode && info.messageType === "user" ? markUserMessage(markdown, `${GLYPH.flower} `) : markdown;
			if (!vibe.uwuMode) return marked;
			// Do not rewrite a message mid-stream: the flourish is chosen by line
			// index, so re-picking it every token would jitter the text.
			if (info.isStreaming && info.messageType !== "user") return marked;
			return uwuifyMarkdown(marked);
		} catch (error) {
			// This runs on *every* streaming frame of *every* message. Rewriting
			// the transcript is decoration — on any hiccup, hand pi the original.
			console.debug("[femboy] markdown transform failed:", error);
			return markdown;
		}
	});

	// Pastel tool rows for every tool, composed with pi's own rendering.
	pi.registerToolRenderer(pastelToolRows());

	pi.on("session_start", async (_event, ctx) => {
		editorInstalled = false;
		clearSpeech();
		// Layering: defaults ← settings.json ← this session's saved vibe.
		hydrateVibe({ ...DEFAULT_VIBE, ...settingsVibe(ctx.cwd), ...savedVibe(ctx) });
		// Background connector to femboy-mcp: offline is the default, never fatal.
		initPairing(ctx.cwd);
		if (ctx.mode !== "tui") return;
		// Losing the pastel chrome must never lose the session: pi can still work
		// with its own header, bars and loader.
		try {
			chrome?.dispose();
			chrome = installChrome(ctx, await buildPanelData(ctx));
		} catch (error) {
			console.debug("[femboy] chrome install failed:", error);
			ctx.ui.notify("pastel chrome could not load — pi's built-ins stay in charge", "warning");
			return;
		}
		installEditorShell(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		chrome?.dispose();
		chrome = undefined;
		void shutdownPairing();
		// Restore pi's own loader in case the next session loads without femboy.
		try {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setWorkingMessage();
			ctx.ui.setWidget(STATUS_KEY, undefined);
			ctx.ui.setWidget(METRICS_KEY, undefined);
		} catch {
			/* the context may already be stale */
		}
	});

	// Both bars carry live values (model, thinking level, tokens) — repaint on
	// the events that change them instead of on a timer.
	pi.on("model_select", () => chrome?.repaint());
	pi.on("thinking_level_select", () => chrome?.repaint());
	pi.on("agent_start", () => chrome?.repaint());
	pi.on("turn_end", () => chrome?.repaint());

	// ---------------------------------------------------------------- commands --

	pi.registerCommand("femboy", {
		description: "Pastel chrome closet: /femboy [open|on|off|headpat|uwu|outfit|welcome|rows|ribbon|companion|reset|stats]",
		getArgumentCompletions: (prefix: string) => {
			const needle = prefix.trim().toLowerCase();
			const words = ["open", "on", "off", "headpat", "uwu", "outfit", "welcome", "rows", "ribbon", "companion", "reset", "stats"];
			const hits = words.filter((word) => word.startsWith(needle)).map((word) => ({ value: word, label: word }));
			if (needle.startsWith("outfit")) {
				hits.push(
					...OUTFITS.map((outfit, index) => ({
						value: `outfit ${outfit.name}`,
						label: `outfit ${index + 1}: ${outfit.name}`,
					})),
				);
			}
			if (needle.startsWith("welcome")) {
				hits.push(...(["header", "overlay", "off"] as WelcomeMode[]).map((mode) => ({ value: `welcome ${mode}`, label: `welcome ${mode}` })));
			}
			return hits.length > 0 ? hits : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			const vibe = getVibe();

			if (!sub || sub === "open") return openOverlay(ctx);

			if (sub === "on" || sub === "off") {
				patchVibe({ pastelMode: sub === "on" });
				ctx.ui.notify(sub === "on" ? `pastel chrome on ${GLYPH.heart}` : "pastel chrome off — pi's built-ins restored", "info");
				return;
			}
			if (sub === "headpat" || sub === "pat") return patOnce(ctx);
			if (sub === "rows") return toggleVibe(ctx, "toolRows");
			if (sub === "ribbon") return toggleVibe(ctx, "ribbonEditor");
			if (sub === "companion") return toggleVibe(ctx, "companion");

			if (sub === "uwu") {
				patchVibe({ uwuMode: !vibe.uwuMode });
				ctx.ui.notify(vibe.uwuMode ? "uwu transcript off" : "uwu transcript on uwu~", "info");
				return;
			}
			if (sub.startsWith("welcome")) {
				const rest = sub.slice("welcome".length).trim();
				return cycleWelcome(ctx, rest === "header" || rest === "overlay" || rest === "off" ? rest : undefined);
			}
			if (sub.startsWith("outfit")) return wearOutfit(ctx, sub.slice("outfit".length));
			if (sub === "reset") {
				patchVibe({ headpats: 0, outfit: 0 });
				ctx.ui.notify("fresh start :3", "info");
				return;
			}
			ctx.ui.notify(truncateToWidth(vibeSummary(), 200), "info");
		},
	});

	pi.registerCommand("uwu", {
		description: "Toggle uwu rendering, or uwuify your draft: /uwu <text>",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				patchVibe({ uwuMode: !getVibe().uwuMode });
				ctx.ui.notify(getVibe().uwuMode ? "uwu transcript on uwu~" : "uwu transcript off", "info");
				return;
			}
			const uwuified = uwuifyMarkdown(text);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(uwuified, "info");
				return;
			}
			ctx.ui.setEditorText(uwuified);
			ctx.ui.notify("nyaa~ swapped your message into uwu :3", "info");
		},
	});

	pi.registerCommand("femboy-off", {
		description: "Restore pi's built-in header, footer, widgets, editor and loader",
		handler: async (_args, ctx) => {
			patchVibe({ pastelMode: false });
			restoreBuiltins(ctx);
			ctx.ui.notify("femboy chrome off — pi's built-ins restored", "info");
		},
	});

	pi.registerShortcut("ctrl+alt+f", {
		description: "Open the femboy closet",
		handler: async (ctx) => openOverlay(ctx),
	});

	// -------------------------------------------------------------------- tool --

	pi.registerTool({
		name: "femboy_vibe",
		label: "Femboy vibe",
		description:
			"Check or change the user's pastel vibe: headpats, outfit, chibi companion, uwu transcript rendering, and the pastel chrome takeover.",
		promptSnippet: "Check or change the user's pastel vibe: headpats, outfit, uwu transcript rendering",
		parameters: VIBE_PARAMS,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const vibe = getVibe();
		switch (params.action) {
			case "headpat":
				patchVibe({ headpats: vibe.headpats + 1 });
				chrome?.celebrate();
				break;
			case "wear": {
				const index = findOutfitIndex(params.outfit ?? "");
				if (index === undefined) {
					throw new Error(`unknown outfit "${params.outfit ?? ""}"; options: ${OUTFITS.map((o) => o.name).join(", ")}`);
				}
				patchVibe({ outfit: index });
				break;
			}
			case "uwu_on":
				patchVibe({ uwuMode: true });
				break;
			case "uwu_off":
				patchVibe({ uwuMode: false });
				break;
			case "chrome_on":
				patchVibe({ pastelMode: true });
				break;
			case "chrome_off":
				patchVibe({ pastelMode: false });
				break;
			case "companion_on":
				patchVibe({ companion: true });
				break;
			case "companion_off":
				patchVibe({ companion: false });
				break;
			case "check":
			default:
				break;
		}
		// The model nudged the vibe — say so out loud. A silent `check` is not a
		// change, so it must not spam a toast.
		if (params.action !== "check") {
			ctx.ui.notify(`${GLYPH.heart} the assistant touched your vibe · ${vibeShort()}`, "info");
		}
		return { content: [{ type: "text", text: vibeSummary() }], details: { ...getVibe() } };
	},
	});
}
