/**
 * sprites.ts — the chibi. Pixel art as glyph grids, one character per cell,
 * painted with the outfit's truecolor palette.
 *
 * A grid row is exactly `SPRITE_COLS` characters; `.` means "empty cell", which
 * is where sparkles and hearts are allowed to land so the silhouette is never
 * eaten by decoration.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, truncateToWidth } from "@earendil-works/pi-tui";
import { COCOA, CREAM, GLYPH, INK, LILAC, MINT, NAVY, PINK, PLUM, ROSE, SKIN, SKY, SNOW, okhsl } from "./palette";

export const SPRITE_COLS = 16;

export interface Palette {
	hair: Color;
	hairLight: Color;
	skin: Color;
	eye: Color;
	blush: Color;
	mouth: Color;
	cloth: Color;
	clothDark: Color;
	garment: Color;
	trim: Color;
	shoe: Color;
	sparkle: Color;
	/** Left-to-right border ramp for this outfit's chrome. */
	border: readonly [Color, Color, Color];
}

export interface Outfit {
	name: string;
	vibe: string;
	cuteness: number;
	palette: Palette;
	body: readonly string[];
}

/**
 * Legend: `.` empty · `H` hair · `h` hair shine · `S` skin · `E` eye · `B` blush
 * · `M` mouth · `C` cloth · `D` dark trim · `K` garment · `W` white trim · `P` shoe
 */
const HEAD: readonly string[] = [
	"...HH......HH...",
	"..HHH......HHH..",
	".HHHHHHHHHHHHHH.",
	"HHhhHHHHHHhhHHHH",
	"HSSBESSSSSSEBSSH",
	"HSSSSSSMMSSSSSSH",
	".HHSSSSSSSSSSHH.",
	"....HHSSSSHH....",
];

const CLASS_COLOR: Readonly<Record<string, Exclude<keyof Palette, "border">>> = {
	H: "hair",
	h: "hairLight",
	S: "skin",
	E: "eye",
	B: "blush",
	M: "mouth",
	C: "cloth",
	D: "clothDark",
	K: "garment",
	W: "trim",
	P: "shoe",
};

const EYE_ROW = 4;
const MOUTH_ROW = 5;

export type Expression = "idle" | "blink" | "happy" | "love";

const FACE: Readonly<Record<Expression, { eye: string; mouth: string }>> = {
	idle: { eye: "●", mouth: GLYPH.blushFace },
	blink: { eye: "─", mouth: GLYPH.blushFace },
	happy: { eye: "^", mouth: GLYPH.blushFace },
	love: { eye: GLYPH.heart, mouth: GLYPH.blushFace },
};

export const OUTFITS: readonly Outfit[] = [
	{
		name: "Pastel Sailor",
		vibe: "sailor collar, pleated skirt, adorkable errands run",
		cuteness: 88,
		palette: {
			hair: PINK,
			hairLight: ROSE,
			skin: SKIN,
			eye: okhsl(232, 0.55, 0.5),
			blush: okhsl(350, 0.75, 0.78),
			mouth: okhsl(350, 0.6, 0.55),
			cloth: SKY,
			clothDark: okhsl(232, 0.45, 0.42),
			garment: LILAC,
			trim: SNOW,
			shoe: COCOA,
			sparkle: CREAM,
			border: [PINK, LILAC, SKY],
		},
		body: [
			"..WWCCCCCCCCWW..",
			".WWWCCCCCCCCWWW.",
			"...WWKKKKKKWW...",
			".KKKKKKKKKKKKKK.",
			"KKKDKKKDDKKKDKKK",
			"WWWWWWWWWWWWWWWW",
			"..SS........SS..",
			"..PP........PP..",
		],
	},
	{
		name: "Oversized Hoodie",
		vibe: "sleeves swallow the hands, thigh-highs, scientifically comfy",
		cuteness: 93,
		palette: {
			hair: LILAC,
			hairLight: PINK,
			skin: SKIN,
			eye: okhsl(232, 0.5, 0.48),
			blush: okhsl(350, 0.7, 0.8),
			mouth: okhsl(350, 0.55, 0.55),
			cloth: PINK,
			clothDark: okhsl(350, 0.4, 0.45),
			garment: SKY,
			trim: SNOW,
			shoe: LILAC,
			sparkle: CREAM,
			border: [LILAC, PINK, ROSE],
		},
		body: [
			"CCCWWWWWWWWWWCCC",
			"CCCCCCCCCCCCCCCC",
			"CCCCCDDDDDDCCCCC",
			"SCCCCCCCCCCCCCCS",
			".CCCCCCCCCCCCCC.",
			"..DDDDDDDDDDDD..",
			"...WW......WW...",
			"...PP......PP...",
		],
	},
	{
		name: "Gothic Mochi",
		vibe: "lace, ribbons, no feelings (only pastel ones)",
		cuteness: 84,
		palette: {
			hair: okhsl(280, 0.22, 0.3),
			hairLight: PLUM,
			skin: okhsl(30, 0.35, 0.88),
			eye: okhsl(350, 0.6, 0.6),
			blush: okhsl(350, 0.6, 0.74),
			mouth: okhsl(350, 0.5, 0.5),
			cloth: INK,
			clothDark: PLUM,
			garment: PLUM,
			trim: PINK,
			shoe: INK,
			sparkle: LILAC,
			border: [PLUM, PINK, LILAC],
		},
		body: [
			"..WWCCDDDDCCWW..",
			".CCCCCCCCCCCCCC.",
			"CCCWWCCCCCCWWCCC",
			"KKKKKKKKKKKKKKKK",
			"KDKDKDKDKDKDKDKD",
			".WWWWWWWWWWWWWW.",
			"...SS......SS...",
			"...PP......PP...",
		],
	},
	{
		name: "Sporty Bling",
		vibe: "crop top, running shorts, gains wrapped in ribbons",
		cuteness: 79,
		palette: {
			hair: MINT,
			hairLight: CREAM,
			skin: SKIN,
			eye: okhsl(162, 0.45, 0.4),
			blush: okhsl(350, 0.7, 0.78),
			mouth: okhsl(350, 0.55, 0.55),
			cloth: MINT,
			clothDark: okhsl(162, 0.35, 0.38),
			garment: NAVY,
			trim: SNOW,
			shoe: PINK,
			sparkle: CREAM,
			border: [MINT, SKY, PINK],
		},
		body: [
			"..WWCCCCCCCCWW..",
			"...SSSSSSSSSS...",
			"..KKKKKKKKKKKK..",
			".KKKKKKKKKKKKKK.",
			".KKDDKKKKKKDDKK.",
			"...SS......SS...",
			"...WW......WW...",
			"...PP......PP...",
		],
	},
];

