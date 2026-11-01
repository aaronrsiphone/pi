/**
 * One timed request to the model under test.
 *
 * Every probe goes through `ask()`, so time to first token, duration, and token counts are measured
 * the same way everywhere. Requests use temperature 0 so re-runs on the same model give the same
 * answers wherever the provider honors it.
 *
 * A provider failure (overloaded, rate limited, connection lost) says nothing about the model, so it
 * is retried, and if it persists the whole suite stops with `ProviderUnavailableError` instead of
 * scoring the model down. Calibration runs on hosted models showed such failures flipping verdicts.
 * A request that runs out of time is different: it is not retried, and the probe scores the missing
 * answer, because a model that thinks for minutes on one answer is slow for interactive work.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ProbeClient {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Sends the single-request probes. */
	registry: ModelRegistry;
	/** Where the multi-step probe's session reads models.json and logins. Defaults to pi's agent directory. */
	agentDir?: string;
}

export interface Reply {
	message: AssistantMessage;
	/** Text content joined, trimmed. */
	text: string;
	/** Milliseconds from sending to the first streamed token, or undefined if none arrived. */
	firstTokenMs: number | undefined;
	totalMs: number;
	outputTokens: number;
	inputTokens: number;
	/** Set when the request ran out of time, e.g. "no answer within 60 s"; the probe scores it as missed. */
	noAnswer: string | undefined;
}

/** The provider kept failing, so the model could not be measured. */
export class ProviderUnavailableError extends Error {}

// Three attempts with 2 s and 4 s pauses ride out a busy provider without stretching the suite much.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/** Send one request and measure it, retrying provider failures. Throws `ProviderUnavailableError` when they persist. */
export async function ask(client: ProbeClient, context: Context, timeoutMs: number): Promise<Reply> {
	return withRetries(() => askOnce(client, context, timeoutMs), replyError);
}

/** Run `attempt` until `failure` reports nothing, pausing longer each time; throw after the last attempt. */
export async function withRetries<T>(
	attempt: () => Promise<T>,
	failure: (result: T) => string | undefined,
): Promise<T> {
	let error = "";
	for (let i = 0; i < ATTEMPTS; i++) {
		if (i > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (i - 1)));
		const result = await attempt();
		const problem = failure(result);
		if (problem === undefined) return result;
		error = problem;
	}
	throw new ProviderUnavailableError(error);
}

async function askOnce(client: ProbeClient, context: Context, timeoutMs: number): Promise<Reply> {
	const started = performance.now();
	let firstTokenMs: number | undefined;
	const stream = client.registry.streamSimple(client.model, context, {
		temperature: 0,
		signal: AbortSignal.timeout(timeoutMs),
		...(client.thinkingLevel === "off" ? {} : { reasoning: client.thinkingLevel }),
	});
	for await (const event of stream) {
		if (
			firstTokenMs === undefined &&
			(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
		) {
			firstTokenMs = performance.now() - started;
		}
	}
	const message = await stream.result();
	const text = message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	return {
		message,
		text,
		firstTokenMs,
		totalMs: performance.now() - started,
		outputTokens: message.usage.output || Math.ceil(text.length / 4),
		inputTokens: message.usage.input,
		noAnswer: message.stopReason === "aborted" ? `no answer within ${timeoutMs / 1000} s` : undefined,
	};
}

/** Why a reply failed at the provider, or undefined when it arrived. */
function replyError(reply: Reply): string | undefined {
	const { stopReason, errorMessage } = reply.message;
	return stopReason === "error" ? (errorMessage ?? stopReason) : undefined;
}
