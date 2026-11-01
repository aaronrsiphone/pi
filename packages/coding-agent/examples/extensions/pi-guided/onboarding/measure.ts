/**
 * The "probe" step: measure the connected model and show what pi found, in plain words.
 *
 * The user has already picked a careful level. Measuring changes nothing: it reports the highest
 * level this model handles, and only when that is below the user's level does it offer to lower it.
 * A failed or declined measurement does not block setup: the user can run /probe later.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SuiteOutcome } from "../capability/index.ts";
import { describeResult } from "../capability/summary.ts";
import { type CarefulLevel, levelLabel } from "../careful/levels.ts";
import type { FlowEvent } from "./flow.ts";

export interface ProbeDeps {
	/** Measures the connected model (the capability extension's `measureModel`). */
	measure(ctx: ExtensionContext): Promise<SuiteOutcome | undefined>;
	/** The careful level in effect; undefined when careful levels are turned off. */
	currentLevel: CarefulLevel | undefined;
	/** Save and apply a lower level (through the careful extension). */
	chooseLevel(level: CarefulLevel): void;
}

/** Run the measurement and show the result. Returns undefined when the user paused with Escape. */
export async function runProbe(ctx: ExtensionContext, deps: ProbeDeps): Promise<FlowEvent | undefined> {
	const outcome = await deps.measure(ctx);
	if (!outcome) return { type: "probed" };
	if (!outcome.ok) {
		const choice = await ctx.ui.select(
			`Pi could not measure the model (${outcome.error}). You can try again later with /probe.`,
			["Continue"],
		);
		return choice === undefined ? undefined : { type: "probed" };
	}
	const highest = outcome.result.placement.recommendations.highestLevel;
	const current = deps.currentLevel;
	const intro = "Here is what pi measured. These are realistic expectations, not a promise: check its work.";
	const lines = [intro, "", ...describeResult(outcome.result), ""];
	if (current === undefined || current <= highest) {
		lines.push(
			current === undefined
				? "Nothing was changed."
				: `Nothing was changed: your careful level stays at ${levelLabel(current)}. Move up with /careful when the answers are right.`,
		);
		const choice = await ctx.ui.select(lines.join("\n"), ["Continue"]);
		return choice === undefined ? undefined : { type: "probed" };
	}
	lines.push(
		`You picked level ${levelLabel(current)}, but this model handles only up to level ${levelLabel(highest)}.`,
	);
	const lower = `Lower to level ${levelLabel(highest)}`;
	const choice = await ctx.ui.select(lines.join("\n"), [lower, `Keep level ${levelLabel(current)}`]);
	if (choice === undefined) return undefined;
	if (choice === lower) deps.chooseLevel(highest);
	return { type: "probed" };
}
