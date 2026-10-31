/**
 * tool-rows.ts — pastel tool rows via `pi.registerToolRenderer()`.
 *
 * This is the part nebula does by re-registering all seven built-in tools with
 * `execute()` delegated back to the original definition. pi 1.4.0 has a better
 * hook: a *resolver* chooses renderers for calls to any tool — built-ins,
 * custom tools, MCP tools — without touching the definition or execution at
 * all. Consequences:
 *
 * - execution is never wrapped, so nothing can break a tool's behaviour;
 * - `next()` gives the renderers pi (and other extensions) would have used, so
 *   we can **compose**: our summary line plus pi's own expanded rendering
 *   (diff view, line numbers, syntax highlighting) instead of hand-rolled
 *   raw-output printing;
 * - the toggle is live: when the vibe says "rows off" the resolver returns
 *   `next()` and stock rendering is back on the very next frame.
 *
 * Row shape (`renderShell: "self"` — no box, no background):
 *
 *   ✿ Read  [README.md • lines 1–120]                     42ms
 *     └ Read 120 lines
 *
 * Error rows swap the blossom for a cross and use the error token. With the
 * uwu transcript on, the tool *name* and the *summary* are uwuified — file
 * paths and commands inside the brackets never are.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH } from "./palette";
import { getVibe } from "./vibe";
import { uwuifyLabel } from "./uwu";

/** Minimal shape of `{renderShell, renderCall, renderResult}` pi hands back. */
interface BaseRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: any) => Component;
	renderResult?: (result: any, options: any, theme: Theme, context: any) => Component;
}

const row = (make: (width: number) => string[]): Component => ({
	render: (width: number) => make(width),
	invalidate() {},
});

const displayName = (name: string) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/[_-]/g, " ");

/** `42ms` / `2.3s` / `1m 5s`, right-aligned in the row. */
function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

// ---------------------------------------------------------------- arguments --

const str = (v: any) => (v == null ? "" : String(v));
const pathOf = (args: any) => str(args?.path ?? args?.file_path ?? args?.filePath ?? "");

/** Compact, human-readable argument chips. Plain text; the row colours them. */
function argChips(toolName: string, args: any): string[] {
	if (!args) return [];
	const name = toolName.toLowerCase();
	switch (name) {
		case "bash": {
			const command = str(args.command).split("\n")[0].trim();
			return command ? [command] : [];
		}
		case "read": {
			const chips = pathOf(args) ? [pathOf(args)] : [];
			const start = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			if (start !== undefined || limit !== undefined) {
				const from = start ?? 1;
				chips.push(limit !== undefined ? `lines ${from}–${from + limit - 1}` : `lines ${from}+`);
			}
			return chips;
		}
		case "write": {
			const chips = pathOf(args) ? [pathOf(args)] : [];
			const lines = args.content == null ? 0 : String(args.content).replace(/\n+$/, "").split("\n").length;
			if (lines) chips.push(`${lines} lines`);
			return chips;
		}
		case "edit": {
			const chips = pathOf(args) ? [pathOf(args)] : [];
			const count = Array.isArray(args.edits) ? args.edits.length : args.oldText || args.newText ? 1 : 0;
			if (count) chips.push(`${count} change${count === 1 ? "" : "s"}`);
			return chips;
		}
		case "grep": {
			const chips = args.pattern ? [`"${str(args.pattern)}"`] : [];
			if (args.path) chips.push(str(args.path));
			if (args.glob) chips.push(str(args.glob));
			return chips;
		}
		case "find": {
			const chips = args.pattern ? [str(args.pattern)] : [];
			if (args.path) chips.push(str(args.path));
			return chips;
		}
		case "ls":
			return [pathOf(args) || "."];
		default: {
			const json = JSON.stringify(args ?? {});
			return json === "{}" ? [] : [json.length > 70 ? `${json.slice(0, 67)}…` : json];
		}
	}
}

function bracketedChips(theme: Theme, chips: string[]): string {
	if (chips.length === 0) return "";
	const body = chips.map((chip) => theme.fg("text", chip)).join(theme.fg("borderMuted", ` ${GLYPH.bullet} `));
	return `  ${theme.fg("borderMuted", "[")}${body}${theme.fg("borderMuted", "]")}`;
}

// ----------------------------------------------------------------- results --

const textOf = (result: any): string => {
	if (!Array.isArray(result?.content)) return "";
	return result.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
};

const hasImage = (result: any) => Array.isArray(result?.content) && result.content.some((p: any) => p?.type === "image");

/** Drop pi's trailing "[… truncated …]" notice so line counts stay clean. */
const stripNotice = (text: string) => text.replace(/\n\n\[[\s\S]*\]\s*$/, "").trim();

