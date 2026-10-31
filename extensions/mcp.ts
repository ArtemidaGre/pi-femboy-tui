/**
 * mcp.ts — tiny streamable-HTTP MCP client for the femboy-mcp pairing.
 *
 * Why hand-rolled: the pi-package stays dependency-free (only pi peer deps), and
 * "pastel never breaks pi" is easier to honour when every socket path is ours.
 * The wire surface we need is small: initialize → resources/read +
 * resources/subscribe → notifications/resources/updated on a GET SSE stream →
 * tools/call. Nothing else.
 *
 * Lifecycle:
 *   offline  — not started, disabled, or the server refused us
 *   connecting — handshake or reconnect in flight
 *   paired   — live session; notifications streaming; subscriptions active
 *
 * A dead server is a *normal* state: `connect()` resolves quietly, failures back
 * off (2s → 60s, jittered), and every public method is safe to call while
 * offline (calls reject with PairingUnavailable, callers fall back to local).
 *
 * Config comes from vibe.ts's settings chain (`femboy.mcp` in settings.json):
 *   { "url": "http://127.0.0.1:7413/mcp", "enabled": true, "secretEnvVar": "FEMBOY_SECRET" }
 * Absent key ⇒ defaults below (enabled: true, localhost:7413). If nothing is
 * listening, pairing simply stays offline.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MCP_DEFAULT_URL = "http://127.0.0.1:7413/mcp";

export interface McpConfig {
	enabled: boolean;
	url: string;
	/** Env var whose value is used as `Authorization: Bearer …`. Optional. */
	secretEnvVar?: string;
}

export type PairingStatus = "offline" | "connecting" | "paired";

/** Rejection used by every RPC when there is no live session — the caller's cue to go local. */
export class PairingUnavailable extends Error {
	constructor(reason: string) {
		super(`femboy-mcp unavailable (${reason})`);
		this.name = "PairingUnavailable";
	}
}

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: any;
	error?: { code: number; message: string; data?: unknown };
}

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** `femboy.mcp` from user settings.json, overridden by project `.pi/settings.json`. */
export function settingsMcpConfig(cwd: string): McpConfig {
	const user = readJson(join(getAgentDir(), "settings.json"));
	const project = readJson(join(cwd, ".pi/settings.json"));
	const raw = { ...(user?.femboy?.mcp ?? {}), ...(project?.femboy?.mcp ?? {}) };
	return {
		enabled: raw.enabled !== false,
		url: typeof raw.url === "string" && raw.url.startsWith("http") ? raw.url : MCP_DEFAULT_URL,
		secretEnvVar: typeof raw.secretEnvVar === "string" ? raw.secretEnvVar : undefined,
	};
}

// --------------------------------------------------------------------- SSE --

interface SseFrame {
	event: string;
	data: string;
	id?: string;
}

function parseSseFrame(block: string): SseFrame | undefined {
	let event = "message";
	let id: string | undefined;
	const dataLines: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
		else if (line.startsWith("id:")) id = line.slice(3).trim();
	}
	if (dataLines.length === 0) return undefined; // heartbeat comment frame
	return { event, data: dataLines.join("\n"), id };
}

/** Invoke `onFrame` for each SSE frame in a response body until the stream ends. */
async function consumeSse(res: Response, onFrame: (frame: SseFrame) => void, signal: AbortSignal): Promise<void> {
	if (!res.body) return;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
	for (;;) {
		let chunk: { done?: boolean; value?: Uint8Array };
		try {
			chunk = await reader.read();
		} catch {
			return; // aborted / cancelled — a normal ending
		}
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		for (;;) {
			const match = buffer.match(/\r?\n\r?\n/);
			if (!match || match.index === undefined) break;
			const block = buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			const frame = parseSseFrame(block);
			if (frame) onFrame(frame);
		}
	}
}

// -------------------------------------------------------------------- client --

export interface FemboyMcpClient {
	readonly status: PairingStatus;
	readonly clientId: string;
	/** Idempotent. Never rejects: failure just leaves the client offline. */
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/** JSON-RPC over the live session. Rejects with PairingUnavailable when offline. */
	request<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
	readResource<T = any>(uri: string): Promise<T>;
	callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
	/** Subscribe to notifications/resources/updated for one URI. Returns unsubscribe. */
	onResourceUpdated(uri: string, cb: (meta: Record<string, unknown> | undefined) => void): () => void;
	onStatus(cb: (status: PairingStatus, detail: string) => void): () => void;
}