export function clampOutfit(index: number): number {
	return Math.max(0, Math.min(OUTFITS.length - 1, Math.trunc(Number(index) || 0)));
}

/** Accepts a 1-based number ("2"), an exact name, or a fuzzy substring. */
export function findOutfitIndex(arg: string): number | undefined {
	const needle = arg.trim().toLowerCase();
	if (!needle) return undefined;
	if (/^\d+$/.test(needle)) {
		const index = Number(needle) - 1;
		return index >= 0 && index < OUTFITS.length ? index : undefined;
	}
	const exact = OUTFITS.findIndex((o) => o.name.toLowerCase() === needle);
	if (exact >= 0) return exact;
	const partial = OUTFITS.findIndex((o) => o.name.toLowerCase().includes(needle));
	return partial >= 0 ? partial : undefined;
}

export interface Heart {
	col: number;
	row: number;
	ttl: number;
}

/**
 * Paint the chibi: head + outfit body, drifting sparkles, rising hearts.
 * Returns exactly HEAD.length + body.length lines, `SPRITE_COLS` cells wide.
 */
export function renderSprite(
	outfit: Outfit,
	expression: Expression,
	tick: number,
	hearts: Heart[],
	theme: Theme,
): string[] {
	const rows = HEAD.concat(outfit.body);
	const grid = rows.map((row) => Array.from(row));
	const palette = outfit.palette;

	// Sparkles land only in empty cells, so the silhouette stays clean.
	for (let k = 0; k < 6; k++) {
		const col = (k * 5 + tick + k * k) % SPRITE_COLS;
		const row = grid.length - 1 - ((Math.floor(tick / 2) + k * 3) % grid.length);
		if (grid[row]?.[col] === ".") grid[row]![col] = "*";
	}
	for (const heart of hearts) {
		if (heart.row >= 0 && heart.row < grid.length && grid[heart.row]?.[heart.col] !== undefined) {
			grid[heart.row]![heart.col] = "~";
		}
	}

	const face = FACE[expression];
	const lines: string[] = [];
	for (let r = 0; r < grid.length; r++) {
		let line = "";
		let mouthDrawn = false;
		for (let c = 0; c < SPRITE_COLS; c++) {
			const cell = grid[r]![c] ?? ".";
			if (cell === ".") {
				line += " ";
				continue;
			}
			if (cell === "*") {
				line += theme.style(SPARKLE_CYCLE[(c + r + tick) % SPARKLE_CYCLE.length]!, { fg: palette.sparkle });
				continue;
			}
			if (cell === "~") {
				line += theme.style(tick % 2 === 0 ? GLYPH.heart : GLYPH.heartFull, { fg: palette.blush });
				continue;
			}
			let glyph = "█";
			let color = palette[CLASS_COLOR[cell] ?? "cloth"]!;
			if (cell === "h" || cell === "D" || cell === "B") glyph = "▄";
			if (r === EYE_ROW && cell === "E") glyph = face.eye;
			if (r === MOUTH_ROW && cell === "M") {
				// The mouth is two cells wide; draw once, fill the rest with skin.
				if (mouthDrawn) {
					glyph = "█";
					color = palette.skin;
				} else {
					glyph = face.mouth;
					mouthDrawn = true;
				}
			}
			line += theme.style(glyph, { fg: color });
		}
		lines.push(truncateToWidth(line, SPRITE_COLS));
	}
	return lines;
}

const SPARKLE_CYCLE = ["✦", "✧", "*", "·"] as const;

/** Tiny inline face for the status bar: `( • ω • )`, blinking on a slow cycle. */
export function miniFace(tick: number): string {
	const eyes = tick % 28 < 2 ? "─" : GLYPH.fill;
	return `( ${eyes} ${GLYPH.blushFace} ${eyes} )`;
}

/** The chibi shrunk to one line, for compact banners and non-TUI modes. */
export function compactFace(tick: number): string {
	return tick % 24 < 2 ? "( ─ ω ─ )" : miniFace(tick);
}
