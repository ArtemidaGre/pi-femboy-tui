/**
 * pairing.ts — the background connector that marries the local vibe store
 * (`vibe.ts`) with the shared pastel state on a femboy-mcp server.
 *
 * Direction of travel:
 *   remote → local   femboy://state (outfit, feature flags) and femboy://mood
 *                    (headpat counter) hydrate the vibe; every notification
 *                    re-reads the snapshot and patchVibe()s, so chrome, ribbons,
 *                    companion and tool rows repaint through the existing
 *                    onVibeChange subscriptions — no rebuild, no restart.
 *   local → remote   outfit / feature-flag patches are pushed (debounced) as
 *                    femboy_set_outfit / femboy_toggle_feature tool calls.
 *
 * Loop safety: an applied remote snapshot never re-pushes (applyingRemote
 * guard), and every apply is revision-checked — our own pushes bounce back as
 * notifications and are re-applied idempotently (the pushing window paints too,
 * the revision gate makes the echo a no-op when nothing moved).
 *
 * Offline is the happy path, not an error: `femboy.mcp.enabled:false` or an
 * unreachable server keeps vibe.ts purely local, exactly as before pairing.
 * Reconnect is the client's backoff loop; the moment status flips to "paired"
 * a full sync runs and live sync resumes.
 *
 * What vibe.ts fields map to:
 *   outfit (index)        ↔ state.outfit (display name)
 *   pastelMode            ↔ features.chrome
 *   uwuMode               ↔ features.uwu
 *   companion             ↔ features.companion
 *   toolRows              ↔ features.toolRows
 *   ribbonEditor          ↔ features.ribbonEditor
 *   headpats              ↔ mood.headpats (remote is the shared counter)
 *   welcome               — local only (per-window preference)
 */

import {
	type PairingStatus,
	type FemboyMcpClient,
	createMcpClient,
	settingsMcpConfig,
} from "./mcp";
import { OUTFITS, findOutfitIndex } from "./sprites";
import { onVibeChange, patchVibe, setRemoteBadge, type VibeState } from "./vibe";

const STATE_URI = "femboy://state";
const MOOD_URI = "femboy://mood";
const PUSH_DEBOUNCE_MS = 250;

interface RemoteState {
	revision: number;
	updatedBy: string | null;
	outfit: string;
	features: Record<string, boolean>;
}

interface RemoteMood {
	revision: number;
	updatedBy: string | null;
	headpats: number;
}

interface PendingPush {
	outfit?: string;
	features: Map<string, boolean>;
}

let client: FemboyMcpClient | undefined;
let applyingRemote = false;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPush: PendingPush | undefined;
let lastSeenStateRevision = -1;
let lastSeenMoodRevision = -1;
let statusDetail = "pairing disabled";

const FEATURE_KEYS: Array<[vibeKey: keyof VibeState, feature: string]> = [
	["pastelMode", "chrome"],
	["uwuMode", "uwu"],
	["companion", "companion"],
	["toolRows", "toolRows"],
	["ribbonEditor", "ribbonEditor"],
];

function featureToVibeKey(feature: string): keyof VibeState | undefined {
	return FEATURE_KEYS.find(([, name]) => name === feature)?.[0];
}

function remoteOutfitIndex(outfitName: string): number | undefined {
	return findOutfitIndex(outfitName);
}

// ------------------------------------------------------------------- remote → local --

function applyStateSnapshot(state: RemoteState): void {
	lastSeenStateRevision = state.revision;
	const patch: Partial<VibeState> = {};
	const outfit = remoteOutfitIndex(state.outfit);
	if (outfit !== undefined && outfit !== -1) patch.outfit = outfit;
	for (const [feature, value] of Object.entries(state.features ?? {})) {
		const key = featureToVibeKey(feature);
		if (key && typeof value === "boolean") (patch as Record<string, unknown>)[key] = value;
	}
	if (Object.keys(patch).length === 0) return;
	applyingRemote = true;
	try {
		patchVibe(patch);
	} finally {
		applyingRemote = false;
	}
}

function applyMoodSnapshot(mood: RemoteMood): void {
	lastSeenMoodRevision = mood.revision;
	if (typeof mood.headpats !== "number") return;
	if (mood.headpats === lastLocalHeadpats) return;
	applyingRemote = true;
	try {
		patchVibe({ headpats: mood.headpats });
	} finally {
		applyingRemote = false;
	}
}

