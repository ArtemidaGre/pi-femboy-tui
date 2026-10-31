/**
 * render-check.mjs — offline smoke test for the femboy chrome.
 *
 * Runs pi's real loader (jiti) and pi's real packages, but no TUI and no model
 * call. What it proves:
 *   - every panel/bar/row renders at every width from 24 to 220 cells, for all
 *     four outfits, and never exceeds the width pi hands render();
 *   - installChrome() assigns the slots pi expects and survives vibe changes
 *     (pastel off/on, welcome header→overlay→off, uwu, headpats, outfit);
 *   - the editor ribbon emits exactly `width` cells and defers to super when
 *     text is scrolled away;
 *   - the tool-row resolver composes: collapsed hides pi's output, expanded
 *     keeps it, rows-off declines to `next()`, errors use the error token;
 *   - uwu never touches code spans, link targets or block-level first lines;
 *   - the overlay survives every key and closes on q;
 *   - the chibi frame breathes open for live speech and deflates on hold/stall
 *     expiry, and never drifts wider than the box it claims to be;
 *   - patches fire the persister and hydrate clamps junk values.
 *
 * `--show` prints a sample so a human can eyeball the pastel.
 */
import { createJiti } from "jiti";
import { visibleWidth, truncateToWidth, rgbColor } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Paths resolve from tools/, not the caller's cwd, so `npm run check` works from anywhere.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions");

initTheme();
const jiti = createJiti(import.meta.url, { interop: true });
const chrome = await jiti.import(`${SRC}/chrome.ts`);
const companionMod = await jiti.import(`${SRC}/companion.ts`);
const rows = await jiti.import(`${SRC}/tool-rows.ts`);
const vibeMod = await jiti.import(`${SRC}/vibe.ts`);
const uwu = await jiti.import(`${SRC}/uwu.ts`);
const overlayMod = await jiti.import(`${SRC}/overlay.ts`);
const speechMod = await jiti.import(`${SRC}/speech.ts`);

const stripSequences = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const show = process.argv.includes("--show");
const C = (r, g, b) => rgbColor(r, g, b);
// Stub theme: identity colouring, real Colour objects for the gradients.
const theme = {
	colors: { accent: C(255, 150, 200), border: C(200, 160, 255), borderAccent: C(150, 200, 255) },
	fg: (_t, text) => String(text),
	bg: (_t, text) => String(text),
	style: (text) => String(text),
	bold: (t) => t,
	italic: (t) => t,
};

const data = {
	counts: { context: 1, extensions: 7, skills: 2, prompts: 1 },
	sessions: [
		{ name: "continue developing femboy extension", ago: "3m ago" },
		{ name: "fix the loader", ago: "2h ago" },
	],
	cwd: process.cwd(),
	piVersion: "1.4.0",
};

let problems = 0;
const fail = (message) => {
	console.log(`FAIL ${message}`);
	problems++;
};
function checkLines(label, lines, width, allowEmpty = false) {
	if (!Array.isArray(lines)) return fail(`${label}: render returned ${typeof lines}, not string[]`);
	if (lines.length === 0) {
		if (allowEmpty) return console.log(`ok   ${label}: intentionally blank`);
		return fail(`${label}: no lines`);
	}
	let max = 0;
	for (const line of lines) {
		if (typeof line !== "string") return fail(`${label}: non-string line`);
		const w = visibleWidth(line);
		max = Math.max(max, w);
		if (w > width) return fail(`${label}: ${w} > ${width} -> ${JSON.stringify(line.slice(0, 70))}`);
	}
	console.log(`ok   ${label}: ${lines.length} lines, max ${max}`);
}

/** A box is a box: when the panel draws one, every line must be exactly `w`. */
function checkBox(label, lines, expected) {
	if (lines.length < 3) return console.log(`ok   ${label}: compact (${lines.length} line(s))`);
	for (const line of lines) {
		const w = visibleWidth(line);
		if (w !== expected) return fail(`${label}: box line measured ${w}, expected ${expected}`);
		// A clipped cell also measures exactly w, so verify the box survives:
		// the first and last cell must still be matching frame characters.
		const stripped = stripSequences(line);
		const openCh = [...stripped][0];
		const closeCh = [...stripped].at(-1);
		const pairs = { "╭": "╮", "│": "│", "╰": "╯" };
		if (!pairs[openCh] || pairs[openCh] !== closeCh) {
			return fail(`${label}: broken box line ${JSON.stringify(line.slice(0, 90))}`);
		}
	}
	console.log(`ok   ${label}: all ${lines.length} lines exactly ${expected}`);
}

