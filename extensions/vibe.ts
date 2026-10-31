/**
 * vibe.ts — single source of truth for the pastel state, plus the settings.json
 * reader that seeds it.
 *
 * Layering (later wins):
 *   1. DEFAULT_VIBE
 *   2. the `femboy` key in settings.json (user level, then project level)
 *   3. the newest `femboy-tui` custom entry in this session — so /reload,
 *      resume and fork keep the headpat count (anti-pattern A6)
 *
 * Everything that draws (chrome, tool rows, overlay) reads `getVibe()` at
 * render time and subscribes with `onVibeChange()` to request a repaint. That
 * is what makes toggles live without rebuilding components — which is also why
 * flipping the editor ribbon never loses your draft.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GLYPH } from "./palette";
import { type Outfit, OUTFITS, clampOutfit, findOutfitIndex } from "./sprites";

export const ENTRY_TYPE = "femboy-tui";

export type WelcomeMode = "header" | "overlay" | "off";

export interface VibeState {
	/** Master switch: take over pi's chrome at all. */
	pastelMode: boolean;
	/** Rewrite transcript markdown into uwu-speak (display only). */
	uwuMode: boolean;
	outfit: number;
	headpats: number;
	/** Where the startup panel lives. */
	welcome: WelcomeMode;
	/** Pastel tool rows (via pi.registerToolRenderer). */
	toolRows: boolean;
	/** Outfit ribbon on the editor's top border. */
	ribbonEditor: boolean;
	/** Chibi companion docked on the right side of the TUI. */
	companion: boolean;
}

export const DEFAULT_VIBE: VibeState = {
	pastelMode: true,
	uwuMode: false,
	outfit: 0,
	headpats: 0,
	welcome: "header",
	toolRows: true,
	ribbonEditor: true,
	companion: true,
};

const MOODS: ReadonlyArray<{ at: number; label: string }> = [
	{ at: 0, label: "shy :3" },
	{ at: 3, label: "warming up" },
	{ at: 10, label: "fluffy" },
	{ at: 25, label: "purring" },
	{ at: 50, label: "maximum kawaii" },
	{ at: 100, label: "transcendent femboy" },
];

export function moodLabel(headpats: number): string {
	let label = MOODS[0]!.label;
	for (const mood of MOODS) if (headpats >= mood.at) label = mood.label;
	return label;
}

function normalize(vibe: VibeState): VibeState {
	return {
		pastelMode: vibe.pastelMode !== false,
		uwuMode: vibe.uwuMode === true,
		outfit: clampOutfit(vibe.outfit),
		headpats: Math.max(0, Math.trunc(Number(vibe.headpats) || 0)),
		welcome: vibe.welcome === "overlay" || vibe.welcome === "off" ? vibe.welcome : "header",
		toolRows: vibe.toolRows !== false,
		ribbonEditor: vibe.ribbonEditor !== false,
		companion: vibe.companion !== false,
	};
}

let state: VibeState = { ...DEFAULT_VIBE };
let persist: ((vibe: VibeState) => void) | undefined;
const listeners = new Set<(next: VibeState, patch: Partial<VibeState>) => void>();

/** Called once from index.ts so patches survive reload/fork. */
export function setVibePersister(fn: (vibe: VibeState) => void): void {
	persist = fn;
}

export function getVibe(): VibeState {
	return state;
}

export function currentOutfit(): Outfit {
	return OUTFITS[state.outfit] ?? OUTFITS[0]!;
}

/** Mutate + persist + notify. Returns the new state. */
export function patchVibe(patch: Partial<VibeState>): VibeState {
	state = normalize({ ...state, ...patch });
	persist?.(state);
	for (const listener of listeners) listener(state, patch);
	return state;
}

/** Replace the state without persisting (hydration path). */
export function hydrateVibe(next: Partial<VibeState>): VibeState {
	state = normalize({ ...DEFAULT_VIBE, ...next });
	for (const listener of listeners) listener(state, next);
	return state;
}

export function onVibeChange(fn: (next: VibeState, patch: Partial<VibeState>) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

// ------------------------------------------------------------------ settings --

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * `settings.json` → `femboy` key. Project settings win over user settings.
 *
 * { "femboy": { "pastel": true, "uwu": false, "welcome": "header" | "overlay" | "off",
 *               "outfit": "Oversized Hoodie" | 2, "toolRows": true, "ribbonEditor": true,
 *               "companion": true } }
 */
export function settingsVibe(cwd: string): Partial<VibeState> {
	const user = readJson(join(getAgentDir(), "settings.json"));
	const project = readJson(join(cwd, ".pi/settings.json"));
	const raw = { ...(user?.femboy ?? {}), ...(project?.femboy ?? {}) };

	const out: Partial<VibeState> = {};
	if (typeof raw.pastel === "boolean") out.pastelMode = raw.pastel;
	if (typeof raw.pastelMode === "boolean") out.pastelMode = raw.pastelMode;
	if (typeof raw.uwu === "boolean") out.uwuMode = raw.uwu;
	if (typeof raw.uwuMode === "boolean") out.uwuMode = raw.uwuMode;
	if (typeof raw.toolRows === "boolean") out.toolRows = raw.toolRows;
	if (typeof raw.ribbonEditor === "boolean") out.ribbonEditor = raw.ribbonEditor;
	if (typeof raw.companion === "boolean") out.companion = raw.companion;
	if (raw.welcome === "header" || raw.welcome === "overlay" || raw.welcome === "off") out.welcome = raw.welcome;
	if (typeof raw.outfit === "string" || typeof raw.outfit === "number") {
		const index = findOutfitIndex(String(raw.outfit));
		if (index !== undefined) out.outfit = index;
	}
	return out;
}

// --------------------------------------------------------------- persistence --

/** Newest `femboy-tui` entry on this session's branch, if any. */
export function savedVibe(ctx: ExtensionContext): Partial<VibeState> {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data as Partial<VibeState> | undefined;
		if (data && typeof data === "object") return data;
		return {};
	}
	return {};
}

// ------------------------------------------------------------------- summary --

export function vibeSummary(): string {
	const outfit = currentOutfit();
	return `${GLYPH.heart} ${outfit.name} (cuteness ${outfit.cuteness}/100) · headpats ${state.headpats} · mood ${moodLabel(
		state.headpats,
	)} · pastel ${state.pastelMode ? "on" : "off"} · tool rows ${state.toolRows ? "on" : "off"} · companion ${
		state.companion ? "on" : "off"
	} · uwu transcript ${state.uwuMode ? "on" : "off"}`;
}

/** Short line for the status bar / notifications. */
export function vibeShort(): string {
	return `${GLYPH.heart} ${currentOutfit().name} · pats ${state.headpats} · ${moodLabel(state.headpats)}`;
}
