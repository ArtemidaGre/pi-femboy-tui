/**
 * speech.ts — the chibi speaks the model's *actual words*.
 *
 * The markdown transformer in index.ts is the only place that sees assistant
 * text live, frame by frame, without owning a timer or a second inference
 * call: pi re-runs it on every streaming re-render with
 * `{ messageType: "assistant", isStreaming }`. So the transformer feeds this
 * store as a side effect, and the companion *reads* it on its own 250 ms
 * animation tick. Producer pull-free, consumer timer-owned — the same
 * discipline the rest of the chrome follows.
 *
 * Display only. The transcript and the LLM context never see any of this;
 * markdown is reduced to plain prose here (fences collapse to a badge — the
 * bubble is for talking, not for code), wrapped to `SPEECH_COLS`, and windowed
 * to the last `MAX_LINES` lines like subtitles at the live edge of the stream.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** Maximum cell width of one wrapped speech line (bubble interior). */
export const SPEECH_COLS = 30;

/** Subtitle window: how many wrapped lines the bubble shows. Sized to the
 * sprite's 16-row height — the left-side layout uses the whole frame. */
const MAX_LINES = 12;

/** Finished speech lingers this long (ms) before the bubble deflates. */
export const HOLD_MS = 8000;

/**
 * Streaming speech that received no new words for this long (ms) is a dead
 * stream (abort, crash, or a producer that stopped calling us) — deflate the
 * frame instead of freezing it wide. Must be longer than any honest thinking
 * pause, shorter than a user's patience with a stuck box.
 */
export const STALL_MS = 12000;

export interface Speech {
	/** The windowed, wrapped lines the bubble draws (oldest first). */
	readonly lines: readonly string[];
	/** True while the model is still streaming this message. */
	readonly streaming: boolean;
	/** Date.now() of the last content change — drives the expiry. */
	readonly updatedAt: number;
	/** Plain prose of the whole message, for change detection. */
	readonly raw: string;
}

let current: Speech | null = null;

export function getSpeech(): Speech | null {
	return current;
}

export function clearSpeech(): void {
	current = null;
}

/** Called by the companion each tick: drop stale or dead-stream speech. */
export function expireSpeech(): void {
	if (!current) return;
	const age = Date.now() - current.updatedAt;
	if (current.streaming) {
		// `updatedAt` only moves when the producer fed us, so this measures
		// silence, not how long the message has been open.
		if (age > STALL_MS) current = null;
		return;
	}
	if (age > HOLD_MS) current = null;
}

/**
 * Markdown → plain prose. Deliberately lossy and cheap: this runs on every
 * streaming frame. An unterminated trailing fence (mid-stream code block) is
 * matched by the `$` alternative, so partial code never leaks into the bubble.
 */
function toPlain(markdown: string): string {
	let text = markdown;
	text = text.replace(/```[^\n]*\n?[\s\S]*?(?:```|$)/g, " (✦ code ✦) ");
	text = text.replace(/`([^`\n]*)`/g, "$1");
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
	text = text.replace(/^\s*>\s?/gm, "");
	text = text.replace(/^\s*[-*+]\s+/gm, "• ");
	let prev = "";
	while (prev !== text) {
		prev = text;
		text = text.replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2");
	}
	text = text.replace(/\|.*\|/g, (row) => row.split("|").filter(Boolean).join(" · "));
	text = text.replace(/^\s*[-—:]+\s*$/, "");
	return text.replace(/\s+/g, " ").trim();
}

/** Greedy word wrap; words longer than `cols` are hard-broken by cell count. */
function wrap(text: string, cols: number): string[] {
	const out: string[] = [];
	let line = "";
	for (const raw of text.split(" ")) {
		let word = raw;
		while (visibleWidth(word) > cols) {
			if (line) {
				out.push(line);
				line = "";
			}
			// sliceByColumn-ish hard break without importing more machinery
			let cut = 0;
			let cells = 0;
			for (let i = 0; i < word.length && cells < cols; i++) {
				cells += visibleWidth(word[i]!);
				cut = i + 1;
				if (cells > cols) cut = i;
			}
			out.push(word.slice(0, cut));
			word = word.slice(cut);
		}
		const candidate = line ? `${line} ${word}` : word;
		if (line && visibleWidth(candidate) > cols) {
			out.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	if (line) out.push(line);
	return out;
}

/**
 * Feed the store from the markdown transformer. Idempotent while the text has
 * not changed — only `updatedAt` moves, so a re-render does not re-wrap the
 * whole message on every frame.
 */
export function speakMarkdown(markdown: string, isStreaming: boolean): void {
	const raw = toPlain(markdown);
	if (!raw) return;
	if (current && current.raw === raw) {
		if (current.streaming !== isStreaming) {
			current = { ...current, streaming: isStreaming, updatedAt: Date.now() };
		} else {
			current = { ...current, updatedAt: Date.now() };
		}
		return;
	}
	current = {
		raw,
		lines: wrap(raw, SPEECH_COLS).slice(-MAX_LINES),
		streaming: isStreaming,
		updatedAt: Date.now(),
	};
}
