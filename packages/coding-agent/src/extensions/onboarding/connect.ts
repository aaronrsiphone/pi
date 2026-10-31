/**
 * The "connect" step: get pi talking to a model, then prove it with one small request.
 *
 * Three ways in, matching what office users are usually given:
 *   - an address (URL) for a company gateway or local server: added to models.json here
 *   - a provider account or API key: pi's own /login screen
 *   - llama.cpp on this computer: /login llama.cpp
 * Built-in commands cannot be started from an extension, so the last two put the command in the
 * editor; the flow resumes when /login selects a model (index.ts listens for model_select).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import {
	checkConnection,
	ENDPOINT_APIS,
	type Endpoint,
	type EndpointApi,
	listModels,
	mergeProvider,
	normalizeBaseUrl,
} from "./endpoint.ts";
import type { FlowEvent } from "./flow.ts";

export interface ConnectDeps {
	/** models.json to add endpoints to. */
	modelsPath: string;
	/** Select a model for this session (`pi.setModel`). */
	setModel(model: Model<Api>): Promise<boolean>;
}

const WAYS = {
	url: "I have an address (URL) from my company or for a server on this computer",
	login: "I have an account or API key with a provider (Anthropic, OpenAI, Google, ...)",
	llama: "I run models on this computer with llama.cpp",
	skip: "Skip setup for now",
} as const;

/** Run the connect step. Returns the flow event, or undefined when the user paused with Escape. */
export async function runConnect(ctx: ExtensionContext, deps: ConnectDeps): Promise<FlowEvent | undefined> {
	const current = ctx.model;
	if (current && ctx.modelRegistry.hasConfiguredAuth(current)) {
		const choice = await ctx.ui.select(`Welcome to pi.\n\nPi is connected to ${describeModel(current)}.`, [
			"Use this model",
			"Connect a different one",
			WAYS.skip,
		]);
		if (choice === undefined) return undefined;
		if (choice === WAYS.skip) return { type: "skip" };
		if (choice === "Use this model") return verify(ctx, deps, current);
	}
	return chooseWay(ctx, deps);
}

/** The "waiting-for-login" step: continue once /login has selected a model. */
export async function runWaitingForLogin(ctx: ExtensionContext, deps: ConnectDeps): Promise<FlowEvent | undefined> {
	const current = ctx.model;
	if (current && ctx.modelRegistry.hasConfiguredAuth(current)) return verify(ctx, deps, current);
	const choice = await ctx.ui.select(
		"Pi is still waiting for you to sign in.\n\nType /login and press Enter, then pick your provider. Setup continues afterwards.",
		["Choose another way to connect", WAYS.skip],
	);
	if (choice === undefined) return undefined;
	if (choice === WAYS.skip) return { type: "skip" };
	return chooseWay(ctx, deps);
}

async function chooseWay(ctx: ExtensionContext, deps: ConnectDeps): Promise<FlowEvent | undefined> {
	const way = await ctx.ui.select(
		"Connect pi to an AI model.\n\nPi needs a model to talk to. What did you get from your company or provider?",
		Object.values(WAYS),
	);
	switch (way) {
		case undefined:
			return undefined;
		case WAYS.skip:
			return { type: "skip" };
		case WAYS.login:
			return handOffToLogin(ctx, "/login");
		case WAYS.llama:
			return handOffToLogin(ctx, "/login llama.cpp");
		default:
			return connectEndpoint(ctx, deps);
	}
}

function handOffToLogin(ctx: ExtensionContext, command: string): FlowEvent {
	ctx.ui.setEditorText(command);
	ctx.ui.notify(
		`Press Enter to open the sign-in screen (${command} is in the message box). Setup continues when you are signed in.`,
		"info",
	);
	return { type: "login-started" };
}

