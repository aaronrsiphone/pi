/**
 * Capability probes: measure the connected model in about a minute and place it in ranges.
 *
 * `/probe` runs the suite on the current model; onboarding runs it right after connecting. Results
 * are saved per model (store.ts) for the expectations card and for comparing runs.
 */

import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { defaultCapabilityDir, saveResult } from "./store.ts";
import { estimateCost, runSuite, SUITE_STEPS, type SuiteOutcome } from "./suite.ts";
import { describeResult } from "./summary.ts";

export type { SuiteOutcome, SuiteResult } from "./suite.ts";

const WIDGET_KEY = "capability";

/**
 * Measure the current model, showing progress, and save the result. Asks first when the model
 * charges per token. Returns undefined when there is no model or the user declined.
 */
export async function measureModel(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	dir: string = defaultCapabilityDir(),
): Promise<SuiteOutcome | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const name = model.name || model.id;
	if (model.cost.input > 0 || model.cost.output > 0) {
		const dollars = estimateCost(model.cost);
		const ok = await ctx.ui.confirm(
			"Measure this model?",
			`Pi sends about 20 requests to ${name} to see what it can do. At its prices that costs about $${dollars < 0.01 ? "0.01" : dollars.toFixed(2)}.`,
		);
		if (!ok) return undefined;
	}
	const show = (current: number) =>
		ctx.ui.setWidget(WIDGET_KEY, [
			`Checking what ${name} can do. This takes about a minute.`,
			...SUITE_STEPS.map((step, i) => `  ${i < current ? "done" : i === current ? " now" : "    "}  ${step}`),
		]);
	try {
		const outcome = await runSuite(
			{ model, thinkingLevel: pi.getThinkingLevel(), registry: ctx.modelRegistry },
			show,
		);
		if (outcome.ok) saveResult(dir, outcome.result);
		return outcome;
	} finally {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

/** Register `/probe`. */
export function createCapabilityExtension(pi: ExtensionAPI, options: { dir?: string } = {}): void {
	pi.registerCommand("probe", {
		description: "Measure what the connected model can do (about a minute) and recommend settings",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model is connected. Run /onboarding or /login first.", "warning");
				return;
			}
			const outcome = await measureModel(ctx, pi, options.dir);
			if (!outcome) return;
			if (!outcome.ok) {
				ctx.ui.notify(`Could not measure the model: ${outcome.error}`, "error");
				return;
			}
			ctx.ui.notify(describeResult(outcome.result).join("\n"), "info");
		},
	});
}

export default function capabilityExtension(pi: ExtensionAPI): void {
	createCapabilityExtension(pi);
}
