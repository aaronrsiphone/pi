/**
 * One timed request to the model under test.
 *
 * Every probe goes through `ask()`, so time to first token, duration, and token counts are measured
 * the same way everywhere. Requests use temperature 0 so re-runs on the same model give the same
 * answers wherever the provider honors it.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../core/model-registry.ts";

export interface ProbeClient {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	registry: ModelRegistry;
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
}

/** Send one request and measure it. Never rejects: provider failures come back as an error message. */
export async function ask(client: ProbeClient, context: Context, timeoutMs: number): Promise<Reply> {
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
	};
}

/** Why a reply failed at the provider, or undefined when it arrived. */
export function replyError(reply: Reply): string | undefined {
	const { stopReason, errorMessage } = reply.message;
	return stopReason === "error" || stopReason === "aborted" ? (errorMessage ?? stopReason) : undefined;
}
