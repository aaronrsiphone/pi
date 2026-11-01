/**
 * The probe suite: run every probe in a fixed order and place the results in ranges.
 *
 * Probes run one at a time: local servers process one request at a time anyway, and sequential
 * runs keep timings comparable between models.
 */

import { type ProbeClient, ProviderUnavailableError } from "./client.ts";
import { HARD_STEPS, probeHard } from "./hard-probes.ts";
import { probeMultiStep } from "./multistep.ts";
import { probeInstructions, probeRetrieval, probeSpeed, probeToolCalls } from "./probes.ts";
import { type Measurements, type Placement, passedBasics, place, SUITE_VERSION } from "./ranges.ts";

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

const BASIC_STEPS = [
	"Speed",
	"Using tools",
	"Following instructions",
	"Finding facts in long text",
	"A small multi-step task",
] as const;

/** Names of the steps, in run order, for progress display. The harder steps run only after every basic probe passed. */
export const SUITE_STEPS = [...BASIC_STEPS, ...HARD_STEPS] as const;

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
	const basics = { tools, instructions, retrieval, multiStep };
	// Only a model that passed everything has more to show; the rest keep the short suite.
	const hard = passedBasics(basics) ? await probeHard(client, (i) => onStep(BASIC_STEPS.length + i)) : undefined;
	const measurements: Measurements = { contextWindow: client.model.contextWindow, speed, ...basics, hard };
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

// Estimated for a run with the harder tier: the two long logs and the agent loop's context dominate
// the input, and reasoning on the calculation the output.
const ESTIMATED_INPUT_TOKENS = 60_000;
const ESTIMATED_OUTPUT_TOKENS = 10_000;

/** Rough cost of one run in dollars, from the model's per-million-token prices, at most. */
export function estimateCost(cost: { input: number; output: number }): number {
	return (ESTIMATED_INPUT_TOKENS * cost.input + ESTIMATED_OUTPUT_TOKENS * cost.output) / 1_000_000;
}
