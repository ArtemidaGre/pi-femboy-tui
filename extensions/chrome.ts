/**
 * chrome.ts — every visual slot pi exposes to extensions, in pastel.
 *
 * Design order, top → bottom:
 *
 *   welcome panel  → ctx.ui.setHeader()                        pinned at top
 *   chibi dock     → nonCapturing overlay (companion.ts)       pinned right
 *   status bar     → ctx.ui.setWidget("femboy", …)             above the editor
 *   editor shell   → makeFemboyEditor(CustomEditor)            ribbon top border
 *   metrics bar    → ctx.ui.setWidget("femboy-metrics", …)     below the editor
 *   bottom footer  → ctx.ui.setFooter() rendered blank; exists only to capture
 *                    footerData (git branch + other extensions' statuses), which
 *                    is the sole route to that data
 *   loader         → setWorkingIndicator() / setWorkingMessage()
 *
 * Discipline:
 * - **No timers.** Components read `getVibe()` at render time; repaint requests
 *   come only from vibe changes, git branch changes, and pi's own loop. An idle
 *   session costs zero repaints. The animated chibi lives in overlay.ts.
 * - **Idempotent install.** `install()` compares a small key; toggling pastel
 *   mode re-assigns slots instead of rebuilding the editor, so your draft is
 *   never lost.
 * - **No stale colors.** The `theme` pi hands a factory is a live proxy, so
 *   colours are read at render time; the only cache is the panel's line list,
 *   keyed by width · rows · vibe · data, and it is dropped in `invalidate()`.
 * - **No Nerd Font, no hardcoded widths.** Everything is measured with pi's
 *   `visibleWidth` / `truncateToWidth`.
 * - **Degrades.** `ctx.mode !== "tui"` owns nothing (those slots are TUI-only).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Color, type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH, type Swatch, gradientRun, ramp } from "./palette";
import { CompanionController } from "./companion";
import { SPRITE_COLS, miniFace, renderSprite } from "./sprites";
import { currentOutfit, getVibe, moodLabel, onVibeChange, vibeShort } from "./vibe";

// -------------------------------------------------------------------- layout --

const pad = (text: string, n: number) => text + " ".repeat(Math.max(0, n - visibleWidth(text)));
const padLeft = (text: string, n: number) => " ".repeat(Math.max(0, n - visibleWidth(text))) + text;
const centerIn = (text: string, n: number) =>
	" ".repeat(Math.max(0, Math.floor((n - visibleWidth(text)) / 2))) + text;
const fit = (text: string, n: number) => truncateToWidth(pad(text, n), n);
/** `left` padded out to `n`, `right` flush to the right edge. Exactly n cells. */
const lr = (left: string, right: string, n: number) => pad(left, Math.max(0, n - visibleWidth(right))) + right;