// ------------------------------------------------------------ welcome panel --
for (const width of [24, 40, 60, 80, 100, 160, 220]) {
	for (let outfit = 0; outfit < 4; outfit++) {
		vibeMod.patchVibe({ outfit, pastelMode: true });
		for (const available of [6, 10, 24, 60]) {
			const lines = chrome.welcomePanel(width, theme, data, available);
			const expected = Math.min(width, 96);
			checkLines(`welcome w=${width} outfit=${outfit} rows=${available}`, lines, expected);
			checkBox(`box w=${width} outfit=${outfit} rows=${available}`, lines, expected);
		}
	}
}
vibeMod.patchVibe({ pastelMode: false });
checkLines("welcome when pastel off", chrome.welcomePanel(80, theme, data, 40), 80);
checkLines("banner", [chrome.pastelBanner(theme, data.cwd, 80)], 80);

// ------------------------------------------------------------------- slots ---
vibeMod.setVibePersister(() => {});
const footerProvider = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map([["femboy", "skip"], ["usage", "$79.12"]]),
	onBranchChange: () => () => {},
};
const slots = {};
const components = {};
let customOpens = 0;
let customCloses = 0;
let companionBuilt;
function makeCtx() {
	const ui = {
		theme,
		notify() {},
		setStatus: (k, v) => (slots[`status:${k}`] = v),
		setHeader: (f) => {
			slots.header = !!f;
			if (f) components.header = f({ requestRender() {} }, theme);
		},
		setWidget: (k, f, o) => {
			slots[`widget:${k}`] = `${!!f}:${o?.placement ?? "aboveEditor"}`;
			if (f) components[k] = f({ requestRender() {} }, theme);
		},
		setFooter: (f) => {
			slots.footer = !!f;
			if (f) components.footer = f({ requestRender() {} }, theme, footerProvider);
		},
		setWorkingIndicator: (o) => (slots.indicator = o ? `${o.frames.length} frames/${o.intervalMs}ms` : "default"),
		setWorkingMessage: (m) => (slots.workingMessage = m ?? "default"),
		setEditorComponent() {},
		getEditorText: () => "",
		setEditorText() {},
		// Mirror pi: the factory runs immediately, the promise settles when done() is called.
		custom: (factory, _opts) => {
			customOpens++;
			return new Promise((resolve) => {
				const comp = factory({ requestRender() {}, terminal: { rows: 32, cols: 120 } }, theme, {}, () => {
					customCloses++;
					comp?.dispose?.();
					resolve(undefined);
				});
				if (comp?.constructor?.name === "ChibiCompanion") companionBuilt = comp;
			});
		},
	};
	return {
		mode: "tui",
		cwd: data.cwd,
		model: { provider: "qwen-token-plan", name: "qwen3.8-flash" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ tokens: 31000, contextWindow: 100000, percent: 31 }),
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "assistant", usage: { input: 1200, output: 400, cacheRead: 9000, cost: { total: 0.041 } } } },
				{ type: "custom" },
			],
			getEntries: () => [],
		},
		ui,
	};
}

vibeMod.patchVibe({ pastelMode: true, welcome: "header", uwuMode: false });
const handle = chrome.installChrome(makeCtx(), data);
console.log(`ok   install slots: ${JSON.stringify(slots)}`);
for (const key of ["header", "femboy", "femboy-metrics", "footer"]) {
	const comp = components[key];
	if (!comp) {
		fail(`component ${key} not built`);
		continue;
	}
	for (const width of [40, 80, 140]) checkLines(`slot ${key} @${width}`, comp.render(width), width, key === "footer");
	comp.invalidate?.();
}
// Both bars must degrade by dropping segments, never by clipping their tail.
for (const width of [40, 60, 80, 120, 200]) {
	const line = components.femboy.render(width)[0];
	if (line.includes("...") || line.includes("…")) fail(`status bar clipped at ${width}: ${line}`);
	else if (!/\d\d:\d\d$/.test(stripSequences(line))) fail(`status bar lost its clock at ${width}: ${line}`);
	else console.log(`ok   status bar degrades cleanly @${width}`);

	const metrics = components["femboy-metrics"].render(width)[0];
	if (metrics.includes("...") || metrics.includes("…")) fail(`metrics bar clipped at ${width}: ${metrics}`);
	else if (width >= 80 && !stripSequences(metrics).includes("ctx")) fail(`metrics bar lost its ctx gauge at ${width}: ${metrics}`);
	else console.log(`ok   metrics bar degrades cleanly @${width}`);
}
vibeMod.patchVibe({ pastelMode: true, welcome: "header" });

