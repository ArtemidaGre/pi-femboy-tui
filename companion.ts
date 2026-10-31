/**
 * companion.ts — the chibi that lives on the right side of the TUI.
 *
 * A *persistent, non-capturing* overlay: `ctx.ui.custom({ overlay: true })`
 * with `nonCapturing: true`, so the editor keeps every keystroke while the
 * chibi waves, blinks and catches hearts in the margin. The custom() promise
 * simply stays pending until `close()` calls `done()` — which is also how pi
 * tears the overlay down and disposes the component.
 *
 * Placement rules:
 * - anchored `top-right`, one cell of margin, width = sprite + border + padding
 * - `visible()` hides it on cramped terminals (< 96 cols or < 24 rows) so the
 *   chibi never eats the transcript on a laptop screen — resize and it returns
 * - the only *timer-owning* part of the chrome besides the closet: one 250 ms
 *   interval, `unref`'d, alive only while the overlay is open
 *
 * The component owns no vibe state. It reads `getVibe()` at render time and
 * reacts to headpats through `celebrate()`; every mutation still goes through
 * `patchVibe()` in vibe.ts. The theme from the factory is a live proxy, so
 * colours follow theme switches without a rebuild.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type Component,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { GLYPH, type Swatch, ramp } from "./palette";
import { type Expression, type Heart, SPRITE_COLS, renderSprite } from "./sprites";
import { currentOutfit, getVibe } from "./vibe";

/** Sprite + 1-cell padding per side + 1-cell border per side. */
const BOX_COLS = SPRITE_COLS + 4;

/** Only show the chibi when the terminal has room to spare. */
function roomy(termWidth: number, termHeight: number): boolean {
	return termWidth >= BOX_COLS + 70 && termHeight >= 24;
}

const center = (text: string, width: number): string => {
	const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
	return " ".repeat(pad) + text + " ".repeat(Math.max(0, width - pad - visibleWidth(text)));
};

/** `text` + trailing spaces, clipped to exactly `n` cells. */
const padTo = (text: string, n: number): string => truncateToWidth(text + " ".repeat(Math.max(0, n - visibleWidth(text))), n);

// ------------------------------------------------------------------ component --

export class ChibiCompanion implements Component {
	private tick = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private hearts: Heart[] = [];
	private happyUntil = -1;
	private lastPats: number | undefined;

	constructor(
		private tui: TUI,
		private theme: Theme,
	) {
		this.interval = setInterval(() => {
			this.tick++;
			this.stepHearts();
			this.tui.requestRender();
		}, 250);
		// Never hold the event loop open for a cosmetic animation.
		this.interval.unref?.();
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
	}

	invalidate(): void {
		// Everything is recomputed per frame; nothing to drop.
	}

	/** Headpats make the chibi pop hearts and grin for a few ticks. */
	celebrate(): void {
		this.happyUntil = this.tick + 20;
		const cols = [2, 6, 10, 13];
		this.hearts = cols.slice(0, 3 + (this.tick % 2)).map((col, i) => ({
			col: (col + (this.tick % 3)) % SPRITE_COLS,
			row: 9 + i,
			ttl: 12 - i,
		}));
	}

	private stepHearts(): void {
		if (this.hearts.length === 0) return;
		this.hearts = this.hearts
			.map((heart) => ({ ...heart, row: heart.row - 1, ttl: heart.ttl - 1 }))
			.filter((heart) => heart.ttl > 0 && heart.row >= -1);
	}

	private expression(): Expression {
		if (this.tick < this.happyUntil) return getVibe().headpats >= 50 ? "love" : "happy";
		return this.tick % 26 < 2 ? "blink" : "idle";
	}