const fmtTokens = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`);
const homePath = (p: string) => p.replace(homedir(), "~");

/** pi's thinking-level names are long; the bar reads better abbreviated. */
const THINK_ABBR: Record<string, string> = { minimal: "min", medium: "med", xhigh: "xhi" };
const thinkLabel = (level: string) => `think:${THINK_ABBR[level] ?? level}`;

// ---------------------------------------------------------------------- data --

export interface LoadedCounts {
	context: number;
	extensions: number;
	skills: number;
	prompts: number;
}

const countDir = (dir: string): number => {
	try {
		return readdirSync(dir).length;
	} catch {
		return 0;
	}
};

function readSettingsJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Tally what pi loaded — cheap sync fs reads, done once per session start. */
export function loadedCounts(cwd: string, agentDir: string): LoadedCounts {
	const settings = readSettingsJson(`${agentDir}/settings.json`);
	const packages = Array.isArray(settings?.packages) ? settings.packages.length : 0;

	let context = 0;
	for (const file of ["AGENTS.md", "CLAUDE.md", ".pi/AGENTS.md"]) {
		try {
			statSync(`${cwd}/${file}`);
			context++;
		} catch {
			/* not present */
		}
	}

	return {
		context,
		extensions: packages + countDir(`${agentDir}/extensions`) + countDir(`${cwd}/.pi/extensions`),
		skills: countDir(`${agentDir}/skills`),
		prompts: countDir(`${agentDir}/prompts`),
	};
}

function relTime(ms: number): string {
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 90) return `${Math.round(s)}s ago`;
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	if (s < 172800) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

/**
 * First meaningful line of a session file, used as its label. A session opened
 * with a skill invocation starts with a huge `<skill …>…</skill>` block, so
 * drop those (body included) and any other tags.
 */
function sessionLabel(file: string): string {
	let text = "";
	try {
		text = readFileSync(file, "utf8").slice(0, 65536);
	} catch {
		return "";
	}
	let firstUser = "";
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const named = entry?.name ?? entry?.title ?? entry?.session_info?.name;
		if (typeof named === "string" && named.trim()) return named.trim().slice(0, 24);
		if (!firstUser && entry?.type === "message" && entry?.message?.role === "user") {
			const content = entry.message.content;
			const raw =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map((part: any) => part?.text ?? "").join(" ")
						: "";
			const cleaned = raw
				.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/gi, " ")
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			if (cleaned) firstUser = cleaned;
		}
	}
	return firstUser ? firstUser.slice(0, 24) : "";
}

export interface SessionRow {
	name: string;
	ago: string;
}

export async function recentSessions(cwd: string): Promise<SessionRow[]> {
	try {
		if (!SessionManager?.list) return [];
		const list: any[] = await SessionManager.list(cwd);
		return list.slice(0, 3).map((session: any) => {
			const file: string = session?.file ?? session?.path ?? "";
			const direct = session?.name ?? session?.title;
			let name = "untitled";
			if (typeof direct === "string" && direct.trim()) name = direct.trim().slice(0, 24);
			else if (file) name = sessionLabel(file) || basename(file).replace(/\.jsonl$/, "").slice(0, 24);
			const ms: number = session?.mtimeMs ?? session?.mtime ?? Date.now();
			return { name, ago: relTime(ms) };
		});
	} catch {
		return [];
	}
}

export interface PanelData {
	counts: LoadedCounts;
	sessions: SessionRow[];
	cwd: string;
	piVersion: string;
}

// ------------------------------------------------------------- welcome panel --

const GREETINGS = ["Ciallo～(∠・ω< )⌒★", "welcome back ♡", "let's be productive nyaa~", "pastel mode engaged"];

const KEY_TIPS: ReadonlyArray<[string, string]> = [
	["/", "command palette"],
	["!", "run a bash command"],
	["ctrl+alt+f", "open the closet"],
	["shift+tab", "cycle thinking level"],
	["ctrl+c", "interrupt the task"],
];

function borderLine(
	theme: Theme,
	stops: readonly Color[],
	edge: "top" | "bottom",
	width: number,
	label: string,
): string {
	const inner = Math.max(1, width - 2);
	const corners = edge === "top" ? ["╭", "╮"] : ["╰", "╯"];
	// Clamp the label itself, so a narrow terminal can never push the corners
	// off the line (a clipped box is worse than a short caption).
	const text = truncateToWidth(label, Math.max(0, inner - 2));
	const labelW = Math.max(0, Math.min(visibleWidth(text), inner - 2));
	const free = inner - labelW;
	const leftCount = Math.floor(free / 2);
	const rightCount = free - leftCount;
	return (
		theme.style(corners[0]!, { fg: stops[0] }) +
		gradientRun(theme, stops, leftCount, 0, inner) +
		theme.style(text, { fg: stops[1], bold: true }) +
		gradientRun(theme, stops, rightCount, leftCount + labelW, inner) +
		theme.style(corners[1]!, { fg: stops[stops.length - 1] })
	);
}

function bar(theme: Theme, stops: readonly Color[], value: number, width: number): string {
	const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
	let out = "";
	for (let i = 0; i < filled; i++) {
		out += theme.style(GLYPH.barFull, { fg: ramp(stops, width <= 1 ? 0 : i / (width - 1)) });
	}
	return out + theme.fg("dim", GLYPH.barEmpty.repeat(Math.max(0, width - filled)));
}

/** One honest line when the terminal is too short for a panel. */
export function pastelBanner(theme: Theme, cwd: string, width: number): string {
	const vibe = getVibe();
	const tick = Math.floor(Date.now() / 400);
	const parts = [
		theme.fg("accent", miniFace(tick)),
		theme.fg("text", currentOutfit().name),
		theme.fg("dim", `· ${vibeShort()}`),
	];
	if (vibe.uwuMode) parts.push(theme.fg("warning", "· uwu transcript on"));
	parts.push(theme.fg("dim", `· ${homePath(cwd)}`));
	return truncateToWidth(parts.join(" "), Math.max(20, Math.floor(width)));
}

/**
 * The startup panel: chibi on the left, tips/loaded/recent-sessions on the
 * right; stacked when narrow; a single banner line when the terminal is too
 * short — a header that eats the screen is worse than no header.
 */
export function welcomePanel(width: number, theme: Theme, data: PanelData, availableRows: number): string[] {
	const vibe = getVibe();
	if (!vibe.pastelMode) return [pastelBanner(theme, data.cwd, width)];

	const w = Math.max(24, Math.min(width, 96));
	const inner = w - 2;
	const leftW = SPRITE_COLS + 2;
	const twoCol = inner >= leftW + 30;
	// side(1) + leftCell + sep(1) + rightCell + side(1) must equal w, so the two
	// cells together get inner - 1 columns.
	const leftCell = leftW;
	const rightCell = twoCol ? Math.max(8, inner - leftCell - 1) : inner;
	const rightW = Math.max(6, rightCell - 2);
	const stops = currentOutfit().palette.border as Swatch;
	const outfit = currentOutfit();

	const left: string[] = [
		centerIn(theme.fg("dim", `・˚ ${GLYPH.sparkle} ˚・`), leftW),
		...renderSprite(outfit, "idle", 0, [], theme),
		centerIn(theme.fg("muted", outfit.name), leftW),
		centerIn(bar(theme, stops, outfit.cuteness, Math.min(14, leftW)), leftW),
	];

	const rule = theme.fg("borderMuted", "─".repeat(rightW));
	const heading = (icon: string, title: string, token: Parameters<Theme["fg"]>[0]) =>
		`  ${theme.fg(token, `${icon} ${theme.bold(title)}`)}`;
	const right: string[] = [];
	right.push(centerIn(theme.fg("accent", GREETINGS[Math.floor(Date.now() / 60000) % GREETINGS.length]!), rightW));
	right.push("  " + theme.fg("dim", `mood: ${moodLabel(vibe.headpats)}`));
	right.push(rule);
	right.push(heading(GLYPH.caret, "Tips", "warning"));
	for (const [key, what] of KEY_TIPS) {
		right.push(`    ${theme.fg("dim", "[")}${theme.fg("text", pad(key, 12))}${theme.fg("dim", "]")} ${theme.fg("muted", what)}`);
	}
	right.push(rule);
	right.push(heading(GLYPH.ring, "Loaded", "success"));
	for (const [n, label] of [
		[data.counts.context, "context files"],
		[data.counts.extensions, "extensions"],
		[data.counts.skills, "skills"],
		[data.counts.prompts, "prompt templates"],
	] as [number, string][]) {
		right.push(`    ${theme.fg("success", `${GLYPH.dot} ${padLeft(String(n), 3)}`)}  ${theme.fg("muted", label)}`);
	}
	right.push(rule);
	right.push(heading(GLYPH.sparkle, `Recent sessions`, "accent"));
	if (data.sessions.length === 0) right.push(`    ${theme.fg("dim", "(none found)")}`);
	for (const session of data.sessions) {
		right.push(`    ${theme.fg("accent", GLYPH.heart)} ${lr(theme.fg("text", session.name), theme.fg("dim", session.ago), rightW - 6)}`);
	}
	right.push(rule);
	right.push(`  ${theme.fg("dim", `${basename(data.cwd)} · pi v${data.piVersion}`)}`);

	if (availableRows < 12) return [pastelBanner(theme, data.cwd, w)];

	// Reserve rows for the editor and the two bars.
	const maxRows = Math.max(6, Math.min(20, availableRows - 8));
	// Captions degrade with width: a clipped box is worse than a short one.
	const title = inner >= 26 ? ` ${GLYPH.heart} FEMBOY ${GLYPH.heart} ` : ` ${GLYPH.heart} `;
	const caption = inner >= 40 ? ` headpats are self-care ${GLYPH.heart} ` : inner >= 24 ? ` self-care ${GLYPH.heart} ` : ` ${GLYPH.heart} `;
	const out: string[] = [borderLine(theme, stops, "top", w, title)];
	const side = theme.style(GLYPH.side, { fg: ramp(stops, 0.5) });
	const sep = theme.style(GLYPH.thin, { fg: ramp(stops, 0.5) });

	const rows = Math.min(maxRows, twoCol ? Math.max(left.length, right.length) : left.length + right.length);
	for (let i = 0; i < rows; i++) {
		if (twoCol) {
			out.push(truncateToWidth(side + fit(` ${left[i] ?? ""}`, leftCell) + sep + fit(` ${right[i] ?? ""}`, rightCell) + side, w));
		} else {
			const stacked = i < left.length ? left[i]! : right[i - left.length] ?? "";
			out.push(truncateToWidth(side + fit(` ${stacked}`, inner) + side, w));
		}
	}
	out.push(borderLine(theme, stops, "bottom", w, caption));
	return out.map((line) => truncateToWidth(line, w));
}

// ---------------------------------------------------------------- status bar --

function statusBar(width: number, theme: Theme, ctx: ExtensionContext, footerData: any): string {
	const w = Math.max(24, width);
	const sep = theme.fg("borderMuted", ` ${GLYPH.dot} `);
	const tick = Math.floor(Date.now() / 400);
	const now = new Date();

	const face = theme.fg("accent", miniFace(tick));
	const provider = ctx.model?.provider ? theme.fg("dim", `${ctx.model.provider} `) : "";
	const model = theme.fg("accent", theme.bold(ctx.model?.name ?? ctx.model?.id ?? "no model"));
	const think = theme.fg("muted", thinkLabel(ctx.thinkingLevel ?? "off"));
	const path = theme.fg("success", homePath(ctx.cwd));
	const branch = theme.fg("muted", `${GLYPH.heart} ${footerData?.getGitBranch?.() ?? "no git"}`);
	const vibe = theme.fg("dim", vibeShort());
	const clock = theme.fg("dim", `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);

	// Progressive degradation, never a clipped tail: drop the least useful
	// segment first (path, then branch, then thinking level, then the vibe
	// summary) so the face, the model and the clock always survive.
	const leftVariants: string[][] = [
		[face, provider + model, think, path, branch],
		[face, provider + model, think, branch],
		[face, provider + model, branch],
		[face, provider + model],
		[face],
	];
	const rightVariants: string[] = [vibe + sep + clock, clock, ""];
	const joined = (parts: string[]) => parts.filter((part) => part !== "").join(sep);
	const fits = (parts: string[], right: string) => visibleWidth(joined(parts)) + 1 + visibleWidth(right) <= w;

	for (const right of rightVariants) {
		for (const parts of leftVariants) {
			if (fits(parts, right)) return lr(joined(parts), right, w);
			break;
		}
	}
	return truncateToWidth(lr(face, clock, w), w);
}