for (const patch of [
	{ outfit: 1 },
	{ headpats: 12 },
	{ uwuMode: true },
	{ welcome: "overlay" },
	{ welcome: "off" },
	{ pastelMode: false },
	{ pastelMode: true },
]) {
	vibeMod.patchVibe(patch);
	for (const key of ["header", "femboy", "femboy-metrics"]) {
		if (components[key]) checkLines(`after ${JSON.stringify(patch)} ${key}`, components[key].render(80), 80);
	}
}
handle.repaint();
handle.refresh();
handle.dispose();
console.log(`ok   loader: ${slots.indicator} · message "${slots.workingMessage}"`);
if (slots["widget:femboy-metrics"] !== "true:belowEditor") fail("metrics widget must be belowEditor");
if (slots["widget:femboy"] !== "true:aboveEditor") fail("status widget must be aboveEditor");

// ---------------------------------------------------------------- companion --
// installChrome opens the chibi dock; dispose must close it.
if (!companionBuilt) fail("installChrome must open the companion when pastel + companion are on");
else {
	checkLines("companion from chrome", companionBuilt.render(20), 20);
	checkBox("companion box", companionBuilt.render(20), 20);
	for (const width of [20, 24, 80]) {
		if (companionBuilt.render(width).some((line) => visibleWidth(line) !== 20)) fail(`companion box drifts @${width}`);
		else console.log(`ok   companion box steady @${width}`);
	}
}
if (customCloses === 0) fail("chrome dispose must close the companion overlay");
else console.log(`ok   companion lifecycle: ${customOpens} open(s), ${customCloses} close(s)`);

const chibi = new companionMod.ChibiCompanion({ requestRender() {} }, theme, { width: 20 });
chibi.celebrate();
checkLines("companion mid-heart-burst", chibi.render(20), 20);
for (let outfit = 0; outfit < 4; outfit++) {
	vibeMod.patchVibe({ outfit });
	checkLines(`companion outfit ${outfit}`, chibi.render(20), 20);
}
chibi.dispose();

// A chibi we can drive by hand: the live object pi re-reads per frame is ours.
{
	const opts = { width: 20 };
	const talker = new companionMod.ChibiCompanion({ requestRender() {} }, theme, opts);
	speechMod.clearSpeech();
	if (talker.render(80).some((line) => visibleWidth(line) !== 20)) fail("silent chibi must stay at sprite width");
	else console.log("ok   silent chibi ignores a greedy width request");

	speechMod.speakMarkdown("hello there\n\n```py\nprint(1)\n```\n", true);
	talker.syncFrame();
	const wide = talker.render(opts.width);
	if (!wide.some((line) => visibleWidth(line) === companionMod.TALK_COLS)) fail("talking chibi must open the speech column");
	else console.log(`ok   talking chibi breathes to ${opts.width} cols (${companionMod.TALK_COLS}), ${wide.length} rows`);
	if (wide.some((line) => /print\(1\)/.test(String(line)))) fail("code fences must collapse to a badge");

	// finished speech deflates after the hold window
	speechMod.speakMarkdown("all done uwu", false);
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + speechMod.HOLD_MS + 10;
		speechMod.expireSpeech();
		if (speechMod.getSpeech() !== null) fail("finished speech must expire after HOLD_MS");
		else console.log("ok   finished speech expires after the hold window");
	} finally {
		Date.now = realNow;
	}

	// a stream that stopped delivering words must not freeze the frame wide
	speechMod.speakMarkdown("this stream died mid-sent", true);
	talker.syncFrame();
	if (opts.width !== companionMod.TALK_COLS) fail("stalled stream should still hold the column open");
	const realNow2 = Date.now;
	try {
		Date.now = () => realNow2() + speechMod.STALL_MS + 10;
		speechMod.expireSpeech();
		if (speechMod.getSpeech() !== null) fail("a stalled stream must be dropped after STALL_MS");
		else console.log("ok   dead stream deflates: the frame cannot freeze wide");
		talker.syncFrame();
		if (opts.width !== companionMod.BOX_COLS) fail("syncFrame must deflate the overlay itself");
		if (talker.render(opts.width).some((line) => visibleWidth(line) !== companionMod.BOX_COLS)) fail("frame must deflate back to sprite width");
	} finally {
		Date.now = realNow2;
	}
	talker.dispose();
	speechMod.clearSpeech();
}

