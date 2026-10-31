/**
 * Connecting pi to an endpoint the user was given: an office gateway or a local server.
 *
 * The endpoint is added to models.json, pi's documented file for compatible endpoints, so it keeps
 * working without onboarding and the user can edit it directly later.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { stripJsonComments } from "../../utils/json.ts";

/** API families an endpoint can speak, in the words users see. */
export const ENDPOINT_APIS = [
	{ api: "openai-completions", label: "OpenAI-compatible (Ollama, LM Studio, vLLM, most company gateways)" },
	{ api: "anthropic-messages", label: "Anthropic-compatible" },
] as const;

export type EndpointApi = (typeof ENDPOINT_APIS)[number]["api"];

export interface Endpoint {
	baseUrl: string;
	api: EndpointApi;
	/** Undefined for servers that need no key; models.json then gets a placeholder so pi treats it as usable. */
	apiKey: string | undefined;
	modelId: string;
}

export type MergeResult =
	| { ok: true; text: string; providerId: string }
	| { ok: false; reason: string; snippet: string };

// Servers without authentication still need some key for pi to list their models.
const NO_KEY = "none";

/** The models.json provider entry for an endpoint. */
export function providerEntry(endpoint: Endpoint): Record<string, unknown> {
	return {
		baseUrl: endpoint.baseUrl,
		api: endpoint.api,
		apiKey: endpoint.apiKey ?? NO_KEY,
		models: [{ id: endpoint.modelId }],
	};
}

/**
 * Add the endpoint to models.json text under a free provider id based on `name`. Refuses to rewrite
 * a file with comments, which a rewrite would drop; the snippet lets the user add it by hand.
 */
export function mergeProvider(existing: string | undefined, name: string, endpoint: Endpoint): MergeResult {
	const entry = providerEntry(endpoint);
	const snippet = JSON.stringify({ providers: { [name]: entry } }, null, "\t");
	let root: Record<string, unknown> = {};
	if (existing !== undefined && existing.trim() !== "") {
		if (stripJsonComments(existing) !== existing) {
			return { ok: false, reason: "models.json contains comments, and rewriting it would remove them.", snippet };
		}
		try {
			const parsed: unknown = JSON.parse(existing);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			root = parsed as Record<string, unknown>;
		} catch {
			return { ok: false, reason: "models.json is not valid JSON.", snippet };
		}
	}
	const providers =
		typeof root.providers === "object" && root.providers !== null ? (root.providers as Record<string, unknown>) : {};
	let providerId = name;
	for (let n = 2; providerId in providers; n++) providerId = `${name}-${n}`;
	const text = `${JSON.stringify({ ...root, providers: { ...providers, [providerId]: entry } }, null, "\t")}\n`;
	return { ok: true, text, providerId };
}

/** Normalize what users paste: trim, drop a trailing slash, add http:// for bare `host:port`. */
export function normalizeBaseUrl(input: string): string | undefined {
	let url = input.trim().replace(/\/+$/, "");
	if (!url) return undefined;
	if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
	try {
		return new URL(url).toString().replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

/** Model ids an OpenAI-compatible server lists at `<baseUrl>/models`, or undefined if it lists none. */
export async function listModels(
	baseUrl: string,
	apiKey: string | undefined,
	signal: AbortSignal,
): Promise<string[] | undefined> {
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
			signal,
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { data?: { id?: unknown }[] };
		const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
		return ids.length > 0 ? ids.sort() : undefined;
	} catch {
		return undefined;
	}
}

export type ConnectionCheck = { ok: true; seconds: number } | { ok: false; error: string };

const CHECK_TIMEOUT_MS = 60_000;

/**
 * Send one tiny request and time it. The model only has to answer; whether the connection works
 * is decided here from the response, not by the model.
 */
export async function checkConnection(registry: ModelRegistry, model: Model<Api>): Promise<ConnectionCheck> {
	const started = Date.now();
	try {
		const reply = await registry.complete(
			model,
			{ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: started }] },
			{ signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return { ok: false, error: reply.errorMessage ?? "The request failed." };
		}
		return { ok: true, seconds: (Date.now() - started) / 1000 };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
