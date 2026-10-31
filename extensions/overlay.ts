/**
 * overlay.ts — the interactive closet (`/femboy`, `ctrl+alt+f`).
 *
 * A focus-stealing `ctx.ui.custom()` overlay: animated chibi on the left
 * (blinking, drifting sparkles, rising hearts on headpats) and a vibe-check
 * menu on the right. It is the only *animated* part of the extension — the
 * chrome deliberately runs no timers, so an idle session costs zero repaints.
 *
 * The component owns no state beyond presentation: every mutation goes through
 * `patchVibe()`, which persists to the session and notifies chrome listeners.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type Component,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { GLYPH, type Swatch, ramp } from "./palette";
import { type Expression, type Heart, OUTFITS, SPRITE_COLS, renderSprite } from "./sprites";
import type { VibeState, WelcomeMode } from "./vibe";
import { currentOutfit, getVibe, moodLabel, patchVibe } from "./vibe";

type ActionId = "headpat" | "uwu" | "pastel" | "rows" | "ribbon" | "companion" | "welcome" | "reset" | "close";

type Item =
	| { kind: "outfit"; index: number; label: string; detail: string }
	| { kind: "action"; action: ActionId; label: string; detail: string };

const TICKER = [
	"nyaa~ ♡",
	"uwu",
	"skirt check: complete",
	"pastel > everything",
	"headpats are self-care",
	"you did good :3",
	"pleats matter",
];

const TIPS = [
	"tip: /uwu <text> rewrites your draft into uwu",
	"tip: ctrl+alt+f opens this closet from anywhere",
	"tip: the model can hand you headpats via femboy_vibe",
	"tip: /femboy welcome header|overlay|off moves the panel",
	"tip: uwu rendering never changes what the model reads",
];

const WELCOME_NEXT: Record<WelcomeMode, WelcomeMode> = { header: "overlay", overlay: "off", off: "header" };

export class FemboyOverlay implements Component {
	private tick = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private cursor = 0;
	private hearts: Heart[] = [];
	private happyUntil = -1;
	private note = "welcome to the closet ♡";
	private borderCache = new Map<string, string>();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
	) {
		this.interval = setInterval(() => {
			// Cosmetic animation: guard it, never hold the session hostage.
			try {
				this.tick++;
				this.stepHearts();
				this.tui.requestRender();
			} catch (error) {
				console.debug("[femboy] closet tick failed:", error);
			}
		}, 120);
		// Never hold the event loop open for a cosmetic animation.
		this.interval.unref?.();
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
	}

	invalidate(): void {
		this.borderCache.clear();
	}

	handleInput(data: string): void {
		try {
			const items = this.items();
			if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
				this.cursor = (this.cursor - 1 + items.length) % items.length;
			} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
				this.cursor = (this.cursor + 1) % items.length;
			} else if (matchesKey(data, "home")) {
				this.cursor = 0;
			} else if (matchesKey(data, "end")) {
				this.cursor = items.length - 1;
			} else if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space")) {
				this.activate(items[this.cursor]);
			} else if (matchesKey(data, "h")) {
				this.pat();
			} else if (matchesKey(data, "u")) {
				this.toggle("uwu");
			} else if (matchesKey(data, "p")) {
				this.toggle("pastel");
			} else if (matchesKey(data, "w")) {
				this.cycleWelcome();
			} else if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
				this.finish();
				return;
			} else {
				return;
			}
			this.tui.requestRender();
		} catch (error) {
			// A dead closet must never jam the terminal's input pump: log, say so,
			// and hand the keys back to pi.
			console.debug("[femboy] closet input failed:", error);
			this.note = `oops, the closet hiccuped · ${String(error).slice(0, 40)}`;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		try {
			const safeWidth = Math.max(24, Math.floor(width));
			const inner = safeWidth - 2;
			const twoCol = inner >= 46;
			const leftW = twoCol ? Math.min(SPRITE_COLS + 2, Math.max(SPRITE_COLS, Math.floor(inner * 0.5))) : inner;
			const rightW = twoCol ? inner - leftW - 1 : inner;
			const maxHeight = Math.max(12, (this.tui.terminal?.rows ?? 32) - 8);

			const stops = currentOutfit().palette.border as Swatch;
			// In the stacked layout the menu has to survive, so the chibi trims first.
			const leftBudget = twoCol ? maxHeight : Math.max(6, maxHeight - 9);
			const left = this.leftPanel(leftW, leftBudget);
			const right = this.rightPanel(rightW, twoCol ? maxHeight : Math.max(6, maxHeight - left.length));

			const body: string[] = [];
			if (twoCol) {
				const rows = Math.min(maxHeight, Math.max(left.length, right.length));
				const side = this.theme.style(GLYPH.side, { fg: ramp(stops, 0.5) });
				const sep = this.theme.style(GLYPH.thin, { fg: ramp(stops, 0.5) });
				for (let i = 0; i < rows; i++) {
					const cell =
						side +
						truncateToWidth(left[i] ?? "", leftW, "", true) +
						sep +
						truncateToWidth(right[i] ?? "", rightW, "", true) +
						side;
					body.push(truncateToWidth(cell, safeWidth));
				}
			} else {
				const stacked = [...left, ...right];
				const rows = Math.min(maxHeight, stacked.length);
				const edge = this.theme.style(GLYPH.side, { fg: ramp(stops, 0.5) });
				for (let i = 0; i < rows; i++) {
					body.push(truncateToWidth(edge + truncateToWidth(stacked[i] ?? "", inner, "", true) + edge, safeWidth));
				}
			}

			const title = ` ${GLYPH.heart} FEMBOY TUI ${GLYPH.heart} `;
			const ticker = `${this.note} · ${TICKER[Math.floor(this.tick / 30) % TICKER.length]}`;
			return [
				this.borderLine("top", safeWidth, title, stops[1]),
				...body,
				this.borderLine("bottom", safeWidth, truncateToWidth(ticker, Math.max(4, inner - 6)), stops[2]),
			].map((line) => truncateToWidth(line, safeWidth));
		} catch (error) {
			console.debug("[femboy] closet render failed:", error);
			return [truncateToWidth(`${GLYPH.heart} the closet hiccuped · q closes me`, Math.max(24, Math.floor(width)))];
		}
	}

	// -- state ----------------------------------------------------------------

	private items(): Item[] {
		const snapshot = getVibe();
		const list: Item[] = OUTFITS.map((outfit, index) => ({
			kind: "outfit" as const,
			index,
			label: outfit.name,
			detail: outfit.vibe,
		}));
		list.push(
			{
				kind: "action",
				action: "headpat",
				label: `headpat × ${snapshot.headpats}`,
				detail: `mood: ${moodLabel(snapshot.headpats)} · enter or h`,
			},
			{
				kind: "action",
				action: "uwu",
				label: `uwu transcript: ${snapshot.uwuMode ? "on" : "off"}`,
				detail: "rewrites chat text into uwu-speak (display only, code stays safe)",
			},
			{
				kind: "action",
				action: "pastel",
				label: `pastel chrome: ${snapshot.pastelMode ? "on" : "off"}`,
				detail: "welcome panel, status bar, metrics bar, tool rows, editor ribbon, loader",
			},
			{
				kind: "action",
				action: "rows",
				label: `pastel tool rows: ${snapshot.toolRows ? "on" : "off"}`,
				detail: "✿ Name [args] 42ms / └ summary, composed with pi's own expand view",
			},
			{
				kind: "action",
				action: "ribbon",
				label: `editor ribbon: ${snapshot.ribbonEditor ? "on" : "off"}`,
				detail: "outfit + uwu state drawn on the editor's top border",
			},
			{
				kind: "action",
				action: "companion",
				label: `chibi companion dock: ${snapshot.companion ? "on" : "off"}`,
				detail: "the little one living on the right side of the TUI (needs a wide terminal)",
			},
			{
				kind: "action",
				action: "welcome",
				label: `welcome panel: ${snapshot.welcome}`,
				detail: "cycle header · overlay · off (w)",
			},
			{
				kind: "action",
				action: "reset",
				label: "reset vibe",
				detail: "back to defaults, headpats forgotten",
			},
			{
				kind: "action",
				action: "close",
				label: `close ${GLYPH.heart}`,
				detail: "esc or q",
			},
		);
		return list;
	}

	private expression(): Expression {
		if (this.tick < this.happyUntil) return getVibe().headpats >= 50 ? "love" : "happy";
		return this.tick % 26 < 2 ? "blink" : "idle";
	}

	private stepHearts(): void {
		if (this.hearts.length === 0) return;
		this.hearts = this.hearts
			.map((heart) => ({ ...heart, row: heart.row - 1, ttl: heart.ttl - 1 }))
			.filter((heart) => heart.ttl > 0 && heart.row >= -1);
	}

	private burstHearts(): void {
		const cols = [2, 6, 10, 13];
		this.hearts = cols.slice(0, 3 + (this.tick % 2)).map((col, i) => ({
			col: (col + (this.tick % 3)) % SPRITE_COLS,
			row: 9 + i,
			ttl: 12 - i,
		}));
	}

	private pat(): void {
		const next = getVibe().headpats + 1;
		patchVibe({ headpats: next });
		this.happyUntil = this.tick + 24;
		this.burstHearts();
		this.note =
			next >= 100
				? "transcendence: pure pastel uwu"
				: next % 10 === 0
					? `${next} headpats, ${moodLabel(next)}`
					: "nyaa~ again please";
	}

	private toggle(id: "uwu" | "pastel" | "rows" | "ribbon" | "companion"): void {
		const keyMap = {
			uwu: "uwuMode",
			pastel: "pastelMode",
			rows: "toolRows",
			ribbon: "ribbonEditor",
			companion: "companion",
		} as const;
		const key = keyMap[id];
		const snapshot = getVibe();
		patchVibe({ [key]: !snapshot[key] } as Partial<VibeState>);
		this.note = `${id} ${snapshot[key] ? "off" : "on"}`;
		if (id === "pastel") this.invalidate();
	}

	private cycleWelcome(): void {
		const next = WELCOME_NEXT[getVibe().welcome];
		patchVibe({ welcome: next });
		this.note = `welcome panel → ${next}`;
	}

	private activate(item: Item | undefined): void {
		if (!item) return;
		if (item.kind === "outfit") {
			patchVibe({ outfit: item.index });
			this.note = `now wearing ${OUTFITS[item.index]!.name} ${GLYPH.heart}`;
			this.happyUntil = this.tick + 14;
			this.invalidate();
			return;
		}
		switch (item.action) {
			case "headpat":
				this.pat();
				break;
			case "uwu":
			case "pastel":
			case "rows":
			case "ribbon":
			case "companion":
				this.toggle(item.action);
				break;
			case "welcome":
				this.cycleWelcome();
				break;
			case "reset":
				patchVibe({ headpats: 0, outfit: 0 });
				this.note = "fresh start :3";
				this.invalidate();
				break;
			case "close":
				this.finish();
				break;
		}
	}

	private finish(): void {
		this.dispose();
		this.done();
	}

	// -- painting -------------------------------------------------------------

	private gradientRun(count: number, start: number, total: number): string {
		const stops = currentOutfit().palette.border as Swatch;
		let out = "";
		for (let i = 0; i < count; i++) {
			out += this.theme.style("─", { fg: ramp(stops, total <= 1 ? 0 : (start + i) / (total - 1)) });
		}
		return out;
	}

	private borderLine(edge: "top" | "bottom", width: number, label: string, color: Color): string {
		const inner = Math.max(1, width - 2);
		const key = `${edge}|${width}|${label}`;
		const cached = this.borderCache.get(key);
		if (cached) return cached;

		const labelWidth = visibleWidth(label);
		const free = Math.max(0, inner - labelWidth);
		const left = Math.floor(free / 2);
		const stops = currentOutfit().palette.border as Swatch;
		const corners = edge === "top" ? ["╭", "╮"] : ["╰", "╯"];
		const line =
			this.theme.style(corners[0]!, { fg: stops[0] }) +
			this.gradientRun(left, 0, inner) +
			this.theme.style(label, { fg: color, bold: true }) +
			this.gradientRun(free - left, left + labelWidth, inner) +
			this.theme.style(corners[1]!, { fg: stops[2] });
		this.borderCache.set(key, line);
		return line;
	}

	private bar(value: number, width: number): string {
		const stops = currentOutfit().palette.border as Swatch;
		const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
		let out = "";
		for (let i = 0; i < filled; i++) {
			out += this.theme.style(GLYPH.barFull, { fg: ramp(stops, width <= 1 ? 0 : i / (width - 1)) });
		}
		return out + this.theme.fg("dim", GLYPH.barEmpty.repeat(Math.max(0, width - filled)));
	}

	private center(text: string, width: number): string {
		const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
		return " ".repeat(pad) + truncateToWidth(text, Math.max(1, width - pad));
	}

	private leftPanel(width: number, available: number): string[] {
		const outfit = currentOutfit();
		const caption = this.center(this.theme.fg("muted", outfit.name), width);
		const meter = this.center(this.bar(outfit.cuteness, Math.max(6, Math.min(14, width - 4))), width);
		const lines: string[] = [
			this.center(this.theme.fg("dim", `・˚ ${GLYPH.sparkle} ˚・`), width),
			...renderSprite(outfit, this.expression(), this.tick, this.hearts, this.theme),
			caption,
			meter,
		];
		return lines.slice(0, Math.max(4, available));
	}

	private rightPanel(width: number, available: number): string[] {
		const items = this.items();
		const header = this.center(this.theme.fg("accent", `${GLYPH.heart} vibe check ${GLYPH.heart}`), width);
		const rule = this.theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const hint = this.theme.fg("dim", "↑↓ pick · enter do · h pat · u uwu · p pastel · w welcome · q close");
		const snapshot = getVibe();
		const stats = this.theme.fg("dim", `headpats ${snapshot.headpats} · mood ${moodLabel(snapshot.headpats)}`);
		const detail = this.theme.fg("muted", this.theme.italic(items[this.cursor]?.detail ?? ""));
		const tip = this.theme.fg("dim", TIPS[Math.floor(this.tick / 24) % TIPS.length] ?? "");

		// Reserve room for header, rule, detail, stats, tip, hint; keep the cursor visible.
		const reserved = 6;
		const budget = Math.max(1, Math.min(items.length, available - reserved));
		let start = 0;
		if (items.length > budget) start = Math.max(0, Math.min(this.cursor - budget + 1, items.length - budget));

		const rows: string[] = [header, rule];
		const worn = snapshot.outfit;
		for (let i = start; i < Math.min(items.length, start + budget); i++) {
			const item = items[i]!;
			const selected = i === this.cursor;
			const marker = selected ? this.theme.fg("accent", "▸") : this.theme.fg("dim", "·");
			const badge =
				item.kind === "outfit" && item.index === worn
					? this.theme.fg("success", GLYPH.blossom)
					: this.theme.fg("borderMuted", " ");
			const label = this.theme.fg(selected ? "accent" : "text", item.label);
			rows.push(truncateToWidth(`${marker}${badge} ${label}`, width));
		}
		rows.push(
			` ${truncateToWidth(detail, Math.max(1, width - 1))}`,
			` ${truncateToWidth(stats, Math.max(1, width - 1))}`,
			` ${truncateToWidth(tip, Math.max(1, width - 1))}`,
			` ${truncateToWidth(hint, Math.max(1, width - 1))}`,
		);
		return rows.slice(0, Math.max(4, available));
	}
}