const ctrl = new companionMod.CompanionController();
const ctxC = makeCtx();
const opensBefore = customOpens;
vibeMod.patchVibe({ pastelMode: false, companion: true });
ctrl.sync(ctxC);
if (customOpens !== opensBefore) fail("controller must not open when pastel is off");
else console.log("ok   controller stays shut when pastel is off");
vibeMod.patchVibe({ pastelMode: true });
ctrl.sync(ctxC);
if (customOpens !== opensBefore + 1) fail("controller must open when pastel + companion are on");
else console.log("ok   controller opens the dock on demand");
ctrl.sync(ctxC); // idempotent
if (customOpens !== opensBefore + 1) fail("sync must be idempotent");
ctrl.close();
vibeMod.patchVibe({ companion: false });
const opensAfter = customOpens;
ctrl.sync(ctxC);
if (customOpens !== opensAfter) fail("companion off must not reopen");
else console.log("ok   controller respects the companion flag");
if (show) {
	console.log("\n--- sample companion (20 cols) ---");
	vibeMod.patchVibe({ companion: true, headpats: 12 });
	const demo = new companionMod.ChibiCompanion({ requestRender() {} }, theme);
	demo.celebrate();
	console.log(demo.render(20).join("\n"));
	demo.dispose();
}

// ------------------------------------------------------------ editor ribbon --
class FakeCustomEditor {
	constructor() {
		this.borderColor = (t) => t;
	}
	renderTopBorder(width) {
		return "─".repeat(width);
	}
}
const Shell = chrome.makeFemboyEditor(FakeCustomEditor);
if (!Shell) fail("makeFemboyEditor returned null");
else {
	vibeMod.patchVibe({ pastelMode: true, ribbonEditor: true, uwuMode: false });
	const editor = new Shell();
	for (const width of [28, 60, 100]) {
		const line = editor.renderTopBorder(width, 0);
		checkLines(`ribbon @${width}`, [line], width);
		if (visibleWidth(line) !== width) fail(`ribbon @${width} measured ${visibleWidth(line)}`);
	}
	if (new Shell().renderTopBorder(60, 4) !== "─".repeat(60)) fail("scrolled border must defer to super");
	else console.log("ok   scrolled border defers to super");
	vibeMod.patchVibe({ ribbonEditor: false });
	checkLines("ribbon off", [new Shell().renderTopBorder(60, 0)], 60);
}