// --------------------------------------------------------------- metrics bar --

interface TokenStats {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

function sessionStats(ctx: ExtensionContext): TokenStats {
	const stats: TokenStats = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message: any = (entry as any).message;
		if (message?.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;
		stats.input += usage.input ?? 0;
		stats.output += usage.output ?? 0;
		stats.cacheRead += usage.cacheRead ?? 0;
		stats.cost += usage.cost?.total ?? 0;
	}
	return stats;
}

function metricsBar(width: number, theme: Theme, ctx: ExtensionContext, footerData: any): string {
	const w = Math.max(24, width);
	const stats = sessionStats(ctx);
	const usage = ctx.getContextUsage?.();
	const percent = usage?.percent == null ? null : Math.max(0, Math.min(100, Math.round(usage.percent)));
	const gaugeW = 8;
	const filled = percent == null ? 0 : Math.round((percent / 100) * gaugeW);
	const stops = currentOutfit().palette.border as Swatch;
	let gauge = "";
	for (let i = 0; i < gaugeW; i++) {
		gauge += theme.style(i < filled ? GLYPH.barFull : GLYPH.barEmpty, { fg: ramp(stops, i / (gaugeW - 1)) });
	}
	const cacheHit =
		stats.input + stats.cacheRead > 0
			? `${Math.round((stats.cacheRead / (stats.input + stats.cacheRead)) * 100)}%`
			: "—";
	const sep = theme.fg("borderMuted", ` ${GLYPH.dot} `);

	// Ordered most to least useful. A narrow terminal drops the tail segments
	// instead of clipping mid-token, which is what `lr()`/`truncateToWidth`
	// would silently do to a single long string.
	const parts = [
		gauge + " " + theme.fg("dim", percent == null ? "ctx ?" : `ctx ${percent}%`),
		theme.fg("muted", `${GLYPH.arrowUp} ${fmtTokens(stats.input)}`),
		theme.fg("muted", `${GLYPH.arrowDown} ${fmtTokens(stats.output)}`),
		theme.fg("warning", `$${stats.cost.toFixed(3)}`),
		theme.fg("accent", `${GLYPH.heart} ${getVibe().headpats} pats`),
		theme.fg("dim", `cache ${cacheHit}`),
	];

	// Our footer slot is blank, so a status set by another extension (usage,
	// balance, caches) would otherwise vanish. Relocate them here, last.
	const statuses: ReadonlyMap<string, string> | undefined = footerData?.getExtensionStatuses?.();
	if (statuses) {
		for (const [key, text] of statuses) {
			if (key === "femboy" || !text) continue;
			parts.push(theme.fg("dim", text.includes("\x1b[") ? text : `${key} ${text}`));
		}
	}
	while (parts.length > 1 && visibleWidth(parts.join(sep)) > w) parts.pop();
	return truncateToWidth(parts.join(sep), w);
}

// -------------------------------------------------------------- editor shell --

/**
 * Subclass pi's own default editor. Do NOT use getEditorComponent() to wrap the
 * current one: that API only exposes a *previously installed* custom editor, so
 * it is undefined by default and the shell would silently no-op.
 *
 * Installed exactly once per session. The ribbon reads `getVibe()` at render
 * time, so toggling it never rebuilds the editor and never loses your draft.
 *
 * Only the top border is redrawn, and only when nothing is scrolled away — the
 * scroll affordance (`↑ n more`) from super is information, not decoration.
 * Line widths must match `width` exactly or pi's cursor positioning breaks.
 */
export function makeFemboyEditor(CustomEditor: any): any {
	if (typeof CustomEditor !== "function") return null;
	return class FemboyEditor extends CustomEditor {
		renderTopBorder(width: number, hiddenLineCount: number): string {
			try {
				const vibe = getVibe();
				if (!vibe.pastelMode || !vibe.ribbonEditor || hiddenLineCount > 0 || width < 28) {
					return super.renderTopBorder(width, hiddenLineCount);
				}
				const border: (text: string) => string = (this as any).borderColor;
				const outfit = currentOutfit();
				const label = vibe.uwuMode ? `${outfit.name} · uwu ${GLYPH.heart}` : `${outfit.name} ${GLYPH.heart}`;
				const text = truncateToWidth(label, Math.max(1, width - 6));
				const block = ` ${text} `;
				const blockW = visibleWidth(block);
				if (blockW >= width) return border("─".repeat(width));
				const leftCount = Math.floor((width - blockW) / 2);
				return border("─".repeat(leftCount)) + block + border("─".repeat(width - blockW - leftCount));
			} catch (error) {
				// A ribbon that cannot draw is a ribbon pi should not have asked for.
				console.debug("[femboy] ribbon render failed:", error);
				try {
					return super.renderTopBorder(width, hiddenLineCount);
				} catch {
					return "─".repeat(Math.max(0, width));
				}
			}
		}
	};
}

// --------------------------------------------------------------------- loader --

export function loaderOptions(theme: Theme): { frames: string[]; intervalMs: number } {
	const vibe = getVibe();
	const stops: readonly Color[] = vibe.pastelMode ? currentOutfit().palette.border : themeStops(theme);
	const cycle = [GLYPH.heart, GLYPH.blossom, GLYPH.sparkle, GLYPH.flower, GLYPH.star, GLYPH.sparkle, GLYPH.blossom];
	return {
		frames: cycle.map((glyph, i) => theme.style(glyph, { fg: ramp(stops, i / (cycle.length - 1)) })),
		intervalMs: 130,
	};
}

function themeStops(theme: Theme): Color[] {
	const c = theme.colors;
	return [c.accent, c.border, c.borderAccent];
}

export function loaderMessage(): string {
	const vibe = getVibe();
	if (!vibe.pastelMode) return "thinking…";
	if (vibe.uwuMode) return "nyaa~ thinking weally hard uwu";
	if (vibe.headpats >= 100) return "thinking at maximum kawaii";
	if (vibe.headpats >= 25) return "thinking, purring a little";
	return `thinking ${GLYPH.heart}`;
}

// -------------------------------------------------------------------- install --

export interface ChromeHandle {
	/** Re-decide every slot from the current vibe (cheap and idempotent). */
	refresh(): void;
	/** Ask the bars to repaint without touching any slot. */
	repaint(): void;
	/** The docked chibi pops hearts and grins (headpat feedback). */
	celebrate(): void;
	dispose(): void;
}

/**
 * Own the chrome for this session following `getVibe()`. index.ts refreshes the
 * handle on vibe changes and disposes it on shutdown.
 */
export function installChrome(ctx: ExtensionContext, data: PanelData): ChromeHandle {
	if (ctx.mode !== "tui") {
		return { refresh: () => {}, repaint: () => {}, celebrate: () => {}, dispose: () => {} };
	}

	const ui = ctx.ui;
	const companion = new CompanionController();
	let statusTui: TUI | undefined;
	let footerData: any = null;
	let stopBranchWatch: (() => void) | undefined;
	let installedKey: string | undefined;
	let disposed = false;

	const restoreBuiltins = () => {
		companion.close();
		ui.setHeader(undefined);
		ui.setWidget("femboy", undefined);
		ui.setWidget("femboy-metrics", undefined);
		ui.setFooter(undefined);
		ui.setStatus("femboy", undefined);
		ui.setWorkingIndicator();
		ui.setWorkingMessage();
		stopBranchWatch?.();
		stopBranchWatch = undefined;
		footerData = null;
	};

	const install = () => {
		if (disposed) return;
		const vibe = getVibe();
		const key = `${vibe.pastelMode}|${vibe.welcome}|${vibe.companion}`;
		if (key === installedKey) return;
		installedKey = key;

		try {
			if (!vibe.pastelMode) {
				restoreBuiltins();
				return;
			}

			// Welcome panel: persistent header · one-shot floating overlay · none.
			if (vibe.welcome === "header") {
				ui.setHeader((_tui, theme) => panelComponent(theme, data, _tui));
			} else {
				ui.setHeader(undefined);
				if (vibe.welcome === "overlay") void showWelcomeOverlay(ctx, data);
			}

			ui.setWidget("femboy", (tui, theme) => {
				statusTui = tui;
				return barComponent((width) => statusBar(width, theme, ctx, footerData));
			});
			ui.setWidget(
				"femboy-metrics",
				(_tui, theme) => barComponent((width) => metricsBar(width, theme, ctx, footerData)),
				{ placement: "belowEditor" },
			);

			// Blank footer, but keep the slot: it is the only route to footerData
			// (git branch + extension statuses) and to branch-change events.
			ui.setFooter((tui, _theme, provided) => {
				footerData = provided;
				stopBranchWatch?.();
				stopBranchWatch = provided.onBranchChange(() => tui.requestRender());
				return {
					dispose: () => {
						stopBranchWatch?.();
						stopBranchWatch = undefined;
					},
					invalidate() {},
					render: () => [],
				};
			});

			ui.setWorkingIndicator(loaderOptions(ui.theme));
			ui.setWorkingMessage(loaderMessage());
			companion.sync(ctx);
		} catch (error) {
			console.debug("[femboy] chrome install failed:", error);
		}
	};

	install();
	const unsubscribe = onVibeChange(() => {
		install();
		statusTui?.requestRender();
	});

	return {
		refresh: () => {
			installedKey = undefined;
			install();
			statusTui?.requestRender();
		},
		repaint: () => statusTui?.requestRender(),
		celebrate: () => companion.celebrate(),
		dispose: () => {
			disposed = true;
			unsubscribe();
			companion.close();
			stopBranchWatch?.();
			stopBranchWatch = undefined;
		},
	};
}

// ---------------------------------------------------------------- components --

function panelComponent(theme: Theme, data: PanelData, tui: TUI): Component {
	let cached: { key: string; lines: string[] } | undefined;
	return {
		invalidate() {
			cached = undefined;
		},
		render(width: number): string[] {
			try {
				const rows = tui.terminal?.rows ?? 32;
				const vibe = getVibe();
				const key = `${width}|${rows}|${vibe.outfit}|${vibe.pastelMode}|${vibe.uwuMode}|${data.sessions.length}`;
				if (cached?.key === key) return cached.lines;
				const lines = welcomePanel(width, theme, data, rows);
				cached = { key, lines };
				return lines;
			} catch (error) {
				// A header that cannot draw must not take the session with it.
				console.debug("[femboy] welcome panel failed:", error);
				cached = undefined;
				return [truncateToWidth(`${GLYPH.heart} pastel header hiccuped`, Math.max(20, width))];
			}
		},
	};
}

function barComponent(draw: (width: number) => string): Component {
	return {
		invalidate() {},
		render: (width: number) => {
			try {
				return [draw(width)];
			} catch (error) {
				// The bars read live session data (model, usage, git): a stale
				// context must cost a bar, not the whole session.
				console.debug("[femboy] bar render failed:", error);
				return [truncateToWidth(`${GLYPH.heart} pastel bar hiccuped`, Math.max(20, width))];
			}
		},
	};
}

/**
 * Internal components, exported only so the offline harness can inject faults
 * and prove the chrome fails soft. Nothing in pi's extension API reads this.
 */
export const __testing = { barComponent, panelComponent };

/**
 * One-shot floating welcome overlay: fire-and-forget, any keypress closes it,
 * the session keeps loading underneath.
 */
async function showWelcomeOverlay(ctx: ExtensionContext, data: PanelData): Promise<void> {
	try {
		await ctx.ui.custom<boolean>(
			(tui, theme, _kb, done) => {
				let closed = false;
				return {
					render: (width: number) => welcomePanel(width, theme, data, tui.terminal?.rows ?? 24),
					invalidate() {},
					handleInput: (input: string) => {
						if (closed || !input) return;
						closed = true;
						done(true);
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center" } },
		);
	} catch (error) {
		console.debug("[femboy] welcome overlay failed:", error);
	}
}