const PROTOCOL_VERSION = "2025-03-26";
const RPC_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export function createMcpClient(config: McpConfig): FemboyMcpClient {
	const clientId = randomUUID();
	let status: PairingStatus = "offline";
	let detail = "not started";
	let sessionId: string | undefined;
	let rpcId = 0;
	let stopRequested = true;
	let backoffMs = BACKOFF_BASE_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let lifecycle: AbortController | undefined;
	let streamAbort: AbortController | undefined;
	let lastEventId: string | undefined;

	const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	const subscribers = new Map<string, Set<(meta: Record<string, unknown> | undefined) => void>>();
	const statusListeners = new Set<(status: PairingStatus, d: string) => void>();
	/** URIs this client asked the server about; replayed after every (re)handshake. */
	const wantedSubscriptions = new Set<string>();

	function setStatus(next: PairingStatus, why: string): void {
		if (status === next && detail === why) return;
		status = next;
		detail = why;
		for (const fn of statusListeners) {
			try {
				fn(status, why);
			} catch (error) {
				console.debug("[femboy-mcp] status listener failed:", error);
			}
		}
	}

	function baseHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"x-femboy-client": clientId,
			"x-femboy-pid": String(process.pid),
			"x-femboy-window-title": process.env.TERM_PROGRAM?.slice(0, 120) ?? "terminal",
			host: hostname(),
		};
		const pane = process.env.TMUX_PANE;
		if (pane) headers["x-femboy-tmux-pane"] = pane;
		if (config.secretEnvVar) {
			const secret = process.env[config.secretEnvVar];
			if (secret) headers.authorization = `Bearer ${secret}`;
		}
		if (sessionId) headers["mcp-session-id"] = sessionId;
		return headers;
	}

	function withTimeout(ms: number): AbortSignal {
		const outer = lifecycle?.signal;
		if (outer?.aborted) return AbortSignal.abort();
		const inner = AbortSignal.timeout(ms);
		return outer ? AbortSignal.any([inner, outer]) : inner;
	}

	function dispatch(message: JsonRpcMessage): void {
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const key = typeof message.id === "string" ? Number(message.id) : message.id;
			const slot = pending.get(key);
			if (!slot) return;
			pending.delete(key);
			if (message.error) slot.reject(new Error(`mcp ${key}: ${message.error.message}`));
			else slot.resolve(message.result);
			return;
		}
		if (message.method === "notifications/resources/updated") {
			const uri = String((message.params as any)?.uri ?? "");
			const meta = (message.params as any)?._meta as Record<string, unknown> | undefined;
			const handlers = subscribers.get(uri);
			if (handlers) for (const fn of handlers) fn(meta);
		}
	}

	/** POST one JSON-RPC message; answer may come back as JSON or as the first SSE frame. */
	async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
		if (!sessionId) throw new PairingUnavailable(status === "paired" ? "no session" : status);
		const id = ++rpcId;
		const body: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
		const response = await fetch(config.url, {
			method: "POST",
			headers: baseHeaders(),
			body: JSON.stringify(body),
			signal: withTimeout(RPC_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`POST ${method} → HTTP ${response.status}`);
		if (response.status === 202 || response.status === 204) return undefined as T;
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			// the answer arrives as an SSE frame on *this* POST stream; later frames are notifications
			return new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: resolve as (v: any) => void, reject });
				void consumeSse(
					response,
					(frame) => {
						try {
							dispatch(JSON.parse(frame.data) as JsonRpcMessage);
						} catch {
							/* ignore malformed frame */
						}
					},
					lifecycle?.signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS),
				)
					.then(() => {
						const slot = pending.get(id);
						if (slot) {
							pending.delete(id);
							slot.reject(new PairingUnavailable(`stream ended before ${method} answer`));
						}
					})
					.catch(() => {
						const slot = pending.get(id);
						if (slot) {
							pending.delete(id);
							slot.reject(new PairingUnavailable(`${method} stream failed`));
						}
					});
			});
		}

		const msg = (await response.json()) as JsonRpcMessage;
		if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
		return msg.result as T;
	}

	/** Long-lived GET stream carrying notifications; resolves when the stream drops. */
	async function notificationStream(): Promise<void> {
		if (!sessionId || !lifecycle) return;
		streamAbort = new AbortController();
		const signal = AbortSignal.any([streamAbort.signal, lifecycle.signal]);
		const headers: Record<string, string> = { ...baseHeaders(), accept: "text/event-stream" };
		if (lastEventId) headers["last-event-id"] = lastEventId;
		const response = await fetch(config.url, { method: "GET", headers, signal }).catch(() => undefined);
		if (!response || !response.ok) return;
		await consumeSse(
			response,
			(frame) => {
				if (frame.id) lastEventId = frame.id;
				try {
					dispatch(JSON.parse(frame.data) as JsonRpcMessage);
				} catch {
					/* ignore malformed frame */
				}
			},
			signal,
		);
	}

	async function handshake(): Promise<boolean> {
		setStatus("connecting", "handshake");
		try {
			// presence hints ride the initialize request — the server reads
			// x-femboy-* headers there, not on later RPCs
			const initHeaders = baseHeaders();
			delete initHeaders["mcp-session-id"]; // none exists yet
			const response = await fetch(config.url, {
				method: "POST",
				headers: initHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: ++rpcId,
					method: "initialize",
					params: {
						protocolVersion: PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: { name: "pi-femboy-tui", version: "0.1.0", title: "pastel chrome" },
					},
				}),
				signal: withTimeout(RPC_TIMEOUT_MS),
			});
			if (!response.ok) {
				setStatus("offline", `initialize → HTTP ${response.status}`);
				return false;
			}
			const announced = response.headers.get("mcp-session-id");
			if (!announced) {
				setStatus("offline", "no Mcp-Session-Id in response");
				return false;
			}
			sessionId = announced;
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				await consumeSse(response, (frame) => {
					try {
						dispatch(JSON.parse(frame.data) as JsonRpcMessage);
					} catch {
						/* ignore */
					}
				}, lifecycle?.signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS)).catch(() => {});
			} else {
				await response.json().catch(() => undefined);
			}
			await fetch(config.url, {
				method: "POST",
				headers: baseHeaders(),
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
				signal: withTimeout(RPC_TIMEOUT_MS),
			});
			// replay subscriptions from before a reconnect
			for (const uri of wantedSubscriptions) {
				await rpc("resources/subscribe", { uri }).catch(() => wantedSubscriptions.delete(uri));
			}
			setStatus("paired", `paired with ${config.url}`);
			return true;
		} catch (error) {
			sessionId = undefined;
			setStatus("offline", error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	async function sessionLoop(): Promise<void> {
		while (lifecycle && !lifecycle.signal.aborted && !stopRequested) {
			const paired = await handshake();
			if (!paired) {
				await sleepBackoff();
				continue;
			}
			lastEventId = undefined;
			await notificationStream().catch(() => undefined);
			if (stopRequested || lifecycle?.signal.aborted) break;
			setStatus("connecting", "notification stream dropped");
			await sleepBackoff();
		}
		if (!stopRequested) setStatus("offline", detail);
	}

	function sleepBackoff(): Promise<void> {
		const wait = Math.min(backoffMs, BACKOFF_MAX_MS) * (0.75 + Math.random() * 0.5);
		backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
		return new Promise((resolve) => {
			reconnectTimer = setTimeout(resolve, wait);
			reconnectTimer.unref?.();
		});
	}

	const client: FemboyMcpClient = {
		get status() {
			return status;
		},
		get clientId() {
			return clientId;
		},

		async connect() {
			if (!config.enabled || lifecycle) return;
			stopRequested = false;
			backoffMs = BACKOFF_BASE_MS;
			lifecycle = new AbortController();
			void sessionLoop().catch((error) => {
				console.debug("[femboy-mcp] session loop died:", error);
				setStatus("offline", "internal loop error");
			});
		},

		async disconnect() {
			stopRequested = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			streamAbort?.abort();
			const live = sessionId;
			sessionId = undefined;
			lifecycle?.abort();
			lifecycle = undefined;
			for (const slot of pending.values()) slot.reject(new PairingUnavailable("disconnect"));
			pending.clear();
			if (live) {
				await fetch(config.url, {
					method: "DELETE",
					headers: { "mcp-session-id": live, ...(config.secretEnvVar && process.env[config.secretEnvVar] ? { authorization: `Bearer ${process.env[config.secretEnvVar]}` } : {}) },
					signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
				}).catch(() => undefined);
			}
			setStatus("offline", "disconnected");
		},

		async request<T>(method: string, params?: Record<string, unknown>) {
			return rpc<T>(method, params);
		},

		async readResource<T>(uri: string) {
			const result = await rpc<{ contents: Array<{ text: string }> }>("resources/read", { uri });
			const text = result.contents?.[0]?.text;
			if (typeof text !== "string") throw new PairingUnavailable(`empty ${uri}`);
			return JSON.parse(text) as T;
		},

		async callTool(name, args) {
			const result = await rpc<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>("tools/call", {
				name,
				arguments: args,
			});
			const text = (result.content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
			return { text, isError: result.isError === true };
		},

		onResourceUpdated(uri, cb) {
			let set = subscribers.get(uri);
			if (!set) subscribers.set(uri, (set = new Set()));
			set.add(cb);
			wantedSubscriptions.add(uri);
			if (status === "paired") void rpc("resources/subscribe", { uri }).catch(() => undefined);
			return () => {
				set!.delete(cb);
				if (set!.size === 0) {
					subscribers.delete(uri);
					wantedSubscriptions.delete(uri);
					if (status === "paired") void rpc("resources/unsubscribe", { uri }).catch(() => undefined);
				}
			};
		},

		onStatus(cb) {
			statusListeners.add(cb);
			return () => statusListeners.delete(cb);
		},
	};

	return client;
}