// ----------------------------------------------------------------- tool rows --
const resolver = rows.pastelToolRows();
const baseRenderers = {
	renderShell: "default",
	renderCall: () => ({ render: (w) => [truncateToWidth("[base call]", w)], invalidate() {} }),
	renderResult: () => ({
		render: (w) => [truncateToWidth("[base expanded diff]", w), truncateToWidth("second line", w)],
		invalidate() {},
	}),
};
const cases = [
	["read", { path: "README.md", offset: 1, limit: 120 }, { content: [{ type: "text", text: Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n") }] }],
	["bash", { command: "ls -la\nsecond line" }, { content: [{ type: "text", text: "a\nb\nc" }] }],
	["edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }, { content: [{ type: "text", text: "ok" }], details: { diff: "+aa\n-bb\n+cc" } }],
	["grep", { pattern: "foo", path: "src", glob: "*.ts" }, { content: [{ type: "text", text: "no matches" }] }],
	["find", { pattern: "**/*.ts" }, { content: [{ type: "text", text: "a.ts\nb.ts" }] }],
	["ls", {}, { content: [{ type: "text", text: "empty directory" }] }],
	["write", { path: "x.ts", content: "1\n2\n3" }, { content: [{ type: "text", text: "wrote" }] }],
	["femboy_vibe", { action: "check" }, { content: [{ type: "text", text: "♡ vibe" }] }],
	["mcp__srv__do_thing", { alpha: 1, beta: "x".repeat(300) }, { content: [{ type: "text", text: "done" }] }],
];
vibeMod.patchVibe({ pastelMode: true, toolRows: true, uwuMode: false });
for (const [name, args, result] of cases) {
	for (const expanded of [false, true]) {
		for (const isError of [false, true]) {
			const r = resolver(name, () => baseRenderers);
			if (!r) {
				fail(`resolver returned nothing for ${name}`);
				continue;
			}
			if (r.renderShell !== "self") fail(`${name}: expected renderShell self`);
			const context = {
				args,
				toolCallId: "t",
				state: {},
				cwd: data.cwd,
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				expanded,
				showImages: false,
				isError,
				durationMs: isError ? 1500 : 42,
			};
			const call = r.renderCall(args, theme, context);
			const res = r.renderResult(result, { expanded, isPartial: false }, theme, context);
			for (const width of [30, 60, 120]) {
				checkLines(`row ${name} exp=${expanded} err=${isError} @${width} call`, call.render(width), width);
				checkLines(`row ${name} exp=${expanded} err=${isError} @${width} result`, res.render(width), width);
			}
			const rendered = res.render(120).join("\n");
			if (!expanded && rendered.includes("base expanded diff")) fail(`${name}: collapsed row leaked base output`);
			if (expanded && !rendered.includes("base expanded diff")) fail(`${name}: expanded row must compose base renderer`);
		}
	}
}
const partial = resolver("bash", () => baseRenderers).renderResult(
	{ content: [] },
	{ isPartial: true, expanded: false },
	theme,
	{ args: { command: "sleep 1" }, state: {}, isError: false, isPartial: true },
);
checkLines("partial bash", partial.render(80), 80);

vibeMod.patchVibe({ toolRows: false });
if (resolver("read", () => baseRenderers) !== baseRenderers) fail("toolRows off must return next() untouched");
else console.log("ok   toolRows off declines to base");
vibeMod.patchVibe({ pastelMode: false });
if (resolver("read", () => baseRenderers) !== baseRenderers) fail("pastel off must return next() untouched");
vibeMod.patchVibe({ pastelMode: true, toolRows: true, uwuMode: true });
const uwuRow = resolver("read", () => baseRenderers)
	.renderCall({ path: "README.md" }, theme, { args: { path: "README.md" }, state: {}, isError: false })
	.render(80)[0];
if (!uwuRow.includes("Wead")) fail("uwu mode should uwuify the tool name");
else console.log(`ok   uwu row name: ${uwuRow}`);
if (uwuRow.includes("READNE")) fail("uwu must not touch arguments");
vibeMod.patchVibe({ uwuMode: false });
if (show) {
	console.log("\n--- sample rows ---");
	for (const [name, args, result] of cases.slice(0, 4)) {
		const context = { args, state: {}, isError: false, expanded: false, isPartial: false, durationMs: 42 };
		const r = resolver(name, () => baseRenderers);
		console.log(r.renderCall(args, theme, context).render(90)[0]);
		console.log(r.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(90)[0]);
	}
}

// ----------------------------------------------------------------- uwu safety --
const md =
	"The real path is `renderCall` and [docs](https://example.com/the-real/docs).\n\n```ts\nconst realValue = loader.renderCall(args);\n```";
const out = uwu.uwuifyMarkdown(md);
if (!(out.includes("`renderCall`") && out.includes("https://example.com/the-real/docs") && out.includes("const realValue = loader.renderCall(args);")))
	fail("uwu touched protected ranges");
else console.log(`ok   uwu protects code + link targets -> ${out.split("\n")[0]}`);
if (uwu.markUserMessage("```js\ncode\n```", "❀ ").startsWith("❀")) fail("caret demoted a fenced block");
if (uwu.markUserMessage("- item one\n- item two", "❀ ").startsWith("❀")) fail("caret demoted a list");
if (!uwu.markUserMessage("hello there", "❀ ").startsWith("❀ ")) fail("caret missing on prose");
if (uwu.markUserMessage("❀ already", "❀ ") !== "❀ already") fail("caret must not stack");
console.log("ok   user-message caret is block-safe");

// --------------------------------------------------------------------- overlay --
const tui = { requestRender() {}, terminal: { rows: 32, cols: 80 } };
vibeMod.patchVibe({ pastelMode: true });
let closed = false;
const overlay = new overlayMod.FemboyOverlay(tui, theme, () => (closed = true));
for (const width of [24, 40, 60, 80, 140]) checkLines(`overlay @${width}`, overlay.render(width), width);
for (const key of ["h", "u", "p", "w", "up", "down", "home", "end", " ", "q"]) {
	overlay.handleInput(key);
	const lines = overlay.render(80);
	if (!Array.isArray(lines) || lines.length === 0) fail(`overlay broke after key ${key}`);
}
if (!closed) fail("overlay must close on q");
overlay.dispose();
console.log("ok   overlay survived h/u/p/w/arrows/enter/q");
if (show) {
	console.log("\n--- sample overlay (80 cols) ---");
	const demo = new overlayMod.FemboyOverlay(tui, theme, () => {});
	console.log(demo.render(80).join("\n"));
	demo.dispose();
}

// ------------------------------------------------------------------ persistence --
let saved;
vibeMod.setVibePersister((v) => (saved = { ...v }));
vibeMod.patchVibe({ headpats: 7, outfit: 2, uwuMode: true });
if (!saved || saved.headpats !== 7 || saved.outfit !== 2 || !saved.uwuMode) fail("persister did not fire");
else console.log(`ok   persisted: ${JSON.stringify(saved)}`);
vibeMod.hydrateVibe({ ...saved, outfit: 99, headpats: -3 });
const clamped = vibeMod.getVibe();
if (clamped.outfit > 3 || clamped.headpats !== 0) fail("hydrate must clamp");
else console.log("ok   hydrate clamps outfit and headpats");
const roundTrip = vibeMod.savedVibe({ sessionManager: { getEntries: () => [{ type: "custom", customType: "femboy-tui", data: { headpats: 42 } }] } });
if (roundTrip.headpats !== 42) fail("savedVibe must read the newest entry");
else console.log("ok   savedVibe reads the newest entry");
// ------------------------------------------------------------- fault handling --
// Decoration must fail soft: if a pastel renderer throws, pi still gets lines
// and the transcript keeps its real content — never an exception on the way.
{
	vibeMod.patchVibe({ pastelMode: true, toolRows: true, uwuMode: false });
	const debug = console.debug;
	console.debug = () => {}; // the point of these tests is the hiccup, not the noise

	const boom = () => {
		throw new Error("boom");
	};
	const chibi2 = new companionMod.ChibiCompanion({ requestRender() {} }, theme, { width: 20 });
	chibi2.draw = boom;
	const broken = chibi2.render(20);
	if (broken.length !== 1 || !String(broken[0]).includes("hiccuped")) fail("companion must degrade to one apology line");
	else console.log("ok   companion survives a throwing renderer");
	chibi2.dispose();

	const brokenBar = chrome.__testing.barComponent(boom);
	if (!String(brokenBar.render(40)[0]).includes("hiccuped")) fail("bars must degrade to one apology line");
	else console.log("ok   pastel bars survive a throwing draw");

	// The header caches by width+rows+vibe, so warm it once, then break the data
	// underneath it and require the guarded fallback line rather than a throw.
	const brokenPanel = chrome.__testing.panelComponent(theme, data, { terminal: { rows: 30 } });
	brokenPanel.render(40);
	const brokenData = { ...data, counts: undefined };
	const brokenPanel2 = chrome.__testing.panelComponent(theme, brokenData, { terminal: { rows: 30 } });
	const panelLines = brokenPanel2.render(40);
	if (!Array.isArray(panelLines) || !String(panelLines[0]).includes("hiccuped")) fail("welcome header must degrade");
	else console.log("ok   welcome header survives a throwing panel");

	// A tool row paints through the theme; break the paint, keep the row.
	const realFg = theme.fg;
	let lines;
	try {
		theme.fg = boom;
		lines = resolver("bash", () => baseRenderers).renderCall({ command: "ls" }, theme, {}).render(40);
	} finally {
		theme.fg = realFg;
	}
	if (!Array.isArray(lines) || lines.length !== 1 || !String(lines[0]).includes("hiccuped")) fail("tool row must degrade to one line");
	else console.log("ok   pastel tool row survives a throwing summary");
	console.debug = debug;
}



if (Object.keys(vibeMod.settingsVibe("/tmp")).length !== 0) fail("missing settings must yield {}");
console.log(`     summary: ${vibeMod.vibeSummary()}`);

console.log(problems === 0 ? "\nALL RENDER CHECKS PASSED ♡" : `\n${problems} PROBLEM(S)`);
process.exit(problems ? 1 : 0);