async function connectEndpoint(ctx: ExtensionContext, deps: ConnectDeps): Promise<FlowEvent | undefined> {
	const endpoint = await askEndpoint(ctx);
	if (!endpoint) return undefined;
	const name = providerName(endpoint.baseUrl);
	const existing = existsSync(deps.modelsPath) ? readFileSync(deps.modelsPath, "utf-8") : undefined;
	const merged = mergeProvider(existing, name, endpoint);
	if (!merged.ok) {
		ctx.ui.notify(
			`${merged.reason}\nAdd this to ${deps.modelsPath} yourself, then run /onboarding again:\n${merged.snippet}`,
			"warning",
		);
		return undefined;
	}
	writeFileSync(deps.modelsPath, merged.text, "utf-8");
	await ctx.modelRegistry.refresh();
	const model = ctx.modelRegistry.find(merged.providerId, endpoint.modelId);
	if (!model || !(await deps.setModel(model))) {
		ctx.ui.notify(
			`Added "${merged.providerId}" to ${deps.modelsPath}, but pi could not select ${endpoint.modelId}. Check the file, then run /onboarding again.`,
			"error",
		);
		return undefined;
	}
	return verify(ctx, deps, model);
}

async function askEndpoint(ctx: ExtensionContext): Promise<Endpoint | undefined> {
	let baseUrl: string | undefined;
	while (!baseUrl) {
		const typed = await ctx.ui.input(
			"Address of the AI server (ask whoever gave you access)",
			"e.g. https://ai.example.com/v1 or localhost:11434/v1",
		);
		if (typed === undefined) return undefined;
		baseUrl = normalizeBaseUrl(typed);
		if (!baseUrl) ctx.ui.notify(`"${typed}" is not a web address. Try again, or press Escape to stop.`, "warning");
	}
	const apiLabel = await ctx.ui.select(
		"Which kind of server is it? If you are not sure, pick the first one.",
		ENDPOINT_APIS.map((a) => a.label),
	);
	const api = ENDPOINT_APIS.find((a) => a.label === apiLabel)?.api;
	if (!api) return undefined;
	const key = await ctx.ui.input("API key (leave empty if the server needs none)", "paste the key, or press Enter");
	if (key === undefined) return undefined;
	const apiKey = key.trim() || undefined;
	const modelId = await askModelId(ctx, baseUrl, api, apiKey);
	return modelId ? { baseUrl, api, apiKey, modelId } : undefined;
}

// Long lists do not fit a dialog; past this the user types the name.
const MAX_LISTED_MODELS = 40;

async function askModelId(
	ctx: ExtensionContext,
	baseUrl: string,
	api: EndpointApi,
	apiKey: string | undefined,
): Promise<string | undefined> {
	const listed = api === "openai-completions" ? await listModels(baseUrl, apiKey, AbortSignal.timeout(15_000)) : [];
	if (listed && listed.length > 0 && listed.length <= MAX_LISTED_MODELS) {
		const typeIt = "None of these: type the name";
		const choice = await ctx.ui.select("Which model should pi use?", [...listed, typeIt]);
		if (choice !== typeIt) return choice;
	} else if (listed === undefined) {
		ctx.ui.notify(
			`Could not get the list of models from ${baseUrl}. You can type the model name instead.`,
			"warning",
		);
	}
	const typed = await ctx.ui.input("Model name (as your company or server calls it)", "e.g. qwen2.5-coder:7b");
	return typed?.trim() || undefined;
}

/** Provider id for models.json from the server's host name: `ai.example.com` -> `ai-example-com`. */
function providerName(baseUrl: string): string {
	const host = new URL(baseUrl).hostname;
	if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "local";
	return host.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "endpoint";
}

async function verify(ctx: ExtensionContext, deps: ConnectDeps, model: Model<Api>): Promise<FlowEvent | undefined> {
	for (;;) {
		ctx.ui.notify(`Checking the connection to ${describeModel(model)}...`, "info");
		const check = await checkConnection(ctx.modelRegistry, model);
		if (check.ok) {
			ctx.ui.notify(`Connected. ${describeModel(model)} answered in ${check.seconds.toFixed(1)} s.`, "info");
			return { type: "connected", model: `${model.provider}/${model.id}` };
		}
		const choice = await ctx.ui.select(`Pi could not reach ${describeModel(model)}.\n\n${check.error}`, [
			"Try again",
			"Set up a different connection",
			WAYS.skip,
		]);
		if (choice === undefined) return undefined;
		if (choice === WAYS.skip) return { type: "skip" };
		if (choice === "Set up a different connection") return chooseWay(ctx, deps);
	}
}

function describeModel(model: Model<Api>): string {
	return `${model.name || model.id} (${model.provider})`;
}
