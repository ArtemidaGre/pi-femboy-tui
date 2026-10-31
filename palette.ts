/**
 * palette.ts — pastel colour vocabulary, gradient helpers, and the glyph set.
 *
 * Two kinds of colour are in play:
 *
 * - **Outfit palettes** are fixed truecolor (`okhslColor`) because a chibi's
 *   hair must stay pink no matter which theme the user picked. They are drawn
 *   through `theme.style(text, { fg })`, which accepts a raw `Color`.
 * - **Chrome colours** (borders, status bar, tool rows) come from theme tokens
 *   via `theme.colors[token]`, so the chrome follows whatever theme is active —
 *   `femboy.json` when it is on, and a sane pastel-ish result on any other.
 *
 * No Nerd Font: every glyph here is ordinary Unicode (Dingbats / geometric /
 * box drawing), so the chrome renders on stock terminal fonts.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, mixColors, okhslColor } from "@earendil-works/pi-tui";

export const okhsl = (h: number, s: number, l: number): Color => okhslColor(h, s, l);

// -- fixed pastel truecolors (outfit palettes) -------------------------------

export const PINK = okhsl(350, 0.72, 0.76);
export const ROSE = okhsl(6, 0.62, 0.72);
export const LILAC = okhsl(300, 0.48, 0.76);
export const SKY = okhsl(232, 0.6, 0.76);
export const MINT = okhsl(162, 0.46, 0.74);
export const CREAM = okhsl(80, 0.45, 0.9);
export const COCOA = okhsl(30, 0.3, 0.62);
export const PLUM = okhsl(310, 0.28, 0.34);
export const NAVY = okhsl(268, 0.34, 0.36);
export const SNOW = okhsl(300, 0.35, 0.95);
export const INK = okhsl(280, 0.2, 0.24);
export const SKIN = okhsl(30, 0.5, 0.86);

/** A three-stop ramp, left → right, used for box borders and meters. */
export type Swatch = readonly [Color, Color, Color];

/**
 * A swatch derived from the active theme, so chrome never fights the theme.
 * Falls back to the house pastel trio if a token resolves oddly.
 */
export function themeSwatch(theme: Theme): Swatch {
	const c = theme.colors;
	return [c.accent, c.border, c.borderAccent];
}

/** Interpolate across an arbitrary number of colour stops (t in 0..1). */
export function ramp(stops: readonly Color[], t: number): Color {
	if (stops.length === 1) return stops[0]!;
	const scaled = Math.max(0, Math.min(1, t)) * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(scaled));
	return mixColors(stops[i]!, stops[i + 1]!, scaled - i);
}

/** `count` copies of `glyph`, coloured along `stops` from `start` to `start+count`. */
export function gradientRun(
	theme: Theme,
	stops: readonly Color[],
	count: number,
	start: number,
	total: number,
	glyph = "─",
): string {
	let out = "";
	for (let i = 0; i < count; i++) {
		out += theme.style(glyph, { fg: ramp(stops, total <= 1 ? 0 : (start + i) / (total - 1)) });
	}
	return out;
}

/**
 * A horizontal rule that carries a label in the middle:
 * `────── label ──────`, exactly `width` cells wide.
 */
export function labeledRule(theme: Theme, stops: readonly Color[], width: number, label: string): string {
	const w = Math.max(1, Math.floor(width));
	const labelW = Math.min(w - 2, label.length);
	const free = Math.max(0, w - labelW);
	const left = Math.floor(free / 2);
	if (labelW <= 0) return gradientRun(theme, stops, w, 0, w);
	return (
		gradientRun(theme, stops, left, 0, w) +
		theme.style(label, { fg: ramp(stops, 0.5), bold: true }) +
		gradientRun(theme, stops, w - left - labelW, left + labelW, w)
	);
}

/** Glyph set — ordinary Unicode only, one cell each (except the multi-cell faces). */
export const GLYPH = {
	heart: "♡",
	heartFull: "♥",
	blossom: "✿",
	flower: "❀",
	sparkle: "✧",
	star: "✦",
	dot: "·",
	bullet: "•",
	ring: "○",
	fill: "●",
	cross: "✗",
	check: "✓",
	tree: "└",
	caret: "❯",
	arrowUp: "↑",
	arrowDown: "↓",
	barFull: "▓",
	barEmpty: "░",
	heavy: "━",
	side: "│",
	thin: "┊",
	blushFace: "ω",
	wing: "˗ˏˋ",
	wingEnd: "ˎˊ˗",
} as const;

export const SPARKLE_GLYPHS = ["✦", "✧", "*", "·"] as const;

/** Loader frames: a blossom blooming and drifting, tinted along the swatch. */
export function sparkleFrames(theme: Theme, stops: readonly Color[]): string[] {
	const cycle = [GLYPH.heart, GLYPH.blossom, GLYPH.sparkle, GLYPH.flower, GLYPH.star, GLYPH.sparkle, GLYPH.blossom];
	return cycle.map((glyph, i) => theme.style(glyph, { fg: ramp(stops, i / (cycle.length - 1)) }));
}