	render(width: number): string[] {
		const theme = this.theme;
		const w = Math.min(Math.max(BOX_COLS, width), BOX_COLS);
		const inner = w - 2;
		const outfit = currentOutfit();
		const vibe = getVibe();
		// Any headpat source (command, tool, closet menu) makes the chibi pop —
		// the counter going up is the event, so no extra wiring is needed.
		if (this.lastPats !== undefined && vibe.headpats > this.lastPats) this.celebrate();
		this.lastPats = vibe.headpats;
		const side = theme.style(GLYPH.side, { fg: ramp(outfit.palette.border as Swatch, 0.5) });

		const lines: string[] = [this.border("top")];
		for (const row of renderSprite(outfit, this.expression(), this.tick, this.hearts, theme)) {
			lines.push(side + padTo(` ${row}`, inner) + side);
		}
		lines.push(side + center(truncateToWidth(theme.fg("muted", outfit.name), inner), inner) + side);
		lines.push(side + center(truncateToWidth(theme.fg("dim", `${GLYPH.heart} ${vibe.headpats}`), inner), inner) + side);
		lines.push(this.border("bottom"));
		return lines.map((line) => truncateToWidth(line, w));
	}

	/** Exactly BOX_COLS cells: corner, gradient run, `label`, gradient run, corner. */
	private border(edge: "top" | "bottom"): string {
		const theme = this.theme;
		const stops = currentOutfit().palette.border as Swatch;
		const corners = edge === "top" ? ["╭", "╮"] : ["╰", "╯"];
		const label = edge === "top" ? ` ${GLYPH.sparkle} ` : ` ${GLYPH.heart} `;
		const run = BOX_COLS - 2 - visibleWidth(label);
		const leftCount = Math.floor(run / 2);
		const cells = (count: number, start: number): string => {
			let out = "";
			for (let i = 0; i < count; i++) {
				out += theme.style("─", { fg: ramp(stops, (start + i) / (BOX_COLS - 3)) });
			}
			return out;
		};
		return (
			theme.style(corners[0]!, { fg: stops[0] as Color }) +
			cells(leftCount, 0) +
			theme.style(label, { fg: stops[1] as Color }) +
			cells(run - leftCount, leftCount + visibleWidth(label)) +
			theme.style(corners[1]!, { fg: stops[2] as Color })
		);
	}
}

// ----------------------------------------------------------------- controller --

/**
 * Owns at most one companion overlay per session. `sync()` opens or closes to
 * match the vibe; it is idempotent, so chrome can call it on every install.
 */
export class CompanionController {
	private done: (() => void) | undefined;
	private component: ChibiCompanion | undefined;
	private handle: OverlayHandle | undefined;
	private pending = false;

	get isOpen(): boolean {
		return this.component !== undefined || this.pending;
	}

	sync(ctx: ExtensionContext): void {
		const vibe = getVibe();
		const wants = vibe.pastelMode && vibe.companion && ctx.mode === "tui";
		if (wants) this.open(ctx);
		else this.close();
	}

	open(ctx: ExtensionContext): void {
		if (this.isOpen || ctx.mode !== "tui") return;
		this.pending = true;
		void ctx.ui
			.custom<void>(
				(tui, theme, _kb, done) => {
					this.pending = false;
					this.done = () => done();
					this.component = new ChibiCompanion(tui, theme);
					return this.component;
				},
				{
					overlay: true,
					overlayOptions: {
						width: BOX_COLS,
						minWidth: BOX_COLS,
						anchor: "top-right",
						margin: { top: 1, right: 1 },
						nonCapturing: true,
						visible: roomy,
					},
					onHandle: (handle) => {
						this.handle = handle;
					},
				},
			)
			.catch((error) => console.debug("[femboy] companion overlay failed:", error))
			.finally(() => {
				this.pending = false;
				this.done = undefined;
				this.component = undefined;
				this.handle = undefined;
			});
	}

	close(): void {
		const done = this.done;
		this.done = undefined;
		if (done) done();
		else this.handle?.hide();
		this.handle = undefined;
	}

	/** Headpat reaction — no-op when the chibi is not on screen. */
	celebrate(): void {
		this.component?.celebrate();
	}
}