function countLines(text: string): number {
	const trimmed = text.replace(/\n+$/, "");
	return trimmed.trim() === "" ? 0 : trimmed.split("\n").length;
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** One human line under the `└`, rebuilt from each tool's real result. */
function summarize(toolName: string, args: any, result: any, theme: Theme): string {
	const name = toolName.toLowerCase();
	const text = textOf(result);
	switch (name) {
		case "read": {
			if (hasImage(result)) return theme.fg("success", `Image ${GLYPH.heart}`);
			const read = countLines(stripNotice(text));
			return theme.fg("muted", `Read ${read} line${read === 1 ? "" : "s"}`);
		}
		case "write":
			return theme.fg("muted", `Wrote ${countLines(stripNotice(text)) || countLines(String(args?.content ?? ""))} lines`);
		case "edit": {
			const diff = result?.details?.diff;
			if (typeof diff !== "string" || !diff) return theme.fg("muted", "Updated");
			const { added, removed } = diffStats(diff);
			return theme.fg("muted", "Updated ") + theme.fg("success", `+${added}`) + " " + theme.fg("error", `−${removed}`);
		}
		case "grep":
			if (/no matches/i.test(text)) return theme.fg("muted", "No matches");
			return theme.fg("muted", `Found ${countLines(text)} match${countLines(text) === 1 ? "" : "es"}`);
		case "find":
			if (/no files found/i.test(text)) return theme.fg("muted", "No files");
			return theme.fg("muted", `Found ${countLines(text)} file${countLines(text) === 1 ? "" : "s"}`);
		case "ls":
			if (/empty directory/i.test(text)) return theme.fg("muted", "Empty");
			return theme.fg("muted", `Listed ${countLines(text)} entr${countLines(text) === 1 ? "y" : "ies"}`);
		case "bash": {
			const lines = text ? countLines(stripNotice(text)) : 0;
			return theme.fg("muted", "Done") + (lines ? theme.fg("dim", ` ${GLYPH.dot} ${lines} lines`) : "");
		}
		default: {
			const first = (text.split("\n")[0] ?? "").trim();
			return theme.fg("muted", first ? first.slice(0, 80) : "Done");
		}
	}
}

const errorFirstLine = (result: any): string => {
	const raw = String(result?.details?.error ?? textOf(result)).trim();
	return raw.split("\n")[0] ?? "";
};

// -------------------------------------------------------------------- rows --

/**
 * Builds the resolver registered with `pi.registerToolRenderer()`.
 * `next()` is the renderers pi (and other extensions) would use — we either
 * decline entirely (rows off) or compose with it.
 */
export function pastelToolRows() {
	return (toolName: string, next: () => BaseRenderers | undefined): BaseRenderers | undefined => {
		const vibe = getVibe();
		if (!vibe.pastelMode || !vibe.toolRows) return next();

		const base = next();
		const uwu = (text: string) => (vibe.uwuMode ? uwuifyLabel(text) : text);

		return {
			renderShell: "self",
			renderCall(args: any, theme: Theme, context: any) {
				return row((width) => {
					const isError = !!context?.isError;
					const mark = isError ? GLYPH.cross : GLYPH.blossom;
					const token = isError ? "error" : "accent";
					const left =
						theme.fg(token, mark) +
						" " +
						theme.fg(token, theme.bold(uwu(displayName(toolName)))) +
						bracketedChips(theme, argChips(toolName, args));
					const ms: number | undefined = context?.durationMs;
					const right = ms != null ? theme.fg("dim", fmtDuration(ms)) : "";
					return [truncateToWidth(padRight(left, right, width), width)];
				});
			},
			renderResult(result: any, options: any, theme: Theme, context: any) {
				return row((width) => {
					const lines: string[] = [];
					const tree = `  ${theme.fg("borderMuted", GLYPH.tree)} `;
					if (options?.isPartial) {
						lines.push(truncateToWidth(tree + theme.fg("dim", `… ${expandHint()}`), width));
						return lines;
					}
					const isError = !!context?.isError;
					const summary = isError
						? theme.fg("error", errorFirstLine(result) || "error")
						: summarize(toolName, context?.args ?? {}, result, theme);
					const hint = isError || options?.expanded ? "" : ` ${theme.fg("dim", expandHint())}`;
					lines.push(truncateToWidth(tree + summary + hint, width));

					// Compose: pi's own expanded rendering (diff view, line
					// numbers, highlighting) stays intact underneath our summary.
					if (options?.expanded && base?.renderResult) {
						try {
							const inner = base.renderResult(result, { ...options, expanded: true }, theme, context);
							for (const line of inner.render(Math.max(24, width - 2))) {
								lines.push(truncateToWidth(`  ${line}`, width));
							}
						} catch (error) {
							console.debug("[femboy] base renderer failed:", error);
						}
					}
					return lines;
				});
			},
		};
	};
}

/** Left chunk padded, right chunk flush right — exactly `width` cells. */
function padRight(left: string, right: string, width: number): string {
	if (!right) return left;
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(gap)}${right}`;
}

/**
 * `keyHint` reads pi's global theme and keybinding config, which are
 * initialized in a real session but not in an off-line harness or a bare HTML
 * export. Degrade to the documented default key instead of rendering a row
 * whose affordance is an empty string.
 */
function expandHint(): string {
	const fallback = "ctrl+o to expand";
	try {
		const hint = keyHint("app.tools.expand", "to expand");
		return visibleWidth(stripTerminalSequences(hint)) >= visibleWidth(fallback) ? hint : fallback;
	} catch {
		return fallback;
	}
}
