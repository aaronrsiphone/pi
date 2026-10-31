/**
 * The probe suite: run every probe in a fixed order and place the results in ranges.
 *
 * Probes run one at a time: local servers process one request at a time anyway, and sequential
 * runs keep timings comparable between models.
 */

import { type ProbeClient, ProviderUnavailableError } from "./client.ts";
import { probeMultiStep } from "./multistep.ts";
import { probeInstructions, probeRetrieval, probeSpeed, probeToolCalls } from "./probes.ts";
import { type Measurements, type Placement, place, SUITE_VERSION } from "./ranges.ts";

export interface SuiteResult {
	suiteVersion: number;
	/** `provider/model`. */
	model: string;
	modelName: string;
	thinkingLevel: string;
	at: number;
	durationMs: number;
	measurements: Measurements;
	placement: Placement;
}

export type SuiteOutcome = { ok: true; result: SuiteResult } | { ok: false; error: string };

/** Names of the steps, in run order, for progress display. */
export const SUITE_STEPS = [
	"Speed",
	"Using tools",
	"Following instructions",
	"Finding facts in long text",
	"A small multi-step task",
] as const;

/** Run the suite. Stops early only when the model or its server cannot be reached reliably. */
export async function runSuite(client: ProbeClient, onStep: (index: number) => void): Promise<SuiteOutcome> {
	try {
		return await measure(client, onStep);
	} catch (error) {
		if (!(error instanceof ProviderUnavailableError)) throw error;
		return {
			ok: false,
			error: `the model's server kept failing (${error.message}). Nothing was scored; try /probe again later`,
		};
	}
}

async function measure(client: ProbeClient, onStep: (index: number) => void): Promise<SuiteOutcome> {
	const started = Date.now();
	onStep(0);
	const { error, ...speed } = await probeSpeed(client);
	if (error) return { ok: false, error };
	onStep(1);
	const tools = await probeToolCalls(client);
	onStep(2);
	const instructions = await probeInstructions(client);
	onStep(3);
	const retrieval = await probeRetrieval(client, client.model.contextWindow);
	onStep(4);
	const multiStep = await probeMultiStep(client);
	const measurements: Measurements = {
		contextWindow: client.model.contextWindow,
		speed,
		tools,
		instructions,
		retrieval,
		multiStep,
	};
	return {
		ok: true,
		result: {
			suiteVersion: SUITE_VERSION,
			model: `${client.model.provider}/${client.model.id}`,
			modelName: client.model.name || client.model.id,
			thinkingLevel: client.thinkingLevel,
			at: started,
			durationMs: Date.now() - started,
			measurements,
			placement: place(measurements, client.model.reasoning),
		},
	};
}

// Estimated from the suite's requests: the retrieval text and the agent loop's repeated context dominate.
const ESTIMATED_INPUT_TOKENS = 25_000;
const ESTIMATED_OUTPUT_TOKENS = 3_000;

/** Rough cost of one run in dollars, from the model's per-million-token prices. */
export function estimateCost(cost: { input: number; output: number }): number {
	return (ESTIMATED_INPUT_TOKENS * cost.input + ESTIMATED_OUTPUT_TOKENS * cost.output) / 1_000_000;
}
