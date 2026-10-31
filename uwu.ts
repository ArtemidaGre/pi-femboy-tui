/**
 * uwu.ts — display-only text rewriting.
 *
 * `pi.registerMarkdownTransformer()` runs on the markdown right before pi
 * renders it, so the model still reads and writes normal English — only the
 * transcript goes uwu. Fenced blocks, inline code, link *targets* and autolinks
 * are protected by splitting on protected ranges first, so `` `renderCall` ``
 * and `[docs](https://example.com/the-real/docs)` survive intact.
 *
 * The flourish is keyed off the line index instead of `Math.random()`, so
 * streaming re-renders do not jitter between frames.
 */

/** Ranges we must never touch. */
const PROTECTED =
	/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<https?:\/\/[^\s>]+>)/g;

const UWU_RULES: ReadonlyArray<{ re: RegExp; to: string }> = [
	{ re: /ove\b/g, to: "uv" },
	{ re: /OVE/g, to: "UV" },
	{ re: /Ove/g, to: "Uv" },
	{ re: /\bteh\b/gi, to: "de" },
	{ re: /\byour\b/gi, to: "ur" },
	{ re: /\byou\b/gi, to: "uwu" },
	{ re: /\bthe\b/gi, to: "de" },
	{ re: /th/g, to: "d" },
	{ re: /TH/g, to: "D" },
	{ re: /Th/g, to: "D" },
	{ re: /r/g, to: "w" },
	{ re: /R/g, to: "W" },
	{ re: /l/g, to: "w" },
	{ re: /L/g, to: "W" },
];

const FLOURISHES = [" uwu", " nyaa~", " :3", " ♡"] as const;

function applyRules(text: string): string {
	let out = text;
	for (const rule of UWU_RULES) out = out.replace(rule.re, rule.to);
	return out;
}

/** Uwufy one stretch of prose. Deterministic given `lineIndex`. */
export function uwuifyProse(text: string, lineIndex: number): string {
	let out = applyRules(text);
	// Soften sentence-final periods into tildes.
	out = out.replace(/(\S)\.(?=\s*$)/g, "$1~");
	const body = out.trimEnd();
	const trailing = out.slice(body.length);
	if (body.length > 16 && lineIndex % 3 === 0 && /[A-Za-z0-9)~]$/.test(body)) {
		out = body + FLOURISHES[Math.floor(lineIndex / 3) % FLOURISHES.length]! + trailing;
	}
	return out;
}

/** Uwufy markdown, leaving code spans and link targets alone. */
export function uwuifyMarkdown(markdown: string): string {
	const parts = markdown.split(PROTECTED);
	// The line index advances across unprotected stretches only, which keeps the
	// flourish choice stable while a message streams in.
	let lineIndex = 0;
	for (let i = 0; i < parts.length; i += 2) {
		const stretch = parts[i]!;
		parts[i] = uwuifyProse(stretch, lineIndex);
		lineIndex += stretch.split("\n").length;
	}
	return parts.join("");
}

/**
 * Chrome labels (tool summaries, loader message) are short and single-line:
 * apply the sound changes, skip the flourishes, never touch inline code.
 */
export function uwuifyLabel(text: string): string {
	const parts = text.split(PROTECTED);
	for (let i = 0; i < parts.length; i += 2) parts[i] = applyRules(parts[i]!);
	return parts.join("");
}

/**
 * pi renders user/assistant messages itself and exposes no render hook, so the
 * markdown transformer is the only lever that reaches them. We prepend a
 * blossom caret to user turns.
 *
 * Guard: skip when the first non-empty line is block-level markdown (fence /
 * heading / quote / list / table / HTML), so the prefix can never demote it
 * into a paragraph.
 */
export function markUserMessage(markdown: string, marker: string): string {
	const lines = markdown.split("\n");
	const i = lines.findIndex((line) => line.trim() !== "");
	if (i === -1) return markdown;
	if (/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||<)/.test(lines[i]!)) return markdown;
	if (lines[i]!.startsWith(marker)) return markdown;
	lines[i] = marker + lines[i]!;
	return lines.join("\n");
}