async function syncFromRemote(reason: string): Promise<void> {
	if (!client || client.status !== "paired") return;
	try {
		const [state, mood] = await Promise.all([
			client.readResource<RemoteState>(STATE_URI),
			client.readResource<RemoteMood>(MOOD_URI),
		]);
		applyStateSnapshot(state);
		applyMoodSnapshot(mood);
		statusDetail = `${reason} · rev ${state.revision}/${mood.revision}`;
	} catch (error) {
		console.debug("[femboy-pair] sync failed:", error);
		statusDetail = `sync failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

let lastLocalHeadpats = -1;

// ------------------------------------------------------------------- local → remote --

function queuePush(patch: PendingPush): void {
	pendingPush = pendingPush ?? { features: new Map() };
	if (patch.outfit !== undefined) pendingPush.outfit = patch.outfit;
	for (const [feature, value] of patch.features) pendingPush.features.set(feature, value);
	if (pushTimer) clearTimeout(pushTimer);
	pushTimer = setTimeout(() => void flushPush(), PUSH_DEBOUNCE_MS);
	pushTimer.unref?.();
}

async function flushPush(): Promise<void> {
	pushTimer = undefined;
	const push = pendingPush;
	pendingPush = undefined;
	if (!push || !client || client.status !== "paired") return;
	try {
		if (push.outfit !== undefined) await client.callTool("femboy_set_outfit", { outfit: push.outfit });
		for (const [feature, enabled] of push.features) {
			await client.callTool("femboy_toggle_feature", { feature, enabled });
		}
	} catch (error) {
		console.debug("[femboy-pair] push failed — staying local:", error);
	}
}

function onLocalVibeChange(next: VibeState, patch: Partial<VibeState>): void {
	lastLocalHeadpats = next.headpats;
	if (applyingRemote || !client || client.status !== "paired") return;
	const push: PendingPush = { features: new Map() };
	if (patch.outfit !== undefined) push.outfit = OUTFITS[next.outfit]?.name;
	for (const [vibeKey, feature] of FEATURE_KEYS) {
		if (patch[vibeKey] !== undefined) push.features.set(feature, Boolean(next[vibeKey]));
	}
	const meaningful = push.outfit !== undefined || push.features.size > 0;
	if (meaningful) queuePush(push);
	// nothing pushable in this patch — keep whatever was already queued
}

// ------------------------------------------------------------------------ api --

/**
 * Idempotent. Call from session_start; safe in every mode (the pi RPC/`-p`
 * runs get the connector too — repaint is a TUI concern of the listeners).
 */
export function initPairing(cwd: string): void {
	const config = settingsMcpConfig(cwd);
	if (!config.enabled) {
		statusDetail = "pairing disabled (femboy.mcp.enabled:false)";
		return;
	}
	if (client) {
		void syncFromRemote("session restart");
		return;
	}

	client = createMcpClient(config);
	onVibeChange(onLocalVibeChange);

	client.onResourceUpdated(STATE_URI, () => {
		void (async () => {
			if (!client) return;
			try {
				const state = await client.readResource<RemoteState>(STATE_URI);
				if (state.revision !== lastSeenStateRevision) applyStateSnapshot(state);
			} catch (error) {
				console.debug("[femboy-pair] state reread failed:", error);
			}
		})();
	});

	client.onResourceUpdated(MOOD_URI, () => {
		void (async () => {
			if (!client) return;
			try {
				const mood = await client.readResource<RemoteMood>(MOOD_URI);
				if (mood.revision !== lastSeenMoodRevision) applyMoodSnapshot(mood);
			} catch (error) {
				console.debug("[femboy-pair] mood reread failed:", error);
			}
		})();
	});

	client.onStatus((status) => {
		statusDetail = status === "paired" ? `paired with ${config.url}` : status;
		setRemoteBadge(status === "paired" ? " ♡mcp" : "");
		if (status === "paired") void syncFromRemote("first pair");
	});

	void client.connect();
	statusDetail = `connecting to ${config.url}`;
}

export function pairingStatus(): PairingStatus {
	return client?.status ?? "offline";
}

export function pairingDetail(): string {
	return statusDetail;
}

/**
 * Headpats through the server when paired (shared counter + achievements).
 * "pushed" ⇒ the mood notification paints vibe.headpats; "offline" ⇒ caller owns the local patch.
 */
export async function patThroughPairing(intensity: number): Promise<"pushed" | "offline"> {
	if (!client || client.status !== "paired") return "offline";
	try {
		const result = await client.callTool("femboy_headpat", { intensity });
		return result.isError ? "offline" : "pushed";
	} catch (error) {
		console.debug("[femboy-pair] headpat push failed:", error);
		return "offline";
	}
}

export type WearResult =
	| { result: "pushed" } // server accepted — the state notification paints the outfit
	| { result: "offline" } // not paired: caller patches the vibe locally
	| { result: "refused"; reason: string }; // gated skin: server said no, don't paint it

/** Outfit through the server when paired; refusals keep their reason for the UI. */
export async function wearThroughPairing(outfitName: string): Promise<WearResult> {
	if (!client || client.status !== "paired") return { result: "offline" };
	try {
		const response = await client.callTool("femboy_set_outfit", { outfit: outfitName });
		if (response.isError) return { result: "refused", reason: response.text || "the closet says no" };
		return { result: "pushed" };
	} catch (error) {
		console.debug("[femboy-pair] wear push failed:", error);
		return { result: "offline" };
	}
}

/** Feature flag through the server when paired. */
export async function toggleThroughPairing(feature: string, enabled: boolean): Promise<boolean> {
	if (!client || client.status !== "paired") return false;
	try {
		await client.callTool("femboy_toggle_feature", { feature, enabled });
		return true;
	} catch (error) {
		console.debug("[femboy-pair] toggle push failed:", error);
		return false;
	}
}

export async function shutdownPairing(): Promise<void> {
	if (pushTimer) clearTimeout(pushTimer);
	const pending = pendingPush;
	pendingPush = undefined;
	if (pending && client?.status === "paired") await flushPush();
	await client?.disconnect().catch(() => undefined);
}
